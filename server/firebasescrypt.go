package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"encoding/base64"
	"errors"

	"golang.org/x/crypto/scrypt"
)

// Firebase Auth's password hash, reimplemented so every account migrated out of Firebase can
// sign in with the password it already had - no forced resets.
//
// Firebase uses standard scrypt to derive a key, then uses that key to AES-CTR encrypt the
// project's `signerKey`. The stored passwordHash is the base64 of that ciphertext. The project
// hash parameters (signerKey, saltSeparator, rounds, memoryCost) come from the Identity Toolkit
// admin config and are captured at migration time - see scripts/migrateToPostgres.mjs.
//
//	key  = scrypt(password, salt||saltSeparator, N=2^memoryCost, r=rounds, p=1, keyLen=32)
//	hash = base64( AES-256-CTR(key, iv=0).encrypt(signerKey) )
//
// This implementation is verified against real exported hashes at startup (see verifySelfTest)
// using the seed accounts whose plaintext passwords are known.

type FirebaseHashConfig struct {
	SignerKey     string `json:"signerKey"`
	SaltSeparator string `json:"saltSeparator"`
	Rounds        int    `json:"rounds"`
	MemoryCost    int    `json:"memoryCost"`
}

var errBadHashConfig = errors.New("firebase hash config missing or incomplete")

// VerifyFirebaseScrypt reports whether `password` produces `passwordHash` for the given
// per-user salt under this project's hash parameters.
func VerifyFirebaseScrypt(cfg FirebaseHashConfig, password, saltB64, passwordHashB64 string) (bool, error) {
	if cfg.SignerKey == "" || cfg.Rounds == 0 || cfg.MemoryCost == 0 {
		return false, errBadHashConfig
	}
	salt, err := base64.StdEncoding.DecodeString(saltB64)
	if err != nil {
		return false, err
	}
	sep, err := base64.StdEncoding.DecodeString(cfg.SaltSeparator)
	if err != nil {
		return false, err
	}
	signerKey, err := base64.StdEncoding.DecodeString(cfg.SignerKey)
	if err != nil {
		return false, err
	}
	want, err := base64.StdEncoding.DecodeString(passwordHashB64)
	if err != nil {
		return false, err
	}

	// N = 2^memoryCost, r = rounds, p = 1 - Firebase's parameter naming differs from scrypt's.
	N := 1 << uint(cfg.MemoryCost)
	derived, err := scrypt.Key([]byte(password), append(salt, sep...), N, cfg.Rounds, 1, 32)
	if err != nil {
		return false, err
	}

	block, err := aes.NewCipher(derived)
	if err != nil {
		return false, err
	}
	out := make([]byte, len(signerKey))
	cipher.NewCTR(block, make([]byte, aes.BlockSize)).XORKeyStream(out, signerKey)

	return hmac.Equal(out, want), nil
}
