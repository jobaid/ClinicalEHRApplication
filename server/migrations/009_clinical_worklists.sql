-- Antimicrobial Review and HIM Coding Worklist.
--
-- Forward-only and purely additive. Every statement is CREATE TABLE IF NOT EXISTS, CREATE INDEX
-- IF NOT EXISTS, or INSERT ... ON CONFLICT DO NOTHING. Nothing here drops, alters, truncates or
-- deletes, so it is safe to run against a live database holding real records, and safe to run
-- again on every boot.
--
-- NO FOREIGN KEYS to patients, users, charges or claims. This is deliberate and matches the
-- decision taken for user_permissions in 007. The operational reality of this deployment is that
-- medbill.sql gets restored over the top of a live database, and that dump begins with
-- `DROP TABLE IF EXISTS public.patients;` (and users, and charges) without CASCADE. A dependent
-- foreign key would make those statements fail and break the restore outright. References are
-- therefore plain TEXT, resolved by join at read time; a row that no longer resolves renders as
-- "Not available" rather than breaking a page.
--
-- WHAT THIS SCHEMA DOES NOT INVENT
--
-- The specification describes an inpatient hospital workflow: admissions, units, attending
-- physicians, microbiology cultures, susceptibility panels, renal function. This application has
-- none of those - it is an outpatient billing and EHR system whose closest thing to an encounter
-- is a charge (patient + date of service + provider + CPT). So:
--
--   * Antimicrobial therapy REFERENCES medications.id where a medication row exists, rather than
--     copying dose/route/frequency into a second place that can then disagree with the chart.
--   * Culture, organism, susceptibility, labs and renal function are nullable free-text captured
--     by the reviewer. They are documentation fields, not derived clinical values, and an empty
--     one means "not documented" - never a fabricated result.
--   * Location, attending, admission and discharge are nullable, because this application does
--     not hold them. The interface shows "Not available" rather than a guess.

-- ---------- centralised workflow statuses ----------
--
-- One table rather than status strings scattered through React components, so a status can be
-- relabelled or reordered without a code change, and so the badge colour a coder sees comes from
-- the same row the API validates against.
CREATE TABLE IF NOT EXISTS workflow_statuses (
  id         TEXT PRIMARY KEY,

  -- 'antimicrobial' | 'him_coding' | 'him_query'
  domain     TEXT    NOT NULL,
  code       TEXT    NOT NULL,
  label      TEXT    NOT NULL,
  sort_order INT     NOT NULL DEFAULT 0,

  -- Terminal statuses are excluded from "open work" counts and from aging.
  is_terminal BOOLEAN NOT NULL DEFAULT FALSE,

  -- A token the frontend maps to its own palette, not a hex value: the interface owns its
  -- colours, the database owns which statuses mean trouble.
  tone       TEXT    NOT NULL DEFAULT 'neutral',
  active     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE UNIQUE INDEX IF NOT EXISTS workflow_statuses_domain_code_idx
  ON workflow_statuses (domain, code);

INSERT INTO workflow_statuses (id, domain, code, label, sort_order, is_terminal, tone) VALUES
  ('am-pending',   'antimicrobial', 'PENDING_REVIEW',   'Pending Review',     10, FALSE, 'amber'),
  ('am-inreview',  'antimicrobial', 'IN_REVIEW',        'In Review',          20, FALSE, 'blue'),
  ('am-followup',  'antimicrobial', 'FOLLOW_UP',        'Follow-Up Required', 30, FALSE, 'amber'),
  ('am-completed', 'antimicrobial', 'COMPLETED',        'Completed',          40, TRUE,  'green'),
  ('am-cancelled', 'antimicrobial', 'CANCELLED',        'Cancelled',          50, TRUE,  'slate'),

  ('him-unassigned', 'him_coding', 'UNASSIGNED',       'Unassigned',             10, FALSE, 'slate'),
  ('him-ready',      'him_coding', 'READY_FOR_CODING', 'Ready for Coding',       20, FALSE, 'blue'),
  ('him-assigned',   'him_coding', 'ASSIGNED',         'Assigned',               30, FALSE, 'blue'),
  ('him-progress',   'him_coding', 'IN_PROGRESS',      'In Progress',            40, FALSE, 'blue'),
  ('him-queryreq',   'him_coding', 'QUERY_REQUIRED',   'Provider Query Required',50, FALSE, 'amber'),
  ('him-querysent',  'him_coding', 'QUERY_SENT',       'Query Sent',             60, FALSE, 'amber'),
  ('him-queryresp',  'him_coding', 'QUERY_RESPONDED',  'Query Response Received',70, FALSE, 'blue'),
  ('him-finalrev',   'him_coding', 'FINAL_REVIEW',     'Ready for Final Review', 80, FALSE, 'blue'),
  ('him-completed',  'him_coding', 'COMPLETED',        'Completed',              90, TRUE,  'green'),
  ('him-hold',       'him_coding', 'ON_HOLD',          'On Hold',               100, FALSE, 'slate'),

  ('q-draft',     'him_query', 'DRAFT',     'Draft',             10, FALSE, 'slate'),
  ('q-sent',      'him_query', 'SENT',      'Sent',              20, FALSE, 'blue'),
  ('q-awaiting',  'him_query', 'AWAITING',  'Awaiting Response', 30, FALSE, 'amber'),
  ('q-received',  'him_query', 'RECEIVED',  'Response Received', 40, FALSE, 'blue'),
  ('q-resolved',  'him_query', 'RESOLVED',  'Resolved',          50, TRUE,  'green'),
  ('q-cancelled', 'him_query', 'CANCELLED', 'Cancelled',         60, TRUE,  'slate')
ON CONFLICT (id) DO NOTHING;

-- ---------- Antimicrobial Review ----------
--
-- One row per course of therapy under review. This is the worklist item; the reviews themselves
-- are append-only rows in antimicrobial_review_entries.
CREATE TABLE IF NOT EXISTS antimicrobial_reviews (
  id            TEXT PRIMARY KEY,

  patient_id    TEXT NOT NULL,

  -- The chart's medication row, when the therapy came from there. Null for a therapy documented
  -- directly on the review. When set, dose/route/frequency are READ FROM medications - the
  -- columns below are a fallback for the null case, never a second copy of the same fact.
  medication_id TEXT,

  antimicrobial TEXT NOT NULL DEFAULT '',
  dose          TEXT NOT NULL DEFAULT '',
  route         TEXT NOT NULL DEFAULT '',
  frequency     TEXT NOT NULL DEFAULT '',
  start_date    TEXT NOT NULL DEFAULT '',
  stop_date     TEXT NOT NULL DEFAULT '',
  ordering_provider TEXT NOT NULL DEFAULT '',
  indication    TEXT NOT NULL DEFAULT '',
  order_status  TEXT NOT NULL DEFAULT '',

  -- Not held anywhere in this application. Nullable, and rendered as "Not available" when empty.
  location      TEXT NOT NULL DEFAULT '',
  attending     TEXT NOT NULL DEFAULT '',
  encounter_ref TEXT NOT NULL DEFAULT '',

  review_due    TIMESTAMPTZ,
  priority      TEXT NOT NULL DEFAULT 'ROUTINE',
  status        TEXT NOT NULL DEFAULT 'PENDING_REVIEW',

  assigned_to   TEXT,
  assigned_to_name TEXT NOT NULL DEFAULT '',

  last_reviewed_at TIMESTAMPTZ,

  created_by    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  extra         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS am_reviews_patient_idx  ON antimicrobial_reviews (patient_id);
CREATE INDEX IF NOT EXISTS am_reviews_status_idx   ON antimicrobial_reviews (status, review_due);
CREATE INDEX IF NOT EXISTS am_reviews_assigned_idx ON antimicrobial_reviews (assigned_to);
CREATE INDEX IF NOT EXISTS am_reviews_due_idx      ON antimicrobial_reviews (review_due);

-- Append-only. A new review NEVER updates an old one: the specification asks for
-- "Review #1 -> Review #2 -> Follow-up -> Completed" to remain readable in full, and an
-- antimicrobial stewardship record that can be edited after the fact is not a record.
CREATE TABLE IF NOT EXISTS antimicrobial_review_entries (
  id            TEXT PRIMARY KEY,
  review_id     TEXT NOT NULL,

  reviewed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewer_id   TEXT NOT NULL DEFAULT '',
  reviewer_name TEXT NOT NULL DEFAULT '',

  -- REVIEWED_NO_CHANGE | RECOMMENDATION | DISCUSSED_WITH_PROVIDER | FOLLOW_UP | COMPLETED |
  -- UNABLE_TO_REVIEW. Documentation of what a clinician decided - the software never decides.
  assessment    TEXT NOT NULL DEFAULT '',

  recommendation_category TEXT NOT NULL DEFAULT '',
  recommendation_notes    TEXT NOT NULL DEFAULT '',

  provider_contacted TEXT NOT NULL DEFAULT '',
  contact_at         TIMESTAMPTZ,
  provider_response  TEXT NOT NULL DEFAULT '',

  followup_date  TEXT NOT NULL DEFAULT '',
  followup_notes TEXT NOT NULL DEFAULT '',

  -- Clinical context AS DOCUMENTED BY THE REVIEWER at the time of review. This application holds
  -- no microbiology or chemistry results, so these are transcription fields. Empty means "not
  -- documented"; nothing here is ever derived or inferred.
  cultures       TEXT NOT NULL DEFAULT '',
  organism       TEXT NOT NULL DEFAULT '',
  susceptibility TEXT NOT NULL DEFAULT '',
  labs           TEXT NOT NULL DEFAULT '',
  renal_function TEXT NOT NULL DEFAULT '',
  allergies_noted TEXT NOT NULL DEFAULT '',
  clinical_notes TEXT NOT NULL DEFAULT '',
  prior_therapy  TEXT NOT NULL DEFAULT '',
  therapy_duration TEXT NOT NULL DEFAULT '',

  -- The worklist status this entry moved the review to, so the history explains the timeline.
  status_after   TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS am_entries_review_idx ON antimicrobial_review_entries (review_id, reviewed_at DESC);

-- ---------- HIM Coding Worklist ----------
--
-- One row per encounter awaiting coding. "Encounter" in this application means a charge: patient
-- plus date of service plus provider plus CPT. charge_id is the link; admit/discharge and
-- encounter type are nullable because outpatient billing data does not carry them.
CREATE TABLE IF NOT EXISTS him_worklist (
  id           TEXT PRIMARY KEY,

  patient_id   TEXT NOT NULL,
  charge_id    TEXT,
  claim_id     TEXT,
  encounter_ref TEXT NOT NULL DEFAULT '',

  dos            TEXT NOT NULL DEFAULT '',
  admit_date     TEXT NOT NULL DEFAULT '',
  discharge_date TEXT NOT NULL DEFAULT '',
  encounter_type TEXT NOT NULL DEFAULT '',
  provider       TEXT NOT NULL DEFAULT '',
  payer          TEXT NOT NULL DEFAULT '',
  location       TEXT NOT NULL DEFAULT '',

  coding_status TEXT NOT NULL DEFAULT 'UNASSIGNED',
  query_status  TEXT NOT NULL DEFAULT '',
  priority      TEXT NOT NULL DEFAULT 'ROUTINE',

  assigned_to      TEXT,
  assigned_to_name TEXT NOT NULL DEFAULT '',
  assigned_at      TIMESTAMPTZ,

  -- When the encounter entered the queue. Days Pending is computed from this, not stored, so it
  -- cannot go stale.
  ready_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,

  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  extra        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS him_worklist_patient_idx  ON him_worklist (patient_id);
CREATE INDEX IF NOT EXISTS him_worklist_status_idx   ON him_worklist (coding_status, ready_at);
CREATE INDEX IF NOT EXISTS him_worklist_assigned_idx ON him_worklist (assigned_to);
CREATE INDEX IF NOT EXISTS him_worklist_charge_idx   ON him_worklist (charge_id);

-- Append-only assignment history. Reassignment writes a new row and never edits the old one, so
-- "who had this encounter on the 3rd" stays answerable.
CREATE TABLE IF NOT EXISTS him_assignments (
  id            TEXT PRIMARY KEY,
  worklist_id   TEXT NOT NULL,

  assigned_to        TEXT,
  assigned_to_name   TEXT NOT NULL DEFAULT '',
  assigned_by        TEXT NOT NULL DEFAULT '',
  assigned_by_name   TEXT NOT NULL DEFAULT '',
  previous_assigned_to      TEXT,
  previous_assigned_to_name TEXT NOT NULL DEFAULT '',

  -- ASSIGN | REASSIGN | UNASSIGN | CLAIM (assign to me)
  action  TEXT NOT NULL DEFAULT 'ASSIGN',
  reason  TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS him_assignments_worklist_idx ON him_assignments (worklist_id, created_at DESC);

CREATE TABLE IF NOT EXISTS him_diagnosis_codes (
  id          TEXT PRIMARY KEY,
  worklist_id TEXT NOT NULL,

  code        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',

  -- Exactly one principal per encounter is enforced in the API, not by a constraint: a partial
  -- unique index would make a coder's mid-edit state illegal and reject a legitimate reorder.
  is_principal BOOLEAN NOT NULL DEFAULT FALSE,

  -- Present On Admission. Inpatient-only, so usually blank here.
  poa         TEXT NOT NULL DEFAULT '',
  sequence    INT  NOT NULL DEFAULT 0,
  notes       TEXT NOT NULL DEFAULT '',

  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS him_dx_worklist_idx ON him_diagnosis_codes (worklist_id, sequence);

CREATE TABLE IF NOT EXISTS him_procedure_codes (
  id          TEXT PRIMARY KEY,
  worklist_id TEXT NOT NULL,

  -- Validated against the existing cpt_catalog table where the code is present there, so this
  -- module and the billing screens agree on what a CPT code means.
  code        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  service_date TEXT NOT NULL DEFAULT '',
  modifiers   TEXT NOT NULL DEFAULT '',
  units       NUMERIC(10,2) NOT NULL DEFAULT 1,
  sequence    INT  NOT NULL DEFAULT 0,
  notes       TEXT NOT NULL DEFAULT '',

  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS him_px_worklist_idx ON him_procedure_codes (worklist_id, sequence);

CREATE TABLE IF NOT EXISTS him_provider_queries (
  id          TEXT PRIMARY KEY,
  worklist_id TEXT NOT NULL,
  patient_id  TEXT NOT NULL DEFAULT '',

  query_type   TEXT NOT NULL DEFAULT '',
  query_reason TEXT NOT NULL DEFAULT '',
  query_text   TEXT NOT NULL DEFAULT '',
  provider     TEXT NOT NULL DEFAULT '',

  status       TEXT NOT NULL DEFAULT 'DRAFT',

  created_by      TEXT NOT NULL DEFAULT '',
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,

  response_text TEXT NOT NULL DEFAULT '',
  resolution    TEXT NOT NULL DEFAULT '',
  coding_impact TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS him_queries_worklist_idx ON him_provider_queries (worklist_id, created_at DESC);
CREATE INDEX IF NOT EXISTS him_queries_status_idx   ON him_provider_queries (status);

-- Append-only timeline. Every status change, assignment, code edit and query event lands here,
-- so the encounter's story reads in order without reconstructing it from five tables.
CREATE TABLE IF NOT EXISTS him_activity (
  id          TEXT PRIMARY KEY,
  worklist_id TEXT NOT NULL,

  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id    TEXT NOT NULL DEFAULT '',
  user_name  TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  old_value  TEXT NOT NULL DEFAULT '',
  new_value  TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS him_activity_worklist_idx ON him_activity (worklist_id, at DESC);
