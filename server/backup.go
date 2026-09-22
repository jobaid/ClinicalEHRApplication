package main

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Backup & Restore.
//
// The dump is produced by pg_dump talking to the database over the compose network, not by
// reading the data directory: a file-level copy of a running PostgreSQL is not a backup, it is a
// corrupt database with a reassuring filename. pg_dump takes a consistent snapshot of a live
// server, which is the whole point.
//
// Files live on their own volume, separate from the database volume. A backup stored inside the
// thing it is backing up is not a backup - `docker compose down -v` would take both.

//go:embed migrations/007_backup.sql
var backupSchemaSQL string

// backupOnce serialises dumps and restores against each other. Two concurrent pg_dumps would
// merely waste disk, but a dump running during a restore would capture a half-restored database
// and store it as if it were a good copy.
var backupOnce sync.Mutex

const (
	backupKindManual    = "manual"
	backupKindScheduled = "scheduled"
	backupKindUploaded  = "uploaded"

	backupStatusRunning  = "running"
	backupStatusComplete = "complete"
	backupStatusFailed   = "failed"

	backupFormatCustom = "custom"
	backupFormatPlain  = "plain"

	// A generous ceiling that still refuses a runaway or hostile upload outright rather than
	// filling the volume and taking the application down with it.
	maxUploadBytes = 4 << 30 // 4 GiB
)

func backupDir() string { return env("BACKUP_DIR", "/var/lib/medbill/backups") }

func databaseURL() string { return os.Getenv("DATABASE_URL") }

// ensureBackupSchema applies 007_backup.sql at startup.
//
// Schema migrations in this project are otherwise applied by the initdb mount, which only runs
// on a database that starts empty - so on an existing deployment a new table would silently not
// exist and every backup request would fail with a confusing SQL error. The file is written to
// be idempotent precisely so it can be run on every boot, which means the feature works after a
// plain `docker compose up -d --build` with no hand-run SQL on a database holding patient data.
func (s *Server) ensureBackupSchema(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, backupSchemaSQL); err != nil {
		return fmt.Errorf("backup schema: %w", err)
	}
	if err := os.MkdirAll(backupDir(), 0o750); err != nil {
		// Not fatal: the rest of the application must still start. Creating a backup will fail
		// with a clear error, which is better than refusing to serve the billing system.
		log.Printf("backup: cannot create %s: %v", backupDir(), err)
	}
	if _, err := exec.LookPath("pg_dump"); err != nil {
		log.Printf("backup: pg_dump is not on PATH - creating backups will fail. " +
			"The api image must include postgresql-client.")
	}
	return nil
}

// ---------- the dump itself ----------

var unsafeFilenameChars = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func safeBackupName(s string) string {
	s = unsafeFilenameChars.ReplaceAllString(s, "_")
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

// pathFor resolves a catalogue row's filename to a path inside the backup directory.
//
// filepath.Base defends the download and delete routes against a stored filename containing
// "../" - the catalogue is only ever written by this file, but a path traversal that depends on
// that staying true is a bug waiting for someone to add an import tool.
func pathFor(filename string) string {
	return filepath.Join(backupDir(), filepath.Base(filename))
}

// detectBackupFormat reads the file's first bytes rather than trusting its extension.
//
// pg_dump's custom format begins with the literal "PGDMP". A file named .sql that is really a
// custom dump would otherwise be handed to psql, which would emit a wall of syntax errors
// against a live database; the reverse would hand plain SQL to pg_restore, which rejects it.
func detectBackupFormat(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return backupFormatPlain
	}
	defer f.Close() //nolint:errcheck // read-only

	head := make([]byte, 5)
	if n, _ := io.ReadFull(f, head); n == 5 && string(head) == "PGDMP" {
		return backupFormatCustom
	}
	return backupFormatPlain
}

func sha256File(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close() //nolint:errcheck // read-only
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// createBackup runs pg_dump and records the result. It is the single path by which a backup file
// comes into existence, so the catalogue cannot disagree with the disk.
func (s *Server) createBackup(ctx context.Context, kind, note, actor string) (string, error) {
	backupOnce.Lock()
	defer backupOnce.Unlock()

	if databaseURL() == "" {
		return "", errors.New("DATABASE_URL is not set")
	}
	if err := os.MkdirAll(backupDir(), 0o750); err != nil {
		return "", fmt.Errorf("backup directory: %w", err)
	}

	id := "BK" + newUID()
	name := fmt.Sprintf("medbill-%s-%s.dump", time.Now().UTC().Format("20060102-150405"), safeBackupName(id))
	full := pathFor(name)

	// The row is written before the dump starts, so a process killed mid-dump leaves a visible
	// 'running' row rather than no evidence at all.
	if _, err := s.db.Exec(ctx,
		`INSERT INTO backups (id, filename, format, kind, status, note, created_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		id, name, backupFormatCustom, kind, backupStatusRunning, note, actor); err != nil {
		return "", err
	}

	fail := func(e error) (string, error) {
		_, _ = s.db.Exec(context.Background(),
			`UPDATE backups SET status=$2, error=$3, completed_at=now() WHERE id=$1`,
			id, backupStatusFailed, clip(e.Error(), 2000))
		_ = os.Remove(full)
		return id, e
	}

	// -Fc is pg_dump's custom format: compressed, and restorable selectively by pg_restore.
	// --no-owner/--no-privileges keep the dump portable between deployments whose role names
	// differ, which is what makes a backup taken here restorable on a rebuilt server.
	cmd := exec.CommandContext(ctx, "pg_dump",
		"--dbname="+databaseURL(),
		"--format=custom",
		"--no-owner",
		"--no-privileges",
		"--file="+full,
	)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fail(fmt.Errorf("pg_dump: %v: %s", err, strings.TrimSpace(stderr.String())))
	}

	sum, size, err := sha256File(full)
	if err != nil {
		return fail(err)
	}

	if _, err := s.db.Exec(ctx,
		`UPDATE backups SET status=$2, size_bytes=$3, sha256=$4, completed_at=now() WHERE id=$1`,
		id, backupStatusComplete, size, sum); err != nil {
		return id, err
	}
	return id, nil
}

// clip shortens a message for storage. Named this way to avoid colliding with truncate() in
// statement_pdf.go, which measures against a PDF column width rather than a byte count.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// ---------- catalogue ----------

type backupRow struct {
	ID          string  `json:"id"`
	Filename    string  `json:"filename"`
	Format      string  `json:"format"`
	Kind        string  `json:"kind"`
	Status      string  `json:"status"`
	SizeBytes   int64   `json:"sizeBytes"`
	SHA256      string  `json:"sha256"`
	Note        string  `json:"note"`
	Error       string  `json:"error"`
	CreatedBy   string  `json:"createdBy"`
	CreatedAt   string  `json:"createdAt"`
	CompletedAt *string `json:"completedAt"`
	OnDisk      bool    `json:"onDisk"`
}

func (s *Server) listBackups(ctx context.Context) ([]backupRow, error) {
	rows, err := s.db.Query(ctx,
		`SELECT id, filename, format, kind, status, size_bytes, sha256, note, error,
		        created_by, created_at, completed_at
		   FROM backups ORDER BY created_at DESC LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []backupRow{}
	for rows.Next() {
		var b backupRow
		var created time.Time
		var completed *time.Time
		if err := rows.Scan(&b.ID, &b.Filename, &b.Format, &b.Kind, &b.Status, &b.SizeBytes,
			&b.SHA256, &b.Note, &b.Error, &b.CreatedBy, &created, &completed); err != nil {
			return nil, err
		}
		b.CreatedAt = created.UTC().Format(time.RFC3339)
		if completed != nil {
			t := completed.UTC().Format(time.RFC3339)
			b.CompletedAt = &t
		}
		// Reported rather than assumed: a file removed from the volume by hand should show as
		// missing in the history instead of failing only when someone tries to restore it.
		if st, statErr := os.Stat(pathFor(b.Filename)); statErr == nil && !st.IsDir() {
			b.OnDisk = true
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// reconcileCatalogue adds a row for any backup file on the volume that the catalogue does not
// know about.
//
// This exists because of one specific hazard. A restore replaces every table - including
// `backups` - with the contents of the dump being restored, so the safety copy taken moments
// earlier disappears from the history while still sitting on disk. The file that exists purely
// to make a bad restore recoverable would be invisible in the only screen anyone would look at.
//
// Also run at startup, which picks up files left behind by a previous container.
func (s *Server) reconcileCatalogue(ctx context.Context) {
	entries, err := os.ReadDir(backupDir())
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()

		var exists bool
		if err := s.db.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM backups WHERE filename = $1)`, name).Scan(&exists); err != nil || exists {
			continue
		}

		full := pathFor(name)
		sum, size, err := sha256File(full)
		if err != nil {
			continue
		}
		created := time.Now().UTC()
		if info, statErr := e.Info(); statErr == nil {
			created = info.ModTime().UTC()
		}

		// Recorded as 'manual' rather than 'scheduled' on purpose: retention never deletes
		// manual backups, and a file whose history has been lost should not then be discarded
		// by a timer before anyone notices it is there.
		if _, err := s.db.Exec(ctx,
			`INSERT INTO backups (id, filename, format, kind, status, size_bytes, sha256, note,
			                      created_by, created_at, completed_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
			 ON CONFLICT (id) DO NOTHING`,
			"BK"+newUID(), name, detectBackupFormat(full), backupKindManual, backupStatusComplete,
			size, sum, "recovered from disk - catalogue entry was missing", "system", created); err != nil {
			log.Printf("backup: could not re-catalogue %s: %v", name, err)
			continue
		}
		log.Printf("backup: re-catalogued %s from disk", name)
	}
}

// ---------- audit ----------

// auditBackup records a backup operation in the existing audit_logs table, alongside every other
// action the application logs, rather than in a private log nobody thinks to read.
func (s *Server) auditBackup(ctx context.Context, u authedUser, action, detail string) {
	_, err := s.db.Exec(ctx,
		`INSERT INTO audit_logs (id, patient_id, "user", action, entity_type, entity_id, old_values, new_values, timestamp)
		 VALUES ($1, NULL, $2, $3, 'backup', $4, '', $5, $6)`,
		"AUD"+newUID(), u.Name, action, "", detail, time.Now().Format("2006-01-02T15:04:05"))
	if err != nil {
		log.Printf("backup: audit write failed for %q: %v", action, err)
	}
}

// ---------- HTTP: backup operations ----------

func (s *Server) handleBackupList(w http.ResponseWriter, r *http.Request) {
	list, err := s.listBackups(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the backup history")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"backups": list})
}

func (s *Server) handleBackupCreate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var body struct{ Note string }
	_ = json.NewDecoder(r.Body).Decode(&body)

	// The handler waits for the dump, so the browser gets a real answer rather than an optimistic
	// one. But the dump is given context.Background() rather than the request's context: if the
	// user closes the tab mid-dump, cancelling would leave a half-written file on disk and a row
	// stuck at 'running'. Letting it finish and record itself is the tidier outcome.
	id, err := s.createBackup(context.Background(), backupKindManual, strings.TrimSpace(body.Note), u.Name)
	if err != nil {
		s.auditBackup(r.Context(), u, "Backup failed", err.Error())
		writeErr(w, http.StatusInternalServerError, "the backup did not complete: "+err.Error())
		return
	}
	s.auditBackup(r.Context(), u, "Backup created", id)
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

func (s *Server) handleBackupDownload(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")

	var filename, status string
	if err := s.db.QueryRow(r.Context(),
		`SELECT filename, status FROM backups WHERE id = $1`, id).Scan(&filename, &status); err != nil {
		writeErr(w, http.StatusNotFound, "no such backup")
		return
	}
	if status != backupStatusComplete {
		writeErr(w, http.StatusConflict, "that backup did not complete, so there is nothing to download")
		return
	}

	f, err := os.Open(pathFor(filename))
	if err != nil {
		writeErr(w, http.StatusNotFound, "the backup file is no longer on disk")
		return
	}
	defer f.Close() //nolint:errcheck // read-only

	st, err := f.Stat()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the backup file")
		return
	}

	s.auditBackup(r.Context(), u, "Backup downloaded", id)

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filepath.Base(filename)+`"`)
	w.Header().Set("Content-Length", fmt.Sprint(st.Size()))
	// This file is a complete copy of the patient database. It must never sit in a shared cache.
	w.Header().Set("Cache-Control", "no-store, private")
	http.ServeContent(w, r, filepath.Base(filename), st.ModTime(), f)
}

func (s *Server) handleBackupUpload(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(16 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "could not read the upload (is it larger than 4 GB?)")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "no file was attached")
		return
	}
	defer file.Close() //nolint:errcheck // read-only

	if err := os.MkdirAll(backupDir(), 0o750); err != nil {
		writeErr(w, http.StatusInternalServerError, "backup directory is not writable")
		return
	}

	id := "BK" + newUID()
	name := fmt.Sprintf("uploaded-%s-%s", time.Now().UTC().Format("20060102-150405"), safeBackupName(header.Filename))
	full := pathFor(name)

	dst, err := os.OpenFile(full, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not store the upload")
		return
	}
	written, copyErr := io.Copy(dst, file)
	closeErr := dst.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(full)
		writeErr(w, http.StatusInternalServerError, "the upload did not finish")
		return
	}

	format := detectBackupFormat(full)

	sum, size, err := sha256File(full)
	if err != nil {
		_ = os.Remove(full)
		writeErr(w, http.StatusInternalServerError, "could not verify the upload")
		return
	}

	if _, err := s.db.Exec(r.Context(),
		`INSERT INTO backups (id, filename, format, kind, status, size_bytes, sha256, note, created_by, completed_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
		id, name, format, backupKindUploaded, backupStatusComplete, size, sum,
		"uploaded: "+clip(header.Filename, 200), u.Name); err != nil {
		_ = os.Remove(full)
		writeErr(w, http.StatusInternalServerError, "could not record the upload")
		return
	}

	s.auditBackup(r.Context(), u, "Backup uploaded", fmt.Sprintf("%s (%d bytes, %s)", id, written, format))
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "format": format, "sizeBytes": size})
}

func (s *Server) handleBackupDelete(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")

	var filename string
	if err := s.db.QueryRow(r.Context(),
		`SELECT filename FROM backups WHERE id = $1`, id).Scan(&filename); err != nil {
		writeErr(w, http.StatusNotFound, "no such backup")
		return
	}
	if err := os.Remove(pathFor(filename)); err != nil && !os.IsNotExist(err) {
		writeErr(w, http.StatusInternalServerError, "could not remove the backup file")
		return
	}
	if _, err := s.db.Exec(r.Context(), `DELETE FROM backups WHERE id = $1`, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update the backup history")
		return
	}
	s.auditBackup(r.Context(), u, "Backup deleted", id)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

// handleBackupRestore replaces the contents of the live database with a backup.
//
// This is the most destructive operation in the application, so two things happen before it
// runs. The stored checksum is re-verified, because restoring a truncated file would replace
// good data with incomplete data. And a fresh safety copy of the CURRENT database is taken
// first, so "I restored the wrong one" is recoverable rather than terminal.
func (s *Server) handleBackupRestore(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")

	var body struct{ Confirm string }
	_ = json.NewDecoder(r.Body).Decode(&body)
	if strings.TrimSpace(body.Confirm) != "RESTORE" {
		writeErr(w, http.StatusBadRequest, `type RESTORE to confirm`)
		return
	}

	var filename, format, status, storedSum string
	if err := s.db.QueryRow(r.Context(),
		`SELECT filename, format, status, sha256 FROM backups WHERE id = $1`, id).
		Scan(&filename, &format, &status, &storedSum); err != nil {
		writeErr(w, http.StatusNotFound, "no such backup")
		return
	}
	if status != backupStatusComplete {
		writeErr(w, http.StatusConflict, "that backup did not complete and must not be restored")
		return
	}

	full := pathFor(filename)
	sum, _, err := sha256File(full)
	if err != nil {
		writeErr(w, http.StatusNotFound, "the backup file is no longer on disk")
		return
	}
	if storedSum != "" && sum != storedSum {
		s.auditBackup(r.Context(), u, "Restore refused", id+": checksum mismatch")
		writeErr(w, http.StatusConflict,
			"this backup file has changed since it was created and will not be restored")
		return
	}

	safetyID, safetyErr := s.createBackup(r.Context(), backupKindManual,
		"automatic safety copy taken before restoring "+id, u.Name)
	if safetyErr != nil {
		s.auditBackup(r.Context(), u, "Restore refused", "safety backup failed: "+safetyErr.Error())
		writeErr(w, http.StatusInternalServerError,
			"a safety copy of the current database could not be taken, so the restore was not started: "+safetyErr.Error())
		return
	}

	backupOnce.Lock()
	defer backupOnce.Unlock()

	// --single-transaction so a failure part-way leaves the database as it was rather than half
	// replaced. ON_ERROR_STOP does the same job for a plain SQL file, which would otherwise
	// plough on after an error and report success.
	var cmd *exec.Cmd
	if format == backupFormatCustom {
		cmd = exec.CommandContext(r.Context(), "pg_restore",
			"--dbname="+databaseURL(),
			"--clean", "--if-exists", "--no-owner", "--no-privileges",
			"--single-transaction",
			full,
		)
	} else {
		cmd = exec.CommandContext(r.Context(), "psql",
			"--dbname="+databaseURL(),
			"-v", "ON_ERROR_STOP=1",
			"--single-transaction",
			"-f", full,
		)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		s.auditBackup(r.Context(), u, "Restore failed", id+": "+clip(detail, 500))
		writeErr(w, http.StatusInternalServerError, "the restore failed and was rolled back: "+clip(detail, 500))
		return
	}

	// The restored dump may predate these tables, or may carry an older copy of them. Re-applying
	// the schema is idempotent and keeps the application able to manage its own backups after
	// restoring a dump taken before this feature existed.
	if err := s.ensureBackupSchema(context.Background()); err != nil {
		log.Printf("backup: re-applying backup schema after restore: %v", err)
	}
	// The restored `backups` table does not know about the files on this volume - including the
	// safety copy taken above, which is the one thing that makes this reversible.
	s.reconcileCatalogue(context.Background())

	// Every cached authorisation answer now refers to rows that may no longer exist.
	s.invalidateTabs()
	s.invalidatePerms()
	s.userPermMu.Lock()
	s.userPermCache = nil
	s.userPermMu.Unlock()

	s.auditBackup(context.Background(), u, "Database restored", id+" (safety copy "+safetyID+")")
	writeJSON(w, http.StatusOK, map[string]any{"restored": id, "safetyBackup": safetyID})
}

// ---------- HTTP: settings ----------

type backupSettings struct {
	AutoEnabled    bool    `json:"autoEnabled"`
	Frequency      string  `json:"frequency"`
	HourUTC        int     `json:"hourUtc"`
	MinuteUTC      int     `json:"minuteUtc"`
	Weekday        int     `json:"weekday"`
	RetentionCount int     `json:"retentionCount"`
	RetentionDays  int     `json:"retentionDays"`
	LastRunAt      *string `json:"lastRunAt"`
	UpdatedBy      string  `json:"updatedBy"`
}

func (s *Server) readSettings(ctx context.Context) (backupSettings, error) {
	var b backupSettings
	var last *time.Time
	err := s.db.QueryRow(ctx,
		`SELECT auto_enabled, frequency, hour_utc, minute_utc, weekday,
		        retention_count, retention_days, last_run_at, updated_by
		   FROM backup_settings WHERE id = 'default'`).
		Scan(&b.AutoEnabled, &b.Frequency, &b.HourUTC, &b.MinuteUTC, &b.Weekday,
			&b.RetentionCount, &b.RetentionDays, &last, &b.UpdatedBy)
	if last != nil {
		t := last.UTC().Format(time.RFC3339)
		b.LastRunAt = &t
	}
	return b, err
}

func (s *Server) handleBackupSettingsGet(w http.ResponseWriter, r *http.Request) {
	b, err := s.readSettings(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the backup settings")
		return
	}
	writeJSON(w, http.StatusOK, b)
}

func (s *Server) handleBackupSettingsPut(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var in backupSettings
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}

	// Clamped here as well as by the CHECK constraints, so an out-of-range value produces a
	// sensible setting and a clear message rather than a raw constraint violation.
	if in.Frequency != "weekly" {
		in.Frequency = "daily"
	}
	in.HourUTC = clampInt(in.HourUTC, 0, 23)
	in.MinuteUTC = clampInt(in.MinuteUTC, 0, 59)
	in.Weekday = clampInt(in.Weekday, 0, 6)
	in.RetentionCount = clampInt(in.RetentionCount, 1, 365)
	in.RetentionDays = clampInt(in.RetentionDays, 1, 3650)

	if _, err := s.db.Exec(r.Context(),
		`UPDATE backup_settings
		    SET auto_enabled=$1, frequency=$2, hour_utc=$3, minute_utc=$4, weekday=$5,
		        retention_count=$6, retention_days=$7, updated_by=$8, updated_at=now()
		  WHERE id='default'`,
		in.AutoEnabled, in.Frequency, in.HourUTC, in.MinuteUTC, in.Weekday,
		in.RetentionCount, in.RetentionDays, u.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the backup settings")
		return
	}

	s.auditBackup(r.Context(), u, "Backup settings changed",
		fmt.Sprintf("auto=%v %s %02d:%02d UTC keep %d/%dd",
			in.AutoEnabled, in.Frequency, in.HourUTC, in.MinuteUTC, in.RetentionCount, in.RetentionDays))

	b, _ := s.readSettings(r.Context())
	writeJSON(w, http.StatusOK, b)
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// ---------- the scheduler ----------

// runBackupScheduler wakes once a minute and runs a scheduled backup when one is due.
//
// "Due" is expressed as "the configured time for today has passed and no run has happened since
// it", not "the clock reads exactly the configured time". A container restarted across its
// backup window would otherwise skip that day silently, which is the failure mode that makes
// people discover their backups stopped months ago.
func (s *Server) runBackupScheduler(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cfg, err := s.readSettings(ctx)
			if err != nil || !cfg.AutoEnabled {
				continue
			}
			now := time.Now().UTC()
			if cfg.Frequency == "weekly" && int(now.Weekday()) != cfg.Weekday {
				continue
			}
			target := time.Date(now.Year(), now.Month(), now.Day(), cfg.HourUTC, cfg.MinuteUTC, 0, 0, time.UTC)
			if now.Before(target) {
				continue
			}
			if cfg.LastRunAt != nil {
				if last, perr := time.Parse(time.RFC3339, *cfg.LastRunAt); perr == nil && !last.Before(target) {
					continue // already ran for this window
				}
			}

			// Claimed before the dump starts so a slow backup cannot be started twice.
			if _, err := s.db.Exec(ctx,
				`UPDATE backup_settings SET last_run_at = now() WHERE id='default'`); err != nil {
				continue
			}

			id, err := s.createBackup(ctx, backupKindScheduled, "scheduled backup", "system")
			if err != nil {
				log.Printf("backup: scheduled backup failed: %v", err)
				continue
			}
			log.Printf("backup: scheduled backup %s complete", id)
			s.applyRetention(ctx, cfg)
		}
	}
}

// applyRetention removes scheduled backups that are both older than the retention window and
// outside the newest N.
//
// Both conditions must hold. Count alone would discard a month of history after a busy week;
// age alone could leave nothing at all if the schedule were paused. And only 'scheduled'
// backups are ever considered - a file a person created or uploaded deliberately must not be
// deleted by a timer.
func (s *Server) applyRetention(ctx context.Context, cfg backupSettings) {
	rows, err := s.db.Query(ctx,
		`SELECT id, filename FROM backups
		  WHERE kind = $1
		    AND created_at < now() - ($2 || ' days')::interval
		    AND id NOT IN (
		         SELECT id FROM backups WHERE kind = $1 ORDER BY created_at DESC LIMIT $3
		    )`,
		backupKindScheduled, fmt.Sprint(cfg.RetentionDays), cfg.RetentionCount)
	if err != nil {
		log.Printf("backup: retention query failed: %v", err)
		return
	}
	type doomed struct{ id, filename string }
	var list []doomed
	for rows.Next() {
		var d doomed
		if err := rows.Scan(&d.id, &d.filename); err == nil {
			list = append(list, d)
		}
	}
	rows.Close()

	for _, d := range list {
		if err := os.Remove(pathFor(d.filename)); err != nil && !os.IsNotExist(err) {
			log.Printf("backup: retention could not remove %s: %v", d.filename, err)
			continue
		}
		if _, err := s.db.Exec(ctx, `DELETE FROM backups WHERE id = $1`, d.id); err != nil {
			log.Printf("backup: retention could not update the catalogue for %s: %v", d.id, err)
			continue
		}
		log.Printf("backup: retention removed %s", d.id)
	}
}
