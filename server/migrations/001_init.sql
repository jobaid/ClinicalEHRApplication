-- Medical Billing - PostgreSQL schema
-- Migrated from Firestore (project billing-c445b). One table per former Firestore collection.
--
-- DESIGN NOTES (deliberate, to guarantee zero business-logic regression):
--
-- 1. Date-like fields are TEXT, not DATE. The React app compares dates as ISO strings
--    (t.date >= fromDate) and uses '' for an absent date. Storing them as DATE would turn ''
--    into NULL and change every one of those comparisons. TEXT reproduces today's behaviour
--    exactly, and no date arithmetic is ever done in SQL.
--
-- 2. Every table carries an `extra` JSONB catch-all. Any field the app writes that is not an
--    explicit column round-trips through it untouched, so no unmapped or future field can be
--    silently dropped. The API merges `extra` over the typed columns on read.
--
-- 3. Nested objects/arrays (charge.postings, patient.guarantor, policy.fieldHistory, ...) are
--    JSONB. The frontend treats them as opaque structures, so preserving them verbatim is both
--    the safest and the simplest option.
--
-- 4. Money is NUMERIC(14,2) and the API emits it as a JSON number, so arithmetic in the app is
--    unchanged. Firestore stored these as IEEE doubles.

BEGIN;

-- ---------- Identity ----------

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL,
  disabled      BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    TEXT,
  created_at    TEXT,
  password_algo TEXT NOT NULL DEFAULT 'firebase-scrypt',
  password_hash TEXT,
  password_salt TEXT,
  extra         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS login_audit (
  id        TEXT PRIMARY KEY,
  "user"    TEXT NOT NULL DEFAULT '',
  role      TEXT NOT NULL DEFAULT '',
  action    TEXT NOT NULL DEFAULT '',
  timestamp TEXT NOT NULL DEFAULT '',
  extra     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT,
  "user"      TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL DEFAULT '',
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id   TEXT,
  old_values  TEXT,
  new_values  TEXT,
  timestamp   TEXT NOT NULL DEFAULT '',
  extra       JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ---------- Patients and front desk ----------

CREATE TABLE IF NOT EXISTS patients (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL DEFAULT '',
  dob               TEXT NOT NULL DEFAULT '',
  phone             TEXT NOT NULL DEFAULT '',
  email             TEXT NOT NULL DEFAULT '',
  ssn               TEXT NOT NULL DEFAULT '',
  address           TEXT NOT NULL DEFAULT '',
  city              TEXT NOT NULL DEFAULT '',
  state             TEXT NOT NULL DEFAULT '',
  zip               TEXT NOT NULL DEFAULT '',
  emergency_contact JSONB NOT NULL DEFAULT '{}'::jsonb,
  guarantor         JSONB NOT NULL DEFAULT '{}'::jsonb,
  extra             JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS appointments (
  id         TEXT PRIMARY KEY,
  patient_id TEXT,
  date       TEXT NOT NULL DEFAULT '',
  time       TEXT NOT NULL DEFAULT '',
  provider   TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT '',
  cpt        TEXT NOT NULL DEFAULT '',
  extra      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS patient_memos (
  id         TEXT PRIMARY KEY,
  patient_id TEXT,
  text       TEXT NOT NULL DEFAULT '',
  "user"     TEXT NOT NULL DEFAULT '',
  date       TEXT NOT NULL DEFAULT '',
  extra      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS id_documents (
  id              TEXT PRIMARY KEY,
  patient_id      TEXT,
  id_type         TEXT NOT NULL DEFAULT '',
  id_number       TEXT NOT NULL DEFAULT '',
  issuing_state   TEXT NOT NULL DEFAULT '',
  issue_date      TEXT NOT NULL DEFAULT '',
  expiration_date TEXT NOT NULL DEFAULT '',
  file            TEXT NOT NULL DEFAULT '',
  file_name       TEXT NOT NULL DEFAULT '',
  file_type       TEXT NOT NULL DEFAULT '',
  file_size       BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT '',
  uploaded_by     TEXT NOT NULL DEFAULT '',
  uploaded_at     TEXT NOT NULL DEFAULT '',
  extra           JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ---------- Insurance ----------

CREATE TABLE IF NOT EXISTS insurance_policies (
  id                      TEXT PRIMARY KEY,
  patient_id              TEXT,
  insurance_company       TEXT NOT NULL DEFAULT '',
  plan_name               TEXT NOT NULL DEFAULT '',
  insurance_type          TEXT NOT NULL DEFAULT '',
  member_id               TEXT NOT NULL DEFAULT '',
  subscriber_id           TEXT NOT NULL DEFAULT '',
  group_number            TEXT NOT NULL DEFAULT '',
  payer_id                TEXT NOT NULL DEFAULT '',
  effective_date          TEXT NOT NULL DEFAULT '',
  termination_date        TEXT NOT NULL DEFAULT '',
  status                  TEXT NOT NULL DEFAULT '',
  priority                TEXT NOT NULL DEFAULT '',
  subscriber_name         TEXT NOT NULL DEFAULT '',
  subscriber_dob          TEXT NOT NULL DEFAULT '',
  subscriber_relationship TEXT NOT NULL DEFAULT '',
  copay                   TEXT NOT NULL DEFAULT '',
  deductible              TEXT NOT NULL DEFAULT '',
  coinsurance             TEXT NOT NULL DEFAULT '',
  auth_required           BOOLEAN NOT NULL DEFAULT FALSE,
  referral_required       BOOLEAN NOT NULL DEFAULT FALSE,
  notes                   TEXT NOT NULL DEFAULT '',
  card_front              TEXT,
  card_back               TEXT,
  field_history           JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by              TEXT NOT NULL DEFAULT '',
  created_at              TEXT NOT NULL DEFAULT '',
  updated_at              TEXT NOT NULL DEFAULT '',
  extra                   JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ---------- Billing core ----------

CREATE TABLE IF NOT EXISTS cpt_catalog (
  id       TEXT PRIMARY KEY,
  code     TEXT NOT NULL DEFAULT '',
  "desc"   TEXT NOT NULL DEFAULT '',
  charge   NUMERIC(14,2) NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT '',
  active   BOOLEAN NOT NULL DEFAULT TRUE,
  extra    JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS charges (
  id                  TEXT PRIMARY KEY,
  patient_id          TEXT,
  dos                 TEXT NOT NULL DEFAULT '',
  provider            TEXT NOT NULL DEFAULT '',
  referral_physician  TEXT NOT NULL DEFAULT '',
  cpt                 TEXT NOT NULL DEFAULT '',
  "desc"              TEXT NOT NULL DEFAULT '',
  charge              NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid                NUMERIC(14,2) NOT NULL DEFAULT 0,
  writeoff            NUMERIC(14,2) NOT NULL DEFAULT 0,
  credits             NUMERIC(14,2) NOT NULL DEFAULT 0,
  memos               JSONB NOT NULL DEFAULT '[]'::jsonb,
  postings            JSONB NOT NULL DEFAULT '[]'::jsonb,
  charge_insurance_id TEXT,
  payer_override      TEXT,
  facility_name       TEXT NOT NULL DEFAULT '',
  facility_address    TEXT NOT NULL DEFAULT '',
  tax_id              TEXT NOT NULL DEFAULT '',
  npi                 TEXT NOT NULL DEFAULT '',
  diagnosis_codes     JSONB NOT NULL DEFAULT '[]'::jsonb,
  ndc                 TEXT NOT NULL DEFAULT '',
  units               NUMERIC(10,2) NOT NULL DEFAULT 1,
  time                TEXT NOT NULL DEFAULT '',
  posted_by           TEXT,
  posted_at           TEXT,
  batch_id            TEXT,
  extra               JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS claims (
  id              TEXT PRIMARY KEY,
  patient_id      TEXT,
  charge_id       TEXT,
  payer           TEXT NOT NULL DEFAULT '',
  cpt             TEXT NOT NULL DEFAULT '',
  dx              TEXT NOT NULL DEFAULT '',
  amount          NUMERIC(14,2) NOT NULL DEFAULT 0,
  submitted       TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT '',
  diagnosis_codes JSONB,
  facility_name   TEXT,
  npi             TEXT,
  units           NUMERIC(10,2),
  tax_id          TEXT,
  extra           JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS transactions (
  id         TEXT PRIMARY KEY,
  charge_id  TEXT,
  patient_id TEXT,
  type       TEXT NOT NULL DEFAULT '',
  amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  date       TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',
  reference  TEXT NOT NULL DEFAULT '',
  posting_id TEXT,
  batch_id   TEXT,
  posted_by  TEXT,
  posted_at  TEXT,
  extra      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS batches (
  id           TEXT PRIMARY KEY,
  batch_number TEXT NOT NULL DEFAULT '',
  user_id      TEXT NOT NULL DEFAULT '',
  user_name    TEXT NOT NULL DEFAULT '',
  batch_date   TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'OPEN',
  opened_at    TEXT,
  closed_at    TEXT,
  extra        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS patient_credit_balances (
  id                TEXT PRIMARY KEY,
  patient_id        TEXT,
  amount            NUMERIC(14,2) NOT NULL DEFAULT 0,
  remaining         NUMERIC(14,2) NOT NULL DEFAULT 0,
  reason            TEXT NOT NULL DEFAULT '',
  date              TEXT NOT NULL DEFAULT '',
  source_charge_id  TEXT,
  source_posting_id TEXT,
  created_by        TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT '',
  extra             JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS insurance_credit_balances (
  id                TEXT PRIMARY KEY,
  patient_id        TEXT,
  insurance_name    TEXT NOT NULL DEFAULT '',
  amount            NUMERIC(14,2) NOT NULL DEFAULT 0,
  remaining         NUMERIC(14,2) NOT NULL DEFAULT 0,
  reason            TEXT NOT NULL DEFAULT '',
  date              TEXT NOT NULL DEFAULT '',
  source_charge_id  TEXT,
  source_posting_id TEXT,
  created_by        TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT '',
  extra             JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ---------- Clinical (EHR-lite) ----------

CREATE TABLE IF NOT EXISTS vitals (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT,
  date        TEXT NOT NULL DEFAULT '',
  height      TEXT NOT NULL DEFAULT '',
  weight      TEXT NOT NULL DEFAULT '',
  bmi         TEXT NOT NULL DEFAULT '',
  bp          TEXT NOT NULL DEFAULT '',
  pulse       TEXT NOT NULL DEFAULT '',
  resp        TEXT NOT NULL DEFAULT '',
  temp        TEXT NOT NULL DEFAULT '',
  spo2        TEXT NOT NULL DEFAULT '',
  pain        TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL DEFAULT '',
  extra       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS allergies (
  id            TEXT PRIMARY KEY,
  patient_id    TEXT,
  substance     TEXT NOT NULL DEFAULT '',
  reaction      TEXT NOT NULL DEFAULT '',
  severity      TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  recorded_date TEXT NOT NULL DEFAULT '',
  recorded_by   TEXT NOT NULL DEFAULT '',
  extra         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS medications (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT,
  name         TEXT NOT NULL DEFAULT '',
  dose         TEXT NOT NULL DEFAULT '',
  route        TEXT NOT NULL DEFAULT '',
  frequency    TEXT NOT NULL DEFAULT '',
  quantity     TEXT NOT NULL DEFAULT '',
  refills      TEXT NOT NULL DEFAULT '',
  start_date   TEXT NOT NULL DEFAULT '',
  end_date     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT '',
  prescriber   TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  extra        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS problems (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT,
  diagnosis   TEXT NOT NULL DEFAULT '',
  icd10       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  onset_date  TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  extra       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS clinical_notes (
  id         TEXT PRIMARY KEY,
  patient_id TEXT,
  type       TEXT NOT NULL DEFAULT '',
  date       TEXT NOT NULL DEFAULT '',
  provider   TEXT NOT NULL DEFAULT '',
  subjective TEXT NOT NULL DEFAULT '',
  objective  TEXT NOT NULL DEFAULT '',
  assessment TEXT NOT NULL DEFAULT '',
  plan       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT '',
  signed_by  TEXT,
  signed_at  TEXT,
  amendments JSONB NOT NULL DEFAULT '[]'::jsonb,
  extra      JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ---------- Workflow: ticklers and support ----------

CREATE TABLE IF NOT EXISTS ticklers (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL DEFAULT '',
  description      TEXT NOT NULL DEFAULT '',
  patient_id       TEXT,
  patient_name     TEXT NOT NULL DEFAULT '',
  claim_id         TEXT,
  cpt              TEXT NOT NULL DEFAULT '',
  dos              TEXT NOT NULL DEFAULT '',
  priority         TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT '',
  reminder_date    TEXT NOT NULL DEFAULT '',
  reminder_time    TEXT NOT NULL DEFAULT '',
  assigned_to_uid  TEXT NOT NULL DEFAULT '',
  assigned_to_name TEXT NOT NULL DEFAULT '',
  created_by_uid   TEXT NOT NULL DEFAULT '',
  created_by_name  TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT '',
  completed_at     TEXT,
  extra            JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id              TEXT PRIMARY KEY,
  subject         TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  priority        TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT '',
  attachment      TEXT,
  attachment_name TEXT,
  notes           JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by_uid  TEXT NOT NULL DEFAULT '',
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT '',
  extra           JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ---------- Indexes on the columns the app filters by ----------

CREATE INDEX IF NOT EXISTS idx_charges_patient      ON charges(patient_id);
CREATE INDEX IF NOT EXISTS idx_charges_dos          ON charges(dos);
CREATE INDEX IF NOT EXISTS idx_charges_batch        ON charges(batch_id);
CREATE INDEX IF NOT EXISTS idx_claims_patient       ON claims(patient_id);
CREATE INDEX IF NOT EXISTS idx_claims_charge        ON claims(charge_id);
CREATE INDEX IF NOT EXISTS idx_txn_charge           ON transactions(charge_id);
CREATE INDEX IF NOT EXISTS idx_txn_patient          ON transactions(patient_id);
CREATE INDEX IF NOT EXISTS idx_txn_batch            ON transactions(batch_id);
CREATE INDEX IF NOT EXISTS idx_txn_posting          ON transactions(posting_id);
CREATE INDEX IF NOT EXISTS idx_txn_date             ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_policies_patient     ON insurance_policies(patient_id);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_appointments_date    ON appointments(date);
CREATE INDEX IF NOT EXISTS idx_memos_patient        ON patient_memos(patient_id);
CREATE INDEX IF NOT EXISTS idx_iddocs_patient       ON id_documents(patient_id);
CREATE INDEX IF NOT EXISTS idx_audit_patient        ON audit_logs(patient_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity         ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_batches_user         ON batches(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ticklers_assigned    ON ticklers(assigned_to_uid, status);
CREATE INDEX IF NOT EXISTS idx_tickets_creator      ON support_tickets(created_by_uid);
CREATE INDEX IF NOT EXISTS idx_vitals_patient       ON vitals(patient_id);
CREATE INDEX IF NOT EXISTS idx_allergies_patient    ON allergies(patient_id);
CREATE INDEX IF NOT EXISTS idx_medications_patient  ON medications(patient_id);
CREATE INDEX IF NOT EXISTS idx_problems_patient     ON problems(patient_id);
CREATE INDEX IF NOT EXISTS idx_notes_patient        ON clinical_notes(patient_id);

COMMIT;
