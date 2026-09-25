-- Doctor role, and the laboratory domain the Doctor workspace reads from.
--
-- Forward-only and additive: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, and one
-- INSERT ... ON CONFLICT DO NOTHING. Nothing drops, alters, truncates or deletes. Safe against a
-- live database and safe to re-run on every boot.
--
-- No foreign keys to patients or users, for the same reason as 007 and 009: medbill.sql is
-- restored over the live database and drops those tables without CASCADE, so a dependent key
-- would break the restore.

-- ---------- Doctor role ----------
--
-- Added as a row, not as a code change, because role_permissions is already the authority for
-- which tabs a role may open. ON CONFLICT DO NOTHING means re-running this never overwrites tab
-- grants an administrator has since edited.
--
-- Deliberately NOT given 'billing', 'claims' or 'users'. A Doctor is a clinical role; section 1
-- is explicit that Doctors must not manage users, security or global configuration unless a
-- Super Admin grants it, and section 29 says the workspace stays clinical rather than billing.
INSERT INTO role_permissions (id, tabs) VALUES
  ('DOCTOR', '["dashboard","schedule","patients","clinical","record","reports"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Repair for a database that received the first version of this migration, which seeded the role
-- without the "record" tab and therefore hid the clinical workspace from the very role it was
-- built for. ON CONFLICT DO NOTHING above cannot fix an existing row, so this does.
--
-- Strictly additive and scoped to one role: it appends an element to DOCTOR's tab array and only
-- when it is absent. It removes nothing, and it never touches SUPER_ADMIN, MANAGER, NURSE,
-- RECEPTIONIST or BILLER - an administrator's own edits to those roles are left alone.
UPDATE role_permissions
   SET tabs = tabs || '["record"]'::jsonb
 WHERE id = 'DOCTOR' AND NOT (tabs @> '["record"]'::jsonb);

-- ---------- Laboratory ----------
--
-- This application had no laboratory data of any kind. These two tables add it, because the
-- Doctor workspace is specified around a lab panel and there was nothing to render.
--
-- The critical design rule, from sections 13 and 14: reference ranges and abnormal flags are
-- STORED, never computed. They arrive with the result from whatever laboratory or interface
-- produced it. Nothing in this application decides that a value is high, low or critical - if
-- the source did not say so, the interface shows no flag rather than inventing one. There is
-- deliberately no threshold table and no rule engine anywhere in this feature.

-- One row per ordered panel or study.
CREATE TABLE IF NOT EXISTS lab_orders (
  id            TEXT PRIMARY KEY,
  patient_id    TEXT NOT NULL,

  -- Links to the encounter this was ordered during, where one is known. Free text because this
  -- application's encounter is a charge and older records may predate any link.
  encounter_ref TEXT NOT NULL DEFAULT '',

  panel_name    TEXT NOT NULL DEFAULT '',
  panel_code    TEXT NOT NULL DEFAULT '',

  -- Free text rather than an enumeration: section 11 is explicit that CBC/CMP/A1C and the rest
  -- are examples, and the system must support tests beyond them. The interface builds its filter
  -- list from the categories actually present in the data.
  category      TEXT NOT NULL DEFAULT '',

  ordering_provider TEXT NOT NULL DEFAULT '',
  lab_name      TEXT NOT NULL DEFAULT '',
  accession     TEXT NOT NULL DEFAULT '',

  ordered_at    TIMESTAMPTZ,
  collected_at  TIMESTAMPTZ,
  resulted_at   TIMESTAMPTZ,

  -- As reported by the source: ordered / collected / preliminary / final / corrected / cancelled.
  status        TEXT NOT NULL DEFAULT '',

  -- An existing row in id_documents holding the original PDF, when one was received. Section 16
  -- asks for the original report to be viewable; this references it rather than storing a second
  -- copy of the file.
  report_document_id TEXT,

  comments      TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  extra         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS lab_orders_patient_idx  ON lab_orders (patient_id, resulted_at DESC);
CREATE INDEX IF NOT EXISTS lab_orders_category_idx ON lab_orders (category);

-- One row per analyte. A CBC is one lab_orders row and several lab_results rows.
CREATE TABLE IF NOT EXISTS lab_results (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL,

  -- Denormalised from the order so the patient's whole lab history can be searched and trended
  -- without joining, which is what keeps the right-hand panel fast on a large record.
  patient_id TEXT NOT NULL,

  test_name  TEXT NOT NULL DEFAULT '',
  test_code  TEXT NOT NULL DEFAULT '',
  loinc      TEXT NOT NULL DEFAULT '',

  -- Both forms are kept. value_text is what the laboratory reported and is what gets displayed -
  -- "NEGATIVE", "<0.01" and ">150" are real results that no number can represent. value_num is
  -- populated only when the result is genuinely numeric, and is the ONLY thing trends plot, so a
  -- qualitative result can never be silently charted as a number.
  value_text TEXT NOT NULL DEFAULT '',
  value_num  NUMERIC(18,4),

  unit       TEXT NOT NULL DEFAULT '',

  -- Supplied by the laboratory. Never derived here.
  reference_low  NUMERIC(18,4),
  reference_high NUMERIC(18,4),
  reference_text TEXT NOT NULL DEFAULT '',

  -- Supplied by the laboratory: '', 'H', 'L', 'A', 'AA', 'CRIT'. An empty flag means the source
  -- did not flag it, which this application reports as "no flag" and never second-guesses.
  flag       TEXT NOT NULL DEFAULT '',

  status     TEXT NOT NULL DEFAULT '',
  observed_at TIMESTAMPTZ,
  sequence   INT NOT NULL DEFAULT 0,
  comments   TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports the right-hand panel's default view (this patient, newest first).
CREATE INDEX IF NOT EXISTS lab_results_patient_idx ON lab_results (patient_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS lab_results_order_idx   ON lab_results (order_id, sequence);

-- Supports "search labs for A1C" and the trend query, both of which look up by test name for one
-- patient across all time.
CREATE INDEX IF NOT EXISTS lab_results_test_idx    ON lab_results (patient_id, lower(test_name), observed_at DESC);

-- Supports the "abnormal / flagged results" card on the Doctor dashboard without scanning every
-- result ever recorded; partial, because flagged results are the small minority.
CREATE INDEX IF NOT EXISTS lab_results_flag_idx    ON lab_results (patient_id, observed_at DESC)
  WHERE flag <> '';

-- ---------- record access audit ----------
--
-- Section 26 asks for medical-record access to be audited. audit_logs already carries the who,
-- what and when and is read from the patient chart, so access events go there rather than into a
-- parallel log. This index is what makes "who opened this patient's record" answerable without a
-- sequential scan once the table is large.
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
