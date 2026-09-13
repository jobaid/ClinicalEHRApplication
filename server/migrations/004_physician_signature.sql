-- Optional electronic signature for a physician, shown on generated patient statements.
--
-- Stored as a base64 data URL in a TEXT column rather than a file path or an object-store key.
-- That is this application's existing convention for images: insurance_policies.card_front /
-- card_back and id_documents.data already hold scans exactly this way, so statements reuse the
-- pattern instead of introducing file storage the deployment does not otherwise need.
--
-- Nullable and empty by default on purpose. A practice that has captured no signatures keeps
-- working, and the statement renderer prints a plain signature line for the physician to sign by
-- hand rather than inventing a signature image.
--
-- Rollback:
--   ALTER TABLE physicians DROP COLUMN IF EXISTS signature;

ALTER TABLE physicians ADD COLUMN IF NOT EXISTS signature TEXT NOT NULL DEFAULT '';
