package main

import (
	"context"
	"crypto/rand"
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
	buf := make([]byte, minLen)
	if _, err := rand.Read(buf); err != nil {
		log.Fatalf("could not generate a development JWT secret: %v", err)
	}
	log.Print("warning: JWT_SECRET is not set, generated an ephemeral one. Sessions will not survive a restart.")
	return buf
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

	mux.HandleFunc("POST /api/batch", s.requireAuth(s.handleBatch))
	mux.HandleFunc("GET /api/stream", s.requireAuth(s.handleStream))

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		if err := pool.Ping(r.Context()); err != nil {
			writeErr(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "collections": len(collections)})
	})

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
