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
	billingRoles   = map[string]bool{"SUPER_ADMIN": true, "MANAGER": true, "BILLER": true}
	clinicalRoles  = map[string]bool{"SUPER_ADMIN": true, "MANAGER": true, "NURSE": true}
	frontDeskRoles = map[string]bool{"SUPER_ADMIN": true, "MANAGER": true, "RECEPTIONIST": true, "BILLER": true, "NURSE": true}
	catalogRoles   = map[string]bool{"SUPER_ADMIN": true, "MANAGER": true}
)

// writeAllowed decides whether a role may write to a collection. These groupings are copied
// from firestore.rules so the migration neither widens nor narrows anyone's permissions.
//
// Reads stay open to any signed-in user, exactly as the rules had it: the app loads whole
// collections and filters client-side, so a per-document read restriction would break it.
func writeAllowed(collection, role, uid string, doc Document, existing Document) (bool, string) {
	switch collection {
	case "charges", "claims", "insurancePolicies", "idDocuments",
		"patientCreditBalances", "insuranceCreditBalances", "transactions":
		if !billingRoles[role] {
			return false, "your role cannot modify billing records"
		}
	case "vitals", "allergies", "medications", "problems", "clinicalNotes":
		if !clinicalRoles[role] {
			return false, "your role cannot modify clinical records"
		}
	case "patients", "appointments", "patientMemos":
		if !frontDeskRoles[role] {
			return false, "your role cannot modify patient records"
		}
	case "cptCatalog":
		if !catalogRoles[role] {
			return false, "only a manager or admin may change the CPT catalog"
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

func deleteAllowed(collection, role string) (bool, string) {
	switch collection {
	case "auditLogs", "loginAudit", "batches":
		return false, "these records cannot be deleted"
	case "ticklers", "supportTickets":
		return true, ""
	}
	if !billingRoles[role] && !clinicalRoles[role] && !frontDeskRoles[role] {
		return false, "your role cannot delete records"
	}
	return true, ""
}
