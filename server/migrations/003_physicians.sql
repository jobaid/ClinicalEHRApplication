-- Physician directory, editable by a Super Admin from Settings > Practice catalog.
--
-- Before this table the roster lived in two hardcoded constants in src/app.jsx - `providers`
-- (the dropdown list) and `providerNPI` (name -> NPI lookup). Adding a doctor, or correcting an
-- NPI after a payer rejected a claim on it, meant a code edit and a redeploy.
--
-- Keeping name and NPI in one row is the point: the two constants could drift apart, and a
-- provider whose name was in the dropdown but missing from providerNPI silently produced claims
-- with a blank Box 24J. A row cannot have half of itself.
--
-- The seed below is exactly what those constants held, so applying this migration changes
-- nothing that is already on screen.

CREATE TABLE IF NOT EXISTS physicians (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL DEFAULT '',
  npi       TEXT NOT NULL DEFAULT '',
  specialty TEXT NOT NULL DEFAULT '',
  active    BOOLEAN NOT NULL DEFAULT TRUE,
  extra     JSONB NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO physicians (id, name, npi, specialty) VALUES
  ('PHY-1001', 'Dr. S. Reyes',  '1912345678', 'Internal Medicine'),
  ('PHY-1002', 'Dr. A. Okafor', '1923456789', 'Family Medicine'),
  ('PHY-1003', 'Dr. M. Lin',    '1934567890', 'Cardiology')
ON CONFLICT (id) DO NOTHING;
