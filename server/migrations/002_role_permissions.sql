-- Role -> tab permissions, editable by a Super Admin from Settings > Manage roles.
--
-- Before this table the grants lived in a hardcoded ROLE_TABS constant in src/app.jsx, which
-- meant changing what a role could reach was a code edit and a redeploy. The rows below seed
-- exactly the grants that constant had, so applying this migration changes nobody's access.
--
-- SUPER_ADMIN is stored for display but is never enforced from here: both the UI and
-- writeAllowed() treat that role as having everything, so an admin cannot lock themselves -
-- or the last remaining admin - out of the screen that hands access back.

CREATE TABLE IF NOT EXISTS role_permissions (
  id         TEXT PRIMARY KEY,
  tabs       JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by TEXT,
  updated_at TEXT,
  extra      JSONB NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO role_permissions (id, tabs) VALUES
  ('SUPER_ADMIN',  '["dashboard","schedule","patients","clinical","billing","claims","reports","users"]'::jsonb),
  ('MANAGER',      '["dashboard","schedule","patients","clinical","billing","claims","reports"]'::jsonb),
  ('NURSE',        '["dashboard","schedule","patients","clinical"]'::jsonb),
  ('RECEPTIONIST', '["dashboard","schedule","patients"]'::jsonb),
  ('BILLER',       '["dashboard","patients","billing","claims","reports"]'::jsonb)
ON CONFLICT (id) DO NOTHING;
