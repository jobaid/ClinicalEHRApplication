-- IP and device access control for the Super Admin.
--
-- Additive and idempotent. No existing table is altered, no row is deleted. The trusted_devices
-- table already models "which browsers has this user marked trusted"; this migration adds:
--   - ip_access_rules: allow / block rules on IP addresses or CIDR blocks, with optional expiry
--   - access_events:    a compact history of authenticated requests with the enforced decision
--   - vpn_ip_cache:     recent VPN / proxy / Tor lookups so the same IP is not queried repeatedly
--
-- Nothing here is enforced by the schema alone; enforcement lives in the middleware and admin
-- endpoints. See server/ipdevice.go.

CREATE TABLE IF NOT EXISTS ip_access_rules (
  id            TEXT PRIMARY KEY,
  cidr          TEXT NOT NULL,               -- "203.0.113.4" or "203.0.113.0/24" or "2001:db8::/32"
  mode          TEXT NOT NULL,               -- 'block' | 'allow'
  reason        TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,                 -- null = permanent
  revoked_at    TIMESTAMPTZ,                 -- null = still in force
  revoked_by    TEXT NOT NULL DEFAULT '',
  revoked_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ip_access_rules_active
  ON ip_access_rules (cidr) WHERE revoked_at IS NULL;

-- One row per authenticated request that reached a protected route, capped to a rolling window
-- by an out-of-band prune (see pruneAccessEvents). We do NOT log every unauthenticated hit -
-- that would fill the table with health checks and bot traffic.
CREATE TABLE IF NOT EXISTS access_events (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL DEFAULT '',
  user_email    TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT '',
  ip            TEXT NOT NULL DEFAULT '',
  ua_short      TEXT NOT NULL DEFAULT '',    -- normalised User-Agent, up to 400 chars
  action        TEXT NOT NULL DEFAULT '',    -- 'login' | 'request' | 'blocked_ip' | 'blocked_vpn'
  path          TEXT NOT NULL DEFAULT '',    -- routing path, no query string
  decision      TEXT NOT NULL DEFAULT '',    -- 'allow' | 'block' | 'unknown'
  vpn_status    TEXT NOT NULL DEFAULT '',    -- 'clean' | 'vpn' | 'proxy' | 'tor' | 'datacenter' | 'unknown' | 'unchecked'
  vpn_source    TEXT NOT NULL DEFAULT '',    -- provider name, when available
  reason        TEXT NOT NULL DEFAULT '',
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_access_events_at   ON access_events (at DESC);
CREATE INDEX IF NOT EXISTS idx_access_events_user ON access_events (user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_access_events_ip   ON access_events (ip, at DESC);

-- One row per IP looked up against the VPN provider. Cache TTL is enforced in code
-- (see vpnCacheTTL). Kept small; a lookup older than the TTL is refreshed on the next request.
CREATE TABLE IF NOT EXISTS vpn_ip_cache (
  ip            TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT '',    -- clean | vpn | proxy | tor | datacenter | unknown
  source        TEXT NOT NULL DEFAULT '',
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
