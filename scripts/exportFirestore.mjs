// Step 1 of the Firestore -> PostgreSQL migration: export everything to JSON on disk.
//
// This is strictly READ-ONLY against Firebase. Nothing in the Firestore project is modified or
// deleted, and the exported files double as a point-in-time backup you can keep or re-run from.
//
// Produces, under migration-export/:
//   <collection>.json          every document, as { id, ...data }
//   _users-auth.json           uid, email and the scrypt password hash/salt for each account
//   _hash-config.json          the project's scrypt parameters, so the Go API can verify
//                              existing passwords without forcing anyone to reset
//   _manifest.json             per-collection document counts, used to verify the import
//
// Usage: node scripts/exportFirestore.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outDir = path.join(root, "migration-export");

const COLLECTIONS = [
  "users", "loginAudit", "auditLogs",
  "patients", "appointments", "patientMemos", "idDocuments",
  "insurancePolicies", "cptCatalog", "charges", "claims", "transactions", "batches",
  "patientCreditBalances", "insuranceCreditBalances",
  "vitals", "allergies", "medications", "problems", "clinicalNotes",
  "ticklers", "supportTickets",
];

function loadDotEnv() {
  const p = path.join(root, ".env");
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq !== -1) out[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
  }
  return out;
}

const envVars = loadDotEnv();
const keyPath = path.isAbsolute(envVars.GOOGLE_APPLICATION_CREDENTIALS || "")
  ? envVars.GOOGLE_APPLICATION_CREDENTIALS
  : path.join(root, envVars.GOOGLE_APPLICATION_CREDENTIALS || "billing-c445b-firebase-adminsdk-fbsvc-c7ccf0b3ef.json");

const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
const app = initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);

mkdirSync(outDir, { recursive: true });

// Firestore Timestamps have no JSON form. This app stores every date as an ISO string already,
// so a Timestamp would be unexpected - convert defensively rather than silently emit "{}".
function normalise(v) {
  if (v === null || v === undefined) return v;
  if (typeof v?.toDate === "function") return v.toDate().toISOString().slice(0, 19);
  if (Array.isArray(v)) return v.map(normalise);
  if (typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalise(x)]));
  }
  return v;
}

const manifest = { exportedAt: new Date().toISOString(), collections: {} };

console.log("Exporting Firestore (read-only)\n");
for (const name of COLLECTIONS) {
  const snap = await db.collection(name).get();
  const docs = snap.docs.map((d) => ({ id: d.id, ...normalise(d.data()) }));
  writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(docs, null, 2));
  manifest.collections[name] = docs.length;
  console.log(`  ${name.padEnd(26)} ${String(docs.length).padStart(5)} docs`);
}

// ---- Auth accounts, including password material ----
const auth = getAuth(app);
const authUsers = [];
let pageToken;
do {
  const page = await auth.listUsers(1000, pageToken);
  for (const u of page.users) {
    authUsers.push({
      uid: u.uid,
      email: u.email || "",
      disabled: !!u.disabled,
      displayName: u.displayName || "",
      passwordHash: u.passwordHash || null,
      passwordSalt: u.passwordSalt || null,
      createdAt: u.metadata.creationTime,
    });
  }
  pageToken = page.pageToken;
} while (pageToken);

writeFileSync(path.join(outDir, "_users-auth.json"), JSON.stringify(authUsers, null, 2));
const withHash = authUsers.filter((u) => u.passwordHash).length;
console.log(`\n  auth accounts              ${String(authUsers.length).padStart(5)} (${withHash} with a password hash)`);

// ---- Project scrypt parameters ----
// Needed to verify those hashes in Go. Comes from the Identity Toolkit admin config, which the
// service account can read directly.
let hashConfig = null;
try {
  const token = await app.options.credential.getAccessToken();
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/admin/v2/projects/${serviceAccount.project_id}/config`,
    { headers: { Authorization: `Bearer ${token.access_token}` } }
  );
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const cfg = await res.json();
  const h = cfg?.signIn?.hashConfig;
  if (h) {
    hashConfig = {
      signerKey: h.signerKey,
      saltSeparator: h.saltSeparator,
      rounds: Number(h.rounds),
      memoryCost: Number(h.memoryCost),
      algorithm: h.algorithm,
    };
    console.log(`  hash config                algorithm=${h.algorithm} rounds=${h.rounds} memoryCost=${h.memoryCost}`);
  } else {
    console.log("  hash config                NOT RETURNED by the admin API");
  }
} catch (err) {
  console.log(`  hash config                FAILED: ${err.message}`);
}
writeFileSync(path.join(outDir, "_hash-config.json"), JSON.stringify(hashConfig, null, 2));

manifest.authUsers = authUsers.length;
writeFileSync(path.join(outDir, "_manifest.json"), JSON.stringify(manifest, null, 2));

const total = Object.values(manifest.collections).reduce((a, b) => a + b, 0);
console.log(`\nExported ${total} documents to migration-export/`);
console.log("Firestore was not modified.");
process.exit(0);
