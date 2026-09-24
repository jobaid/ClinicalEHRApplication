package main

import "testing"

// loadDemoConfig is the gate on a feature that publishes a working password on a public page.
// Every way it can be misconfigured should end in "disabled", never in "enabled with something
// surprising".

func TestDemoDisabledWhenUnset(t *testing.T) {
	t.Setenv("DEMO_USER_EMAIL", "")
	t.Setenv("DEMO_USER_PASSWORD", "")

	cfg, err := loadDemoConfig()
	if err != nil {
		t.Fatalf("unset configuration should not be an error: %v", err)
	}
	if cfg.Enabled {
		t.Error("no demo account was configured, but one is enabled")
	}
}

// Half-configured must fail loudly rather than invent the missing half. An email with no password
// that silently became "enabled" would be an account nobody could sign into but that the login
// page advertised.
func TestDemoRequiresBothValues(t *testing.T) {
	cases := []struct{ name, email, password string }{
		{"email without password", "demo@example.com", ""},
		{"password without email", "", "a-long-enough-password"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("DEMO_USER_EMAIL", c.email)
			t.Setenv("DEMO_USER_PASSWORD", c.password)
			if _, err := loadDemoConfig(); err == nil {
				t.Error("expected an error, got none")
			}
		})
	}
}

func TestDemoRejectsWeakOrMalformedValues(t *testing.T) {
	cases := []struct{ name, email, password string }{
		{"short password", "demo@example.com", "short"},
		{"not an address", "demo-manager", "a-long-enough-password"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("DEMO_USER_EMAIL", c.email)
			t.Setenv("DEMO_USER_PASSWORD", c.password)
			cfg, err := loadDemoConfig()
			if err == nil {
				t.Error("expected an error, got none")
			}
			if cfg.Enabled {
				t.Error("rejected configuration must not come back enabled")
			}
		})
	}
}

// The role is a compile-time constant on purpose. If it ever becomes configurable, a typo in an
// environment file could publish SUPER_ADMIN credentials on a public login page.
func TestDemoRoleIsPinnedToManager(t *testing.T) {
	if demoRole != "MANAGER" {
		t.Fatalf("demoRole = %q, want MANAGER", demoRole)
	}
	if demoRole == "SUPER_ADMIN" {
		t.Fatal("the demo account must never be a Super Admin")
	}
}

func TestDemoConfigAcceptsValidSettings(t *testing.T) {
	t.Setenv("DEMO_USER_EMAIL", "demo.manager@example.com")
	t.Setenv("DEMO_USER_PASSWORD", "a-sufficiently-long-password")
	t.Setenv("DEMO_USER_NAME", "Manager Demo")

	cfg, err := loadDemoConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !cfg.Enabled {
		t.Fatal("valid configuration did not enable the demo account")
	}
	if cfg.Email != "demo.manager@example.com" || cfg.Name != "Manager Demo" {
		t.Errorf("got %+v", cfg)
	}
}

// denyDemo is the guard on every endpoint that would let a visitor break the published
// credentials. It must be inert for everyone else.
func TestDenyDemoOnlyBlocksDemoAccounts(t *testing.T) {
	if denyDemo(nil, authedUser{IsDemo: false}) {
		t.Error("a normal account was blocked by the demo guard")
	}
}
