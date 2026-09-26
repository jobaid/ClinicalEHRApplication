package main

import (
	"context"
	"net/http"
)

// Read authorization for the generic collections API.
//
// Until this file, GET /api/collections/{name} checked only that the caller was signed in. Every
// account - a receptionist, a newly created Human Resource user, the published demo account - could
// read every patient with their SSN, every charge, claim and payment, and the full audit log,
// directly from the API. The interface hid the tabs; the server never checked. Writes were always
// guarded (writeAllowed, deleteAllowed); reads never were.
//
// The rule now: a collection is readable only when one of the caller's ROLE TABS uses it. Super
// Admin reads everything, as it does everywhere else. A collection not listed below is refused -
// the safe answer to "may this role read a table nobody thought about" is no.

// Readable by any signed-in account. Sign-in itself reads `users` to find the caller's own row, so
// it cannot be gated without breaking login; it is the staff directory and carries no password
// material (schema.go does not register the credential columns). The rest are reference and
// configuration data with no patient in them.
var alwaysReadable = map[string]bool{
	"users":           true,
	"rolePermissions": true,
	"cptCatalog":      true,
	"physicians":      true,
	"insurance":       true, // the payer list, not anybody's policy
	"supportTickets":  true, // every account can raise one from the header
}

// Which tabs justify reading each collection. Any one match is enough.
//
// "dashboard" appears nowhere on purpose. Every role has the dashboard, so letting it grant data
// would hand billing and clinical records to every role - including Human Resource and HIM, which
// section 17 and section 50 say must not receive them.
var collectionReadTabs = map[string][]string{
	"patients":                {"patients", "schedule", "clinical", "record", "billing", "claims", "reports"},
	"appointments":            {"schedule", "patients", "clinical", "record", "billing"},
	"patientMemos":            {"patients", "billing", "record", "clinical"},
	"idDocuments":             {"patients", "billing", "record"},
	"insurancePolicies":       {"patients", "billing", "claims", "reports", "record"},
	"charges":                 {"billing", "claims", "reports"},
	"claims":                  {"billing", "claims", "reports"},
	"transactions":            {"billing", "claims", "reports"},
	"patientCreditBalances":   {"billing", "claims", "reports"},
	"insuranceCreditBalances": {"billing", "claims", "reports"},
	"batches":                 {"billing", "claims", "reports"},
	"ticklers":                {"billing", "claims", "patients"},
	"vitals":                  {"clinical", "record"},
	"allergies":               {"clinical", "record"},
	"medications":             {"clinical", "record"},
	"problems":                {"clinical", "record"},
	"clinicalNotes":           {"clinical", "record"},
	"auditLogs":               {"users", "billing", "patients", "record"},
	"loginAudit":              {"users"},
}

func (s *Server) collectionReadAllowed(ctx context.Context, name string, u authedUser) bool {
	if u.Role == "SUPER_ADMIN" || alwaysReadable[name] {
		return true
	}
	tabs := s.tabsFor(ctx, u.Role)
	for _, t := range collectionReadTabs[name] {
		if tabs.has(t) {
			return true
		}
	}
	return false
}

// requireCollectionRead wraps the list handler. 403 rather than an empty list, so a direct API
// caller is told plainly that the answer is no rather than being led to think the table is empty.
func (s *Server) requireCollectionRead(next http.HandlerFunc) http.HandlerFunc {
	return s.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		if !s.collectionReadAllowed(r.Context(), r.PathValue("name"), userFrom(r.Context())) {
			writeErr(w, http.StatusForbidden, "your role does not have access to that information")
			return
		}
		next(w, r)
	})
}
