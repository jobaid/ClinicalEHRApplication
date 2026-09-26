-- HR workforce: employees, org structure, schedules, attendance, leave, credentials, training.
--
-- Forward-only and idempotent, like every migration here. Everything is additive: no existing
-- table is altered, and nothing is dropped, truncated or deleted.
--
-- ABOUT EMPLOYEE IDENTITY
--
-- employees.user_id is the primary key, so an employee IS an application user, one to one. That
-- was a deliberate choice and it has a consequence worth stating plainly: somebody cannot be
-- recorded as an employee without also having a login. For a per-diem night-shift member of staff
-- who never signs in, that means creating an account nobody uses. If that becomes a problem, the
-- migration path is to make user_id nullable and add a separate employee id - which is why every
-- other table below keys on user_id through this table rather than duplicating employee details.
--
-- No FOREIGN KEY to users. medbill.sql restores drop that table without CASCADE, so a constraint
-- here would turn a restore into a failure. The same reason the rest of this schema has none.
--
-- ABOUT SEPARATION FROM PATIENT DATA
--
-- Nothing in this file references patients, charges, claims, medical_records, lab_results or
-- prescriptions, and nothing in the workforce API joins to them. Section 23: HR data and patient
-- data stay separate.

-- ---------- configurable org structure (section 3: "use configurable company values") ----------

CREATE TABLE IF NOT EXISTS hr_departments (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  code       TEXT NOT NULL DEFAULT '',
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_departments_name ON hr_departments (lower(name));

CREATE TABLE IF NOT EXISTS hr_job_titles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_job_titles_name ON hr_job_titles (lower(name));

CREATE TABLE IF NOT EXISTS hr_work_locations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  city       TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT '',
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_work_locations_name ON hr_work_locations (lower(name));

-- Section 7: shift names are configured, not hard-coded. Morning/Evening/Night below are seeds a
-- practice can rename or replace, not a fixed vocabulary.
CREATE TABLE IF NOT EXISTS hr_shifts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  start_time TIME NOT NULL,
  end_time   TIME NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_shifts_name ON hr_shifts (lower(name));

-- ---------- the employee record ----------

CREATE TABLE IF NOT EXISTS employees (
  user_id           TEXT PRIMARY KEY,
  employee_no       TEXT NOT NULL DEFAULT '',
  department_id     TEXT,
  job_title_id      TEXT,
  location_id       TEXT,
  -- The manager is another employee, named by their user id. Self-referential and nullable,
  -- because somebody has to be at the top.
  manager_user_id   TEXT,
  employment_type   TEXT NOT NULL DEFAULT '',   -- hr_employment_type in workflow_statuses
  employment_status TEXT NOT NULL DEFAULT '',   -- hr_employment_status
  work_arrangement  TEXT NOT NULL DEFAULT '',   -- hr_work_arrangement
  default_shift_id  TEXT,
  hire_date         DATE,
  termination_date  DATE,
  work_phone        TEXT NOT NULL DEFAULT '',
  photo_url         TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_employee_no
  ON employees (employee_no) WHERE employee_no <> '';
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees (department_id);
CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees (manager_user_id);
CREATE INDEX IF NOT EXISTS idx_employees_status ON employees (employment_status);
CREATE INDEX IF NOT EXISTS idx_employees_hire_date ON employees (hire_date);

-- ---------- schedules, attendance and leave ----------
--
-- One row per employee per date. The workforce page's "today" filters are DERIVED from these three
-- tables plus the holiday calendar and never stored as a status on the employee, because an
-- employee's attendance is a fact about a date, not a property of the person.

CREATE TABLE IF NOT EXISTS employee_schedules (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  work_date   DATE NOT NULL,
  shift_id    TEXT,
  start_time  TIME,
  end_time    TIME,
  is_day_off  BOOLEAN NOT NULL DEFAULT FALSE,
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_schedules_day
  ON employee_schedules (user_id, work_date);
CREATE INDEX IF NOT EXISTS idx_employee_schedules_date ON employee_schedules (work_date);

CREATE TABLE IF NOT EXISTS employee_attendance (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  work_date  DATE NOT NULL,
  -- hr_attendance in workflow_statuses: PRESENT, LATE, ABSENT, CALLED_OFF, REMOTE, ...
  status     TEXT NOT NULL DEFAULT '',
  clock_in   TIMESTAMPTZ,
  clock_out  TIMESTAMPTZ,
  minutes_late INTEGER,
  note       TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_attendance_day
  ON employee_attendance (user_id, work_date);
CREATE INDEX IF NOT EXISTS idx_employee_attendance_date ON employee_attendance (work_date);
CREATE INDEX IF NOT EXISTS idx_employee_attendance_status ON employee_attendance (status);

-- A leave request covers a RANGE, so "on PTO today" is a range containment test rather than a
-- lookup by date. Only an approved request counts as leave; a pending one is a request.
CREATE TABLE IF NOT EXISTS pto_requests (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  leave_type  TEXT NOT NULL DEFAULT '',   -- hr_leave_type
  status      TEXT NOT NULL DEFAULT '',   -- hr_pto_status: PENDING, APPROVED, DENIED, CANCELLED
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  hours       NUMERIC(8,2),
  reason      TEXT NOT NULL DEFAULT '',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by  TEXT NOT NULL DEFAULT '',
  decided_at  TIMESTAMPTZ,
  CONSTRAINT pto_requests_dates CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_pto_requests_user ON pto_requests (user_id);
CREATE INDEX IF NOT EXISTS idx_pto_requests_range ON pto_requests (start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_pto_requests_status ON pto_requests (status);

-- Section 4 lists Holiday as a workforce status, which needs a calendar to derive it from.
CREATE TABLE IF NOT EXISTS company_holidays (
  holiday_date DATE PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- credentials and training (section 9) ----------

CREATE TABLE IF NOT EXISTS employee_credentials (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  credential_type TEXT NOT NULL DEFAULT '',
  identifier      TEXT NOT NULL DEFAULT '',
  issuing_body    TEXT NOT NULL DEFAULT '',
  issued_date     DATE,
  expiry_date     DATE,
  note            TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_credentials_user ON employee_credentials (user_id);
CREATE INDEX IF NOT EXISTS idx_employee_credentials_expiry ON employee_credentials (expiry_date);

CREATE TABLE IF NOT EXISTS employee_training (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  course         TEXT NOT NULL DEFAULT '',
  due_date       DATE,
  completed_date DATE,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_training_user ON employee_training (user_id);
CREATE INDEX IF NOT EXISTS idx_employee_training_due ON employee_training (due_date);

-- ---------- saved workforce views (section 18) ----------

CREATE TABLE IF NOT EXISTS hr_saved_views (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  filters    JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Section 18: a saved view belongs to its owner unless explicitly shared.
  shared     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_saved_views_owner_name
  ON hr_saved_views (user_id, lower(name));

-- ---------- configurable vocabularies ----------
--
-- Reuses workflow_statuses, which migration 009 already created for the clinical worklists, rather
-- than adding a second lookup mechanism. A practice renames or deactivates these rows instead of
-- editing code, which is what section 3 asks for.

INSERT INTO workflow_statuses (id, domain, code, label, sort_order, is_terminal, tone) VALUES
  ('hr_es_active',     'hr_employment_status', 'ACTIVE',     'Active',     10, FALSE, 'success'),
  ('hr_es_leave',      'hr_employment_status', 'ON_LEAVE',   'On Leave',   20, FALSE, 'warning'),
  ('hr_es_suspended',  'hr_employment_status', 'SUSPENDED',  'Suspended',  30, FALSE, 'warning'),
  ('hr_es_resigned',   'hr_employment_status', 'RESIGNED',   'Resigned',   40, TRUE,  'neutral'),
  ('hr_es_terminated', 'hr_employment_status', 'TERMINATED', 'Terminated', 50, TRUE,  'danger'),
  ('hr_es_retired',    'hr_employment_status', 'RETIRED',    'Retired',    60, TRUE,  'neutral'),

  ('hr_et_full',    'hr_employment_type', 'FULL_TIME', 'Full-Time', 10, FALSE, 'neutral'),
  ('hr_et_part',    'hr_employment_type', 'PART_TIME', 'Part-Time', 20, FALSE, 'neutral'),
  ('hr_et_contract','hr_employment_type', 'CONTRACT',  'Contract',  30, FALSE, 'neutral'),
  ('hr_et_temp',    'hr_employment_type', 'TEMPORARY', 'Temporary', 40, FALSE, 'neutral'),
  ('hr_et_intern',  'hr_employment_type', 'INTERN',    'Intern',    50, FALSE, 'neutral'),
  ('hr_et_perdiem', 'hr_employment_type', 'PER_DIEM',  'Per Diem',  60, FALSE, 'neutral'),

  ('hr_wa_onsite', 'hr_work_arrangement', 'ON_SITE', 'On-Site', 10, FALSE, 'neutral'),
  ('hr_wa_remote', 'hr_work_arrangement', 'REMOTE',  'Remote',  20, FALSE, 'info'),
  ('hr_wa_hybrid', 'hr_work_arrangement', 'HYBRID',  'Hybrid',  30, FALSE, 'info'),

  ('hr_at_present',   'hr_attendance', 'PRESENT',    'Present',    10, FALSE, 'success'),
  ('hr_at_late',      'hr_attendance', 'LATE',       'Late',       20, FALSE, 'warning'),
  ('hr_at_remote',    'hr_attendance', 'REMOTE',     'Remote',     30, FALSE, 'info'),
  ('hr_at_absent',    'hr_attendance', 'ABSENT',     'Absent',     40, FALSE, 'danger'),
  ('hr_at_calledoff', 'hr_attendance', 'CALLED_OFF', 'Called Off', 50, FALSE, 'danger'),
  ('hr_at_sick',      'hr_attendance', 'SICK',       'Sick',       60, FALSE, 'warning'),

  ('hr_pto_pending',   'hr_pto_status', 'PENDING',   'Pending',   10, FALSE, 'warning'),
  ('hr_pto_approved',  'hr_pto_status', 'APPROVED',  'Approved',  20, FALSE, 'success'),
  ('hr_pto_denied',    'hr_pto_status', 'DENIED',    'Denied',    30, TRUE,  'danger'),
  ('hr_pto_cancelled', 'hr_pto_status', 'CANCELLED', 'Cancelled', 40, TRUE,  'neutral'),

  ('hr_lt_pto',       'hr_leave_type', 'PTO',        'PTO',             10, FALSE, 'info'),
  ('hr_lt_sick',      'hr_leave_type', 'SICK',       'Sick Leave',      20, FALSE, 'warning'),
  ('hr_lt_unpaid',    'hr_leave_type', 'UNPAID',     'Unpaid Leave',    30, FALSE, 'neutral'),
  ('hr_lt_bereave',   'hr_leave_type', 'BEREAVEMENT','Bereavement',     40, FALSE, 'neutral'),
  ('hr_lt_parental',  'hr_leave_type', 'PARENTAL',   'Parental Leave',  50, FALSE, 'neutral'),
  ('hr_lt_jury',      'hr_leave_type', 'JURY_DUTY',  'Jury Duty',       60, FALSE, 'neutral')
ON CONFLICT (id) DO NOTHING;

-- Default shifts. Seeds, not a fixed vocabulary - see the note on hr_shifts.
INSERT INTO hr_shifts (id, name, start_time, end_time, sort_order) VALUES
  ('shift_morning', 'Morning', '08:00', '16:00', 10),
  ('shift_evening', 'Evening', '16:00', '00:00', 20),
  ('shift_night',   'Night',   '00:00', '08:00', 30)
ON CONFLICT (id) DO NOTHING;

-- ---------- navigation ----------
--
-- The "hr" tab, added the way migration 010 learned to: an INSERT for a role that has no row, plus
-- an idempotent UPDATE for one that does. Migration 010 seeded a role without the tab it needed and
-- the screen was invisible to everybody, so both halves are here deliberately.
--
-- Only these two roles get the tab. Seeing the tab is not the same as seeing the page: the
-- Workforce screen is gated on the per-user HR_WORKFORCE_VIEW grant, so adding the tab to a role
-- exposes nothing on its own.

UPDATE role_permissions
   SET tabs = tabs || '["hr"]'::jsonb
 WHERE id IN ('MANAGER', 'SUPER_ADMIN') AND NOT (tabs @> '["hr"]'::jsonb);
