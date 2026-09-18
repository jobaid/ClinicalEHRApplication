# Deploying to CloudPanel

This runs the whole stack — PostgreSQL, the Go API and the built frontend — as three containers,
published on **one loopback port**, with CloudPanel's nginx in front of it as the only thing the
internet can reach.

**Est. 30 minutes.** You need a VPS with CloudPanel installed and SSH root access.

---

## The domain question

### If you own a domain (the normal case)

Point it at the server before anything else — Let's Encrypt validates over DNS reaching the box,
so nothing below works until this does. At your registrar create two A records:

| Type | Name  | Value            |
|------|-------|------------------|
| A    | `@`   | your server IPv4 |
| A    | `www` | your server IPv4 |

Remove any stale `AAAA` record left pointing somewhere else, or IPv6 clients (and Let's Encrypt
over IPv6) reach the wrong machine while IPv4 clients reach the right one — a failure that looks
intermittent and wastes hours.

Verify, and wait until it answers correctly before continuing:

```bash
nslookup -type=A www.example.com     # must return your server IP
```

Then set **both** forms in `CORS_ORIGINS`, comma-separated:

```ini
CORS_ORIGINS=https://www.example.com,https://example.com
```

The API matches origins exactly. List only one and a visitor arriving on the other signs in
successfully and then has every request rejected — a confusing failure worth avoiding up front.

In CloudPanel use the `www` form as the site's Domain Name, then add the bare domain under
**Site → Domains**, and tick both when issuing the certificate.

### If you do not own one

CloudPanel requires a **hostname** for every site. It does not require a *purchased* one.

Use [nip.io](https://nip.io), a free wildcard DNS service: `203.0.113.10.nip.io` resolves to
`203.0.113.10` with no registration and no DNS records to create. It costs nothing, works
immediately, and — unlike a bare IP address — lets you issue a real Let's Encrypt certificate.

Throughout this document replace `203.0.113.10` with your server's actual IP.

> **This application stores PHI**: patient names, dates of birth, SSNs and insurance IDs. Over
> plain HTTP all of it, plus the session token, crosses the internet in clear text. TLS is not
> optional polish here, which is why this route is worth the extra ten minutes over
> `http://<ip>:8080`.

---

## 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
docker compose version    # confirm the plugin came with it
```

Docker coexists with CloudPanel fine — CloudPanel owns ports 80/443 and 8443, and nothing here
binds those.

## 2. Get the code

```bash
sudo mkdir -p /opt/medbill && cd /opt/medbill
sudo git clone <your-repository-url> .
cp .env.docker.example .env.docker
```

## 3. Configure

Generate the secrets — do not invent them by hand:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -base64 32)"
echo "JWT_SECRET=$(openssl rand -base64 48)"
echo "BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -base64 24)"
```

Put those into `.env.docker` along with:

```ini
CORS_ORIGINS=https://www.example.com,https://example.com
WEB_PORT=127.0.0.1:8080
BOOTSTRAP_ADMIN_EMAIL=you@example.com
MFA_ENFORCEMENT=all
```

Two of those lines matter more than they look:

- **`WEB_PORT=127.0.0.1:8080`** binds the stack to loopback, so it is reachable *only* through
  CloudPanel's nginx and never directly from the internet. Postgres and the API publish no ports
  at all.
- **`BOOTSTRAP_ADMIN_EMAIL` / `..._PASSWORD`** create your first administrator. A new database has
  no accounts, and creating one requires being signed in as a SUPER_ADMIN already — so without
  these there is no way into a fresh install. They are ignored once any account exists.
  *Skip both if you are restoring a database dump in step 6; it already has your accounts.*
- **`MFA_ENFORCEMENT=all`** is the default and means every account must set up an authenticator
  app. Nobody is locked out: an account that has not enrolled is sent to the QR enrolment screen
  on its next sign-in rather than refused. Plan for it anyway — every user needs their phone the
  first time they sign in after the switch. `MFA_ENFORCEMENT=none` turns the requirement off
  without deleting anyone's enrolment, as a rollout safety valve.

`.env.docker` is gitignored. Keep it that way.

## 4. Start it

```bash
cd /opt/medbill
docker compose --env-file .env.docker up -d --build
docker compose logs -f api        # watch for "medbill API listening"
curl -I http://127.0.0.1:8080     # expect: HTTP/1.1 200 OK
```

The first build takes a few minutes. The database schema is created automatically on first start —
Postgres runs everything in `server/migrations/` when its data directory is empty.

> Migrations run **only** on that first start. A migration added later must be applied by hand:
> `docker compose exec -T db psql -U medbill -d medbill < server/migrations/00X_whatever.sql`

## 5. Create the CloudPanel site

In CloudPanel (`https://203.0.113.10:8443`) → **Sites → Add Site → Create a Reverse Proxy**:

| Field | Value |
|---|---|
| Domain Name | `203.0.113.10.nip.io` |
| Reverse Proxy URL | `http://127.0.0.1:8080` |
| Site User | anything you like |

Then **Site → SSL/TLS → Let's Encrypt → Issue**. nip.io hostnames pass the HTTP-01 challenge.

### Then fix the vhost — do not skip this

Go to **Site → Vhost** and replace CloudPanel's generated `location / { ... }` block with the two
blocks from [`cloudpanel-vhost.conf`](cloudpanel-vhost.conf) in this directory. Leave everything
else CloudPanel wrote alone.

CloudPanel's default config **buffers** proxied responses. `GET /api/stream` is a Server-Sent
Events feed held open for the whole session — it is what replaced Firestore's `onSnapshot`. With
buffering on, the app loads, shows correct data once, and then silently never updates again. It
looks like the app is broken rather than the proxy.

Validate and reload:

```bash
nginx -t && systemctl reload nginx
```

## 6. Your data

**Restoring your existing database** (recommended — it brings your accounts with it):

```bash
# on your Windows machine
./tools/pgsql/bin/pg_dump.exe -h 127.0.0.1 -p 5433 -U postgres -d medbill \
    -Fc --no-owner -f medbill.dump
scp medbill.dump root@203.0.113.10:/opt/medbill/

# on the server
cd /opt/medbill
docker compose cp medbill.dump db:/tmp/medbill.dump
docker compose exec db pg_restore -U medbill -d medbill \
    --clean --if-exists --no-owner /tmp/medbill.dump
docker compose exec db rm /tmp/medbill.dump
```

**Starting empty:** nothing to do — the bootstrap admin from step 3 is your way in.

### Check the MFA tables survived the restore

`pg_restore --clean` drops and recreates only what is *in the dump*. A dump taken from a database
that predates `006_mfa.sql` therefore leaves `user_mfa` and `trusted_devices` alone — they were
created by the migrations in step 4 and stay empty, which is correct. Confirm rather than assume:

```bash
docker compose exec db psql -U medbill -d medbill -c "\dt user_mfa|trusted_devices"
```

If they are missing, the migration did not run (the data directory was not empty on first start).
Apply it by hand:

```bash
docker compose exec -T db psql -U medbill -d medbill < server/migrations/006_mfa.sql
```

Without those tables every sign-in fails at the enrolment step, and the message will not tell you
why.

## 6b. First sign-in with two-step verification

Because `MFA_ENFORCEMENT=all`, the first sign-in for **every** account goes:

```
email + password  ->  QR code  ->  scan with an authenticator app  ->  6-digit code
                  ->  10 backup codes shown ONCE  ->  the application
```

Tell your staff to have their phones with them, and to save the backup codes somewhere — a lost
phone with no backup codes left means an administrator has to reset the account.

"Trust this device for 30 days" on that screen skips the code on that browser next time. It relies
on an httpOnly cookie marked `Secure` whenever the request arrived over TLS, which the API decides
from the `X-Forwarded-Proto` header. The supplied vhost sets that header — another reason not to
skip step 5.

## 7. Firewall

In CloudPanel → **Security → Firewall**, allow only:

| Port | Why |
|---|---|
| 22 | SSH |
| 80 | HTTP (Let's Encrypt renewals, redirect to HTTPS) |
| 443 | HTTPS — the application |
| 8443 | CloudPanel admin — restrict to your own IP if you can |

**Do not open 8080.** It is loopback-bound and opening it would bypass TLS entirely.

## 8. First sign-in

Open `https://203.0.113.10.nip.io`, sign in with the bootstrap credentials, and immediately:

1. Change that password from the UI.
2. Remove `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` from `.env.docker`.
3. `docker compose --env-file .env.docker up -d` to apply.

Leaving them set opens no back door — the server refuses to act on them once an account exists,
and logs that it skipped them — but there is no reason for the password to keep living in a file.

---

## Operating it

```bash
cd /opt/medbill

docker compose logs -f api            # API logs
docker compose ps                     # what is running
docker compose restart api            # restart just the API
docker compose --env-file .env.docker up -d --build   # deploy a new version
```

**Back up the database.** Nothing here does it for you:

```bash
docker compose exec -T db pg_dump -U medbill -d medbill -Fc > /opt/backups/medbill-$(date +%F).dump
```

Put that in cron and keep the backups off this server.

---

## When something is wrong

| Symptom | Cause |
|---|---|
| Data loads once, then never updates | The vhost fix in step 5 was not applied, or nginx was not reloaded |
| 502 Bad Gateway | The stack is down — `docker compose ps`, then `docker compose logs api` |
| Cannot sign in on a fresh install | No bootstrap credentials were set, and the database is empty |
| API exits immediately at startup | A required variable is missing. Under `APP_ENV=production` the server refuses to start without `DATABASE_URL`, `JWT_SECRET` and `CORS_ORIGINS` rather than fall back to development defaults |
| Login works, then every request fails | `CORS_ORIGINS` does not exactly match the URL in the browser — scheme included |
| Uploading an ID photo fails | `client_max_body_size` — it is set to 25m in the supplied vhost |

---

## What has and has not been tested

Verified on a development machine:

- all five migrations apply cleanly to an empty database, producing 25 tables
- the bootstrap admin is created on an empty database and can sign in as SUPER_ADMIN
- the bootstrap refuses once any account exists, and a second, different credential offered to it
  is rejected at login — it cannot be used to add an administrator to a running system
- `go vet` and `go build` pass

**Not tested:** the Docker images have never been built — there is no Docker on the development
machine. The Dockerfiles have been checked by reading (Go version matches `go.mod`, `ADDR` and
`VITE_API_BASE` are genuinely read by the code, nginx's document root matches Vite's output
directory, secrets are excluded from both build contexts), but the first `docker compose build` is
the first real proof. Run it locally before you run it on the server — the errors are cheaper to
fix there. The nginx snippet has likewise not been run through `nginx -t`; step 5 does that.
