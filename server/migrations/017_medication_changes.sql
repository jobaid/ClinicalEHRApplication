-- Medication duration, and a permanent history of dose and duration changes.
--
-- Forward-only and idempotent. medications gains one NULLABLE column: existing medications have no
-- recorded duration, and inventing one for them would be a clinical fact nobody entered.
--
-- medication_changes is append-only. There is no UPDATE or DELETE path for it anywhere in the
-- application: section 46 requires the old dose never to be silently overwritten, and the surest way
-- to guarantee that is for a change to be a new row, never an edit of an old one.
--
-- No foreign key to medications or patients, for the same restore-safety reason as every other
-- migration here.

ALTER TABLE medications ADD COLUMN IF NOT EXISTS duration_days INTEGER;

CREATE TABLE IF NOT EXISTS medication_changes (
  id                TEXT PRIMARY KEY,
  medication_id     TEXT NOT NULL,
  patient_id        TEXT,
  change_type       TEXT NOT NULL,          -- DOSE | DURATION | DOSE_AND_DURATION
  old_dose          TEXT NOT NULL DEFAULT '',
  new_dose          TEXT NOT NULL DEFAULT '',
  old_duration_days INTEGER,
  new_duration_days INTEGER,
  effective_date    DATE NOT NULL,
  reason            TEXT NOT NULL,
  changed_by        TEXT NOT NULL DEFAULT '',   -- user id, from the session
  changed_by_name   TEXT NOT NULL DEFAULT '',
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_medication_changes_med ON medication_changes (medication_id, changed_at);
