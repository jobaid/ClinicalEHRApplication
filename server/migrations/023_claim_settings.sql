-- Claims & Billing Settings storage.
--
-- Two tables, both additive and idempotent.
--
-- claim_settings is a small key/JSONB store for practice-wide billing configuration - things
-- that are single values or small objects (practice NPI, tax ID, service location, claim number
-- format, etc). One row per key. History is not tracked here; audit_logs records who changed a
-- value and when.
--
-- claim_reason_codes is a proper CRUD list for reasons the biller picks in dropdowns - write-off
-- reasons, debit / adjustment reasons, denial reasons. Kept in one table with a `kind` column so
-- adding another reason category later needs no new table.

CREATE TABLE IF NOT EXISTS claim_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by  TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS claim_reason_codes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                 -- 'writeoff' | 'debit' | 'denial'
  code        TEXT NOT NULL DEFAULT '',      -- optional short code (e.g. CO-45)
  description TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT '',      -- optional grouping ('Adjustment', 'Refund', ...)
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_claim_reason_codes_kind
  ON claim_reason_codes(kind, active, sort_order);
