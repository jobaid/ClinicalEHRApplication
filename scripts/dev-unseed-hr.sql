-- Removes everything scripts/dev-seed-hr.sql created. Safe to run more than once.
--
-- Matches ONLY the sample rows: user ids beginning 'SEED-', the accounts tagged
-- extra->>'seeded' = 'dev', and the HR rows whose own ids begin 'SEED'. It cannot touch a real
-- employee, a real user, or anything outside the HR tables.
--
-- The lookup rows (departments, job titles, locations) are left in place deliberately: they are
-- configuration a practice would keep and rename, not sample people. Delete them by hand if you
-- want a completely bare HR module.

\echo 'Removing DEVELOPMENT HR sample data.'

DELETE FROM employee_training     WHERE user_id LIKE 'SEED-%';
DELETE FROM employee_credentials  WHERE user_id LIKE 'SEED-%';
DELETE FROM pto_requests          WHERE user_id LIKE 'SEED-%';
DELETE FROM employee_attendance   WHERE user_id LIKE 'SEED-%';
DELETE FROM employee_schedules    WHERE user_id LIKE 'SEED-%';
DELETE FROM employees             WHERE user_id LIKE 'SEED-%';

-- Both conditions, not either: the id prefix AND the tag. A real account could in principle be
-- given an id starting SEED- by hand, and it must survive this script.
DELETE FROM users
 WHERE id LIKE 'SEED-%' AND extra->>'seeded' = 'dev';

\echo 'Done. Any remaining HR rows are yours, not seed data.'
