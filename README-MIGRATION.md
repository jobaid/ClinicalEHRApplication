# Backend migration: Firebase → Go + PostgreSQL

The React/Vite frontend is unchanged. Only the backend was replaced.

```
BEFORE   React/Vite ──▶ Firebase Auth + Cloud Firestore
AFTER    React/Vite ──▶ Go REST API ──▶ PostgreSQL
```

**`src/app.jsx` was not modified by this migration.** The whole app talked to Firebase through
13 functions in two files (`src/firebase/authService.js`, `src/firebase/firestoreService.js`).
Those two files were reimplemented against the Go API with identical signatures, so every screen,
form, calculation and workflow above them is untouched.

The original Firebase implementations are preserved in `src/firebase/_legacy-firebase/`.
**The Firestore project was not deleted** — the migration only read from it.

---

## Running it

Easiest: double-click **`start-app.cmd`**, or run it from a terminal. It starts all three tiers
and opens a window for the API and the frontend.

Manually, it is three processes in this order — PostgreSQL and the API must be up before the
frontend:

```bash
npm run db:start     # PostgreSQL on 5433 (background; returns once it accepts connections)
npm run api          # Go API on 8080     (own terminal)
npm run dev          # frontend on 5173   (own terminal)
```

Then open <http://localhost:5173>.

| Script | What it does |
|---|---|
| `npm run db:start` / `db:stop` / `db:status` | control the local PostgreSQL cluster |
| `npm run db:psql` | psql shell into the `medbill` database |
| `npm run api` | run the prebuilt API binary |
| `npm run api:build` | rebuild `server/medbill-server.exe` after Go changes |
| `npm run api:test` | Go test suite |

Sign in with any seeded account, e.g. `admin@medbill.local` / `Admin@12345` (Super Admin),
`manager@medbill.local` / `Manager@12345`, `biller@medbill.local` / `Biller@12345`.

### If login says "Invalid email or password" for every account

That message is what the login screen shows for *any* failure, including one where the request
never reached the API. Check the browser console first — the API client now prints the real
reason there.

The usual causes are that the API is not running (`npm run api`) or that the page was opened on
an origin the API rejects. Vite prints two URLs for the same server, Local and Network; both are
accepted now, as is `npm run preview` on 4173.

Note the npm scripts call the portable toolchain in `tools/` directly — `go` and `psql` are not
on your PATH, so a bare `go run .` will not work.

Go 1.27 and PostgreSQL 17.6 are installed **user-scope** under `tools/` — nothing was installed
system-wide and no admin rights were used. Delete `tools/` to remove them.

### Configuration

| Variable | Default | Used by |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:medbill_dev_pw@127.0.0.1:5433/medbill` | API |
| `ADDR` | `:8080` | API |
| `JWT_SECRET` | dev placeholder — **change for production** | API |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | API |
| `ALLOW_LOCAL_ORIGINS` | `true` — also accept any loopback/LAN origin; set `false` in production | API |
| `FIREBASE_HASH_CONFIG` | `server/firebase-hash-config.json` | API |
| `VITE_API_BASE` | `http://localhost:8080` | frontend |

---

## What the API looks like

The endpoints mirror the document operations the app already performed.

| Endpoint | Replaces |
|---|---|
| `POST /api/auth/login` | `signInWithEmailAndPassword` |
| `GET /api/auth/me` | `onAuthStateChanged` |
| `POST /api/auth/users` | `createUserWithEmailAndPassword` |
| `GET /api/collections/{name}` | `onSnapshot(collection)` |
| `PUT /api/collections/{name}/{id}` | `setDoc` |
| `PATCH /api/collections/{name}/{id}` | `updateDoc` |
| `POST /api/collections/{name}` | `addDoc` |
| `DELETE /api/collections/{name}/{id}` | `deleteDoc` |
| `POST /api/batch` | `writeBatch` (one SQL transaction) |
| `GET /api/stream` | the live half of `onSnapshot` |

### Live updates

Firestore pushed changes to every listening client, which is why the app never merges local state
after a write. That behaviour is preserved with a Server-Sent Events change feed: the API pushes
the name of any collection that changed and the client refetches just that collection. One
connection is shared by all 22 collections. Verified working across clients — a write from a
second session appears in the browser with no reload.

### Passwords

Existing accounts keep their existing passwords. Firebase's scrypt variant is reimplemented in
`server/firebasescrypt.go` and the per-user hashes were migrated as-is.
`server/firebasescrypt_test.go` verified this against the real exported hashes at migration time;
now that the export has been deleted it skips automatically. Accounts created from now on use
bcrypt; the `users.password_algo` column records which applies per account.

### Authorization

`server/auth.go` reimplements what `firestore.rules` used to enforce — same role names, same
collection groupings, so nobody gained or lost access in the migration. (That rules file has since
been deleted; `server/auth.go` is now the only definition of these permissions.) Reads stay open to any signed-in user (the app loads whole
collections and filters client-side, as before); writes are restricted by role. Password columns
are outside the collection registry and can never be read through the API.

---

## The database

22 tables, one per former Firestore collection — see `server/migrations/001_init.sql`.

Three deliberate choices, all made to avoid changing behaviour:

1. **Date-like fields are `TEXT`, not `DATE`.** The app compares dates as ISO strings
   (`t.date >= fromDate`) and uses `""` for an absent date. `DATE` would turn `""` into `NULL`
   and change every one of those comparisons.
2. **Every table has an `extra JSONB` catch-all.** Any field not mapped to a column round-trips
   through it, so no field can be silently dropped.
3. **Nested structures stay JSONB** (`charges.postings`, `patients.guarantor`,
   `insurance_policies.field_history`, …). The frontend treats them as opaque.

`server/schema.go` is the single source of truth mapping collections/fields to tables/columns.
The importer uses the same registry as the live API, so the two cannot drift apart.

---

## Re-running the migration

The migration is complete and the exported snapshot has since been deleted, along with the
Firebase service-account key. To run it again you would need to restore a service-account
credential first, then:

```bash
npm run db:export      # Firestore -> migration-export/*.json  (READ-ONLY)
npm run db:migrate     # migration-export/ -> PostgreSQL, then verifies
```

The export doubles as a point-in-time backup. The import re-reads every row afterwards and
compares it field by field against the source, and fails loudly on any mismatch.

`server/firebase-hash-config.json` is the one piece of the export still required at runtime -
it holds the scrypt parameters that verify migrated passwords. Do not delete it.

---

## Verification results

**Data migration — 1,618 documents / 14,573 fields, every field round-tripped intact.**

| Collection | Docs | | Collection | Docs |
|---|---:|---|---|---:|
| patients | 122 | | auditLogs | 528 |
| charges | 89 | | loginAudit | 592 |
| transactions | 94 | | ticklers | 68 |
| claims | 10 | | supportTickets | 25 |
| insurancePolicies | 8 | | batches | 10 |
| appointments | 6 | | users | 6 |
| cptCatalog | 6 | | patientMemos | 6 |
| idDocuments | 2 | | vitals / allergies / medications / problems | 11/9/9/9 |
| clinicalNotes | 8 | | credit balances | 0 |

**Business-logic parity — computed with the app's own formulas from both backends:**

| Metric | Firestore | PostgreSQL |
|---|---:|---:|
| Total charged | 4666 | 4666 |
| Total paid | 416 | 416 |
| Total adjusted | 416 | 416 |
| Outstanding balance | 4250 | 4250 |
| Open charges | 86 | 86 |
| Transactions total | 5082 | 5082 |
| Postings preserved | 5 | 5 |
| Claims by status | 7 Submitted / 1 Denied / 2 Paid | identical |

**Feature checklist — driven through the real UI:**

| Feature | Before | After | Status |
|---|---|---|---|
| Login (existing password) | Working | Working | PASS |
| Bad password rejected | Working | Working | PASS |
| Session persists on reload | Working | Working | PASS |
| Dashboard | Working | Working | PASS |
| All 7 nav menus | Working | Working | PASS |
| Patient management (122 rows) | Working | Working | PASS |
| Patient search | Working | Working | PASS |
| Demography / Insurance / Memo / Appointment / Claim tabs | Working | Working | PASS |
| Billing | Working | Working | PASS |
| Claims | Working | Working | PASS |
| Reports — Overview charts | Working | Working | PASS |
| Reports — Aging / Debit / Credit | Working | Working | PASS |
| Reports — CSV export | Working | Working | PASS |
| Daily Transaction report | Working | Working | PASS |
| Batch open / close | Working | Working | PASS |
| Historical batches (10) | Working | Working | PASS |
| Tickler / reminders (68) | Working | Working | PASS |
| Support tickets (25) | Working | Working | PASS |
| Atomic multi-doc writes | Working | Working | PASS |
| Balance calculations | Working | Working | PASS |
| Nested postings / memos / dx codes | Working | Working | PASS |
| Manager permissions | Working | Working | PASS |
| Nurse permissions | Working | Working | PASS |
| Receptionist permissions | Working | Working | PASS |
| Biller permissions | Working | Working | PASS |
| Live cross-client updates | Working | Working | PASS |
| Console errors | none | none | PASS |

---

## Before production

- Set a real `JWT_SECRET`.
- Move `DATABASE_URL` credentials out of the default.
- **Rotate the Firebase service-account key.** The file
  `billing-c445b-firebase-adminsdk-fbsvc-*.json` has been deleted from the working tree, but
  deleting the file does not revoke the credential, and it may still exist in git history.
  Revoke it in the Google Cloud console.
- The old Firebase config (`firebase.json`, `.firebaserc`, `firestore.rules`,
  `firestore.indexes.json`) has been removed. The authorization rules it described are
  reimplemented in `server/auth.go`.
- `scripts/exportFirestore.mjs` and `scripts/seedFirestore.mjs` still target Firebase and cannot
  run without a restored service-account key. The `firebase` and `firebase-admin` npm packages
  are no longer used by the application itself.
