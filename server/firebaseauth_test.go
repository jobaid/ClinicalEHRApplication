package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Every check in verifyFirebaseIDToken is a door. These tests try to walk through each one.
//
// The signing key is ours rather than Google's, which is the only way to produce a token that is
// correctly signed but wrong in exactly one respect - the situation each negative case needs.

const testProject = "billing-d9417"

func testKeys(t *testing.T) (*rsa.PrivateKey, func()) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	original := fetchSigningKey
	fetchSigningKey = func(context.Context, string) (*rsa.PublicKey, error) { return &key.PublicKey, nil }
	return key, func() { fetchSigningKey = original }
}

func sign(t *testing.T, key *rsa.PrivateKey, claims jwt.Claims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = "test-key"
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

func goodClaims() *firebaseClaims {
	return &firebaseClaims{
		Email:         "admin@medbill.local",
		EmailVerified: true,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "firebase-uid-123",
			Audience:  jwt.ClaimStrings{testProject},
			Issuer:    "https://securetoken.google.com/" + testProject,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
}

func TestFirebaseTokenAccepted(t *testing.T) {
	key, restore := testKeys(t)
	defer restore()

	id, err := verifyFirebaseIDToken(context.Background(), sign(t, key, goodClaims()), testProject)
	if err != nil {
		t.Fatalf("a well-formed token was rejected: %v", err)
	}
	if id.UID != "firebase-uid-123" {
		t.Errorf("uid = %q, want firebase-uid-123", id.UID)
	}
	if id.Email != "admin@medbill.local" {
		t.Errorf("email = %q", id.Email)
	}
}

// The single most important check. Firebase ID tokens are issued by Google for every project in
// the world; `aud` is what makes one belong to THIS practice. Without it, anybody with any
// Firebase project could mint a token that this server would accept.
func TestFirebaseTokenFromAnotherProjectRejected(t *testing.T) {
	key, restore := testKeys(t)
	defer restore()

	c := goodClaims()
	c.Audience = jwt.ClaimStrings{"someone-elses-project"}
	c.Issuer = "https://securetoken.google.com/someone-elses-project"

	if _, err := verifyFirebaseIDToken(context.Background(), sign(t, key, c), testProject); err == nil {
		t.Fatal("a token for a different Firebase project was ACCEPTED")
	}
}

func TestFirebaseTokenWrongIssuerRejected(t *testing.T) {
	key, restore := testKeys(t)
	defer restore()

	c := goodClaims()
	c.Issuer = "https://evil.example.com/" + testProject
	if _, err := verifyFirebaseIDToken(context.Background(), sign(t, key, c), testProject); err == nil {
		t.Fatal("a token with a forged issuer was ACCEPTED")
	}
}

func TestFirebaseTokenExpiredRejected(t *testing.T) {
	key, restore := testKeys(t)
	defer restore()

	c := goodClaims()
	c.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Minute))
	if _, err := verifyFirebaseIDToken(context.Background(), sign(t, key, c), testProject); err == nil {
		t.Fatal("an expired token was ACCEPTED")
	}
}

func TestFirebaseTokenWithoutExpiryRejected(t *testing.T) {
	key, restore := testKeys(t)
	defer restore()

	c := goodClaims()
	c.ExpiresAt = nil
	if _, err := verifyFirebaseIDToken(context.Background(), sign(t, key, c), testProject); err == nil {
		t.Fatal("a token with no expiry was ACCEPTED")
	}
}

func TestFirebaseTokenWithoutSubjectRejected(t *testing.T) {
	key, restore := testKeys(t)
	defer restore()

	c := goodClaims()
	c.Subject = ""
	if _, err := verifyFirebaseIDToken(context.Background(), sign(t, key, c), testProject); err == nil {
		t.Fatal("a token with no subject was ACCEPTED")
	}
}

// Algorithm confusion: a token that claims alg:HS256 while the verifier holds an RSA public key.
// Where the key type is not pinned, the public key gets used as an HMAC secret - and it is public,
// so anyone can forge a token. The method check in the keyfunc is what closes this.
func TestFirebaseTokenAlgorithmConfusionRejected(t *testing.T) {
	_, restore := testKeys(t)
	defer restore()

	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, goodClaims())
	tok.Header["kid"] = "test-key"
	forged, err := tok.SignedString([]byte("public key used as a shared secret"))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := verifyFirebaseIDToken(context.Background(), forged, testProject); err == nil {
		t.Fatal("an HS256 token was ACCEPTED where RS256 was required")
	}
}

func TestFirebaseTokenSignedByAnotherKeyRejected(t *testing.T) {
	_, restore := testKeys(t)
	defer restore()

	// A different key entirely: correct claims, wrong signer.
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if _, err := verifyFirebaseIDToken(context.Background(), sign(t, other, goodClaims()), testProject); err == nil {
		t.Fatal("a token signed by an unknown key was ACCEPTED")
	}
}

func TestFirebaseDisabledWhenNoProjectConfigured(t *testing.T) {
	key, restore := testKeys(t)
	defer restore()

	// With no project id there is nothing to check `aud` against, so verification must refuse
	// rather than fall through and accept whatever it is given.
	if _, err := verifyFirebaseIDToken(context.Background(), sign(t, key, goodClaims()), ""); err == nil {
		t.Fatal("verification succeeded with no project configured")
	}
}

func TestMaxAgeFrom(t *testing.T) {
	cases := map[string]time.Duration{
		"public, max-age=19260, must-revalidate, no-transform": 19260 * time.Second,
		"max-age=3600": 3600 * time.Second,
		"no-cache":     0,
		"":             0,
		"max-age=abc":  0,
	}
	for header, want := range cases {
		if got := maxAgeFrom(header); got != want {
			t.Errorf("maxAgeFrom(%q) = %v, want %v", header, got, want)
		}
	}
}
