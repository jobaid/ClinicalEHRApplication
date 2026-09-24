# Deployment

How to update this application on the live server without losing data.

The guarantee this document is built around: **a deployment updates application code only.** The
database, the uploaded documents and the production configuration all live outside Git and are
never touched by `git pull`.

---

## What lives where

| Thing | Where it lives | Touched by a deploy? |
|---|---|---|
| Application code | Git | Yes — that is the point |
| PostgreSQL data | Docker volume `db-data` | No |
| Uploaded ID documents, insurance cards, signatures | **Inside PostgreSQL** (see below) | No |
| Backup files | Docker volume `backup-data` | No |
| Production secrets | `.env.docker` on the server, gitignored | No |
| Dev JWT secret | `server/dev-jwt-secret`, gitignored, never on the server | No |

### Uploads are in the database, not on disk

This application stores scanned documents as base64 data URLs in PostgreSQL columns —
`id_documents.data`, `insurance_policies.card_front` / `card_back`, and physician signatures.
There is no uploads directory.

That is worth knowing for two reasons. `git pull`, `npm install` and `npm run build` cannot
delete a patient's ID scan, because none of them write to the database. And a `pg_dump` backup is
a complete backup — there is no second location to remember.

---

## Normal update

Everything below runs on the server, from the directory containing `docker-compose.yml`.

```bash
ssh root@34.85.203.81
ls -d /opt/medbill /opt/medbill/*/ 2>/dev/null | head
cd <the directory that printed>
```

### 1. Record the current state

Take these numbers now and compare them at the end. This is how you detect data loss rather than
hope it did not happen.

```bash
docker compose --env-file .env.docker exec -T db psql -U medbill -d medbill -c "
SELECT 'users' t, count(*) FROM users
UNION ALL SELECT 'patients',     count(*) FROM patients
UNION ALL SELECT 'charges',      count(*) FROM charges
UNION ALL SELECT 'claims',       count(*) FROM claims
UNION ALL SELECT 'transactions', count(*) FROM transactions
UNION ALL SELECT 'insurance_policies', count(*) FROM insurance_policies
UNION ALL SELECT 'appointments', count(*) FROM appointments
UNION ALL SELECT 'patient_memos', count(*) FROM patient_memos
UNION ALL SELECT 'batches',      count(*) FROM batches
UNION ALL SELECT 'id_documents', count(*) FROM id_documents
UNION ALL SELECT 'audit_logs',   count(*) FROM audit_logs
ORDER BY 1;"
```

### 2. Back up, and verify the backup

```bash
STAMP=$(date +%Y%m%d-%H%M)
docker compose --env-file .env.docker exec -T db \
  pg_dump -U medbill -d medbill --format=custom --no-owner --no-privileges \
  > /root/pre-deploy-$STAMP.dump

ls -lh /root/pre-deploy-$STAMP.dump
```

**If that file is missing or under ~50 KB, stop.** Do not deploy without a backup you have seen
the size of. A backup command that silently failed is worse than no backup, because you will
proceed believing you have one.

### 3. Pull the code

```bash
git status          # should be clean; local edits here mean someone patched production by hand
git pull
git log --oneline -1
```

### 4. Rebuild and restart

```bash
docker compose --env-file .env.docker up -d --build
```

`--build` is required whenever the frontend or the Go code changed — the React bundle is compiled
into the web image, so without it you pull new code and keep serving the old app.

**Never add `-v`.** `docker compose down -v` deletes the volumes, and that is the one command in
this document that would destroy the database. Plain `down` and `stop` are safe.

### 5. Migrations

There is nothing to run by hand. The server applies its own additive schema at startup
(`ensureBackupSchema`, `ensureDemoSchema`), and those files are written to be idempotent —
`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `INSERT ... ON CONFLICT DO NOTHING`.

No migration in this project drops, truncates or deletes. If you ever add one that does, it does
not belong in the startup path.

### 6. Health checks

```bash
docker compose --env-file .env.docker ps
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/api/health     # want 200
docker compose --env-file .env.docker logs --tail 40 api
```

### 7. Verify nothing was lost

Re-run the counts from step 1. **They must match, except where you expect a change** — a new
release that adds the demo account raises `users` by exactly one.

If a count dropped, stop and restore from step 2's backup before anyone writes more data on top
of the damage.

Then check by hand:

- Sign in as a real user. MFA still required.
- Open a patient chart. Demographics, insurance, claims, payments all present.
- Open an uploaded ID document. It renders.
- Run the Aging Report and the Daily Transaction Report.

---

## Rollback

Rolling back code does **not** mean rolling back the database. Restoring an old dump would throw
away every payment posted since it was taken.

```bash
git log --oneline -5
git checkout <previous-commit-sha>
docker compose --env-file .env.docker up -d --build
```

The database keeps running forward with the data it has. Because every migration in this project
is additive, older code simply ignores columns it does not know about.

Restoring the database is a **separate, deliberate** operation, and only for actual data
corruption:

```bash
docker compose --env-file .env.docker cp /root/pre-deploy-<stamp>.dump db:/tmp/restore.dump
docker compose --env-file .env.docker exec -T db \
  pg_restore -U medbill -d medbill --clean --if-exists --no-owner --no-privileges \
  --single-transaction /tmp/restore.dump
```

Everything written after that dump was taken is gone. Be sure.

---

## If the server directory is not a Git repository

Do **not** run `git init` over it, and do not delete it. Work out what is there first:

```bash
pwd; ls -la
cat docker-compose.yml | head -30      # where the app reads its config
docker volume ls                        # where the data is
ls -la .env.docker                      # the production secrets
git remote -v 2>/dev/null || echo "not a git repo"
```

Then attach it to the repository without replacing any of it:

```bash
cp .env.docker /root/.env.docker.backup     # the one file Git must not overwrite
git init
git remote add origin https://github.com/jobaid/ClinicalEHRApplication.git
git fetch origin
git checkout -f -t origin/main              # overwrites TRACKED files only
cp /root/.env.docker.backup .env.docker     # restore, in case it was ever committed historically
chmod 600 .env.docker
```

`git checkout -f` replaces files Git tracks. `.env.docker` is gitignored, the database is in a
Docker volume, and uploads are inside the database — so none of them are in Git's reach. The
backup copy is belt and braces.

---

## Production secrets

`.env.docker` lives on the server and is gitignored. It holds `POSTGRES_PASSWORD`, `JWT_SECRET`,
`CORS_ORIGINS`, and the demo account settings. Git contains `.env.docker.example` with the same
keys and no values.

Never commit it. Never paste it into a chat window. `chmod 600 .env.docker`.

Rotating `JWT_SECRET` signs everyone out **and** makes every stored MFA secret undecryptable,
because the MFA encryption key is derived from it. If you rotate it, expect every enrolled user
to re-enrol.

---

## The demonstration account

### What it is

One ordinary account in the `users` table, role `MANAGER`, marked `is_demo = true`. Its password
is printed on the login page, and it is the **only** account exempt from authenticator
verification.

It is off by default. Setting both variables in `.env.docker` turns it on:

```
DEMO_USER_EMAIL=demo.manager@2set.com
DEMO_USER_PASSWORD=<at least 12 characters>
DEMO_USER_NAME=Manager Demo
```

Leave them blank and no demo account exists — the panel never renders.

### How the exemption is contained

The sign-in path reads `users.is_demo` from the database on every login, alongside the password
hash. It is not a check on the username, not a client-side flag, and not a global switch.

`is_demo` is deliberately absent from the `users` collection in `server/schema.go`, so **no
request to `/api/collections/users` can set it**. Only the migration and the startup seeder can.
A signed-in user cannot flag their own account and thereby skip MFA.

The demo account is additionally refused: changing its own password, enrolling an authenticator,
and disabling MFA — because a visitor who changed the published password would lock out everyone
after them.

### It cannot overwrite a real user

If `DEMO_USER_EMAIL` names an address that already belongs to a non-demo account, the seeder
refuses, changes nothing, and logs:

```
demo: REFUSING to touch <address> - that address belongs to an existing non-demo account.
```

The `/api/auth/demo` endpoint then reports `{"enabled": false}`, so the login page never shows a
password next to a real user's email.

### Before you enable it on real data

The demo account holds the **Manager** role, which can read patient charts, claims and payments.
Anyone on the internet can sign in with credentials printed on your login page.

Only enable it on a database whose contents you are willing to publish. If this deployment holds
real patient information — names, dates of birth, insurance IDs, claims — do not enable it.
Stand up a separate instance with synthetic data instead.

---

## Never in a deployment

```
docker compose down -v          deletes the database volume
DROP DATABASE / DROP TABLE      no migration here does this
TRUNCATE / DELETE FROM users    no migration here does this
npm run seed                    no such script; seeding is for empty databases only
```

If a future deployment step wants any of these, it is not a deployment step.
