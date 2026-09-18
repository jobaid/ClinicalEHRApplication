package main

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Verification of Firebase Authentication ID tokens.
//
// A Firebase ID token is an RS256 JWT signed by Google, not by this server. Verifying one is
// therefore a different job from verifying our own HS256 session token, and every one of these
// checks matters:
//
//   - signature, against Google's rotating public certificates (fetched and cached below);
//   - `aud` equal to the project id - without it, an ID token minted for ANY other Firebase
//     project in the world would be accepted here;
//   - `iss` equal to securetoken.google.com/<project id>;
//   - `exp`/`iat` in range, and a non-empty `sub`.
//
// Google publishes the certificates at a URL with a Cache-Control max-age and rotates them
// roughly daily, so they are cached until that expiry rather than re-fetched per request.

const googleCertsURL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"

// firebaseProjectID returns the configured project, or "" when Firebase auth is not enabled.
// Empty is the default: the server keeps using its own tokens and nothing changes.
func firebaseProjectID() string {
	return strings.TrimSpace(env("FIREBASE_PROJECT_ID", ""))
}

type googleCerts struct {
	mu      sync.RWMutex
	keys    map[string]*rsa.PublicKey
	expires time.Time
}

var certCache = &googleCerts{keys: map[string]*rsa.PublicKey{}}

// Indirection so the verifier can be tested against a key we control. Production always resolves
// through certCache, which only ever holds certificates fetched from Google.
var fetchSigningKey = func(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	return certCache.get(ctx, kid)
}

func (c *googleCerts) get(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	c.mu.RLock()
	if key, ok := c.keys[kid]; ok && time.Now().Before(c.expires) {
		c.mu.RUnlock()
		return key, nil
	}
	c.mu.RUnlock()

	if err := c.refresh(ctx); err != nil {
		return nil, err
	}

	c.mu.RLock()
	defer c.mu.RUnlock()
	key, ok := c.keys[kid]
	if !ok {
		// An unknown key id after a fresh fetch means the token was not signed by Google for this
		// service - not that our cache is stale.
		return nil, fmt.Errorf("unknown signing key %q", kid)
	}
	return key, nil
}

func (c *googleCerts) refresh(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, googleCertsURL, nil)
	if err != nil {
		return err
	}
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("fetch Google signing certificates: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Google signing certificates returned %s", resp.Status)
	}

	var pems map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&pems); err != nil {
		return fmt.Errorf("decode Google signing certificates: %w", err)
	}

	keys := make(map[string]*rsa.PublicKey, len(pems))
	for kid, certPEM := range pems {
		block, _ := pem.Decode([]byte(certPEM))
		if block == nil {
			continue
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			continue
		}
		if pub, ok := cert.PublicKey.(*rsa.PublicKey); ok {
			keys[kid] = pub
		}
	}
	if len(keys) == 0 {
		return errors.New("Google returned no usable signing certificates")
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	c.keys = keys
	// Honour the published cache lifetime; fall back to an hour if the header is missing or odd.
	c.expires = time.Now().Add(time.Hour)
	if cc := resp.Header.Get("Cache-Control"); cc != "" {
		if d := maxAgeFrom(cc); d > time.Minute {
			c.expires = time.Now().Add(d)
		}
	}
	return nil
}

func maxAgeFrom(cacheControl string) time.Duration {
	for _, part := range strings.Split(cacheControl, ",") {
		part = strings.TrimSpace(part)
		if !strings.HasPrefix(part, "max-age=") {
			continue
		}
		var secs int
		if _, err := fmt.Sscanf(part, "max-age=%d", &secs); err == nil && secs > 0 {
			return time.Duration(secs) * time.Second
		}
	}
	return 0
}

// firebaseIdentity is what a verified ID token tells us. Roles are NOT read from it: they live in
// the users table, so an administrator changing someone's role takes effect immediately instead of
// waiting for a token to expire.
type firebaseIdentity struct {
	UID           string
	Email         string
	EmailVerified bool
}

type firebaseClaims struct {
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	jwt.RegisteredClaims
}

// verifyFirebaseIDToken checks a Firebase ID token and returns who it is for.
func verifyFirebaseIDToken(ctx context.Context, raw, projectID string) (firebaseIdentity, error) {
	if projectID == "" {
		return firebaseIdentity{}, errors.New("Firebase auth is not configured")
	}

	claims := &firebaseClaims{}
	_, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
		// Firebase signs ID tokens with RS256. Refusing anything else closes the algorithm
		// confusion hole where a token claiming alg:HS256 would be verified with a public key as
		// if it were a shared secret.
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method %v", t.Header["alg"])
		}
		kid, _ := t.Header["kid"].(string)
		if kid == "" {
			return nil, errors.New("token has no key id")
		}
		return fetchSigningKey(ctx, kid)
	},
		jwt.WithAudience(projectID),
		jwt.WithIssuer("https://securetoken.google.com/"+""+projectID),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return firebaseIdentity{}, err
	}

	// `sub` is the Firebase UID and is what the users table is keyed on.
	if claims.Subject == "" {
		return firebaseIdentity{}, errors.New("token has no subject")
	}
	return firebaseIdentity{
		UID:           claims.Subject,
		Email:         claims.Email,
		EmailVerified: claims.EmailVerified,
	}, nil
}

// resolveFirebaseUser maps a verified Firebase identity onto this application's account record.
//
// Matched on id first, then on email. The email fallback is what lets accounts that were migrated
// out of Firebase be matched back up: their Postgres id is the original Firebase UID in most
// cases, but an account created since (the bootstrap admin, for instance) has a locally generated
// id and only its address in common.
func (s *Server) resolveFirebaseUser(ctx context.Context, id firebaseIdentity) (authedUser, error) {
	var u authedUser
	var disabled bool

	err := s.db.QueryRow(ctx,
		`SELECT id, email, role, name, disabled FROM users WHERE id = $1`, id.UID).
		Scan(&u.UID, &u.Email, &u.Role, &u.Name, &disabled)

	if err != nil && id.Email != "" {
		err = s.db.QueryRow(ctx,
			`SELECT id, email, role, name, disabled FROM users WHERE lower(email) = lower($1)`, id.Email).
			Scan(&u.UID, &u.Email, &u.Role, &u.Name, &disabled)
	}
	if err != nil {
		// Authenticating with Google is not the same as being authorised here. An unknown account
		// is refused rather than created, so signing in to the Firebase project does not by itself
		// grant access to patient data.
		return authedUser{}, errors.New("this account has no access to this practice")
	}
	if disabled {
		return authedUser{}, errors.New("this account has been disabled")
	}
	return u, nil
}
