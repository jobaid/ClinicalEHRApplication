package main

import (
	"context"
	"fmt"
	"log"
	"net/mail"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

// A brand-new database has no accounts at all, and POST /api/auth/users requires an existing
// SUPER_ADMIN to call it — so without this a fresh deployment is unreachable: nobody can sign in,
// and nobody can be created. This closes that gap for the first boot and only the first boot.
//
// The rule that makes it safe to leave configured is that it refuses to do anything once ANY
// account exists. It is a way to open an empty system, never a way to add an administrator to a
// running one, so leaving BOOTSTRAP_ADMIN_* set in a compose file does not leave a back door: on
// every subsequent start it finds accounts and declines.
//
// Set both to use it:
//
//	BOOTSTRAP_ADMIN_EMAIL=you@example.com
//	BOOTSTRAP_ADMIN_PASSWORD=<a long random string>
//
// Then sign in, change the password from the UI, and remove both from the environment.

const bootstrapMinPasswordLen = 12

// bootstrapAdmin creates the first SUPER_ADMIN when the users table is empty.
//
// Returns an error only for a misconfiguration the operator must fix (a malformed address, a weak
// password, a failed write). Finding existing accounts is not an error — it is the normal steady
// state, and the server carries on.
func bootstrapAdmin(ctx context.Context, pool *pgxpool.Pool) error {
	email := strings.TrimSpace(os.Getenv("BOOTSTRAP_ADMIN_EMAIL"))
	password := os.Getenv("BOOTSTRAP_ADMIN_PASSWORD")

	if email == "" && password == "" {
		return nil // not requested
	}
	if email == "" || password == "" {
		return fmt.Errorf("BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set together")
	}
	if _, err := mail.ParseAddress(email); err != nil {
		return fmt.Errorf("BOOTSTRAP_ADMIN_EMAIL is not a valid address")
	}
	// Stricter than the 6 characters the normal create-user endpoint allows. That one is a
	// signed-in administrator choosing a colleague's temporary password; this one is typed into a
	// deployment config, is the only credential on the system, and is reachable from the internet
	// the moment the server starts.
	if len(password) < bootstrapMinPasswordLen {
		return fmt.Errorf("BOOTSTRAP_ADMIN_PASSWORD must be at least %d characters", bootstrapMinPasswordLen)
	}

	// One transaction, and the count is taken with a lock held, so two containers starting at the
	// same moment cannot both see an empty table and both insert. The second blocks, then finds
	// the first one's row and backs out.
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed

	if _, err := tx.Exec(ctx, `LOCK TABLE users IN EXCLUSIVE MODE`); err != nil {
		return fmt.Errorf("lock users: %w", err)
	}

	var existing int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&existing); err != nil {
		return fmt.Errorf("count users: %w", err)
	}
	if existing > 0 {
		// Deliberately not fatal, and deliberately logged: an operator who left the variables set
		// should be able to see that they did nothing.
		log.Printf("bootstrap: %d account(s) already exist — not creating one. Unset BOOTSTRAP_ADMIN_* to silence this.", existing)
		return nil
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}

	uid := newUID()
	if _, err := tx.Exec(ctx,
		`INSERT INTO users (id, email, name, role, password_algo, password_hash, created_by, created_at)
		 VALUES ($1, $2, $3, 'SUPER_ADMIN', 'bcrypt', $4, 'bootstrap', $5)`,
		uid, email, "Administrator", string(hash), time.Now().UTC().Format(time.RFC3339),
	); err != nil {
		return fmt.Errorf("create admin: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	// The address identifies the account for the operator reading the logs; the password is never
	// written anywhere — they already have it, and container logs are not a secret store.
	log.Printf("bootstrap: created the first SUPER_ADMIN (%s). Sign in, change the password, then unset BOOTSTRAP_ADMIN_*.", email)
	return nil
}
