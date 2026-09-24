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

	// Empty for a real session token. Set to mfaChallengeKind for the short-lived token issued
	// between "password accepted" and "second factor accepted".
	//
	// This is the boundary the whole MFA feature rests on: a challenge token proves only that
	// somebody knew the password, so requireAuth refuses it. Without this field the challenge
	// would be a fully valid session and the second factor would be optional in practice.
	Purpose string `json:"purpose,omitempty"`

	jwt.RegisteredClaims
}

type authedUser struct {
	UID   string
	Email string
	Role  string
	Name  string

	// Read from users.is_demo on every authentication, never from the token and never inferred
	// from the address. This is the authority for the one MFA exemption in the system, so it has
	// to come from the row itself - a value carried in a session token would survive the account
	// being un-flagged.
	IsDemo bool
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

// issueChallengeToken mints the short-lived token that carries a half-finished login from the
// password step to the second-factor step. It is not a session and requireAuth will not accept it.
func (s *Server) issueChallengeToken(u authedUser) (string, error) {
	claims := Claims{
		UID: u.UID, Email: u.Email, Role: u.Role, Purpose: mfaChallengeKind,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   u.UID,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(mfaChallengeTTL)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.jwtSecret)
}

// parseChallengeToken accepts ONLY a challenge token, so a full session cannot be replayed into
// the enrolment endpoints and a challenge cannot be replayed into the application.
func (s *Server) parseChallengeToken(raw string) (*Claims, error) {
	claims, err := s.parseToken(strings.TrimSpace(strings.TrimPrefix(raw, "Bearer ")))
	if err != nil {
		return nil, err
	}
	if claims.Purpose != mfaChallengeKind {
		return nil, errors.New("not a verification token")
	}
	return claims, nil
}

var errBadCredentials = errors.New("invalid email or password")

// authenticate verifies an email/password pair against the stored credential.
func (s *Server) authenticate(ctx context.Context, email, password string) (authedUser, error) {
	var (
		uid, role, name string
		algo            string
		hash, salt      *string
		disabled        bool
		isDemo          bool
	)
	err := s.db.QueryRow(ctx,
		`SELECT id, role, name, disabled, password_algo, password_hash, password_salt, is_demo
		   FROM users WHERE lower(email) = lower($1)`, email).
		Scan(&uid, &role, &name, &disabled, &algo, &hash, &salt, &isDemo)
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
	return authedUser{UID: uid, Email: email, Role: role, Name: name, IsDemo: isDemo}, nil
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

	// The password is correct. What happens next depends on the second factor.
	state, err := s.mfaStateFor(r.Context(), u.UID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read security settings")
		return
	}

	switch {
	case u.IsDemo:
		// The one MFA exemption in the system, and it is narrow by construction.
		//
		// u.IsDemo came from users.is_demo on this request, read in authenticate() alongside the
		// password hash - not from the submitted address, not from the session token, and not
		// from anything the client sent. The column cannot be written through the collections
		// API (it is absent from the users collection in schema.go), so no signed-in user can
		// flag their own account and land in this branch.
		//
		// This is checked BEFORE state.Enabled so that a demo account which somehow acquired an
		// enrolment still signs in without one, rather than stranding a published account behind
		// an authenticator nobody has.
		s.recordLoginAudit(r.Context(), u, "Demo sign-in (MFA not required)")
		s.completeLogin(w, u, "demo account")

	case state.Enabled:
		// This browser may already have proved the second factor within the last 30 days.
		if s.trustedDeviceValid(r.Context(), r, u.UID) {
			s.completeLogin(w, u, "trusted device")
			return
		}
		challenge, err := s.issueChallengeToken(u)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "could not start verification")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"mfaRequired": true,
			"challenge":   challenge,
			"backupCodes": s.backupCodesRemaining(r.Context(), u.UID),
		})

	case mfaEnforced():
		// Required but not set up. Enrolment is offered here rather than refused, so turning the
		// requirement on does not lock out accounts that predate it - they enrol on next sign-in.
		challenge, err := s.issueChallengeToken(u)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "could not start enrolment")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"mfaEnrollRequired": true,
			"challenge":         challenge,
			"email":             u.Email,
		})

	default:
		s.completeLogin(w, u, "password only")
	}
}

// completeLogin issues the real session token. Every successful sign-in ends here, whatever route
// it took, so there is exactly one place a session can be minted.
func (s *Server) completeLogin(w http.ResponseWriter, u authedUser, _ string) {
	token, err := s.issueToken(u)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not issue session")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		// isDemo is reported so the interface can label the session visibly. It is a display
		// hint, not a grant: every route re-reads the account, so a client that lies about it
		// gains nothing.
		"user": map[string]any{"uid": u.UID, "email": u.Email, "isDemo": u.IsDemo},
	})
}

// userFromChallenge re-reads the account named by a challenge token.
//
// Re-read rather than trusted from the token: an account disabled in the seconds between the
// password step and the code step must not be able to finish signing in.
func (s *Server) userFromChallenge(r *http.Request) (authedUser, *Claims, error) {
	claims, err := s.parseChallengeToken(r.Header.Get("Authorization"))
	if err != nil {
		return authedUser{}, nil, err
	}
	var u authedUser
	var disabled bool
	if err := s.db.QueryRow(r.Context(),
		`SELECT id, email, role, name, disabled, is_demo FROM users WHERE id = $1`, claims.UID).
		Scan(&u.UID, &u.Email, &u.Role, &u.Name, &disabled, &u.IsDemo); err != nil {
		return authedUser{}, nil, errors.New("unknown account")
	}
	if disabled {
		return authedUser{}, nil, errors.New("this account has been disabled")
	}
	return u, claims, nil
}

// handleMFAVerify is the second step of signing in: a 6-digit code, or a backup code.
func (s *Server) handleMFAVerify(w http.ResponseWriter, r *http.Request) {
	u, _, err := s.userFromChallenge(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "your verification window expired - please sign in again")
		return
	}
	var body struct {
		Code        string `json:"code"`
		TrustDevice bool   `json:"trustDevice"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}

	state, err := s.mfaStateFor(r.Context(), u.UID)
	if err != nil || !state.Enabled {
		writeErr(w, http.StatusBadRequest, "multi-factor authentication is not set up for this account")
		return
	}

	// A 6-digit authenticator code, or one single-use backup code.
	if !validateTOTP(body.Code, state.Secret) && !s.consumeBackupCode(r.Context(), u.UID, body.Code) {
		s.recordLoginAudit(r.Context(), u, "MFA code rejected")
		writeErr(w, http.StatusUnauthorized, "that code is not valid")
		return
	}

	if body.TrustDevice {
		raw, expires, err := s.issueTrustedDevice(r.Context(), u.UID, r.UserAgent())
		if err == nil {
			setTrustedCookie(w, r, raw, expires)
		}
		// A failure to record the device is not a reason to refuse a correct code: the user
		// simply gets asked again next time.
	}
	s.recordLoginAudit(r.Context(), u, "MFA verified")
	s.completeLogin(w, u, "mfa")
}

// handleMFAEnrollStart returns a fresh secret and the otpauth:// URI for the QR code.
// Reachable with a challenge token (first-time enrolment during sign-in) or a full session
// (setting it up from Settings).
func (s *Server) handleMFAEnrollStart(w http.ResponseWriter, r *http.Request) {
	u, err := s.actorFor(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "please sign in again")
		return
	}
	// The demo account is exempt from MFA, so enrolling one would be a second factor nobody holds.
	if denyDemo(w, u) {
		return
	}
	secret, uri, err := s.beginEnrolment(r.Context(), u.UID, u.Email)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"secret":  secret,
		"otpauth": uri,
		"issuer":  mfaIssuer,
		"account": u.Email,
	})
}

// handleMFAEnrollConfirm turns enrolment on once the user has produced a working code, and
// returns the backup codes - the only time they are ever shown.
func (s *Server) handleMFAEnrollConfirm(w http.ResponseWriter, r *http.Request) {
	u, err := s.actorFor(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "please sign in again")
		return
	}
	// See handleMFAEnrollStart: the demo account must never acquire an enrolment.
	if denyDemo(w, u) {
		return
	}
	var body struct {
		Code        string `json:"code"`
		TrustDevice bool   `json:"trustDevice"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	codes, err := s.completeEnrolment(r.Context(), u.UID, body.Code)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.TrustDevice {
		if raw, expires, err := s.issueTrustedDevice(r.Context(), u.UID, r.UserAgent()); err == nil {
			setTrustedCookie(w, r, raw, expires)
		}
	}
	s.recordLoginAudit(r.Context(), u, "MFA enabled")

	// Enrolling mid-login finishes the login; enrolling from Settings leaves the existing session
	// alone, so no second token is issued there.
	resp := map[string]any{"backupCodes": codes}
	if _, _, err := s.userFromChallenge(r); err == nil {
		if token, err := s.issueToken(u); err == nil {
			resp["token"] = token
			resp["user"] = map[string]any{"uid": u.UID, "email": u.Email}
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// actorFor resolves the account behind either a full session or an in-progress challenge, for the
// endpoints that legitimately serve both.
func (s *Server) actorFor(r *http.Request) (authedUser, error) {
	if u, _, err := s.userFromChallenge(r); err == nil {
		return u, nil
	}
	claims, err := s.parseToken(strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")))
	if err != nil || claims.Purpose != "" {
		return authedUser{}, errors.New("not authenticated")
	}
	var u authedUser
	var disabled bool
	if err := s.db.QueryRow(r.Context(),
		`SELECT id, email, role, name, disabled, is_demo FROM users WHERE id = $1`, claims.UID).
		Scan(&u.UID, &u.Email, &u.Role, &u.Name, &disabled, &u.IsDemo); err != nil || disabled {
		return authedUser{}, errors.New("unknown account")
	}
	return u, nil
}

// handleMFAStatus reports the signed-in user's own security state, for the Settings screen.
func (s *Server) handleMFAStatus(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	state, err := s.mfaStateFor(r.Context(), u.UID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read security settings")
		return
	}
	devices, err := s.listTrustedDevices(r.Context(), r, u.UID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list trusted devices")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":           state.Enabled,
		"enforced":          mfaEnforced(),
		"backupCodesLeft":   s.backupCodesRemaining(r.Context(), u.UID),
		"trustedDevices":    devices,
		"trustedDeviceDays": int(trustedDeviceTTL.Hours() / 24),
	})
}

// handleMFADisable turns MFA off, which also ends every trusted device for the account.
// The current password is required: an unlocked browser must not be enough to remove a factor.
func (s *Server) handleMFADisable(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	// Nothing to disable - the demo account never enrols - and this endpoint takes the account
	// password, which is public for this account.
	if denyDemo(w, u) {
		return
	}
	var body struct{ Password string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	if _, err := s.authenticate(r.Context(), u.Email, body.Password); err != nil {
		writeErr(w, http.StatusUnauthorized, "that password is not correct")
		return
	}
	if mfaEnforced() {
		writeErr(w, http.StatusForbidden, "multi-factor authentication is required for all accounts and cannot be turned off")
		return
	}
	if err := s.disableMFA(r.Context(), u.UID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not disable multi-factor authentication")
		return
	}
	clearTrustedCookie(w, r)
	s.recordLoginAudit(r.Context(), u, "MFA disabled")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleListDevices / handleRevokeDevice / handleRevokeAllDevices back the Trusted Devices screen.
func (s *Server) handleListDevices(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	devices, err := s.listTrustedDevices(r.Context(), r, u.UID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list trusted devices")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": devices})
}

func (s *Server) handleRevokeDevice(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")
	ok, err := s.revokeTrustedDevice(r.Context(), u.UID, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not revoke that device")
		return
	}
	if !ok {
		writeErr(w, http.StatusNotFound, "that device is not on your list")
		return
	}
	s.recordLoginAudit(r.Context(), u, "Trusted device revoked")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleRevokeAllDevices(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	n, err := s.revokeAllTrustedDevices(r.Context(), u.UID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not revoke trusted devices")
		return
	}
	// Including this browser: "revoke all" that quietly spared the device you are sitting at
	// would not be all.
	clearTrustedCookie(w, r)
	s.recordLoginAudit(r.Context(), u, "All trusted devices revoked")
	writeJSON(w, http.StatusOK, map[string]any{"revoked": n})
}

// recordLoginAudit writes a security event to the existing login_audit table, so MFA activity
// appears alongside sign-ins rather than in a new log nobody reads.
func (s *Server) recordLoginAudit(ctx context.Context, u authedUser, action string) {
	_, _ = s.db.Exec(ctx,
		`INSERT INTO login_audit (id, "user", action, role, timestamp)
		 VALUES ($1, $2, $3, $4, $5)`,
		newUID(), u.Name, action, u.Role, time.Now().UTC().Format(time.RFC3339))
}

// handleMe re-validates a stored token on page load, standing in for onAuthStateChanged.
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{
		"uid": u.UID, "email": u.Email, "isDemo": u.IsDemo,
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
	// The demo account's password is published on the login page. Letting a visitor change it
	// would lock out every visitor after them.
	if denyDemo(w, u) {
		return
	}
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
	if _, err = s.db.Exec(ctx,
		`UPDATE users SET password_algo = 'bcrypt', password_hash = $2, password_salt = NULL WHERE id = $1`,
		uid, string(hash)); err != nil {
		return err
	}

	// A password change ends device trust for that account - whether the user changed it
	// themselves or an administrator reset it. Device trust records that someone already proved
	// the second factor; after a credential change that assurance is stale, and the usual reason
	// for changing a password is suspecting someone else has had access. Every trusted browser
	// must therefore re-verify. Placed here rather than in the handlers so a future code path
	// that sets a password cannot forget to do it.
	if _, err := s.revokeAllTrustedDevices(ctx, uid); err != nil {
		return err
	}
	return nil
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
			// Not one of ours. When Firebase auth is configured, it may be a Firebase ID token.
			//
			// Both are accepted deliberately: a switch to Firebase cannot be atomic across every
			// signed-in browser, and refusing our own tokens the moment FIREBASE_PROJECT_ID is set
			// would sign everyone out mid-shift. Set FIREBASE_ONLY=true to stop accepting local
			// sessions once the changeover is done.
			if pid := firebaseProjectID(); pid != "" {
				id, ferr := verifyFirebaseIDToken(r.Context(), token, pid)
				if ferr == nil {
					u, uerr := s.resolveFirebaseUser(r.Context(), id)
					if uerr != nil {
						writeErr(w, http.StatusForbidden, uerr.Error())
						return
					}
					next(w, r.WithContext(context.WithValue(r.Context(), userKey, u)))
					return
				}
			}
			writeErr(w, http.StatusUnauthorized, "session expired")
			return
		}
		if env("FIREBASE_ONLY", "false") == "true" {
			writeErr(w, http.StatusUnauthorized, "please sign in again")
			return
		}
		// A challenge token means the password was right and nothing else. It must never reach an
		// application endpoint, or the second factor becomes decorative.
		if claims.Purpose != "" {
			writeErr(w, http.StatusUnauthorized, "verification is not complete")
			return
		}

		var role, name, email string
		var disabled, isDemo bool
		if err := s.db.QueryRow(r.Context(),
			`SELECT role, name, email, disabled, is_demo FROM users WHERE id = $1`, claims.UID).
			Scan(&role, &name, &email, &disabled, &isDemo); err != nil {
			writeErr(w, http.StatusUnauthorized, "unknown account")
			return
		}
		if disabled {
			writeErr(w, http.StatusForbidden, "this account has been disabled")
			return
		}

		u := authedUser{UID: claims.UID, Email: email, Role: role, Name: name, IsDemo: isDemo}
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
