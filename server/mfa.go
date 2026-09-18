package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"
)

// Multi-factor authentication: time-based one-time passwords (RFC 6238), the same standard
// Google Authenticator, Authy, 1Password and Microsoft Authenticator implement.
//
// Two rules shape everything here:
//
//   1. The shared secret is the second factor. Anyone holding it can mint valid codes forever, so
//      it is encrypted at rest and never returned to the client after enrolment completes.
//   2. A half-finished enrolment is not a second factor. `enabled` stays false until the user has
//      proved they can produce a code from the secret they were given.

const (
	mfaIssuer        = "Clinical EHR"
	mfaBackupCount   = 10
	mfaBackupLen     = 10 // characters, before the hyphen is inserted
	mfaChallengeTTL  = 5 * time.Minute
	mfaSkewPeriods   = 1 // accept the adjacent 30s windows, for clock drift
	mfaChallengeKind = "mfa-challenge"
)

var (
	errMFANotEnrolled = errors.New("multi-factor authentication is not set up for this account")
	errMFABadCode     = errors.New("that code is not valid")
)

// mfaEnforced reports whether an account must satisfy MFA to sign in.
//
// Default "all": every account. MFA_ENFORCEMENT=none turns the requirement off without removing
// anyone's enrolment - an operator-level safety valve for the case where something goes wrong
// during rollout and people would otherwise be locked out of their own records. It is deliberately
// not settable per user from the UI: that would be a bypass rather than a configuration.
func mfaEnforced() bool {
	return !strings.EqualFold(strings.TrimSpace(env("MFA_ENFORCEMENT", "all")), "none")
}

// ---------- secret encryption ----------

// mfaKey derives the AES key for secret encryption from the JWT signing secret.
//
// Deriving rather than reusing keeps the two purposes cryptographically separate, so a token
// signing operation can never be coerced into acting on a stored secret. MFA_SECRET_KEY overrides
// it where an operator wants the two rotated independently - rotating JWT_SECRET otherwise makes
// every enrolled secret undecryptable, which would force everyone to re-enrol.
func (s *Server) mfaKey() []byte {
	if custom := strings.TrimSpace(env("MFA_SECRET_KEY", "")); custom != "" {
		sum := sha256.Sum256([]byte(custom))
		return sum[:]
	}
	mac := hmac.New(sha256.New, s.jwtSecret)
	mac.Write([]byte("medbill/mfa-secret-encryption/v1"))
	return mac.Sum(nil)
}

func (s *Server) encryptSecret(plain string) (string, error) {
	block, err := aes.NewCipher(s.mfaKey())
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	// Nonce is prefixed to the ciphertext; GCM authenticates both, so a tampered row fails to
	// decrypt rather than yielding a wrong secret.
	return base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(plain), nil)), nil
}

func (s *Server) decryptSecret(encoded string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(s.mfaKey())
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", errors.New("stored secret is truncated")
	}
	plain, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	if err != nil {
		return "", fmt.Errorf("stored secret could not be decrypted: %w", err)
	}
	return string(plain), nil
}

// ---------- enrolment state ----------

type mfaState struct {
	Enrolled bool
	Enabled  bool
	Secret   string
}

func (s *Server) mfaStateFor(ctx context.Context, uid string) (mfaState, error) {
	var enc string
	var enabled bool
	err := s.db.QueryRow(ctx, `SELECT secret_enc, enabled FROM user_mfa WHERE user_id = $1`, uid).
		Scan(&enc, &enabled)
	if err != nil {
		return mfaState{}, nil // no row: not enrolled, which is not an error
	}
	secret, err := s.decryptSecret(enc)
	if err != nil {
		return mfaState{}, err
	}
	return mfaState{Enrolled: true, Enabled: enabled, Secret: secret}, nil
}

// beginEnrolment creates (or replaces) a pending enrolment and returns the secret plus the
// otpauth:// URI the authenticator app scans.
//
// Replacing a pending enrolment is safe; replacing an ENABLED one is not, and is refused, or a
// stolen session could silently swap the second factor for one the attacker controls.
func (s *Server) beginEnrolment(ctx context.Context, uid, email string) (secret, uri string, err error) {
	state, err := s.mfaStateFor(ctx, uid)
	if err != nil {
		return "", "", err
	}
	if state.Enabled {
		return "", "", errors.New("multi-factor authentication is already set up for this account")
	}

	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      mfaIssuer,
		AccountName: email,
		Period:      30,
		Digits:      otp.DigitsSix,
		Algorithm:   otp.AlgorithmSHA1, // what every mainstream authenticator app implements
	})
	if err != nil {
		return "", "", err
	}

	enc, err := s.encryptSecret(key.Secret())
	if err != nil {
		return "", "", err
	}
	if _, err := s.db.Exec(ctx,
		`INSERT INTO user_mfa (user_id, secret_enc, enabled, backup_codes, updated_at)
		 VALUES ($1, $2, FALSE, '[]'::jsonb, now())
		 ON CONFLICT (user_id) DO UPDATE
		   SET secret_enc = EXCLUDED.secret_enc, enabled = FALSE,
		       backup_codes = '[]'::jsonb, updated_at = now()`,
		uid, enc); err != nil {
		return "", "", err
	}
	return key.Secret(), key.URL(), nil
}

// completeEnrolment turns a pending enrolment on, once the user has proved they can produce a
// code from it, and returns the one and only copy of their backup codes.
func (s *Server) completeEnrolment(ctx context.Context, uid, code string) ([]string, error) {
	state, err := s.mfaStateFor(ctx, uid)
	if err != nil {
		return nil, err
	}
	if !state.Enrolled {
		return nil, errMFANotEnrolled
	}
	if !validateTOTP(code, state.Secret) {
		return nil, errMFABadCode
	}

	plain, hashed, err := generateBackupCodes()
	if err != nil {
		return nil, err
	}
	blob, err := json.Marshal(hashed)
	if err != nil {
		return nil, err
	}
	if _, err := s.db.Exec(ctx,
		`UPDATE user_mfa
		    SET enabled = TRUE, enrolled_at = now(), backup_codes = $2::jsonb, updated_at = now()
		  WHERE user_id = $1`, uid, string(blob)); err != nil {
		return nil, err
	}
	return plain, nil
}

// disableMFA removes the enrolment entirely, and with it every trusted device.
//
// A trusted device is a record that this browser already satisfied MFA. Once MFA is gone those
// records mean nothing, and leaving them behind would let a device keep a bypass for a check that
// no longer exists - so they go in the same transaction.
func (s *Server) disableMFA(ctx context.Context, uid string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	if _, err := tx.Exec(ctx, `DELETE FROM user_mfa WHERE user_id = $1`, uid); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE trusted_devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, uid); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ---------- code verification ----------

// validateTOTP checks a 6-digit code, allowing one 30-second window either side so a phone whose
// clock is slightly off still works.
func validateTOTP(code, secret string) bool {
	code = strings.TrimSpace(strings.ReplaceAll(code, " ", ""))
	if len(code) != 6 {
		return false
	}
	ok, err := totp.ValidateCustom(code, secret, time.Now().UTC(), totp.ValidateOpts{
		Period:    30,
		Skew:      mfaSkewPeriods,
		Digits:    otp.DigitsSix,
		Algorithm: otp.AlgorithmSHA1,
	})
	return err == nil && ok
}

// consumeBackupCode checks a recovery code and, if it matches, removes it.
//
// Single use is the point: a code that kept working would be a permanent password-equivalent
// sitting in whatever the user wrote it down on.
func (s *Server) consumeBackupCode(ctx context.Context, uid, code string) bool {
	normalised := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(code), "-", ""))
	if normalised == "" {
		return false
	}

	var blob []byte
	if err := s.db.QueryRow(ctx, `SELECT backup_codes FROM user_mfa WHERE user_id = $1`, uid).Scan(&blob); err != nil {
		return false
	}
	var hashes []string
	if err := json.Unmarshal(blob, &hashes); err != nil {
		return false
	}
	for i, h := range hashes {
		if bcrypt.CompareHashAndPassword([]byte(h), []byte(normalised)) == nil {
			remaining := append(append([]string{}, hashes[:i]...), hashes[i+1:]...)
			updated, err := json.Marshal(remaining)
			if err != nil {
				return false
			}
			if _, err := s.db.Exec(ctx,
				`UPDATE user_mfa SET backup_codes = $2::jsonb, updated_at = now() WHERE user_id = $1`,
				uid, string(updated)); err != nil {
				return false
			}
			return true
		}
	}
	return false
}

// ---------- backup codes ----------

// Unambiguous alphabet: no O/0, I/1, or similar pairs, because these get written on paper and
// typed back in by someone reading their own handwriting.
const backupAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func generateBackupCodes() (plain []string, hashed []string, err error) {
	for i := 0; i < mfaBackupCount; i++ {
		buf := make([]byte, mfaBackupLen)
		if _, err := io.ReadFull(rand.Reader, buf); err != nil {
			return nil, nil, err
		}
		var sb strings.Builder
		for _, b := range buf {
			sb.WriteByte(backupAlphabet[int(b)%len(backupAlphabet)])
		}
		raw := sb.String()
		h, err := bcrypt.GenerateFromPassword([]byte(raw), bcrypt.DefaultCost)
		if err != nil {
			return nil, nil, err
		}
		// Displayed hyphenated for legibility; compared with the hyphen stripped.
		plain = append(plain, raw[:5]+"-"+raw[5:])
		hashed = append(hashed, string(h))
	}
	return plain, hashed, nil
}

func (s *Server) backupCodesRemaining(ctx context.Context, uid string) int {
	var blob []byte
	if err := s.db.QueryRow(ctx, `SELECT backup_codes FROM user_mfa WHERE user_id = $1`, uid).Scan(&blob); err != nil {
		return 0
	}
	var hashes []string
	if err := json.Unmarshal(blob, &hashes); err != nil {
		return 0
	}
	return len(hashes)
}
