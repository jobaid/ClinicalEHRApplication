-- Uploaded medical records.
--
-- Forward-only and additive: one new table and its indexes. Nothing existing is dropped,
-- altered, renamed or touched. id_documents, clinical_notes, lab_orders and every other table
-- keep working exactly as they do now.
--
-- No foreign key to patients, consistent with 007, 009 and 010: medbill.sql is restored over the
-- live database and drops patients without CASCADE, so a dependent key would break the restore.
--
-- The file is stored base64 in a TEXT column, which is how this application already stores
-- scanned identity documents and insurance cards (id_documents.file, insurance_policies
-- .card_front). Following the existing pattern rather than introducing a filesystem or object
-- store means nothing about deployment, backup or restore changes: a pg_dump still captures
-- every uploaded record, and `git pull` still cannot touch one.

CREATE TABLE IF NOT EXISTS medical_records (
  id         TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,

  record_name TEXT NOT NULL DEFAULT '',

  -- THE DATE OF THE RECORD ITSELF, entered by the person uploading it. A discharge summary from
  -- last May is dated last May. Section 4 is explicit that this must never be the upload date,
  -- which is why it is a separate column from uploaded_at below and is never defaulted to now().
  record_date TEXT NOT NULL DEFAULT '',

  record_type TEXT NOT NULL DEFAULT '',
  provider    TEXT NOT NULL DEFAULT '',
  facility    TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',

  -- Same shape as id_documents: the bytes, plus what they claim to be.
  file       TEXT   NOT NULL DEFAULT '',
  file_name  TEXT   NOT NULL DEFAULT '',
  file_type  TEXT   NOT NULL DEFAULT '',
  file_size  BIGINT NOT NULL DEFAULT 0,

  -- Recorded at upload so a stored record can be shown to be the one that was uploaded. A
  -- medical record that may have been altered in place is not evidence of anything.
  sha256     TEXT NOT NULL DEFAULT '',

  -- Taken from the authenticated session, never from the request body. Section 5: the uploader
  -- must not be able to type who they are.
  uploaded_by_id   TEXT NOT NULL DEFAULT '',
  uploaded_by_name TEXT NOT NULL DEFAULT '',
  uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Soft delete. A medical record that was filed and then withdrawn is part of the history of
  -- the chart; removing the row outright would erase the fact that it ever existed.
  status     TEXT NOT NULL DEFAULT 'active',
  deleted_by TEXT NOT NULL DEFAULT '',
  deleted_at TIMESTAMPTZ,

  extra      JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- The list view: this patient's active records, most recent RECORD first (not upload first -
-- a clinician reads a chart by when things happened).
CREATE INDEX IF NOT EXISTS medical_records_patient_idx
  ON medical_records (patient_id, record_date DESC);

CREATE INDEX IF NOT EXISTS medical_records_active_idx
  ON medical_records (patient_id, uploaded_at DESC) WHERE status = 'active';
