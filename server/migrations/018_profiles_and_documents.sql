-- User profile extensions, personal certificates, and HR employee documents.
--
-- Forward-only and idempotent. Nothing is dropped, nothing is renamed. Phone, address and skills
-- ride on the existing users.extra JSONB rather than adding columns - the app already round-trips
-- unmapped fields through that catch-all, so treating them the same way keeps profile edits under
-- the same read paths as the rest of the user record.
--
-- File bytes are stored the way medical_records and id_documents already store them: as a base64
-- data URL in a TEXT column. One storage pattern, one backup path.

CREATE TABLE IF NOT EXISTS user_certificates (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  issuer         TEXT NOT NULL DEFAULT '',
  issue_date     TEXT NOT NULL DEFAULT '',
  expiry_date    TEXT NOT NULL DEFAULT '',
  credential_id  TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  file           TEXT NOT NULL DEFAULT '',
  file_name      TEXT NOT NULL DEFAULT '',
  file_type      TEXT NOT NULL DEFAULT '',
  file_size      BIGINT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_certificates_user ON user_certificates(user_id);

-- Employee HR documents. Never hard-deleted: an archived row keeps a non-null archived_at so the
-- history of what was on file remains readable.
CREATE TABLE IF NOT EXISTS employee_documents (
  id             TEXT PRIMARY KEY,
  employee_id    TEXT NOT NULL,
  document_name  TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'Other',
  description    TEXT NOT NULL DEFAULT '',
  expiry_date    TEXT NOT NULL DEFAULT '',
  file           TEXT NOT NULL DEFAULT '',
  file_name      TEXT NOT NULL DEFAULT '',
  file_type      TEXT NOT NULL DEFAULT '',
  file_size      BIGINT NOT NULL DEFAULT 0,
  uploaded_by    TEXT NOT NULL DEFAULT '',
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at    TIMESTAMPTZ,
  archived_by    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_employee_documents_employee ON employee_documents(employee_id);
