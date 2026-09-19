#!/usr/bin/env bash
#
# Puts nginx + a Let's Encrypt certificate in front of the application on a plain Ubuntu server -
# no control panel involved.
#
#   sudo DOMAIN=2set.com EMAIL=you@example.com bash deploy/setup-nginx.sh
#
# Run it AFTER the stack is up and answering on 127.0.0.1:8080 (deploy/setup-server.sh does that).
# Safe to re-run: it rewrites its own site file, never touches other sites, and certbot will
# simply report the certificate is still valid.

set -euo pipefail

DOMAIN="${DOMAIN:-2set.com}"
WWW="${WWW:-www.$DOMAIN}"
EMAIL="${EMAIL:-}"
UPSTREAM="${UPSTREAM:-127.0.0.1:8080}"
SITE="/etc/nginx/sites-available/medbill"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$*"; }
die()  { printf '  \033[31mfail\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this with sudo."

# ---------------------------------------------------------------- 1. the app must be up first
bold "1. Application"
curl -fsS -o /dev/null "http://$UPSTREAM/" 2>/dev/null \
  || die "nothing is answering on http://$UPSTREAM - start the stack first (deploy/setup-server.sh)."
ok "application answering on $UPSTREAM"

# ---------------------------------------------------------------- 2. DNS
#
# Checked before certbot runs, because a Let's Encrypt failure is rate-limited and its error
# message does not say "your DNS is wrong" - it just says the challenge failed.
bold "2. DNS"
MYIP="$(curl -fsS --max-time 10 https://api.ipify.org || echo '')"
for host in "$DOMAIN" "$WWW"; do
  RESOLVED="$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR==1{print $1}')"
  if [ -z "$RESOLVED" ]; then
    warn "$host does not resolve yet - certbot will fail for it"
  elif [ -n "$MYIP" ] && [ "$RESOLVED" != "$MYIP" ]; then
    warn "$host resolves to $RESOLVED but this server is $MYIP"
  else
    ok "$host -> $RESOLVED"
  fi
done

# ---------------------------------------------------------------- 3. packages
bold "3. nginx and certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx >/dev/null
ok "installed"

# ---------------------------------------------------------------- 4. site
#
# Written as plain HTTP only. certbot rewrites this file to add the TLS server block and the
# redirect, copying these proxy settings across - which is why they live in the location block
# rather than anywhere else.
bold "4. Site configuration"
cat > "$SITE" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN $WWW;

    # Uploaded insurance cards and ID documents are posted as base64 JSON, which inflates them by
    # about a third. The 1m default rejects a phone photo.
    client_max_body_size 25m;

    server_tokens off;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / {
        proxy_pass http://$UPSTREAM;
        proxy_http_version 1.1;

        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        # The API marks the trusted-device cookie Secure based on this header. Without it, "trust
        # this device for 30 days" silently stops working behind TLS.
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection        "";

        # GET /api/stream is a Server-Sent Events feed held open for the whole session - it is what
        # replaced Firestore's onSnapshot. nginx buffers proxied responses by default, which holds
        # events back until the buffer fills: the page loads, shows correct data once, and then
        # never updates again. It looks like an application bug rather than a proxy setting.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 24h;
    }
}
NGINX

ln -sf "$SITE" /etc/nginx/sites-enabled/medbill
# Ubuntu's stock welcome page also claims port 80 and would win on a bare hostname.
rm -f /etc/nginx/sites-enabled/default
nginx -t || die "nginx rejected the configuration (shown above)."
systemctl reload nginx
ok "nginx serving $DOMAIN on port 80"

# ---------------------------------------------------------------- 5. certificate
bold "5. HTTPS"
if [ -z "$EMAIL" ]; then
  warn "no EMAIL set - skipping certbot. Run it yourself when DNS is ready:"
  echo "    certbot --nginx -d $DOMAIN -d $WWW --agree-tos -m you@example.com --redirect"
else
  # --redirect adds the 80 -> 443 redirect. This application carries PHI; plain HTTP would put
  # patient names, dates of birth and SSNs on the wire in clear text.
  certbot --nginx -d "$DOMAIN" -d "$WWW" --agree-tos -m "$EMAIL" --redirect -n \
    || die "certbot failed - almost always DNS. Check section 2 above, then re-run."
  ok "certificate issued and HTTP redirects to HTTPS"
  systemctl reload nginx
fi

# ---------------------------------------------------------------- 6. firewall
bold "6. Firewall"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp  >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ok "ufw: 22, 80, 443 allowed (8080 deliberately NOT opened - it is loopback-bound)"
  warn "ufw is not enabled by this script. Enable it yourself with: ufw enable"
else
  warn "ufw not installed - make sure your cloud firewall allows 80 and 443, and NOT 8080"
fi

bold "Done."
echo
echo "  Open https://$DOMAIN"
echo "  Sign in as your existing admin account; every account is taken through"
echo "  authenticator enrolment on first sign-in (MFA_ENFORCEMENT=all)."
echo
echo "  Check the live feed works: open the app in two tabs, post a payment in one,"
echo "  and it should appear in the other without refreshing."
echo
