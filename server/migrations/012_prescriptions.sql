-- Prescriptions, pharmacies and prescriber eligibility.
--
-- Forward-only and additive. CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS only.
-- Nothing is dropped, altered, truncated or deleted, and no existing table is modified, so this
-- is safe against the live database and safe to re-run on every boot.
--
-- No foreign keys to patients, users or physicians, consistent with 007 through 011: medbill.sql
-- is restored over the live database and drops those tables without CASCADE.
--
-- WHAT THIS DOES NOT PRETEND TO BE
--
-- This application has no e-prescribing network, no licensed drug database and no interaction
-- checking service. Transmission to a real pharmacy goes through Surescripts, which is a
-- commercial contract and a certification process, not an endpoint. So these tables record what
-- a prescriber wrote and what happened to it - they do not imply that anything reached a
-- pharmacy. A prescription only ever reaches a status the transmission layer actually returned;
-- see eprescribing.go, whose default provider refuses to transmit and says so.

-- ---------- pharmacies ----------
--
-- A pharmacy that can be TRANSMITTED to must carry the identifier its network knows it by - for
-- Surescripts that is the NCPDP ID. Until a provider is configured there is nothing to populate
-- it from, so the column exists, stays empty, and is what the transmission layer checks before
-- it will consider a prescription sendable. A name typed into a box is an address book entry,
-- not a routing destination, and section 5 is explicit about the difference.
CREATE TABLE IF NOT EXISTS pharmacies (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL DEFAULT '',
  address  TEXT NOT NULL DEFAULT '',
  city     TEXT NOT NULL DEFAULT '',
  state    TEXT NOT NULL DEFAULT '',
  zip      TEXT NOT NULL DEFAULT '',
  phone    TEXT NOT NULL DEFAULT '',
  fax      TEXT NOT NULL DEFAULT '',

  -- The network identifier. Empty means "not reachable electronically".
  ncpdp_id TEXT NOT NULL DEFAULT '',
  npi      TEXT NOT NULL DEFAULT '',

  -- Where this row came from: 'manual' (typed by staff) or the name of the directory service
  -- that returned it. A manually typed pharmacy is never treated as transmittable.
  source   TEXT NOT NULL DEFAULT 'manual',
  active   BOOLEAN NOT NULL DEFAULT TRUE,

  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  extra      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS pharmacies_name_idx  ON pharmacies (lower(name));
CREATE INDEX IF NOT EXISTS pharmacies_ncpdp_idx ON pharmacies (ncpdp_id) WHERE ncpdp_id <> '';

-- One preferred pharmacy per patient. Changing it rewrites this row only; prescriptions keep
-- their own pharmacy reference, so history is unaffected - section 6.
CREATE TABLE IF NOT EXISTS patient_pharmacies (
  patient_id  TEXT PRIMARY KEY,
  pharmacy_id TEXT NOT NULL,
  updated_by  TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- prescriber eligibility ----------
--
-- Section 19: an application permission is not a licence to prescribe. RX_SIGN says the software
-- will let you press the button; this table says whether the person behind it is someone a
-- pharmacy would accept a prescription from. Both are required, and they are deliberately
-- separate records maintained by different people - a Super Admin grants the permission, a
-- practice administrator records the credential.
--
-- No DEA number column. Storing one would imply this application is ready to prescribe
-- controlled substances, and it is not: that needs an EPCS-certified solution with DEA identity
-- proofing and two-factor signing (section 20). The column arrives with that integration or not
-- at all.
CREATE TABLE IF NOT EXISTS prescriber_profiles (
  user_id      TEXT PRIMARY KEY,

  -- Links to the existing physicians row where one exists, rather than copying the roster.
  physician_id TEXT NOT NULL DEFAULT '',

  npi          TEXT NOT NULL DEFAULT '',
  state_license TEXT NOT NULL DEFAULT '',
  license_state TEXT NOT NULL DEFAULT '',

  -- Set by a person who checked, not by signing up. Nothing here is self-asserted.
  verified     BOOLEAN NOT NULL DEFAULT FALSE,
  verified_by  TEXT NOT NULL DEFAULT '',
  verified_at  TIMESTAMPTZ,

  active       BOOLEAN NOT NULL DEFAULT TRUE,
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- prescriptions ----------
CREATE TABLE IF NOT EXISTS prescriptions (
  id         TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,

  -- Everything below is what the PRESCRIBER entered. Nothing is suggested, defaulted or
  -- completed by the application: section 4 is explicit that the medication, dose, quantity,
  -- frequency and duration are the prescriber's decision, and with no licensed drug database
  -- there is nothing this software could responsibly propose anyway.
  medication  TEXT NOT NULL DEFAULT '',
  strength    TEXT NOT NULL DEFAULT '',
  dose        TEXT NOT NULL DEFAULT '',
  route       TEXT NOT NULL DEFAULT '',
  frequency   TEXT NOT NULL DEFAULT '',
  quantity    TEXT NOT NULL DEFAULT '',
  days_supply TEXT NOT NULL DEFAULT '',
  refills     TEXT NOT NULL DEFAULT '0',
  start_date  TEXT NOT NULL DEFAULT '',
  sig         TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',

  -- Recorded as the prescriber answered it, because it changes what may lawfully happen next.
  -- A prescription marked controlled can be drafted and printed but never transmitted here.
  is_controlled BOOLEAN NOT NULL DEFAULT FALSE,

  pharmacy_id TEXT NOT NULL DEFAULT '',

  -- The prescriber is resolved from the authenticated session at signing time and stored here.
  -- Section 22: a prescriberId sent by the browser is never trusted.
  prescriber_user_id TEXT NOT NULL DEFAULT '',
  prescriber_name    TEXT NOT NULL DEFAULT '',
  prescriber_npi     TEXT NOT NULL DEFAULT '',

  -- DRAFT | READY_TO_SIGN | SIGNED | SUBMITTED | ACCEPTED | FAILED | CANCELLED
  --
  -- SUBMITTED and beyond are only ever written by the transmission layer in response to what a
  -- provider actually returned. Nothing in this application moves a prescription to ACCEPTED on
  -- its own - section 10.
  status TEXT NOT NULL DEFAULT 'DRAFT',

  signed_by   TEXT NOT NULL DEFAULT '',
  signed_at   TIMESTAMPTZ,

  -- What the transmission attempt produced, verbatim, so a failure can be explained rather than
  -- summarised as "something went wrong".
  transmission_provider TEXT NOT NULL DEFAULT '',
  transmission_ref      TEXT NOT NULL DEFAULT '',
  transmission_error    TEXT NOT NULL DEFAULT '',
  transmitted_at        TIMESTAMPTZ,

  cancelled_by     TEXT NOT NULL DEFAULT '',
  cancelled_at     TIMESTAMPTZ,
  cancelled_reason TEXT NOT NULL DEFAULT '',

  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  extra      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS prescriptions_patient_idx ON prescriptions (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS prescriptions_status_idx  ON prescriptions (status);

-- Append-only. Section 13: once signed or transmitted a prescription is not silently rewritten,
-- and this is the record that makes that verifiable.
CREATE TABLE IF NOT EXISTS prescription_status_history (
  id              TEXT PRIMARY KEY,
  prescription_id TEXT NOT NULL,
  from_status     TEXT NOT NULL DEFAULT '',
  to_status       TEXT NOT NULL DEFAULT '',
  actor_id        TEXT NOT NULL DEFAULT '',
  actor_name      TEXT NOT NULL DEFAULT '',
  detail          TEXT NOT NULL DEFAULT '',
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rx_history_idx ON prescription_status_history (prescription_id, at DESC);
