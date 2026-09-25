package main

import (
	"path/filepath"
	"reflect"
	"testing"
)

// The permission helpers are the security boundary for Backup & Restore, so they are tested
// directly rather than only through the handlers: a mistake here is the difference between
// "this Biller cannot restore production" and "this Biller can".

func TestSanitizeUserPermissionsRejectsUnknownValues(t *testing.T) {
	got, dropped := sanitizeUserPermissions([]any{
		PermBackupView,
		"BACKUP_EVERYTHING", // not a real permission
		"insurance.delete",  // a real permission, but from the ROLE allowlist, not this one
		PermBackupCreate,
		42,
	})

	want := []string{PermBackupView, PermBackupCreate}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("kept %v, want %v", got, want)
	}
	if !dropped {
		t.Error("dropped = false, but three values were discarded")
	}
}

// A role-scoped grant must not be settable through the user-scoped API. If these two allowlists
// ever merge, backup access becomes grantable by editing a role, which routes around the whole
// "the Super Admin decides which users" requirement.
func TestRoleAndUserAllowlistsDoNotOverlap(t *testing.T) {
	for p := range knownUserPermissions {
		if knownPermissions[p] {
			t.Errorf("%q appears in both the role and user allowlists", p)
		}
	}
	for p := range knownPermissions {
		if knownUserPermissions[p] {
			t.Errorf("%q appears in both the role and user allowlists", p)
		}
	}
}

func TestSanitizeUserPermissionsIsOrderedAndDeduplicated(t *testing.T) {
	got, _ := sanitizeUserPermissions([]any{
		PermBackupDelete, PermBackupView, PermBackupView, PermBackupCreate,
	})
	want := []string{PermBackupView, PermBackupCreate, PermBackupDelete}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v (canonical order, no duplicates)", got, want)
	}
}

func TestSanitizeUserPermissionsHandlesEmptyAndNil(t *testing.T) {
	if got, dropped := sanitizeUserPermissions(nil); len(got) != 0 || dropped {
		t.Errorf("nil gave (%v, %v), want empty and nothing dropped", got, dropped)
	}
	// Revoking everything sends an empty list; it must not be mistaken for "nothing supplied".
	if got, dropped := sanitizeUserPermissions([]any{}); got == nil || len(got) != 0 || dropped {
		t.Errorf("empty list gave (%v, %v), want an empty non-nil slice", got, dropped)
	}
}

func TestSuperAdminHoldsEveryPermission(t *testing.T) {
	all := allBackupPermissions()
	for _, p := range allUserPermissionOrder {
		if !all.has(p) {
			t.Errorf("a Super Admin is missing %q", p)
		}
	}
	if len(all) != len(knownUserPermissions) {
		t.Errorf("allBackupPermissions has %d entries, allowlist has %d - they must agree",
			len(all), len(knownUserPermissions))
	}
}

// Every permission in the display order must be in the allowlist and vice versa, or a grant could
// be displayed but never stored, or stored but never displayed.
func TestPermissionOrderMatchesAllowlist(t *testing.T) {
	if len(allUserPermissionOrder) != len(knownUserPermissions) {
		t.Fatalf("order has %d, allowlist has %d", len(allUserPermissionOrder), len(knownUserPermissions))
	}
	for _, p := range allUserPermissionOrder {
		if !knownUserPermissions[p] {
			t.Errorf("%q is in the display order but not the allowlist", p)
		}
	}
}

// The Access Management grid is built from the groups. A permission missing from every group
// would be enforceable by the API but impossible for a Super Admin to grant - a grant nobody
// could ever hold.
func TestEveryPermissionAppearsInExactlyOneGroup(t *testing.T) {
	seen := map[string]int{}
	for _, g := range permissionGroups {
		for _, p := range g.Permissions {
			seen[p]++
		}
	}
	for _, p := range allUserPermissionOrder {
		switch seen[p] {
		case 1:
		case 0:
			t.Errorf("%q is in no permission group, so it can never be granted", p)
		default:
			t.Errorf("%q appears in %d groups", p, seen[p])
		}
	}
}

// The three modules must stay independent: granting someone backup access must not hand them
// patient-facing clinical worklists, and vice versa.
func TestModulePermissionsDoNotOverlap(t *testing.T) {
	groups := map[string]map[string]bool{}
	for _, g := range permissionGroups {
		set := map[string]bool{}
		for _, p := range g.Permissions {
			set[p] = true
		}
		groups[g.Key] = set
	}
	for aKey, a := range groups {
		for bKey, b := range groups {
			if aKey >= bKey {
				continue
			}
			for p := range a {
				if b[p] {
					t.Errorf("%q is shared between the %s and %s groups", p, aKey, bKey)
				}
			}
		}
	}
}

func TestHighRiskPermissionsAreTheDestructiveOnes(t *testing.T) {
	// Creating, viewing and downloading cannot change live data, so they must not be flagged;
	// flagging everything would train people to click through the confirmation.
	for _, p := range []string{PermBackupView, PermBackupCreate, PermBackupDownload, PermBackupUpload} {
		if isHighRiskPermission(p) {
			t.Errorf("%q should not be high risk", p)
		}
	}
	for _, p := range []string{PermBackupRestore, PermBackupDelete, PermBackupSettings, PermBackupAccessManagement} {
		if !isHighRiskPermission(p) {
			t.Errorf("%q should be high risk", p)
		}
	}
}

func TestDiffPerms(t *testing.T) {
	added, removed := diffPerms(
		[]string{PermBackupView, PermBackupCreate},
		[]string{PermBackupView, PermBackupDownload},
	)
	if !reflect.DeepEqual(added, []string{PermBackupDownload}) {
		t.Errorf("added = %v, want [BACKUP_DOWNLOAD]", added)
	}
	if !reflect.DeepEqual(removed, []string{PermBackupCreate}) {
		t.Errorf("removed = %v, want [BACKUP_CREATE]", removed)
	}

	// No change must produce two empty slices, so the caller can skip writing history for a
	// save that changed nothing.
	added, removed = diffPerms([]string{PermBackupView}, []string{PermBackupView})
	if len(added) != 0 || len(removed) != 0 {
		t.Errorf("identical sets gave added=%v removed=%v", added, removed)
	}
}

// The catalogue is only ever written by backup.go, but the download and delete routes resolve a
// stored filename to a path on disk. If that ever stopped being true, a traversal must not reach
// outside the backup directory.
func TestPathForRefusesTraversal(t *testing.T) {
	dir := backupDir()
	for _, name := range []string{
		"../../etc/passwd",
		"../secrets.env",
		"/etc/shadow",
		"..\\..\\windows\\system32\\config\\sam",
	} {
		got := pathFor(name)
		if filepath.Dir(got) != filepath.Clean(dir) {
			t.Errorf("pathFor(%q) = %q, which escapes %q", name, got, dir)
		}
	}
}

func TestSafeBackupName(t *testing.T) {
	if got := safeBackupName("../../evil name.dump"); got != ".._.._evil_name.dump" {
		t.Errorf("got %q", got)
	}
	long := make([]byte, 400)
	for i := range long {
		long[i] = 'a'
	}
	if got := safeBackupName(string(long)); len(got) != 120 {
		t.Errorf("long name was %d chars, want it capped at 120", len(got))
	}
}

func TestClampInt(t *testing.T) {
	cases := []struct{ v, lo, hi, want int }{
		{5, 1, 10, 5},
		{0, 1, 10, 1},
		{99, 1, 10, 10},
		{-4, 0, 23, 0},
	}
	for _, c := range cases {
		if got := clampInt(c.v, c.lo, c.hi); got != c.want {
			t.Errorf("clampInt(%d,%d,%d) = %d, want %d", c.v, c.lo, c.hi, got, c.want)
		}
	}
}

func TestClip(t *testing.T) {
	if got := clip("hello", 10); got != "hello" {
		t.Errorf("got %q", got)
	}
	if got := clip("hello world", 5); got != "hello" {
		t.Errorf("got %q", got)
	}
}
