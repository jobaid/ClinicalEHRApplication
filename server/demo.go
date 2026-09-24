package main

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// The demonstration account.
//
// One ordinary account, stored in the same users table, verified by the same bcrypt comparison
// and issued the same session token as everyone else. The only thing that makes it different is
// a single authoritative column - users.is_demo - which the sign-in path reads from the database
// to decide that this one account may skip the second factor.
//
// What this is deliberately NOT: a branch on the username, a frontend flag, or a general MFA
// switch. A check like `if email == "demo.manager@..."` would make the security boundary a
// string literal that appears in the client bundle, and a global switch would turn one
// convenience into an estate-wide weakening. The database row is the authority.

//go:embed migrations/008_demo_user.sql
var demoSchemaSQL string

// The demo account's role is pinned here rather than read from the environment. Making it
// configurable would mean a typo or a careless .env edit could publish SUPER_ADMIN credentials
// on a public login page.
const demoRole = "MANAGER"

// Long enough that the published account is not also a usable guess at how this deployment
// generates passwords.
const demoMinPasswordLen = 12

type demoConfig struct {
	Enabled  bool
	Email    string
	Password string
	Name     string
}

// loadDemoConfig reads the demo account settings. Absent configuration disables the feature
// entirely - there is no default demo account, because a default one would appear on every
// deployment of this code including ones whose operator never asked for it.
func loadDemoConfig() (demoConfig, error) {
	email := strings.TrimSpace(os.Getenv("DEMO_USER_EMAIL"))
	password := os.Getenv("DEMO_USER_PASSWORD")

	if email == "" && password == "" {
		return demoConfig{}, nil // not requested
	}
	if email == "" || password == "" {
		return demoConfig{}, errors.New("DEMO_USER_EMAIL and DEMO_USER_PASSWORD must be set together")
	}
	if !strings.Contains(email, "@") {
		return demoConfig{}, fmt.Errorf("DEMO_USER_EMAIL %q is not a valid address", email)
	}
	if len(password) < demoMinPasswordLen {
		return demoConfig{}, fmt.Errorf("DEMO_USER_PASSWORD must be at least %d characters", demoMinPasswordLen)
	}

	return demoConfig{
		Enabled:  true,
		Email:    email,
		Password: password,
		Name:     env("DEMO_USER_NAME", "Manager Demo"),
	}, nil
}

// ensureDemoSchema applies 008_demo_user.sql at startup.
//
// Same reasoning as ensureBackupSchema: migrations in this project are otherwise applied by the
// initdb mount, which only runs on a database that starts empty. An existing production database
// would never see this column, and every sign-in would fail on a missing column. The file is
// idempotent, so running it on every boot is safe and means a code-only deployment is enough.
func (s *Server) ensureDemoSchema(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, demoSchemaSQL); err != nil {
		return fmt.Errorf("demo schema: %w", err)
	}
	return nil
}

// ensureDemoUser creates or refreshes the demo account, and is safe to run on every boot.
//
// The safety property that matters: this can only ever create a new row, or update a row that is
// ALREADY flagged is_demo. If the configured address belongs to a real member of staff, the
// function refuses and says so. No production credential can be overwritten by a misconfigured
// DEMO_USER_EMAIL - which is the failure mode worth engineering against, because it would
// silently replace a real person's password with one published on the login page.
func (s *Server) ensureDemoUser(ctx context.Context, cfg demoConfig) error {
	if !cfg.Enabled {
		return nil
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit

	// FOR UPDATE so two containers starting at once cannot both decide the row is missing.
	var existingID string
	var existingIsDemo bool
	err = tx.QueryRow(ctx,
		`SELECT id, is_demo FROM users WHERE lower(email) = lower($1) FOR UPDATE`, cfg.Email).
		Scan(&existingID, &existingIsDemo)

	hasRow := err == nil
	if err != nil && !strings.Contains(err.Error(), "no rows") {
		return err
	}

	if hasRow && !existingIsDemo {
		// A real account owns this address. Leave it completely alone and make the problem
		// visible rather than "fixing" it.
		log.Printf("demo: REFUSING to touch %s - that address belongs to an existing non-demo "+
			"account. Set DEMO_USER_EMAIL to an address no real user owns.", cfg.Email)
		return nil
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(cfg.Password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	if hasRow {
		// Re-applied on every boot so that rotating DEMO_USER_PASSWORD actually takes effect,
		// and so a demo visitor cannot leave the account in a state that breaks the next
		// visitor. The WHERE clause repeats the is_demo condition: belt and braces against a
		// row being re-flagged between the SELECT and here.
		if _, err := tx.Exec(ctx,
			`UPDATE users
			    SET name = $2, role = $3, disabled = FALSE,
			        password_algo = 'bcrypt', password_hash = $4, password_salt = NULL
			  WHERE id = $1 AND is_demo = TRUE`,
			existingID, cfg.Name, demoRole, string(hash)); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		log.Printf("demo: refreshed the demo account %s (role %s, MFA not required)", cfg.Email, demoRole)
		return nil
	}

	id := "U" + newUID()
	if _, err := tx.Exec(ctx,
		`INSERT INTO users (id, email, name, role, disabled, created_by, created_at,
		                    password_algo, password_hash, password_salt, is_demo)
		 VALUES ($1, $2, $3, $4, FALSE, 'system', $5, 'bcrypt', $6, NULL, TRUE)`,
		id, cfg.Email, cfg.Name, demoRole, time.Now().UTC().Format(time.RFC3339), string(hash)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	log.Printf("demo: created the demo account %s (role %s, MFA not required)", cfg.Email, demoRole)
	return nil
}

// handleDemoInfo publishes the demo credentials for the login page.
//
// Publishing a password over an unauthenticated endpoint is intentional here and nowhere else.
// This one account exists to be signed into by strangers, its password is printed on the login
// screen, and serving it from the database-backed configuration rather than baking it into the
// JavaScript bundle means the page can never advertise a password the server does not actually
// accept. No other account is reachable through this endpoint, and nothing here reveals whether
// any other account exists.
func (s *Server) handleDemoInfo(w http.ResponseWriter, r *http.Request) {
	cfg, err := loadDemoConfig()
	if err != nil || !cfg.Enabled {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}

	// Confirmed against the database rather than reported from the environment: if the seeder
	// refused because a real account owns the address, the login page must not invite people to
	// try credentials that will not work - or worse, advertise a password next to a real user's
	// email address.
	var isDemo, disabled bool
	if err := s.db.QueryRow(r.Context(),
		`SELECT is_demo, disabled FROM users WHERE lower(email) = lower($1)`, cfg.Email).
		Scan(&isDemo, &disabled); err != nil || !isDemo || disabled {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":  true,
		"email":    cfg.Email,
		"password": cfg.Password,
		"name":     cfg.Name,
		"role":     demoRole,
		"notice":   "This account is for demonstration purposes only.",
	})
}

// errDemoAccount is returned by the guards below. The demo account is shared by strangers, so
// anything that would change its credentials or its second-factor state has to be refused -
// otherwise the first visitor to click "change password" silently breaks the published
// credentials for everyone who comes after.
var errDemoAccount = errors.New("this action is not available on the demonstration account")

// denyDemo writes the refusal and reports whether it did, so callers read as a guard clause.
func denyDemo(w http.ResponseWriter, u authedUser) bool {
	if !u.IsDemo {
		return false
	}
	writeErr(w, http.StatusForbidden, errDemoAccount.Error())
	return true
}
