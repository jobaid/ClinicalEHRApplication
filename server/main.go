package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
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
//	POST   /api/batch                   several writes, atomically
//	GET    /api/stream                  SSE change feed (replaces onSnapshot)

type Server struct {
	db         *pgxpool.Pool
	hub        *hub
	jwtSecret  []byte
	hashConfig FirebaseHashConfig
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
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
	dsn := env("DATABASE_URL", "postgres://postgres:medbill_dev_pw@127.0.0.1:5433/medbill")
	addr := env("ADDR", ":8080")
	origins := env("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
	secret := env("JWT_SECRET", "dev-only-secret-change-in-production")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("ping: %v", err)
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

	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("GET /api/auth/me", s.requireAuth(s.handleMe))
	mux.HandleFunc("POST /api/auth/users", s.requireAuth(s.handleCreateUser))

	mux.HandleFunc("GET /api/collections/{name}", s.requireAuth(s.handleList))
	mux.HandleFunc("POST /api/collections/{name}", s.requireAuth(s.handleCreate))
	mux.HandleFunc("PUT /api/collections/{name}/{id}", s.requireAuth(s.handleWrite))
	mux.HandleFunc("PATCH /api/collections/{name}/{id}", s.requireAuth(s.handleWrite))
	mux.HandleFunc("DELETE /api/collections/{name}/{id}", s.requireAuth(s.handleDelete))

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
