package main

import "testing"

// A blocked origin is indistinguishable from a bad password in the UI (the login handler has a
// bare catch), so these cases are worth pinning down: every way a developer can reach the dev
// server must be accepted, and nothing off-machine may be.
func TestOriginAllowed(t *testing.T) {
	const configured = "http://localhost:5173,http://127.0.0.1:5173"

	allow := []string{
		"http://localhost:5173",      // Vite "Local"
		"http://127.0.0.1:5173",      // loopback by IP
		"http://192.168.1.183:5173",  // Vite "Network" - the one that was broken
		"http://10.0.0.5:5173",       // other RFC1918 ranges
		"http://172.20.1.4:5173",     //
		"http://localhost:4173",      // npm run preview
		"http://[::1]:5173",          // IPv6 loopback
	}
	for _, o := range allow {
		if !originAllowed(configured, true, o) {
			t.Errorf("origin %s should be ALLOWED", o)
		}
	}

	deny := []string{
		"http://evil.example.com",
		"https://attacker.test:5173",
		"http://8.8.8.8:5173",             // public IP
		"http://evil-localhost:51730",     // must not match as a substring
		"http://localhost.attacker.com",   // suffix trickery
		"",                                // no Origin header
	}
	for _, o := range deny {
		if originAllowed(configured, true, o) {
			t.Errorf("origin %s should be DENIED", o)
		}
	}

	// With local origins switched off, only the configured list is honoured.
	if originAllowed(configured, false, "http://192.168.1.183:5173") {
		t.Error("LAN origin should be denied when ALLOW_LOCAL_ORIGINS=false")
	}
	if !originAllowed(configured, false, "http://localhost:5173") {
		t.Error("configured origin should still be allowed when ALLOW_LOCAL_ORIGINS=false")
	}
	if !originAllowed("*", false, "http://anything.test") {
		t.Error(`"*" should allow any origin`)
	}
}
