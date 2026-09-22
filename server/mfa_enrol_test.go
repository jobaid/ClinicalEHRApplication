package main

import (
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

// otpauthURL rebuilds a QR payload for a secret that already exists, so that resuming an
// enrolment shows the SAME code the user already scanned. If what it builds differs in any
// parameter from what totp.Generate produced, the phone and the server silently disagree and
// every six-digit code is rejected - the exact failure this function exists to prevent.
func TestOtpauthURLMatchesGeneratedKey(t *testing.T) {
	const email = "someone@example.com"

	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      mfaIssuer,
		AccountName: email,
		Period:      30,
		Digits:      otp.DigitsSix,
		Algorithm:   otp.AlgorithmSHA1,
	})
	if err != nil {
		t.Fatalf("generate: %v", err)
	}

	rebuilt, err := otp.NewKeyFromURL(otpauthURL(mfaIssuer, email, key.Secret()))
	if err != nil {
		t.Fatalf("the rebuilt URL does not parse: %v", err)
	}

	if rebuilt.Secret() != key.Secret() {
		t.Errorf("secret changed: %q vs %q", rebuilt.Secret(), key.Secret())
	}
	if rebuilt.Issuer() != key.Issuer() {
		t.Errorf("issuer = %q, want %q", rebuilt.Issuer(), key.Issuer())
	}
	if rebuilt.AccountName() != key.AccountName() {
		t.Errorf("account = %q, want %q", rebuilt.AccountName(), key.AccountName())
	}

	// The real check: both must produce the same code at the same instant.
	now := time.Now().UTC()
	a, err := totp.GenerateCode(key.Secret(), now)
	if err != nil {
		t.Fatalf("code from original: %v", err)
	}
	b, err := totp.GenerateCode(rebuilt.Secret(), now)
	if err != nil {
		t.Fatalf("code from rebuilt: %v", err)
	}
	if a != b {
		t.Errorf("codes differ: original %s, rebuilt %s", a, b)
	}
	if !validateTOTP(b, key.Secret()) {
		t.Error("a code from the rebuilt key is rejected by validateTOTP")
	}
}

// Authenticator apps fall back to their own defaults for anything the URI leaves out, and those
// defaults are not universally SHA1/6/30. Stating all three is what keeps a scanned code valid
// across different apps.
func TestOtpauthURLStatesEveryParameter(t *testing.T) {
	raw := otpauthURL(mfaIssuer, "someone@example.com", "JBSWY3DPEHPK3PXP")
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	q := u.Query()
	for key, want := range map[string]string{
		"algorithm": "SHA1",
		"digits":    "6",
		"period":    "30",
		"issuer":    mfaIssuer,
		"secret":    "JBSWY3DPEHPK3PXP",
	} {
		if got := q.Get(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
	if u.Scheme != "otpauth" || u.Host != "totp" {
		t.Errorf("got %s://%s, want otpauth://totp", u.Scheme, u.Host)
	}
	// The label carries the issuer so the app groups the entry sensibly. A "+" here instead of
	// a space is the classic symptom of building this with url.Values.
	if !strings.Contains(u.Path, mfaIssuer+":") {
		t.Errorf("path %q does not carry the issuer label", u.Path)
	}
	if strings.Contains(u.Path, "+") {
		t.Errorf("path %q contains '+', which apps display literally", u.Path)
	}
}

// A skew of one period each side is 90 seconds of total tolerance. Codes outside that must be
// rejected, or the second factor becomes a much weaker one.
func TestValidateTOTPToleranceBoundaries(t *testing.T) {
	secret := "JBSWY3DPEHPK3PXP"
	now := time.Now().UTC()

	for _, offset := range []time.Duration{-30 * time.Second, 0, 30 * time.Second} {
		code, err := totp.GenerateCode(secret, now.Add(offset))
		if err != nil {
			t.Fatalf("generate at %v: %v", offset, err)
		}
		if !validateTOTP(code, secret) {
			t.Errorf("a code %v from now was rejected, but one window of drift must be accepted", offset)
		}
	}

	// Three minutes out - which is what an unsynced device clock looks like - must fail.
	far, err := totp.GenerateCode(secret, now.Add(3*time.Minute))
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if validateTOTP(far, secret) {
		t.Error("a code from 3 minutes away was accepted; the tolerance is far too wide")
	}
}

func TestValidateTOTPRejectsMalformedInput(t *testing.T) {
	secret := "JBSWY3DPEHPK3PXP"
	for _, code := range []string{"", "12345", "1234567", "abcdef", "   "} {
		if validateTOTP(code, secret) {
			t.Errorf("%q was accepted", code)
		}
	}
}
