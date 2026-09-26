-- Removes everything scripts/dev-seed-clinical.sql created. Safe to run more than once.
--
-- Matches only ids beginning SEED, so it cannot touch a real worklist entry or a real review.
-- It creates no patients and deletes none.

\echo 'Removing DEVELOPMENT HIM and Antimicrobial sample data.'

DELETE FROM him_provider_queries       WHERE id LIKE 'SEED%' OR worklist_id LIKE 'SEEDHIM%';
DELETE FROM him_procedure_codes        WHERE id LIKE 'SEED%' OR worklist_id LIKE 'SEEDHIM%';
DELETE FROM him_diagnosis_codes        WHERE id LIKE 'SEED%' OR worklist_id LIKE 'SEEDHIM%';
DELETE FROM him_assignments            WHERE worklist_id LIKE 'SEEDHIM%';
DELETE FROM him_activity               WHERE worklist_id LIKE 'SEEDHIM%';
DELETE FROM him_worklist               WHERE id LIKE 'SEEDHIM%';

DELETE FROM antimicrobial_review_entries WHERE id LIKE 'SEED%' OR review_id LIKE 'SEEDAM%';
DELETE FROM antimicrobial_reviews        WHERE id LIKE 'SEEDAM%';

\echo 'Done.'
