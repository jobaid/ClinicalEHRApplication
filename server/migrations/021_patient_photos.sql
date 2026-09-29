-- Patient profile picture. One row per patient, so REPLACING a photo is an UPSERT and there is
-- exactly one active picture at any time. Additive and idempotent - no existing table changes.

CREATE TABLE IF NOT EXISTS patient_photos (
  patient_id  TEXT PRIMARY KEY,
  mime        TEXT NOT NULL,
  file_bytes  BYTEA NOT NULL,
  file_size   INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT NOT NULL DEFAULT '',
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
