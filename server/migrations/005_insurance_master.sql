-- Master insurance list, plus the granular permissions that govern it.
--
-- Until now a patient's insurer was free text typed into insurance_policies.insurance_company,
-- with the payer ID typed beside it. Two billers spelling "UnitedHealthcare" differently produced
-- two payers as far as every report was concerned, and a wrong payer ID is a rejected claim.
-- This adds one authoritative row per insurer that policies point at.
--
-- ---------- Why the policy keeps its own copy of the payer details ----------
--
-- insurance_policies.insurance_company and .payer_id are NOT dropped, and the new
-- insurance_address is a third column of the same kind. They are a snapshot, deliberately.
-- A claim submitted last year was submitted to the address and payer ID that were correct last
-- year; if the master record is later corrected, the historical claim must still show what was
-- actually used. The master row is the source for NEW policies, not a live join for old ones.
-- payer_label() in src/app.jsx, the statement renderer and the claims screens all read the
-- snapshot columns, so they keep working unchanged for every row that predates this migration.
--
-- Rollback:
--   ALTER TABLE insurance_policies DROP COLUMN IF EXISTS insurance_id, DROP COLUMN IF EXISTS insurance_address;
--   ALTER TABLE role_permissions   DROP COLUMN IF EXISTS permissions;
--   DROP TABLE IF EXISTS insurance;

-- ---------- 1. The master list ----------

CREATE TABLE IF NOT EXISTS insurance (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  payer_id   TEXT NOT NULL DEFAULT '',
  address    TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  website    TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  -- 'Active' | 'Inactive'. Inactive stays selectable nowhere new but keeps rendering on the
  -- policies that already reference it - this is the app's standard soft-delete, the same one
  -- the physician and CPT catalogues use.
  status     TEXT NOT NULL DEFAULT 'Active',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  extra      JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Duplicate prevention, enforced by the database rather than only by the form.
-- Case- and space-insensitive on the name, because "Aetna" and "aetna " are the same payer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_insurance_name_unique
  ON insurance (lower(btrim(name)));

-- Payer IDs are unique where present, but blank is allowed and must not collide with itself -
-- some smaller payers genuinely have none on file, hence the partial index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_insurance_payer_unique
  ON insurance (btrim(payer_id)) WHERE btrim(payer_id) <> '';

CREATE INDEX IF NOT EXISTS idx_insurance_status ON insurance (status);

-- ---------- 2. Link patient policies to it ----------

ALTER TABLE insurance_policies ADD COLUMN IF NOT EXISTS insurance_id      TEXT;
ALTER TABLE insurance_policies ADD COLUMN IF NOT EXISTS insurance_address TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_policies_insurance ON insurance_policies (insurance_id);

-- ---------- 3. Backfill, without losing anything ----------
--
-- Every distinct insurer already typed into a policy becomes a master row, so the existing data
-- is the seed for the master list rather than being stranded beside it. Nothing is invented: the
-- names and payer IDs come from the rows themselves.
--
-- DISTINCT ON collapses spelling variants that differ only by case or padding onto one row, which
-- is what the unique index requires; the first spelling encountered wins and an administrator can
-- correct it afterwards in Settings > Insurance Management.
INSERT INTO insurance (id, name, payer_id, status, created_by, created_at, updated_at)
SELECT
  'INS-' || upper(substr(md5(lower(btrim(insurance_company))), 1, 10)),
  btrim(insurance_company),
  COALESCE(max_payer, ''),
  'Active',
  'migration 005',
  to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS'),
  to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS')
FROM (
  SELECT DISTINCT ON (lower(btrim(insurance_company)))
         insurance_company,
         -- If the same insurer was typed with different payer IDs, take the most common one
         -- rather than an arbitrary row.
         (SELECT p2.payer_id
            FROM insurance_policies p2
           WHERE lower(btrim(p2.insurance_company)) = lower(btrim(p1.insurance_company))
             AND btrim(p2.payer_id) <> ''
           GROUP BY p2.payer_id
           ORDER BY count(*) DESC, p2.payer_id
           LIMIT 1) AS max_payer
    FROM insurance_policies p1
   WHERE btrim(insurance_company) <> ''
   ORDER BY lower(btrim(insurance_company)), insurance_company
) src
ON CONFLICT DO NOTHING;

-- Point each existing policy at the master row matching the name it already carries. Policies
-- whose insurer is blank keep a NULL insurance_id and go on displaying exactly what they hold
-- today - unmatched rows are left alone rather than guessed at.
UPDATE insurance_policies p
   SET insurance_id = i.id
  FROM insurance i
 WHERE p.insurance_id IS NULL
   AND lower(btrim(p.insurance_company)) = lower(btrim(i.name));

-- ---------- 4. Granular permissions ----------
--
-- role_permissions.tabs governs which SCREENS a role can open, and stays exactly as it was. This
-- second column governs individual ACTIONS, which tabs cannot express: "may see the master
-- insurance list but may not edit it" is one tab and four different answers.
--
-- Empty for every role by default, so this migration grants nobody anything new. SUPER_ADMIN is
-- not stored here at all - it holds every permission implicitly, the same way it holds every tab,
-- so an administrator cannot revoke their own ability to grant permissions back.
ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]'::jsonb;
