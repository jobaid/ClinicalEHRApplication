package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

// Authentication and role-based authorization.
//
// Replaces Firebase Auth. Sign-in verifies against whichever algorithm the account was migrated
// with (firebase-scrypt for pre-existing accounts, bcrypt for ones created since), then issues a
// JWT the SPA sends back as a Bearer token.
//
// The role rules below mirror firestore.rules exactly - same role names, same collection groups -
// so no user gains or loses access in the migration.

type Claims struct {
	UID   string `json:"uid"`
	Email string `json:"email"`
	Role  string `json:"role"`
	jwt.RegisteredClaims
}

type authedUser struct {
	UID   string
	Email string
	Role  string
	Name  string
}

const sessionTTL = 12 * time.Hour

func (s *Server) issueToken(u authedUser) (string, error) {
	claims := Claims{
		UID: u.UID, Email: u.Email, Role: u.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   u.UID,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(sessionTTL)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.jwtSecret)
}

func (s *Server) parseToken(tokenStr string) (*Claims, error) {
	tok, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method %v", t.Header["alg"])
		}
		return s.jwtSecret, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := tok.Claims.(*Claims)
	if !ok || !tok.Valid {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}

var errBadCredentials = errors.New("invalid email or password")

// authenticate verifies an email/password pair against the stored credential.
func (s *Server) authenticate(ctx context.Context, email, password string) (authedUser, error) {
	var (
		uid, role, name  string
		algo             string
		hash, salt       *string
		disabled         bool
	)
	err := s.db.QueryRow(ctx,
		`SELECT id, role, name, disabled, password_algo, password_hash, password_salt
		   FROM users WHERE lower(email) = lower($1)`, email).
		Scan(&uid, &role, &name, &disabled, &algo, &hash, &salt)
	if err != nil {
		return authedUser{}, errBadCredentials
	}
	if disabled {
		return authedUser{}, errors.New("this account has been disabled")
	}
	if hash == nil {
		return authedUser{}, errBadCredentials
	}

	var ok bool
	switch algo {
	case "bcrypt":
		ok = bcrypt.CompareHashAndPassword([]byte(*hash), []byte(password)) == nil
	case "firebase-scrypt":
		saltStr := ""
		if salt != nil {
			saltStr = *salt
		}
		var vErr error
		ok, vErr = VerifyFirebaseScrypt(s.hashConfig, password, saltStr, *hash)
		if vErr != nil && !errors.Is(vErr, errBadHashConfig) {
			return authedUser{}, errBadCredentials
		}
	default:
		return authedUser{}, fmt.Errorf("unsupported password algorithm %q", algo)
	}
	if !ok {
		return authedUser{}, errBadCredentials
	}
	return authedUser{UID: uid, Email: email, Role: role, Name: name}, nil
}

// ---------- HTTP handlers ----------

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct{ Email, Password string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	u, err := s.authenticate(r.Context(), body.Email, body.Password)
	if err != nil {
		// Same generic message Firebase gave, so the login screen's copy still fits.
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	token, err := s.issueToken(u)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not issue session")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"user":  map[string]any{"uid": u.UID, "email": u.Email},
	})
}

// handleMe re-validates a stored token on page load, standing in for onAuthStateChanged.
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{
		"uid": u.UID, "email": u.Email,
	})
}

// handleCreateUser creates a credential for a new account. Only SUPER_ADMIN may call it,
// matching the users-collection write rule in firestore.rules. The caller's own session is
// untouched - the Firebase client SDK needed a throwaway secondary app to achieve that.
func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	if u.Role != "SUPER_ADMIN" {
		writeErr(w, http.StatusForbidden, "only an account admin may create users")
		return
	}
	var body struct{ Email, Password string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	if len(body.Password) < 6 {
		writeErr(w, http.StatusBadRequest, "password must be at least 6 characters")
		return
	}

	var exists bool
	if err := s.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM users WHERE lower(email) = lower($1))`, body.Email).Scan(&exists); err != nil {
		writeErr(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	if exists {
		writeErr(w, http.StatusConflict, "that email address is already in use")
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not hash password")
		return
	}
	uid := newUID()
	// The profile row (name/role) is written separately by the app through the collections API,
	// exactly as it was with Firestore; this only establishes the credential.
	if _, err := s.db.Exec(r.Context(),
		`INSERT INTO users (id, email, name, role, password_algo, password_hash)
		 VALUES ($1, $2, '', 'BILLER', 'bcrypt', $3)`, uid, body.Email, string(hash)); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create account")
		return
	}
	s.hub.broadcast("users")
	writeJSON(w, http.StatusOK, map[string]any{"uid": uid})
}

// handleChangePassword lets any signed-in user change their own password. The current password
// is re-verified here rather than trusted from the session, so a walked-up-to unlocked browser
// cannot be used to lock the real owner out of their account.
//
// Whatever algorithm the account was migrated with, it is rewritten as bcrypt - the scrypt path
// exists only to honour hashes that came out of Firebase, never to create new ones.
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var body struct{ CurrentPassword, NewPassword string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	if len(body.NewPassword) < 6 {
		writeErr(w, http.StatusBadRequest, "password must be at least 6 characters")
		return
	}
	if _, err := s.authenticate(r.Context(), u.Email, body.CurrentPassword); err != nil {
		writeErr(w, http.StatusForbidden, "your current password is not correct")
		return
	}
	if err := s.setPassword(r.Context(), u.UID, body.NewPassword); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not change the password")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleResetPassword lets a SUPER_ADMIN set someone else's password. This app has no email, so
// without it a locked-out user could only be recovered with hand-written SQL.
func (s *Server) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	if u.Role != "SUPER_ADMIN" {
		writeErr(w, http.StatusForbidden, "only an account admin may reset passwords")
		return
	}
	var body struct{ NewPassword string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	if len(body.NewPassword) < 6 {
		writeErr(w, http.StatusBadRequest, "password must be at least 6 characters")
		return
	}
	target := r.PathValue("id")
	var exists bool
	if err := s.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)`, target).Scan(&exists); err != nil || !exists {
		writeErr(w, http.StatusNotFound, "no such account")
		return
	}
	if err := s.setPassword(r.Context(), target, body.NewPassword); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not reset the password")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// setPassword writes a bcrypt credential, clearing the scrypt salt so authenticate() cannot fall
// back to the superseded hash.
func (s *Server) setPassword(ctx context.Context, uid, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx,
		`UPDATE users SET password_algo = 'bcrypt', password_hash = $2, password_salt = NULL WHERE id = $1`,
		uid, string(hash))
	return err
}

// ---------- middleware ----------

type ctxKey int

const userKey ctxKey = 0

func userFrom(ctx context.Context) authedUser {
	u, _ := ctx.Value(userKey).(authedUser)
	return u
}

// requireAuth rejects anything without a valid session and attaches the caller to the context.
// The role is re-read from the database on every request rather than trusted from the token, so
// a role change or a disable takes effect immediately instead of at token expiry.
func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := r.Header.Get("Authorization")
		if raw == "" {
			// EventSource cannot set headers, so the SSE stream passes its token as a query param.
			raw = "Bearer " + r.URL.Query().Get("access_token")
		}
		token := strings.TrimPrefix(raw, "Bearer ")
		if token == "" || token == raw && !strings.HasPrefix(raw, "Bearer ") {
			writeErr(w, http.StatusUnauthorized, "missing session")
			return
		}
		claims, err := s.parseToken(token)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "session expired")
			return
		}

		var role, name, email string
		var disabled bool
		if err := s.db.QueryRow(r.Context(),
			`SELECT role, name, email, disabled FROM users WHERE id = $1`, claims.UID).
			Scan(&role, &name, &email, &disabled); err != nil {
			writeErr(w, http.StatusUnauthorized, "unknown account")
			return
		}
		if disabled {
			writeErr(w, http.StatusForbidden, "this account has been disabled")
			return
		}

		u := authedUser{UID: claims.UID, Email: email, Role: role, Name: name}
		next(w, r.WithContext(context.WithValue(r.Context(), userKey, u)))
	}
}

// ---------- authorization (mirrors firestore.rules) ----------

var (
	catalogRoles = map[string]bool{"SUPER_ADMIN": true, "MANAGER": true}
)

// ---------- role -> tab grants ----------
//
// A role's access is a set of tab names, stored in role_permissions and edited from
// Settings > Manage roles. The billing/clinical/front-desk collection groups below are derived
// from that set rather than hardcoded, so granting Billing to a role in the UI actually lets
// that role post charges instead of only showing them a tab the server then refuses to write.
//
// SUPER_ADMIN is never read from the table: it always holds every tab. That is what stops an
// admin from removing their own access to the screen that grants access back.

type tabSet map[string]bool

func (t tabSet) has(tab string) bool { return t[tab] }

// defaultRoleTabs mirrors the seed in migrations/002_role_permissions.sql, and is what a role
// falls back to if its row is missing or the table cannot be read. Falling back to the shipped
// grants keeps a database hiccup from either locking everyone out or opening everything up.
var defaultRoleTabs = map[string][]string{
	"SUPER_ADMIN":  {"dashboard", "schedule", "patients", "clinical", "billing", "claims", "reports", "users"},
	"MANAGER":      {"dashboard", "schedule", "patients", "clinical", "billing", "claims", "reports"},
	"NURSE":        {"dashboard", "schedule", "patients", "clinical"},
	"RECEPTIONIST": {"dashboard", "schedule", "patients"},
	"BILLER":       {"dashboard", "patients", "billing", "claims", "reports"},
}

func fallbackTabs(role string) tabSet {
	out := tabSet{}
	for _, tab := range defaultRoleTabs[role] {
		out[tab] = true
	}
	return out
}

// invalidateTabs drops the cache after role_permissions changes, so a permission edit takes
// effect on the very next request instead of at some cache expiry.
func (s *Server) invalidateTabs() {
	s.tabMu.Lock()
	s.tabCache = nil
	s.tabMu.Unlock()
}

// tabsFor returns the effective tab grant for a role.
func (s *Server) tabsFor(ctx context.Context, role string) tabSet {
	if role == "SUPER_ADMIN" {
		return fallbackTabs("SUPER_ADMIN")
	}

	s.tabMu.RLock()
	cached, ok := s.tabCache[role]
	s.tabMu.RUnlock()
	if ok {
		return cached
	}

	loaded := map[string]tabSet{}
	rows, err := s.db.Query(ctx, `SELECT id, tabs FROM role_permissions`)
	if err != nil {
		return fallbackTabs(role)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			return fallbackTabs(role)
		}
		var tabs []string
		if err := json.Unmarshal(raw, &tabs); err != nil {
			continue
		}
		set := tabSet{}
		for _, tab := range tabs {
			set[tab] = true
		}
		loaded[id] = set
	}
	if rows.Err() != nil {
		return fallbackTabs(role)
	}

	s.tabMu.Lock()
	s.tabCache = loaded
	s.tabMu.Unlock()

	if set, ok := loaded[role]; ok {
		return set
	}
	return fallbackTabs(role)
}

// writeAllowed decides whether a role may write to a collection. These groupings are copied
// from firestore.rules so the migration neither widens nor narrows anyone's permissions.
//
// Reads stay open to any signed-in user, exactly as the rules had it: the app loads whole
// collections and filters client-side, so a per-document read restriction would break it.
// governingTab maps a collection onto the tab grant that controls it, so writes and deletes are
// judged by the same rule. Collections absent from this map are governed by the per-collection
// cases in writeAllowed instead (ownership checks, admin-only, append-only).
var governingTab = map[string]string{
	"charges": "billing", "claims": "billing", "insurancePolicies": "billing",
	"idDocuments": "billing", "patientCreditBalances": "billing",
	"insuranceCreditBalances": "billing", "transactions": "billing",

	"vitals": "clinical", "allergies": "clinical", "medications": "clinical",
	"problems": "clinical", "clinicalNotes": "clinical",

	"patients": "patients", "appointments": "patients", "patientMemos": "patients",
}

var tabDenial = map[string]string{
	"billing":  "your role cannot modify billing records",
	"clinical": "your role cannot modify clinical records",
	"patients": "your role cannot modify patient records",
}

func writeAllowed(collection, role, uid string, tabs tabSet, perms permSet, doc Document, existing Document) (bool, string) {
	if tab, ok := governingTab[collection]; ok && !tabs.has(tab) {
		return false, tabDenial[tab]
	}
	switch collection {
	case "cptCatalog":
		if !catalogRoles[role] {
			return false, "only a manager or admin may change the CPT catalog"
		}
	case "insurance":
		// Master insurance is shared reference data: one wrong payer ID here misroutes every
		// claim for that payer, for every patient. Gated on its own grant rather than on the
		// billing tab, so "can post a payment" and "can rewrite the payer list" stay separate.
		need, verb := PermInsuranceCreate, "add"
		if existing != nil {
			need, verb = PermInsuranceUpdate, "edit"
		}
		if !perms.has(need) {
			return false, "your role cannot " + verb + " master insurance records"
		}
	case "physicians":
		// An NPI is what a payer pays against, so a wrong one is a rejected claim across every
		// charge that provider touches. Pinned to SUPER_ADMIN rather than catalogRoles.
		if role != "SUPER_ADMIN" {
			return false, "only an account admin may change the physician directory"
		}
	case "auditLogs", "loginAudit":
		// Append-only: create is allowed for anyone signed in, updates and deletes never are.
		if existing != nil {
			return false, "audit records cannot be modified"
		}
	case "batches":
		// A user may only open or close their own batch.
		owner, _ := doc["userId"].(string)
		if existing != nil {
			if eo, ok := existing["userId"].(string); ok {
				owner = eo
			}
		}
		if owner != "" && owner != uid {
			return false, "you can only change your own batch"
		}
	case "ticklers":
		if existing == nil {
			if c, _ := doc["createdByUid"].(string); c != "" && c != uid {
				return false, "you can only create ticklers as yourself"
			}
		} else {
			creator, _ := existing["createdByUid"].(string)
			assignee, _ := existing["assignedToUid"].(string)
			if creator != uid && assignee != uid && !catalogRoles[role] {
				return false, "you can only change ticklers you created or are assigned"
			}
		}
	case "supportTickets":
		if existing == nil {
			if c, _ := doc["createdByUid"].(string); c != "" && c != uid {
				return false, "you can only file tickets as yourself"
			}
		} else {
			creator, _ := existing["createdByUid"].(string)
			if creator != uid && !catalogRoles[role] {
				return false, "you can only change tickets you filed"
			}
		}
	case "rolePermissions":
		// Who may grant access is not itself a grantable permission - it is pinned to
		// SUPER_ADMIN, so no role can be edited into the ability to escalate itself.
		if role != "SUPER_ADMIN" {
			return false, "only an account admin may change role permissions"
		}
		if existing != nil && existing["id"] == "SUPER_ADMIN" {
			return false, "the Super Admin role always keeps full access"
		}
		// Unrecognised permission strings are rejected outright rather than stored. A value the
		// server does not know grants nothing, so silently accepting one would show an
		// administrator a saved checkbox that does not actually do anything.
		if raw, present := doc["permissions"]; present {
			if _, dropped := sanitizePermissions(raw); dropped {
				return false, "that permission list contains entries this server does not recognise"
			}
		}
	case "users":
		// Creating your own profile row is allowed; changing anyone's is admin-only.
		if existing == nil {
			if id, _ := doc["id"].(string); id == uid || role == "SUPER_ADMIN" {
				return true, ""
			}
			return false, "only an account admin may add users"
		}
		if role != "SUPER_ADMIN" {
			return false, "only an account admin may change users"
		}
	}
	return true, ""
}

// deleteAllowed gates hard deletes. Most of this app soft-deletes, but ID documents are removed
// outright (a scanned government ID has to actually go when someone deletes it), so a delete is
// held to the same grant as a write to the same collection rather than to a blanket "this role
// can write something, somewhere" check.
func deleteAllowed(collection, role string, tabs tabSet, perms permSet) (bool, string) {
	switch collection {
	case "auditLogs", "loginAudit", "batches", "rolePermissions":
		return false, "these records cannot be deleted"
	case "ticklers", "supportTickets":
		return true, ""
	case "insurance":
		// Deleting outright is only reachable for a row nothing references; handleDelete makes
		// that check against the database. This is the grant half of the decision.
		if !perms.has(PermInsuranceDelete) {
			return false, "your role cannot delete master insurance records"
		}
		return true, ""
	case "users", "cptCatalog", "physicians":
		if role != "SUPER_ADMIN" {
			return false, "only an account admin may delete these records"
		}
		return true, ""
	}
	tab, ok := governingTab[collection]
	if !ok {
		return false, "your role cannot delete records"
	}
	if !tabs.has(tab) {
		return false, tabDenial[tab]
	}
	return true, ""
}
