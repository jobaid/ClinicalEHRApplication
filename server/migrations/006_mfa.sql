-- Multi-factor authentication (TOTP) and 30-day trusted devices.
--
-- Two tables, deliberately separate from `users`: MFA enrolment and device trust are security
-- state with their own lifecycle, and ON DELETE CASCADE means removing an account takes its
-- authenticator secret and every trusted device with it rather than leaving orphans behind.

CREATE TABLE IF NOT EXISTS user_mfa (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- The TOTP shared secret, AES-256-GCM encrypted. Never stored in the clear: anyone holding it
  -- can generate valid codes forever, which makes it equivalent to the second factor itself.
  secret_enc   TEXT        NOT NULL,

  -- False between "enrolment started" and "first code verified". A half-finished enrolment must
  -- not lock anyone out, and must not count as a satisfied second factor.
  enabled      BOOLEAN     NOT NULL DEFAULT FALSE,
  enrolled_at  TIMESTAMPTZ,

  -- bcrypt hashes of single-use recovery codes, so a lost phone is recoverable without an
  -- administrator having to disable MFA for the account. Hashed for the same reason passwords
  -- are: a database leak must not yield usable credentials.
  backup_codes JSONB       NOT NULL DEFAULT '[]'::jsonb,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trusted_devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- SHA-256 of the token held by the browser, never the token itself. The server can verify a
  -- presented token but cannot reproduce one from the database, so a dump of this table does not
  -- let anyone skip MFA. Same reasoning as password_hash on users.
  token_hash   TEXT        NOT NULL UNIQUE,

  -- Shown on the Trusted Devices screen so a person can recognise which entry is which. This is
  -- the User-Agent string and nothing more: the browser cannot tell us anything about the
  -- hardware, and pretending otherwise would invite people to trust a guess.
  user_agent   TEXT        NOT NULL DEFAULT '',
  label        TEXT        NOT NULL DEFAULT '',

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,

  -- Hard stop. Checked on every use, so a row that outlives its window stops working whether or
  -- not anything ever sweeps the table.
  expires_at   TIMESTAMPTZ NOT NULL,

  -- Set rather than deleted, so "this device was revoked on the 3rd" stays answerable.
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS trusted_devices_user_idx ON trusted_devices (user_id);
CREATE INDEX IF NOT EXISTS trusted_devices_expiry_idx ON trusted_devices (expires_at);
