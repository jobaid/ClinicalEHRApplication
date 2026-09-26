-- Claim workflow: submission history and printer alignment profiles.
--
-- Forward-only and idempotent, like every migration here. Two tables are added and nothing
-- existing is altered: claims already carries an `extra` jsonb column, so HCFA metadata and the
-- widened status vocabulary (Ready, Validation Error, Rejected) need no column change, and the
-- existing Draft/Submitted/Paid/Denied values keep their meaning.
--
-- No foreign keys to claims, patients or users. medbill.sql restores drop those tables without
-- CASCADE, so a constraint here would turn a restore into a failure.

-- Append-only claim history. Section 22: submission events are never overwritten, so there is no
-- UPDATE path in the application for this table - a correction is a new row.
CREATE TABLE IF NOT EXISTS claim_submissions (
  id            TEXT PRIMARY KEY,
  claim_id      TEXT NOT NULL,
  patient_id    TEXT,
  event         TEXT NOT NULL,              -- Claim Created, Claim Validated, HCFA Printed, ...
  status        TEXT NOT NULL DEFAULT '',   -- the claim status AFTER this event, if it changed
  actor         TEXT NOT NULL DEFAULT '',   -- display name, from the session - never from the body
  detail        TEXT NOT NULL DEFAULT '',
  -- Only ever written from a real external response. Section 21: an empty response_code is why
  -- "Accepted" cannot be displayed - there is nothing to display it from.
  response_code TEXT NOT NULL DEFAULT '',
  response_text TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claim_submissions_claim ON claim_submissions (claim_id, created_at);
CREATE INDEX IF NOT EXISTS idx_claim_submissions_patient ON claim_submissions (patient_id);

-- Printer alignment profiles (section 13). Per user, because the offsets that make a claim land
-- correctly are a property of one person's printer and paper stock, not of the practice.
CREATE TABLE IF NOT EXISTS claim_print_profiles (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT 'Default',
  paper_size TEXT NOT NULL DEFAULT 'Letter',
  offset_x   NUMERIC(6,3) NOT NULL DEFAULT 0,
  offset_y   NUMERIC(6,3) NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_print_profiles_user_name
  ON claim_print_profiles (user_id, lower(name));
