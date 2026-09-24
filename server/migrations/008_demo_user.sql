-- Demo account marker.
--
-- Forward-only and purely additive: one nullable-by-default flag on an existing table. It adds
-- no constraint that existing rows could violate, drops nothing, rewrites nothing, and every
-- existing user keeps every value they had - they simply become explicitly is_demo = FALSE,
-- which is what they already were implicitly.
--
-- On PostgreSQL 11 and later, ADD COLUMN with a non-volatile DEFAULT is a catalogue-only change:
-- the table is not rewritten and no long lock is held, so this is safe to run against a live
-- production database with real patient records in it.
--
-- Deliberately NOT exposed through the collections API. is_demo is absent from the users
-- collection's field list in server/schema.go, so no request to /api/collections/users can set
-- or clear it. The flag is writable only by this migration and by the startup seeder in
-- server/demo.go - which means a signed-in user cannot mark their own account as a demo account
-- and thereby exempt themselves from multi-factor authentication.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index: the demo accounts are a handful of rows at most, and this is read on every
-- sign-in. Indexing only the TRUE rows keeps it to a page or two regardless of how many real
-- accounts the practice grows to.
CREATE INDEX IF NOT EXISTS users_is_demo_idx ON users (is_demo) WHERE is_demo;
