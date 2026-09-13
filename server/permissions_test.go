package main

import (
	"strings"
	"testing"
)

// Tests for the granular action grants and the insurance write rules.
//
// The point of these is one property: no grant, no write. A caller who cannot see the button must
// also be refused when they skip the interface and post to the API directly, which is the only
// version of "permission" that means anything.

// ---------- permSet ----------

func TestPermSetHas(t *testing.T) {
	p := permSet{PermInsuranceView: true, PermInsuranceCreate: true}
	if !p.has(PermInsuranceView) || !p.has(PermInsuranceCreate) {
		t.Error("granted permissions should report as held")
	}
	if p.has(PermInsuranceUpdate) || p.has(PermInsuranceDelete) {
		t.Error("ungranted permissions must not report as held")
	}
	// The zero value must be safe: a role with no row grants nothing rather than everything.
	var empty permSet
	if empty.has(PermInsuranceView) {
		t.Error("a nil permSet must grant nothing")
	}
}

// ---------- sanitizePermissions ----------

func TestSanitizePermissionsKeepsKnownValues(t *testing.T) {
	got, dropped := sanitizePermissions([]any{PermInsuranceUpdate, PermInsuranceView})
	if dropped {
		t.Error("known permissions should not be reported as dropped")
	}
	// Stable order regardless of submission order, so an audit entry reads as a real diff.
	want := []string{PermInsuranceView, PermInsuranceUpdate}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("position %d: got %q, want %q", i, got[i], want[i])
		}
	}
}

func TestSanitizePermissionsRejectsUnknown(t *testing.T) {
	cases := []struct {
		name string
		in   any
	}{
		{"invented permission", []any{"insurance.superuser"}},
		{"another collection", []any{"patients.delete"}},
		{"wrong type in list", []any{PermInsuranceView, 42}},
		{"not a list", "insurance.view"},
		{"typo", []any{"insurance.veiw"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, dropped := sanitizePermissions(c.in)
			if !dropped {
				t.Errorf("%#v should be reported as containing unrecognised entries", c.in)
			}
		})
	}
}

func TestSanitizePermissionsDeduplicates(t *testing.T) {
	got, _ := sanitizePermissions([]any{PermInsuranceView, PermInsuranceView, PermInsuranceView})
	if len(got) != 1 {
		t.Errorf("duplicates should collapse, got %v", got)
	}
}

func TestSanitizePermissionsEmptyAndNil(t *testing.T) {
	got, dropped := sanitizePermissions([]any{})
	if len(got) != 0 || dropped {
		t.Errorf("an empty list is valid and grants nothing, got %v dropped=%v", got, dropped)
	}
	got, dropped = sanitizePermissions(nil)
	if len(got) != 0 || dropped {
		t.Errorf("nil is valid and grants nothing, got %v dropped=%v", got, dropped)
	}
}

// ---------- writeAllowed on the master insurance list ----------

func insuranceDoc() Document {
	return Document{"id": "INS-1", "name": "Aetna", "payerId": "60054", "address": "Hartford, CT"}
}

func TestInsuranceCreateRequiresCreatePermission(t *testing.T) {
	tabs := tabSet{"billing": true} // holding the billing tab must not be enough

	ok, why := writeAllowed("insurance", "BILLER", "u1", tabs, permSet{}, insuranceDoc(), nil)
	if ok {
		t.Fatal("a role with no insurance grant created a master insurance record")
	}
	if !strings.Contains(why, "add") {
		t.Errorf("the refusal should say which action was refused, got %q", why)
	}

	ok, _ = writeAllowed("insurance", "BILLER", "u1", tabs, permSet{PermInsuranceCreate: true}, insuranceDoc(), nil)
	if !ok {
		t.Error("insurance.create should permit creating")
	}
}

func TestInsuranceUpdateRequiresUpdatePermission(t *testing.T) {
	existing := insuranceDoc()

	// Create permission alone must not allow editing an existing row - they are separate grants
	// precisely so "may add a payer we started using" and "may rewrite an existing payer ID" can
	// be answered differently.
	ok, why := writeAllowed("insurance", "MANAGER", "u1", tabSet{}, permSet{PermInsuranceCreate: true}, insuranceDoc(), existing)
	if ok {
		t.Fatal("insurance.create allowed an edit")
	}
	if !strings.Contains(why, "edit") {
		t.Errorf("refusal should name the action, got %q", why)
	}

	ok, _ = writeAllowed("insurance", "MANAGER", "u1", tabSet{}, permSet{PermInsuranceUpdate: true}, insuranceDoc(), existing)
	if !ok {
		t.Error("insurance.update should permit editing")
	}
}

// View alone is exactly that: readable, not writable.
func TestInsuranceViewGrantsNoWrites(t *testing.T) {
	view := permSet{PermInsuranceView: true}

	if ok, _ := writeAllowed("insurance", "BILLER", "u1", tabSet{}, view, insuranceDoc(), nil); ok {
		t.Error("view permission allowed a create")
	}
	if ok, _ := writeAllowed("insurance", "BILLER", "u1", tabSet{}, view, insuranceDoc(), insuranceDoc()); ok {
		t.Error("view permission allowed an update")
	}
	if ok, _ := deleteAllowed("insurance", "BILLER", tabSet{}, view); ok {
		t.Error("view permission allowed a delete")
	}
}

func TestInsuranceDeleteRequiresDeletePermission(t *testing.T) {
	if ok, why := deleteAllowed("insurance", "BILLER", tabSet{}, permSet{PermInsuranceUpdate: true}); ok {
		t.Errorf("update permission allowed a delete (%q)", why)
	}
	if ok, _ := deleteAllowed("insurance", "BILLER", tabSet{}, permSet{PermInsuranceDelete: true}); !ok {
		t.Error("insurance.delete should permit deleting")
	}
}

// Every other collection must be unaffected by the new grants - this feature widens nobody's
// existing access.
func TestInsurancePermissionsDoNotLeakToOtherCollections(t *testing.T) {
	all := permSet{
		PermInsuranceView: true, PermInsuranceCreate: true,
		PermInsuranceUpdate: true, PermInsuranceDelete: true,
	}
	// Holding every insurance permission must not buy a write to patient billing records.
	if ok, _ := writeAllowed("charges", "BILLER", "u1", tabSet{}, all, Document{}, nil); ok {
		t.Error("insurance permissions granted a write to charges without the billing tab")
	}
	// And the billing tab still governs charges exactly as before.
	if ok, _ := writeAllowed("charges", "BILLER", "u1", tabSet{"billing": true}, permSet{}, Document{}, nil); !ok {
		t.Error("the billing tab should still govern charges")
	}
}

// ---------- rolePermissions is itself protected ----------

func TestOnlyAdminMayChangeRolePermissions(t *testing.T) {
	doc := Document{"id": "BILLER", "tabs": []any{"billing"}, "permissions": []any{PermInsuranceView}}

	if ok, why := writeAllowed("rolePermissions", "MANAGER", "u1", tabSet{"users": true}, permSet{}, doc, nil); ok {
		t.Errorf("a non-admin granted permissions to a role (%q)", why)
	}
	if ok, _ := writeAllowed("rolePermissions", "SUPER_ADMIN", "u1", tabSet{}, permSet{}, doc, nil); !ok {
		t.Error("SUPER_ADMIN should be able to grant permissions")
	}
}

// A role cannot be edited into holding a permission the server does not implement - that would
// show an administrator a ticked box that grants nothing.
func TestUnknownPermissionsAreRejectedOnSave(t *testing.T) {
	doc := Document{"id": "BILLER", "tabs": []any{}, "permissions": []any{"insurance.everything"}}
	ok, why := writeAllowed("rolePermissions", "SUPER_ADMIN", "u1", tabSet{}, permSet{}, doc, nil)
	if ok {
		t.Fatal("an unrecognised permission was accepted")
	}
	if !strings.Contains(why, "recognise") {
		t.Errorf("refusal should explain why, got %q", why)
	}
}

func TestSuperAdminRoleRowStaysUneditable(t *testing.T) {
	existing := Document{"id": "SUPER_ADMIN"}
	doc := Document{"id": "SUPER_ADMIN", "tabs": []any{}, "permissions": []any{}}
	if ok, _ := writeAllowed("rolePermissions", "SUPER_ADMIN", "u1", tabSet{}, permSet{}, doc, existing); ok {
		t.Error("the Super Admin role row must not be editable, or an admin can lock everyone out")
	}
}
