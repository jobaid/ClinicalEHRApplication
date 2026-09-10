package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Verifies the Firebase scrypt port against the REAL exported hashes, using the seed accounts
// whose plaintext passwords are known from scripts/seedFirestore.mjs. If this passes, every
// migrated account can sign in with its existing password.

type exportedUser struct {
	LocalID      string `json:"localId"`
	Email        string `json:"email"`
	PasswordHash string `json:"passwordHash"`
	Salt         string `json:"salt"`
}

func loadExport(t *testing.T) (FirebaseHashConfig, map[string]exportedUser) {
	t.Helper()
	base := filepath.Join("..", "migration-export")

	cfgRaw, err := os.ReadFile(filepath.Join(base, "_hash-config.json"))
	if err != nil {
		t.Skipf("no hash config exported yet: %v", err)
	}
	var cfg FirebaseHashConfig
	if err := json.Unmarshal(cfgRaw, &cfg); err != nil {
		t.Fatalf("hash config: %v", err)
	}

	usersRaw, err := os.ReadFile(filepath.Join(base, "_auth-export.json"))
	if err != nil {
		t.Skipf("no auth export yet: %v", err)
	}
	var wrapper struct {
		Users []exportedUser `json:"users"`
	}
	if err := json.Unmarshal(usersRaw, &wrapper); err != nil {
		t.Fatalf("auth export: %v", err)
	}
	byEmail := map[string]exportedUser{}
	for _, u := range wrapper.Users {
		byEmail[u.Email] = u
	}
	return cfg, byEmail
}

func TestFirebaseScryptAgainstRealHashes(t *testing.T) {
	cfg, users := loadExport(t)

	// Plaintext passwords from scripts/seedFirestore.mjs.
	known := map[string]string{
		"admin@medbill.local":     "Admin@12345",
		"manager@medbill.local":   "Manager@12345",
		"nurse@medbill.local":     "Nurse@12345",
		"reception@medbill.local": "Reception@12345",
		"biller@medbill.local":    "Biller@12345",
	}

	for email, password := range known {
		u, ok := users[email]
		if !ok {
			t.Errorf("%s: not present in the auth export", email)
			continue
		}
		ok, err := VerifyFirebaseScrypt(cfg, password, u.Salt, u.PasswordHash)
		if err != nil {
			t.Errorf("%s: verify errored: %v", email, err)
			continue
		}
		if !ok {
			t.Errorf("%s: correct password REJECTED - scrypt parameters are wrong", email)
			continue
		}
		t.Logf("%s: correct password accepted", email)

		// A wrong password must not validate.
		bad, err := VerifyFirebaseScrypt(cfg, password+"x", u.Salt, u.PasswordHash)
		if err != nil {
			t.Errorf("%s: negative check errored: %v", email, err)
		}
		if bad {
			t.Errorf("%s: WRONG password accepted", email)
		}
	}
}
