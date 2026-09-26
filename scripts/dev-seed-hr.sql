-- DEVELOPMENT SEED DATA - NOT A MIGRATION. NEVER RUN THIS AGAINST PRODUCTION.
--
-- This file is NOT in server/migrations/, so the server never applies it automatically. It exists
-- to put enough sample staff into a local database that the Workforce screen can be clicked
-- through, because an empty workforce is not much to look at.
--
-- HOW THE SAMPLE ACCOUNTS ARE MADE SAFE
--
-- An employee is a user in this application, so seeding staff necessarily creates login rows. Three
-- things make these unusable as logins, not one:
--
--   disabled = TRUE     authenticate() refuses a disabled account, and every request re-reads the
--                       flag, so even a token minted earlier stops working
--   password_hash NULL  there is no password that verifies
--   @seed.invalid       .invalid is a reserved TLD that can never resolve, so no message can ever
--                       be delivered to one of these addresses by accident
--
-- They are also tagged extra->>'seeded' = 'dev', which is what scripts/dev-unseed-hr.sql matches on.
-- Remove them with that script before this database is used for anything real.
--
-- Re-running is safe: every statement is idempotent.

\echo 'Seeding DEVELOPMENT HR sample data. Do not run this against production.'

-- ---------- org structure ----------

INSERT INTO hr_departments (id, name, code) VALUES
  ('dep_bill', 'Billing', 'BIL'),
  ('dep_hr',   'HR',      'HR'),
  ('dep_it',   'IT',      'IT'),
  ('dep_clin', 'Clinical','CLIN'),
  ('dep_front','Front Desk','FD')
ON CONFLICT (id) DO NOTHING;

INSERT INTO hr_job_titles (id, name) VALUES
  ('jt_lead',     'Team Lead'),
  ('jt_biller',   'Billing Specialist'),
  ('jt_coder',    'Medical Coder'),
  ('jt_hrgen',    'HR Generalist'),
  ('jt_sysadmin', 'Systems Administrator'),
  ('jt_nurse',    'Registered Nurse'),
  ('jt_ma',       'Medical Assistant'),
  ('jt_recep',    'Receptionist')
ON CONFLICT (id) DO NOTHING;

INSERT INTO hr_work_locations (id, name, city, state) VALUES
  ('loc_ny',  'Main Clinic',   'New York', 'NY'),
  ('loc_bos', 'North Branch',  'Boston',   'MA'),
  ('loc_rem', 'Remote',        '',         '')
ON CONFLICT (id) DO NOTHING;

-- ---------- sample staff ----------
--
-- Fourteen people, spread across departments, locations, shifts, employment types and tenures, so
-- every filter on the Workforce screen has something to find.

INSERT INTO users (id, email, name, role, password_algo, password_hash, disabled, extra)
VALUES
  ('SEED-EMP01','john.smith@seed.invalid',    'John Smith',    'BILLER',      'bcrypt', NULL, TRUE, '{"seeded":"dev"}'::jsonb),
  ('SEED-EMP02','mary.jones@seed.invalid',    'Mary Jones',    'BILLER',      'bcrypt', NULL, TRUE, '{"seeded":"dev"}'::jsonb),
  ('SEED-EMP03','david.lee@seed.invalid',     'David Lee',     'BILLER',      'bcrypt', NULL, TRUE, '{"seeded":"dev"}'::jsonb),
  ('SEED-EMP04','sarah.brown@seed.invalid',   'Sarah Brown',   'BILLER',      'bcrypt', NULL, TRUE, '{"seeded":"dev"}'::jsonb),
  ('SEED-EMP05','aisha.khan@seed.invalid',    'Aisha Khan',    'MANAGER',     'bcrypt', NULL, TRUE, '{"seeded":"dev"}'::jsonb),
  ('SEED-EMP06','tom.nguyen@seed.invalid',    'Tom Nguyen',    'MANAGER',     'bcrypt', NULL, TRUE, '{"seeded":"dev"}'::jsonb),
  ('SEED-EMP07','priya.patel@seed.invalid',   'Priya Patel',   'BILLER',      'bcrypt', NULL, TRUE, '{"seeded":"dev"}'::jsonb),
  ('SEED-EMP08','carlos.diaz@seed.invalid',   'Carlos Diaz',   'BILLER',      'bcrypt', NULL, TRUE, '{"seeded":"dev"}'::jsonb),
  ('SEED-EMP09','emma.wilson@seed.invalid',   'Emma Wilson',   'NURSE',       'bcrypt', NULL, TRUE, '{"seeded":"dev"}'::jsonb),
  ('SEED-EMP10','noah.clark@seed.invalid',    'Noah Clark',    'NURSE',       'bcrypt', NULL, TRUE, '{"seeded":"dev"}'::jsonb),
  ('SEED-EMP11','grace.kim@seed.invalid',     'Grace Kim',     'NURSE',       'bcrypt', NULL, TRUE, '{"seeded":"dev"}'::jsonb),
  ('SEED-EMP12','omar.haddad@seed.invalid',   'Omar Haddad',   'BILLER',      'bcrypt', NULL, TRUE, '{"seeded":"dev"}'::jsonb),
  ('SEED-EMP13','lucy.turner@seed.invalid',   'Lucy Turner',   'RECEPTIONIST','bcrypt', NULL, TRUE, '{"seeded":"dev"}'::jsonb),
  ('SEED-EMP14','marcus.reid@seed.invalid',   'Marcus Reid',   'NURSE',       'bcrypt', NULL, TRUE, '{"seeded":"dev"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO employees (user_id, employee_no, department_id, job_title_id, location_id,
                       manager_user_id, employment_type, employment_status, work_arrangement,
                       default_shift_id, hire_date, work_phone)
VALUES
  ('SEED-EMP01','E-1001','dep_bill', 'jt_lead',    'loc_ny', NULL,          'FULL_TIME','ACTIVE','ON_SITE','shift_morning','2020-01-15','212-555-0101'),
  ('SEED-EMP02','E-1002','dep_bill', 'jt_biller',  'loc_ny', 'SEED-EMP01',  'FULL_TIME','ACTIVE','ON_SITE','shift_morning','2023-06-01','212-555-0102'),
  ('SEED-EMP03','E-1003','dep_bill', 'jt_coder',   'loc_ny', 'SEED-EMP01',  'PART_TIME','ACTIVE','ON_SITE','shift_morning',CURRENT_DATE - 25,'212-555-0103'),
  ('SEED-EMP04','E-1004','dep_bill', 'jt_biller',  'loc_bos','SEED-EMP01',  'FULL_TIME','ACTIVE','ON_SITE','shift_morning','2019-03-10','617-555-0104'),
  ('SEED-EMP05','E-1005','dep_hr',   'jt_hrgen',   'loc_ny', NULL,          'FULL_TIME','ACTIVE','ON_SITE','shift_morning','2021-05-20','212-555-0105'),
  ('SEED-EMP06','E-1006','dep_hr',   'jt_hrgen',   'loc_ny', 'SEED-EMP05',  'FULL_TIME','ACTIVE','HYBRID', 'shift_morning','2024-02-01','212-555-0106'),
  ('SEED-EMP07','E-1007','dep_it',   'jt_sysadmin','loc_rem','SEED-EMP05',  'FULL_TIME','ACTIVE','REMOTE', 'shift_morning','2022-08-15','212-555-0107'),
  ('SEED-EMP08','E-1008','dep_it',   'jt_sysadmin','loc_bos','SEED-EMP05',  'FULL_TIME','ACTIVE','ON_SITE','shift_evening','2018-11-01','617-555-0108'),
  ('SEED-EMP09','E-1009','dep_clin', 'jt_nurse',   'loc_ny', 'SEED-EMP01',  'PART_TIME','ACTIVE','ON_SITE','shift_night',  '2025-01-10','212-555-0109'),
  ('SEED-EMP10','E-1010','dep_clin', 'jt_ma',      'loc_ny', 'SEED-EMP01',  'PER_DIEM', 'ACTIVE','ON_SITE',NULL,           CURRENT_DATE - 5,'212-555-0110'),
  ('SEED-EMP11','E-1011','dep_clin', 'jt_nurse',   'loc_bos','SEED-EMP01',  'FULL_TIME','ACTIVE','ON_SITE','shift_morning','2017-04-01','617-555-0111'),
  ('SEED-EMP12','E-1012','dep_it',   'jt_sysadmin','loc_rem','SEED-EMP05',  'CONTRACT', 'ACTIVE','REMOTE', 'shift_morning',CURRENT_DATE - 117,'212-555-0112'),
  ('SEED-EMP13','E-1013','dep_front','jt_recep',   'loc_ny', 'SEED-EMP05',  'FULL_TIME','ACTIVE','ON_SITE','shift_morning','2023-09-12','212-555-0113'),
  ('SEED-EMP14','E-1014','dep_clin', 'jt_nurse',   'loc_ny', 'SEED-EMP01',  'FULL_TIME','ON_LEAVE','ON_SITE','shift_evening','2022-02-28','212-555-0114')
ON CONFLICT (user_id) DO NOTHING;

-- ---------- a fortnight of rota ----------
--
-- Generated around today rather than written out, so the screen has something to show on whatever
-- date it is opened.
--
-- TODAY is always a working day for everyone except the two people who are meant to read as off.
-- The obvious alternative - roster the weekend off - makes the screen useless exactly when it is
-- opened on a Saturday, and it also contradicts the attendance rows below: somebody cannot be
-- Present on a day they were rostered off. Other days follow a normal Monday-to-Friday week, which
-- is what keeps the Day off filter meaningful.

INSERT INTO employee_schedules (id, user_id, work_date, shift_id, start_time, end_time, is_day_off)
SELECT
  'SEEDSCH-' || e.user_id || '-' || to_char(d::date, 'YYYYMMDD'),
  e.user_id,
  d::date,
  e.default_shift_id,
  CASE WHEN off.v THEN NULL ELSE sh.start_time END,
  CASE WHEN off.v THEN NULL ELSE sh.end_time   END,
  off.v
FROM employees e
JOIN hr_shifts sh ON sh.id = e.default_shift_id
CROSS JOIN generate_series(CURRENT_DATE - 7, CURRENT_DATE + 7, interval '1 day') d
CROSS JOIN LATERAL (SELECT
  CASE WHEN d::date = CURRENT_DATE
       THEN e.user_id IN ('SEED-EMP04','SEED-EMP10')
       ELSE extract(isodow FROM d) >= 6
  END AS v) off
WHERE e.user_id LIKE 'SEED-%'
ON CONFLICT (id) DO NOTHING;

-- ---------- today's attendance ----------
--
-- Chosen so every quick filter on the Workforce screen has at least one person behind it, and so
-- the derived-status precedence is visible: EMP14 is on sick leave AND has no attendance row, which
-- must read as Sick rather than as Not clocked in.

INSERT INTO employee_attendance (id, user_id, work_date, status, clock_in, minutes_late)
VALUES
  ('SEEDATT01','SEED-EMP01',CURRENT_DATE,'PRESENT',    now() - interval '3 hours', NULL),
  ('SEEDATT02','SEED-EMP02',CURRENT_DATE,'LATE',       now() - interval '2 hours', 22),
  ('SEEDATT03','SEED-EMP03',CURRENT_DATE,'ABSENT',     NULL, NULL),
  ('SEEDATT07','SEED-EMP07',CURRENT_DATE,'REMOTE',     now() - interval '4 hours', NULL),
  ('SEEDATT08','SEED-EMP08',CURRENT_DATE,'CALLED_OFF', NULL, NULL),
  ('SEEDATT09','SEED-EMP09',CURRENT_DATE,'PRESENT',    now() - interval '8 hours', NULL),
  ('SEEDATT12','SEED-EMP12',CURRENT_DATE,'PRESENT',    now() - interval '3 hours', NULL),
  ('SEEDATT13','SEED-EMP13',CURRENT_DATE,'PRESENT',    now() - interval '5 hours', NULL)
ON CONFLICT (id) DO NOTHING;

-- ---------- leave ----------

INSERT INTO pto_requests (id, user_id, leave_type, status, start_date, end_date, hours)
VALUES
  ('SEEDPTO01','SEED-EMP05','PTO', 'APPROVED', CURRENT_DATE - 1, CURRENT_DATE + 2, 32),
  ('SEEDPTO02','SEED-EMP11','SICK','APPROVED', CURRENT_DATE,     CURRENT_DATE,      8),
  ('SEEDPTO03','SEED-EMP14','SICK','APPROVED', CURRENT_DATE - 3, CURRENT_DATE + 10,80),
  ('SEEDPTO04','SEED-EMP09','PTO', 'PENDING',  CURRENT_DATE + 20,CURRENT_DATE + 24,40),
  ('SEEDPTO05','SEED-EMP02','PTO', 'PENDING',  CURRENT_DATE + 30,CURRENT_DATE + 31,16),
  ('SEEDPTO06','SEED-EMP12','PTO', 'APPROVED', CURRENT_DATE + 8, CURRENT_DATE + 10,24)
ON CONFLICT (id) DO NOTHING;

-- ---------- credentials and training ----------

INSERT INTO employee_credentials (id, user_id, credential_type, identifier, issuing_body, expiry_date)
VALUES
  ('SEEDCRD01','SEED-EMP09','RN Licence',       'RN-99120','State Board',  CURRENT_DATE + 45),
  ('SEEDCRD02','SEED-EMP11','RN Licence',       'RN-77431','State Board',  CURRENT_DATE - 12),
  ('SEEDCRD03','SEED-EMP14','RN Licence',       'RN-51002','State Board',  CURRENT_DATE + 20),
  ('SEEDCRD04','SEED-EMP01','CPR Certification','CPR-4410','Red Cross',    CURRENT_DATE + 200),
  ('SEEDCRD05','SEED-EMP10','CPR Certification','CPR-8821','Red Cross',    CURRENT_DATE + 6)
ON CONFLICT (id) DO NOTHING;

INSERT INTO employee_training (id, user_id, course, due_date, completed_date)
VALUES
  ('SEEDTRN01','SEED-EMP03','HIPAA Annual',       CURRENT_DATE - 5,  NULL),
  ('SEEDTRN02','SEED-EMP06','HIPAA Annual',       CURRENT_DATE + 10, NULL),
  ('SEEDTRN03','SEED-EMP13','HIPAA Annual',       CURRENT_DATE + 25, NULL),
  ('SEEDTRN04','SEED-EMP01','HIPAA Annual',       CURRENT_DATE - 30, CURRENT_DATE - 31),
  ('SEEDTRN05','SEED-EMP08','Security Awareness', CURRENT_DATE - 2,  NULL)
ON CONFLICT (id) DO NOTHING;

\echo 'Done. Sign in as your usual admin account and open HR -> Workforce.'
\echo 'To remove all of it: psql -f scripts/dev-unseed-hr.sql'
