// hashpw prints a bcrypt hash for a password, using the exact library the server verifies with.
//
//	go run ./cmd/hashpw                 # generates a strong random password and its hash
//	go run ./cmd/hashpw 'my password'   # hashes the password you choose
//
// Why this exists rather than htpasswd: htpasswd emits a $2y$ prefix, which Go's bcrypt refuses
// outright, and routing a $-laden hash through a shell invites it to be mangled before it ever
// reaches the database. This prints something safe to paste.
package main

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"os"

	"golang.org/x/crypto/bcrypt"
)

// Unambiguous alphabet: no O/0 or I/l, because these get read aloud and typed by hand.
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"

func randomPassword(n int) (string, error) {
	out := make([]byte, n)
	for i := range out {
		k, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			return "", err
		}
		out[i] = alphabet[k.Int64()]
	}
	return string(out), nil
}

func main() {
	password := ""
	generated := false
	if len(os.Args) > 1 {
		password = os.Args[1]
	} else {
		p, err := randomPassword(20)
		if err != nil {
			fmt.Fprintln(os.Stderr, "could not generate a password:", err)
			os.Exit(1)
		}
		password, generated = p, true
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		fmt.Fprintln(os.Stderr, "could not hash:", err)
		os.Exit(1)
	}

	// Proves the hash verifies before it is used, so a bad paste is caught here and not at a
	// login screen that only ever says "invalid email or password".
	if bcrypt.CompareHashAndPassword(hash, []byte(password)) != nil {
		fmt.Fprintln(os.Stderr, "the generated hash failed its own verification")
		os.Exit(1)
	}

	if generated {
		fmt.Println("password:", password)
	}
	fmt.Println("hash:    ", string(hash))
}
