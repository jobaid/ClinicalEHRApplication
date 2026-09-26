package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Go API for the medical billing app - the replacement for Firebase Auth + Cloud Firestore.
//
// The React frontend is unchanged: src/firebase/authService.js and firestoreService.js keep
// their exact function signatures and now call these endpoints instead of the Firebase SDK.
//
//	POST   /api/auth/login              email+password -> { token, user }
//	GET    /api/auth/me                 revalidate a stored token
//	POST   /api/auth/users              create a credential (SUPER_ADMIN only)
//	GET    /api/collections/{name}      list a whole collection
//	POST   /api/collections/{name}      create with a server-generated id
//	PUT    /api/collections/{name}/{id} replace a document
//	PATCH  /api/collections/{name}/{id} merge into a document
//	DELETE /api/collections/{name}/{id} remove a document
//	POST   /api/auth/password           change your own password
//	POST   /api/auth/users/{id}/password reset another account's password (SUPER_ADMIN)
//	POST   /api/batch                   several writes, atomically
//	GET    /api/stream                  SSE change feed (replaces onSnapshot)

type Server struct {
	db         *pgxpool.Pool
	hub        *hub
	jwtSecret  []byte
	hashConfig FirebaseHashConfig

	// Cached role -> tab grants from the role_permissions table. Every authorized write reads
	// these, so they are cached rather than re-queried per request; any write to
	// rolePermissions clears the cache (see invalidateTabs).
	tabMu    sync.RWMutex
	tabCache map[string]tabSet

	// Granular action grants (see permissions.go). Cached and invalidated on the same events as
	// tabCache, but kept separate because the two answer different questions.
	permMu    sync.RWMutex
	permCache map[string]permSet

	// Per-USER grants (see userpermissions.go), which is what governs Backup & Restore. Keyed by
	// user id rather than by role, and invalidated one entry at a time so revoking one person's
	// access does not throw away everyone else's cached answer.
	userPermMu    sync.RWMutex
	userPermCache map[string]permSet
}

// ---------- Configuration and its production guardrails ----------
//
// Everything below exists because this repository is public. A default that is merely
// inconvenient in a private repo becomes an unauthenticated admin login once the source is
// readable: anyone can take a hardcoded JWT signing key out of the source, mint a token with
// {"role":"SUPER_ADMIN"}, and the server will honour it.
//
// So there are no usable secret defaults any more. In production the process refuses to start
// without real values; in development it generates ephemeral ones, which means a known-value
// secret never exists anywhere, not even locally.

// isProduction reports whether this process should hold itself to production rules. Anything
// other than an explicit development marker counts as production - the safe direction to fail,
// since a misspelled APP_ENV then gets stricter treatment rather than laxer.
func isProduction() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("APP_ENV"))) {
	case "", "dev", "development", "local", "test":
		return false
	default:
		return true
	}
}

// requireEnv reads a setting that has no safe default. In production a missing value is fatal;
// in development it falls back and says loudly that it did.
func requireEnv(key, devFallback, why string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	if isProduction() {
		log.Fatalf("%s is not set. %s Refusing to start with APP_ENV=%q.", key, why, os.Getenv("APP_ENV"))
	}
	log.Printf("warning: %s is not set, using a development default. Never run this configuration in production.", key)
	return devFallback
}

// jwtSigningSecret returns the HMAC key used to sign session tokens.
//
// Unset in development generates 32 random bytes rather than reusing a constant. The cost is
// that restarting the API invalidates existing sessions (everyone signs in again); the benefit
// is that no checked-in value can ever sign a token an environment will accept.
func jwtSigningSecret() []byte {
	const minLen = 32
	if v := strings.TrimSpace(os.Getenv("JWT_SECRET")); v != "" {
		if len(v) < minLen {
			log.Fatalf("JWT_SECRET is only %d characters; use at least %d. Generate one with: openssl rand -base64 48", len(v), minLen)
		}
		return []byte(v)
	}
	if isProduction() {
		log.Fatal("JWT_SECRET is not set. Session tokens would be forgeable by anyone who can read this source. " +
			"Generate one with: openssl rand -base64 48")
	}
	// Development only - isProduction() has already returned above.
	//
	// This is persisted rather than regenerated per boot, and the reason is not convenience.
	// mfaKey() derives the MFA secret-encryption key from this value, so a secret that changes
	// on every restart makes every stored authenticator secret undecryptable. An enrolment
	// started before a restart then cannot be read afterwards, which used to lock the account
	// out of signing in entirely. Stable across restarts, the whole class of problem disappears.
	//
	// The file is gitignored and only ever used outside production, where an unset JWT_SECRET
	// is a fatal error rather than something to generate.
	path := env("DEV_JWT_SECRET_FILE", "dev-jwt-secret")
	if existing, err := os.ReadFile(path); err == nil {
		if v := strings.TrimSpace(string(existing)); len(v) >= minLen {
			log.Printf("warning: JWT_SECRET is not set; using the development secret in %s", path)
			return []byte(v)
		}
	}

	buf := make([]byte, minLen)
	if _, err := rand.Read(buf); err != nil {
		log.Fatalf("could not generate a development JWT secret: %v", err)
	}
	secret := base64.StdEncoding.EncodeToString(buf)

	// 0600: it signs sessions on this machine. If it cannot be written, carry on with the
	// in-memory value - a read-only checkout should still be able to run the server.
	if err := os.WriteFile(path, []byte(secret), 0o600); err != nil {
		log.Printf("warning: JWT_SECRET is not set and %s could not be written (%v); "+
			"using an ephemeral secret. Sessions and MFA enrolments will not survive a restart.", path, err)
	} else {
		log.Printf("warning: JWT_SECRET is not set; generated a development secret and saved it to %s", path)
	}
	return []byte(secret)
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// How long to keep retrying the first database connection before giving up.
const dbStartupTimeout = 30 * time.Second

// waitForDB blocks until the database answers, or the timeout expires.
//
// A single ping at startup is a race the API loses often. PostgreSQL accepts TCP connections
// before it is ready to serve them and answers "the database system is starting up" (SQLSTATE
// 57P03) in between, so starting the database and the API together — `npm run db:start` followed
// straight away by `npm run api`, or the two containers in docker-compose — reliably fails on a
// cold start even though nothing is actually wrong.
//
// Retrying also covers the restart case: if PostgreSQL is bounced underneath a running stack,
// the API comes back on its own instead of needing to be restarted by hand.
func waitForDB(pool *pgxpool.Pool, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastErr error
	var reported bool

	for attempt := 1; ; attempt++ {
		// Each ping gets its own short deadline so one hung attempt cannot eat the whole budget.
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		err := pool.Ping(ctx)
		cancel()
		if err == nil {
			if reported {
				log.Print("database is ready")
			}
			return nil
		}
		lastErr = err

		if time.Now().After(deadline) {
			return fmt.Errorf("after %d attempts over %s: %w", attempt, timeout, lastErr)
		}
		// Stay quiet about the first failure: on a normal cold start the database is ready within
		// a second or two, and a warning for that is noise, not information.
		if attempt == 2 {
			log.Printf("waiting for the database to accept connections (%v)", lastErr)
			reported = true
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// loadHashConfig reads the Firebase scrypt parameters captured during migration. Without it,
// accounts migrated from Firebase cannot sign in (bcrypt accounts still can).
func loadHashConfig(path string) FirebaseHashConfig {
	var cfg FirebaseHashConfig
	raw, err := os.ReadFile(path)
	if err != nil {
		log.Printf("warning: no Firebase hash config at %s - migrated passwords will not verify", path)
		return cfg
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		log.Printf("warning: could not parse %s: %v", path, err)
	}
	return cfg
}

func main() {
	dsn := requireEnv("DATABASE_URL", "postgres://postgres:medbill_dev_pw@127.0.0.1:5433/medbill?sslmode=disable",
		"The database password would otherwise come from this repository's source.")
	addr := env("ADDR", ":8080")
	// Browsers enforce CORS, so a wrong origin list here is what stands between a hostile page
	// and a logged-in user's session. There is no sane production default, only the local dev one.
	origins := requireEnv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173",
		"Set it to the exact origin(s) serving the frontend, comma-separated.")
	secret := jwtSigningSecret()

	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	if err := waitForDB(pool, dbStartupTimeout); err != nil {
		log.Fatalf("database never became ready: %v", err)
	}
	defer pool.Close()

	s := &Server{
		db:         pool,
		hub:        newHub(),
		jwtSecret:  []byte(secret),
		hashConfig: loadHashConfig(env("FIREBASE_HASH_CONFIG", "server/firebase-hash-config.json")),
	}

	// One-shot data import: server migrate [exportDir]. Runs and exits; never starts the API.
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		dir := "migration-export"
		if len(os.Args) > 2 {
			dir = os.Args[2]
		}
		if err := runMigrate(context.Background(), pool, dir); err != nil {
			log.Fatalf("migration failed: %v", err)
		}
		return
	}

	// Opens an empty system on first boot. Does nothing once any account exists, so it is safe to
	// leave configured — see bootstrap.go. Fatal on a misconfiguration, because a server that
	// silently started with no way to sign in is worse than one that says why.
	if err := bootstrapAdmin(context.Background(), pool); err != nil {
		log.Fatalf("bootstrap: %v", err)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	// Unauthenticated on purpose: it serves the credentials the login page prints for the one
	// demonstration account, and nothing else. See server/demo.go.
	mux.HandleFunc("GET /api/auth/demo", s.handleDemoInfo)
	mux.HandleFunc("GET /api/auth/me", s.requireAuth(s.handleMe))
	mux.HandleFunc("POST /api/auth/users", s.requireAuth(s.handleCreateUser))
	mux.HandleFunc("POST /api/auth/password", s.requireAuth(s.handleChangePassword))
	mux.HandleFunc("POST /api/auth/users/{id}/password", s.requireAuth(s.handleResetPassword))

	// Multi-factor authentication.
	//
	// verify and the two enrol endpoints are NOT behind requireAuth: they are reached with the
	// short-lived challenge token issued after the password step, which requireAuth deliberately
	// rejects. They authenticate that token themselves. Everything else here needs a real session.
	mux.HandleFunc("POST /api/auth/mfa/verify", s.handleMFAVerify)
	mux.HandleFunc("POST /api/auth/mfa/enroll/start", s.handleMFAEnrollStart)
	mux.HandleFunc("POST /api/auth/mfa/enroll/confirm", s.handleMFAEnrollConfirm)
	mux.HandleFunc("GET /api/auth/mfa/status", s.requireAuth(s.handleMFAStatus))
	mux.HandleFunc("POST /api/auth/mfa/disable", s.requireAuth(s.handleMFADisable))

	// Trusted devices.
	mux.HandleFunc("GET /api/auth/devices", s.requireAuth(s.handleListDevices))
	mux.HandleFunc("DELETE /api/auth/devices/{id}", s.requireAuth(s.handleRevokeDevice))
	mux.HandleFunc("DELETE /api/auth/devices", s.requireAuth(s.handleRevokeAllDevices))

	mux.HandleFunc("GET /api/collections/{name}", s.requireAuth(s.handleList))
	mux.HandleFunc("POST /api/collections/{name}", s.requireAuth(s.handleCreate))
	mux.HandleFunc("PUT /api/collections/{name}/{id}", s.requireAuth(s.handleWrite))
	mux.HandleFunc("PATCH /api/collections/{name}/{id}", s.requireAuth(s.handleWrite))
	mux.HandleFunc("DELETE /api/collections/{name}/{id}", s.requireAuth(s.handleDelete))

	// Patient statements: preview returns JSON for the review screen, pdf returns the document.
	// Both recompute every figure server-side - see statement.go.
	mux.HandleFunc("POST /api/statements/preview", s.requireAuth(s.handleStatementPreview))
	mux.HandleFunc("POST /api/statements/pdf", s.requireAuth(s.handleStatementPDF))

	// Backup & Restore. Every route is registered through requirePerm rather than requireAuth:
	// the grant is re-read from the database on each request, so a revocation takes effect
	// immediately and calling the endpoint directly gains nothing over using the screen.
	// See userpermissions.go and backup.go.
	mux.HandleFunc("GET /api/admin/backups", s.requirePerm(PermBackupView, s.handleBackupList))
	mux.HandleFunc("POST /api/admin/backups", s.requirePerm(PermBackupCreate, s.handleBackupCreate))
	mux.HandleFunc("GET /api/admin/backups/{id}/download", s.requirePerm(PermBackupDownload, s.handleBackupDownload))
	mux.HandleFunc("POST /api/admin/backups/upload", s.requirePerm(PermBackupUpload, s.handleBackupUpload))
	mux.HandleFunc("POST /api/admin/backups/{id}/restore", s.requirePerm(PermBackupRestore, s.handleBackupRestore))
	mux.HandleFunc("DELETE /api/admin/backups/{id}", s.requirePerm(PermBackupDelete, s.handleBackupDelete))

	mux.HandleFunc("GET /api/admin/backup-settings", s.requirePerm(PermBackupView, s.handleBackupSettingsGet))
	mux.HandleFunc("PUT /api/admin/backup-settings", s.requirePerm(PermBackupSettings, s.handleBackupSettingsPut))

	mux.HandleFunc("GET /api/admin/backup-access", s.requirePerm(PermBackupAccessManagement, s.handleBackupAccessList))
	mux.HandleFunc("PUT /api/admin/backup-access/{userId}", s.requirePerm(PermBackupAccessManagement, s.handleBackupAccessUpdate))
	mux.HandleFunc("GET /api/admin/backup-access/history", s.requirePerm(PermBackupAccessManagement, s.handleBackupAccessHistory))

	// What the signed-in browser may do, so the interface knows which controls to render. Any
	// authenticated account may ask about itself; the answer is advisory, never the enforcement.
	mux.HandleFunc("GET /api/admin/backup-permissions/me", s.requireAuth(s.handleMyBackupPermissions))

	// Antimicrobial Review and HIM Coding Worklist. Registered through requirePerm, not
	// requireAuth: the grant is re-read from the database per request, so hiding a menu item is
	// a courtesy and this is the actual boundary. Calling these directly without the grant
	// returns 403.
	mux.HandleFunc("GET /api/clinical/statuses", s.requireAuth(s.handleWorkflowStatuses))

	mux.HandleFunc("GET /api/clinical/antimicrobial", s.requirePerm(PermAntimicrobialView, s.handleAMList))
	mux.HandleFunc("GET /api/clinical/antimicrobial/summary", s.requirePerm(PermAntimicrobialView, s.handleAMSummary))
	mux.HandleFunc("GET /api/clinical/antimicrobial/{id}", s.requirePerm(PermAntimicrobialView, s.handleAMDetail))
	mux.HandleFunc("POST /api/clinical/antimicrobial", s.requirePerm(PermAntimicrobialReview, s.handleAMCreate))
	mux.HandleFunc("POST /api/clinical/antimicrobial/{id}/reviews", s.requirePerm(PermAntimicrobialReview, s.handleAMAddReview))
	mux.HandleFunc("POST /api/clinical/antimicrobial/{id}/assign", s.requirePerm(PermAntimicrobialAssign, s.handleAMAssign))

	mux.HandleFunc("GET /api/him/worklist", s.requirePerm(PermHIMWorklistView, s.handleHIMList))
	mux.HandleFunc("GET /api/him/summary", s.requirePerm(PermHIMWorklistView, s.handleHIMSummary))
	mux.HandleFunc("GET /api/him/worklist/{id}", s.requirePerm(PermHIMWorklistView, s.handleHIMDetail))
	mux.HandleFunc("POST /api/him/worklist", s.requirePerm(PermHIMCodingEdit, s.handleHIMCreate))
	mux.HandleFunc("POST /api/him/worklist/{id}/assign", s.requirePerm(PermHIMAssign, s.handleHIMAssign))
	mux.HandleFunc("POST /api/him/worklist/{id}/status", s.requirePerm(PermHIMCodingEdit, s.handleHIMStatus))
	mux.HandleFunc("PUT /api/him/worklist/{id}/diagnoses", s.requirePerm(PermHIMCodingEdit, s.handleHIMDiagnoses))
	mux.HandleFunc("PUT /api/him/worklist/{id}/procedures", s.requirePerm(PermHIMCodingEdit, s.handleHIMProcedures))
	mux.HandleFunc("POST /api/him/worklist/{id}/queries", s.requirePerm(PermHIMQueryCreate, s.handleHIMQueryCreate))
	mux.HandleFunc("POST /api/him/queries/{qid}/status", s.requirePerm(PermHIMQueryManage, s.handleHIMQueryUpdate))

	// Doctor Clinical Workspace. Patient identity is always part of the query, never taken from
	// the path alone, so changing an id in the URL cannot reach another patient's record.
	mux.HandleFunc("GET /api/doctor/patients/{id}/header", s.requirePerm(PermDoctorPatientView, s.handleDoctorHeader))
	mux.HandleFunc("GET /api/doctor/patients/{id}/timeline", s.requirePerm(PermDoctorRecordView, s.handleDoctorTimeline))
	mux.HandleFunc("GET /api/doctor/patients/{id}/labs", s.requirePerm(PermDoctorLabView, s.handleLabList))
	mux.HandleFunc("GET /api/doctor/patients/{id}/labs/trend", s.requirePerm(PermDoctorLabView, s.handleLabTrend))
	mux.HandleFunc("GET /api/doctor/patients/{id}/labs/{orderId}", s.requirePerm(PermDoctorLabView, s.handleLabReport))

	// Uploaded medical records. Patient id is part of every query, so editing a record id in the
	// URL cannot reach a document belonging to someone else.
	mux.HandleFunc("GET /api/patients/{id}/records", s.requirePerm(PermMedRecView, s.handleMedRecList))
	mux.HandleFunc("POST /api/patients/{id}/records", s.requirePerm(PermMedRecUpload, s.handleMedRecUpload))
	mux.HandleFunc("GET /api/patients/{id}/records/{recordId}", s.requirePerm(PermMedRecView, s.handleMedRecGet))
	mux.HandleFunc("GET /api/patients/{id}/records/{recordId}/download", s.requirePerm(PermMedRecDownload, s.handleMedRecDownload))
	mux.HandleFunc("POST /api/patients/{id}/records/{recordId}/email", s.requirePerm(PermMedRecEmail, s.handleMedRecEmail))
	mux.HandleFunc("DELETE /api/patients/{id}/records/{recordId}", s.requirePerm(PermMedRecDelete, s.handleMedRecDelete))
	mux.HandleFunc("GET /api/email/status", s.requireAuth(s.handleEmailStatus))

	// Prescriptions. Signing and sending are separate grants from viewing, and BOTH additionally
	// require a verified prescriber profile - a permission is not a licence to prescribe.
	mux.HandleFunc("GET /api/rx/prescriber/me", s.requireAuth(s.handleRxPrescriberMe))
	mux.HandleFunc("GET /api/rx/pharmacies", s.requirePerm(PermRxView, s.handleRxPharmacySearch))
	mux.HandleFunc("POST /api/rx/pharmacies", s.requirePerm(PermRxCreate, s.handleRxPharmacyCreate))
	mux.HandleFunc("GET /api/rx/patients/{id}/pharmacy", s.requirePerm(PermRxView, s.handleRxPreferredPharmacy))
	mux.HandleFunc("PUT /api/rx/patients/{id}/pharmacy", s.requirePerm(PermRxCreate, s.handleRxPreferredPharmacy))

	mux.HandleFunc("GET /api/rx/patients/{id}/prescriptions", s.requirePerm(PermRxView, s.handleRxList))
	mux.HandleFunc("POST /api/rx/patients/{id}/prescriptions", s.requirePerm(PermRxCreate, s.handleRxCreate))
	mux.HandleFunc("GET /api/rx/patients/{id}/prescriptions/{rxId}", s.requirePerm(PermRxView, s.handleRxDetail))
	mux.HandleFunc("PUT /api/rx/patients/{id}/prescriptions/{rxId}", s.requirePerm(PermRxCreate, s.handleRxUpdate))
	mux.HandleFunc("POST /api/rx/patients/{id}/prescriptions/{rxId}/validate", s.requirePerm(PermRxView, s.handleRxValidate))
	mux.HandleFunc("POST /api/rx/patients/{id}/prescriptions/{rxId}/sign", s.requirePerm(PermRxSign, s.handleRxSign))
	mux.HandleFunc("POST /api/rx/patients/{id}/prescriptions/{rxId}/send", s.requirePerm(PermRxSend, s.handleRxSend))
	mux.HandleFunc("POST /api/rx/patients/{id}/prescriptions/{rxId}/cancel", s.requirePerm(PermRxCancel, s.handleRxCancel))

	mux.HandleFunc("POST /api/batch", s.requireAuth(s.handleBatch))
	mux.HandleFunc("GET /api/stream", s.requireAuth(s.handleStream))

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		if err := pool.Ping(r.Context()); err != nil {
			writeErr(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "collections": len(collections)})
	})

	// Antimicrobial Review and HIM Coding Worklist tables. Additive and idempotent, applied here
	// for the same reason as the others: the initdb mount never runs on a database that already
	// holds data, so a code-only deployment would otherwise be missing every new table.
	if err := s.ensureClinicalSchema(context.Background()); err != nil {
		log.Printf("clinical: %v - the worklist modules will not work until this is resolved", err)
	}

	// Doctor role and the laboratory tables. Additive and idempotent, same as the others.
	if err := s.ensureDoctorSchema(context.Background()); err != nil {
		log.Printf("doctor: %v - the clinical workspace will not work until this is resolved", err)
	}

	// Uploaded medical records. Additive and idempotent, same as every other schema step here.
	if err := s.ensureMedicalRecordSchema(context.Background()); err != nil {
		log.Printf("medical records: %v - uploads will not work until this is resolved", err)
	}

	// Prescriptions. Additive and idempotent, same as every other schema step.
	if err := s.ensurePrescriptionSchema(context.Background()); err != nil {
		log.Printf("prescriptions: %v - the Rx feature will not work until this is resolved", err)
	}

	// Demo account. The schema step is additive and idempotent; the seeder creates the account
	// on first run and refreshes only a row already flagged is_demo on later runs. Neither step
	// can modify a real user - see server/demo.go. Failures are logged, never fatal: a
	// misconfigured demo account must not stop a clinic's billing system from starting.
	if err := s.ensureDemoSchema(context.Background()); err != nil {
		log.Printf("demo: %v - demo sign-in will not work until this is resolved", err)
	} else if cfg, cfgErr := loadDemoConfig(); cfgErr != nil {
		log.Printf("demo: %v - demo sign-in is disabled", cfgErr)
	} else if err := s.ensureDemoUser(context.Background(), cfg); err != nil {
		log.Printf("demo: could not prepare the demo account: %v", err)
	}

	// Backup tables, then the timer that fills them. ensureBackupSchema is idempotent, so this
	// runs on every boot and a deployment that only pulls new code still gets the new tables -
	// the initdb mount would not, because it only fires on an empty data directory.
	if err := s.ensureBackupSchema(context.Background()); err != nil {
		// Not fatal. A billing system that refuses to start because its backup catalogue is
		// unavailable has turned a missing feature into an outage.
		log.Printf("backup: %v - Backup & Restore will not work until this is resolved", err)
	} else {
		// Picks up any dump files left on the volume by a previous container whose catalogue
		// rows did not survive (a restore replaces the catalogue along with everything else).
		s.reconcileCatalogue(context.Background())
		go s.runBackupScheduler(context.Background())
	}

	log.Printf("medbill API listening on %s (db ok, %d collections)", addr, len(collections))
	srv := &http.Server{
		Addr:              addr,
		Handler:           withCORS(origins, mux),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: the SSE stream is a long-lived response.
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
