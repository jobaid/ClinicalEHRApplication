-- Backup & Restore, and the per-user grants that govern who may use it.
--
-- Every statement here is idempotent. The server runs this file at startup (see
-- ensureBackupSchema in backup.go) as well as it being applied by the initdb mount on a fresh
-- database, so it must be safe to execute against a database that already has all of it.
--
-- Deliberately NO foreign keys to users(id). The operational reality of this deployment is that
-- medbill.sql gets restored over the top of a live database, and that dump begins with
-- `DROP TABLE IF EXISTS public.users;` without CASCADE. A dependent foreign key would make that
-- statement fail outright and break the restore. Grants are therefore joined to users at read
-- time; a user_id that no longer resolves simply yields no permissions, which is the safe
-- direction to fail.

-- ---------- per-user action grants ----------
--
-- role_permissions answers "what may this ROLE do" and is left exactly as it is (the existing
-- insurance.* grants live there). Backup access cannot be expressed that way: section 56 of the
-- specification requires two people holding the same MANAGER role to be able to have different
-- backup permissions. So this table adds a per-USER layer over the same permission machinery -
-- same allowlist, same sanitiser, same fail-closed cache - rather than a second system.
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id     TEXT PRIMARY KEY,
  permissions JSONB       NOT NULL DEFAULT '[]'::jsonb,
  updated_by  TEXT        NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- backup catalogue ----------
--
-- One row per backup file on disk. The row is written BEFORE the dump starts, with status
-- 'running', so a dump that is killed halfway leaves visible evidence rather than a silent gap.
CREATE TABLE IF NOT EXISTS backups (
  id           TEXT PRIMARY KEY,
  filename     TEXT        NOT NULL,

  -- 'custom' (pg_dump -Fc, what we create) or 'plain' (a .sql file, which uploads may be).
  -- Restore dispatches on this, so it is stored rather than guessed from the extension.
  format       TEXT        NOT NULL DEFAULT 'custom',

  -- 'manual' | 'scheduled' | 'uploaded'. Retention only ever deletes 'scheduled' backups: a
  -- file someone made or uploaded on purpose must not vanish because a timer decided it was old.
  kind         TEXT        NOT NULL DEFAULT 'manual',

  -- 'running' | 'complete' | 'failed'
  status       TEXT        NOT NULL DEFAULT 'running',

  size_bytes   BIGINT      NOT NULL DEFAULT 0,

  -- Recorded at creation and re-checked before a restore. A backup that has been altered or
  -- truncated on disk is worse than no backup, because it is trusted.
  sha256       TEXT        NOT NULL DEFAULT '',

  note         TEXT        NOT NULL DEFAULT '',
  error        TEXT        NOT NULL DEFAULT '',

  created_by   TEXT        NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS backups_created_idx ON backups (created_at DESC);
CREATE INDEX IF NOT EXISTS backups_kind_idx    ON backups (kind, created_at DESC);

-- ---------- automatic backup configuration ----------
--
-- A single row. The CHECK keeps it that way: a second configuration row would mean the scheduler
-- silently picks one of two answers depending on row order.
CREATE TABLE IF NOT EXISTS backup_settings (
  id              TEXT        PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  auto_enabled    BOOLEAN     NOT NULL DEFAULT FALSE,

  -- 'daily' | 'weekly'
  frequency       TEXT        NOT NULL DEFAULT 'daily',

  -- Stored in UTC, because the server's local zone is a deployment detail that changes when the
  -- host does, and a backup window that silently shifts by an hour twice a year is a support
  -- ticket nobody enjoys. The UI converts for display.
  hour_utc        SMALLINT    NOT NULL DEFAULT 2  CHECK (hour_utc   BETWEEN 0 AND 23),
  minute_utc      SMALLINT    NOT NULL DEFAULT 0  CHECK (minute_utc BETWEEN 0 AND 59),

  -- 0 = Sunday. Only consulted when frequency = 'weekly'.
  weekday         SMALLINT    NOT NULL DEFAULT 0  CHECK (weekday BETWEEN 0 AND 6),

  -- Retention is the AND of both limits: a scheduled backup is removed once it is both older
  -- than retention_days and outside the newest retention_count. Either alone is a foot-gun -
  -- a count alone discards history after a busy week, days alone can leave nothing at all.
  retention_count INT         NOT NULL DEFAULT 7  CHECK (retention_count BETWEEN 1 AND 365),
  retention_days  INT         NOT NULL DEFAULT 30 CHECK (retention_days  BETWEEN 1 AND 3650),

  last_run_at     TIMESTAMPTZ,
  updated_by      TEXT        NOT NULL DEFAULT '',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO backup_settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

-- ---------- permission change history ----------
--
-- Section 58 wants a read-only history of who granted what to whom. This is its own table rather
-- than audit_logs because audit_logs is patient-scoped (it has a patient_id and is read through
-- the patient chart); an administrative grant has no patient and would be invisible there.
-- Backup OPERATIONS still write to the existing audit trail - only the grant history lives here.
CREATE TABLE IF NOT EXISTS backup_permission_history (
  id          TEXT        PRIMARY KEY,
  actor_id    TEXT        NOT NULL DEFAULT '',
  actor_name  TEXT        NOT NULL DEFAULT '',
  target_id   TEXT        NOT NULL DEFAULT '',
  target_name TEXT        NOT NULL DEFAULT '',

  -- BACKUP_PERMISSION_GRANTED | BACKUP_PERMISSION_REVOKED | BACKUP_PERMISSION_UPDATED
  action      TEXT        NOT NULL DEFAULT '',

  added       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  removed     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backup_perm_history_idx ON backup_permission_history (created_at DESC);
