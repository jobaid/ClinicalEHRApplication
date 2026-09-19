#!/usr/bin/env bash
#
# Server-side setup for the Clinical EHR / medical billing stack behind CloudPanel.
#
#   scp this file, .env.docker and medbill.dump to the server, then:
#     sudo bash setup-server.sh
#
# Safe to re-run: every step checks before it acts, and the database is only restored when you
# ask for it. It installs Docker if missing, starts the stack bound to loopback, verifies the
# schema, and prints exactly what is left to do in the CloudPanel web interface.
#
# What it deliberately does NOT do: create the CloudPanel site, issue the certificate, or edit the
# vhost. Those are browser actions on your panel, and doing them from a script would mean handing
# it your CloudPanel credentials.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/medbill}"
DOMAIN="${DOMAIN:-www.2set.com}"
DUMP="${DUMP:-}"

# Every compose call must carry --env-file: compose re-interpolates docker-compose.yml each
# time, and ${VAR:?} turns a missing value into an error rather than a blank. Wrapping it once
# means a later command cannot silently omit it - which is exactly the bug this replaces.
dc() { docker compose --env-file .env.docker "$@"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$*"; }
die()  { printf '  \033[31mfail\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this with sudo."

# ---------------------------------------------------------------- 1. files
#
# Checked before anything is installed: a wrong APP_DIR or a missing .env.docker should not leave
# Docker installed on the machine as the side effect of a typo.
bold "1. Application files"
[ -d "$APP_DIR" ] || die "$APP_DIR does not exist. Clone the repository there first."
cd "$APP_DIR"
[ -f docker-compose.yml ] || die "no docker-compose.yml in $APP_DIR - is this the right directory?"
[ -f .env.docker ] || die "no .env.docker in $APP_DIR. Copy the one generated for you, or fill in .env.docker.example."
ok "repository and .env.docker found"

# Secrets must not be world-readable: the file holds the database password and the JWT signing key.
chmod 600 .env.docker
ok ".env.docker permissions set to 600"

# Fail early on the settings that silently break things later rather than at first sign-in.
grep -q '^JWT_SECRET=.\+' .env.docker      || die "JWT_SECRET is empty in .env.docker"
grep -q '^POSTGRES_PASSWORD=.\+' .env.docker || die "POSTGRES_PASSWORD is empty in .env.docker"
grep -q '^CORS_ORIGINS=.\+' .env.docker    || die "CORS_ORIGINS is empty in .env.docker"
grep -q '^WEB_PORT=127\.0\.0\.1:' .env.docker \
  || warn "WEB_PORT is not bound to 127.0.0.1 - the stack will be reachable from the internet, bypassing TLS"
ok "required settings present"

# ---------------------------------------------------------------- 2. Docker
bold "2. Docker"
if command -v docker >/dev/null 2>&1; then
  ok "docker present ($(docker --version | cut -d, -f1))"
else
  echo "  installing Docker..."
  curl -fsSL https://get.docker.com | sh >/dev/null
  ok "docker installed"
fi
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing."
ok "compose plugin present"

# ---------------------------------------------------------------- 3. build & start
bold "3. Build and start"
dc up -d --build
echo "  waiting for the API..."
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null http://127.0.0.1:8080/ 2>/dev/null; then break; fi
  [ "$i" -eq 60 ] && { dc logs --tail 40 api; die "the API did not come up. Logs above."; }
  sleep 2
done
ok "stack is up and answering on 127.0.0.1:8080"

# ---------------------------------------------------------------- 4. restore
bold "4. Database"
DBU="$(grep '^POSTGRES_USER=' .env.docker | cut -d= -f2-)"
DBN="$(grep '^POSTGRES_DB=' .env.docker | cut -d= -f2-)"

if [ -n "$DUMP" ]; then
  [ -f "$DUMP" ] || die "dump file $DUMP not found"
  warn "restoring $DUMP - this REPLACES the current contents of $DBN"
  dc cp "$DUMP" db:/tmp/restore.dump
  dc exec -T db pg_restore -U "$DBU" -d "$DBN" \
    --clean --if-exists --no-owner --no-privileges /tmp/restore.dump || \
    warn "pg_restore reported errors - 'does not exist, skipping' lines are normal on a fresh database"
  dc exec -T db rm -f /tmp/restore.dump
  ok "database restored"
else
  ok "no dump given (DUMP=...) - keeping whatever is in the database"
fi

# The migrations run only when the data directory starts empty, and a restored dump taken before
# a migration was added will not contain its tables. Check rather than assume.
bold "5. Schema check"
for t in users charges patients user_mfa trusted_devices; do
  if dc exec -T db psql -U "$DBU" -d "$DBN" -tAc \
      "SELECT to_regclass('public.$t') IS NOT NULL;" | grep -q t; then
    ok "table $t"
  else
    warn "table $t is MISSING - applying migrations by hand"
    for m in server/migrations/*.sql; do
      dc exec -T db psql -U "$DBU" -d "$DBN" -q -f - < "$m" >/dev/null 2>&1 || true
    done
    dc exec -T db psql -U "$DBU" -d "$DBN" -tAc "SELECT to_regclass('public.$t') IS NOT NULL;" \
      | grep -q t && ok "table $t created" || die "could not create $t - check server/migrations/"
  fi
done

ROWS="$(dc exec -T db psql -U "$DBU" -d "$DBN" -tAc \
  "SELECT (SELECT count(*) FROM patients) || ' patients, ' || (SELECT count(*) FROM charges) || ' charges, ' || (SELECT count(*) FROM users) || ' users';" | tr -d '\r')"
ok "data: $ROWS"

# ---------------------------------------------------------------- 6. what is left
bold "Done. Three steps remain, and they are in the CloudPanel web interface:"
cat <<EOF

  1. Sites -> Add Site -> Create a Reverse Proxy
       Domain Name        $DOMAIN
       Reverse Proxy URL  http://127.0.0.1:8080
     Then Site -> Domains -> add the bare domain too.

  2. Site -> SSL/TLS -> Let's Encrypt, with BOTH names ticked.

  3. Site -> Vhost: paste these six lines inside the 'location /' block,
     then run:  nginx -t && systemctl reload nginx

       proxy_http_version 1.1;
       proxy_set_header Connection "";
       proxy_buffering off;
       proxy_cache off;
       proxy_read_timeout 24h;
       client_max_body_size 25m;

     Without them the live data feed is buffered (the app loads, then never
     updates) and the trusted-device cookie is not marked Secure.

  Firewall: allow 22, 80, 443, 8443 only. Never 8080 - it is loopback-bound
  on purpose, and opening it would bypass TLS.

  First sign-in: every account is sent through authenticator enrolment
  (MFA_ENFORCEMENT=all). Staff need their phones, and the ten backup codes
  are shown once.

EOF
