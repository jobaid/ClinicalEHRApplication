package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strings"
	"time"
)

// Trusted devices: "don't ask me for a code on this browser for 30 days".
//
// The security property that matters is that the browser holds a bearer token it cannot read,
// forge or manufacture, and the server holds only a hash of it. Concretely:
//
//   - 32 bytes from crypto/rand. Not derived from the user, the device or the time, so it cannot
//     be guessed from anything an attacker knows.
//   - Stored server-side as SHA-256 only. A dump of trusted_devices lets nobody skip MFA, for the
//     same reason a dump of users lets nobody sign in.
//   - Delivered as an httpOnly cookie, so page JavaScript - including anything injected through
//     an XSS hole - cannot read it. This is the concrete difference from
//     localStorage.setItem("mfaVerified", "true"), which any script on the page can simply write.
//   - Checked against the database on every login: expiry, revocation and ownership are all
//     server-side facts. The cookie proves possession; it decides nothing by itself.
//
// A stolen cookie is still a stolen credential - that is true of every "remember me" scheme, and
// is why the window is bounded at 30 days, why it is revocable, and why the UI says to use it
// only on a private machine.

const (
	trustedDeviceTTL    = 30 * 24 * time.Hour
	trustedDeviceCookie = "medbill_td"
	trustedTokenBytes   = 32
)

func hashTrustedToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// issueTrustedDevice records a new trusted device and returns the raw token for the cookie.
// The raw token is returned once and never stored, so it exists only in this response and in the
// browser that receives it.
func (s *Server) issueTrustedDevice(ctx context.Context, uid, userAgent string) (string, time.Time, error) {
	buf := make([]byte, trustedTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", time.Time{}, err
	}
	raw := base64.RawURLEncoding.EncodeToString(buf)
	expires := time.Now().Add(trustedDeviceTTL)

	if len(userAgent) > 400 {
		userAgent = userAgent[:400]
	}
	if _, err := s.db.Exec(ctx,
		`INSERT INTO trusted_devices (id, user_id, token_hash, user_agent, label, expires_at, last_used_at)
		 VALUES ($1, $2, $3, $4, $5, $6, now())`,
		newUID(), uid, hashTrustedToken(raw), userAgent, describeUserAgent(userAgent), expires,
	); err != nil {
		return "", time.Time{}, err
	}
	return raw, expires, nil
}

// trustedDeviceValid reports whether this request carries a live trusted-device cookie for this
// user, and refreshes last_used_at when it does.
//
// Every condition is checked in SQL against the row: it belongs to this user, it has not expired,
// and it has not been revoked. Nothing is taken from the cookie except the token itself.
func (s *Server) trustedDeviceValid(ctx context.Context, r *http.Request, uid string) bool {
	c, err := r.Cookie(trustedDeviceCookie)
	if err != nil || c.Value == "" {
		return false
	}
	tag, err := s.db.Exec(ctx,
		`UPDATE trusted_devices
		    SET last_used_at = now()
		  WHERE token_hash = $1
		    AND user_id    = $2
		    AND revoked_at IS NULL
		    AND expires_at > now()`,
		hashTrustedToken(c.Value), uid)
	return err == nil && tag.RowsAffected() == 1
}

// setTrustedCookie writes the cookie the browser will present on later logins.
//
// httpOnly:  script cannot read it, so an XSS bug cannot exfiltrate the bypass.
// SameSite:  Lax, so it still arrives on a normal top-level navigation to the login page while
//
//	not riding along on third-party requests.
//
// Secure:    set whenever the request arrived over TLS (directly or via a proxy that says so).
//
//	Left off for plain-HTTP localhost development, where the browser would otherwise
//	silently discard the cookie and trust would appear broken for no visible reason.
func setTrustedCookie(w http.ResponseWriter, r *http.Request, raw string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     trustedDeviceCookie,
		Value:    raw,
		Path:     "/",
		Expires:  expires,
		MaxAge:   int(time.Until(expires).Seconds()),
		HttpOnly: true,
		Secure:   requestIsTLS(r),
		SameSite: http.SameSiteLaxMode,
	})
}

func clearTrustedCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     trustedDeviceCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   requestIsTLS(r),
		SameSite: http.SameSiteLaxMode,
	})
}

func requestIsTLS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	// Behind nginx or CloudPanel the connection to Go is plain HTTP; the proxy reports the
	// browser-facing scheme here.
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// ---------- management ----------

type trustedDeviceRow struct {
	ID         string     `json:"id"`
	Label      string     `json:"label"`
	UserAgent  string     `json:"userAgent"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	Current    bool       `json:"current"`
}

func (s *Server) listTrustedDevices(ctx context.Context, r *http.Request, uid string) ([]trustedDeviceRow, error) {
	rows, err := s.db.Query(ctx,
		`SELECT id, label, user_agent, created_at, last_used_at, expires_at, token_hash
		   FROM trusted_devices
		  WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
		  ORDER BY last_used_at DESC NULLS LAST, created_at DESC`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	currentHash := ""
	if c, err := r.Cookie(trustedDeviceCookie); err == nil && c.Value != "" {
		currentHash = hashTrustedToken(c.Value)
	}

	out := []trustedDeviceRow{}
	for rows.Next() {
		var d trustedDeviceRow
		var hash string
		if err := rows.Scan(&d.ID, &d.Label, &d.UserAgent, &d.CreatedAt, &d.LastUsedAt, &d.ExpiresAt, &hash); err != nil {
			return nil, err
		}
		// Marks "this browser" in the list, so nobody revokes the device they are sitting at by
		// accident - or, worse, revokes every other one believing it was this one.
		d.Current = currentHash != "" && hash == currentHash
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Server) revokeTrustedDevice(ctx context.Context, uid, id string) (bool, error) {
	// user_id is in the WHERE clause, so one account cannot revoke another account's device by
	// guessing an id.
	tag, err := s.db.Exec(ctx,
		`UPDATE trusted_devices SET revoked_at = now()
		  WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, id, uid)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// revokeAllTrustedDevices is the single entry point for every security event that should end
// device trust: the user asking, a password change, a password reset by an administrator, and
// MFA being disabled. Keeping one function means a new security event cannot forget one table.
func (s *Server) revokeAllTrustedDevices(ctx context.Context, uid string) (int64, error) {
	tag, err := s.db.Exec(ctx,
		`UPDATE trusted_devices SET revoked_at = now()
		  WHERE user_id = $1 AND revoked_at IS NULL`, uid)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// describeUserAgent produces a short human label such as "Chrome on Windows".
//
// Deliberately modest: the User-Agent string is all the browser gives us, it can be edited by
// whoever sends it, and it says nothing trustworthy about the hardware. Presenting a guessed
// device model would invite people to make security decisions on a value we cannot stand behind.
func describeUserAgent(ua string) string {
	if strings.TrimSpace(ua) == "" {
		return "Unknown browser"
	}
	browser := "Unknown browser"
	switch {
	case strings.Contains(ua, "Edg/"):
		browser = "Edge"
	case strings.Contains(ua, "OPR/"), strings.Contains(ua, "Opera"):
		browser = "Opera"
	case strings.Contains(ua, "Firefox/"):
		browser = "Firefox"
	case strings.Contains(ua, "Chrome/"):
		browser = "Chrome"
	case strings.Contains(ua, "Safari/"):
		browser = "Safari"
	}
	os := ""
	switch {
	case strings.Contains(ua, "Windows NT"):
		os = "Windows"
	case strings.Contains(ua, "Android"):
		os = "Android"
	case strings.Contains(ua, "iPhone"), strings.Contains(ua, "iPad"):
		os = "iOS"
	case strings.Contains(ua, "Mac OS X"):
		os = "macOS"
	case strings.Contains(ua, "Linux"):
		os = "Linux"
	}
	if os == "" {
		return browser
	}
	return browser + " on " + os
}
