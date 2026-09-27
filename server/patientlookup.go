package main

import (
	"net/http"
	"strings"
)

// Narrow patient lookup used by the HIM and Antimicrobial "new item" forms.
//
// HIM and Antimicrobial roles do NOT hold the patients / clinical / billing tabs, so their
// accounts cannot read the patients collection through the generic /api/collections/patients
// endpoint - and they should not, since that response carries SSN, guarantor and every other
// identifying detail. But a coder still has to say "which patient" when starting an encounter.
//
// This endpoint answers exactly that need: it returns id, name, MRN and DOB for accounts that
// hold either HIM_WORKLIST_VIEW or ANTIMICROBIAL_VIEW. Nothing else, so it is a small, principled
// exposure, and the write endpoints still enforce their own separate grants.

type patientLookupRow struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	MRN  string `json:"mrn"`
	DOB  string `json:"dob"`
}

// GET /api/patients/lookup?q=
func (s *Server) handlePatientLookup(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	perms := s.effectiveUserPerms(r.Context(), u.UID, u.Role)
	// Anyone with a role tab that already reads patients keeps working, and holders of the two
	// worklist grants are additionally allowed here.
	tabs := s.tabsFor(r.Context(), u.Role)
	allowedByTab := u.Role == "SUPER_ADMIN" || tabs.has("patients") || tabs.has("clinical") ||
		tabs.has("record") || tabs.has("billing") || tabs.has("claims") || tabs.has("schedule")
	if !allowedByTab && !perms.has(PermHIMWorklistView) && !perms.has(PermAntimicrobialView) {
		writeErr(w, http.StatusForbidden, "your role does not have access to patient information")
		return
	}

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	limit := 20
	args := []any{}
	where := "TRUE"
	if q != "" {
		args = append(args, "%"+q+"%")
		// id, name and MRN (stored as id here) all match the same LIKE; a coder types whichever
		// they have at hand.
		where = "(name ILIKE $1 OR id ILIKE $1)"
	}
	rows, err := s.db.Query(r.Context(),
		"SELECT id, name, id, dob FROM patients WHERE "+where+" ORDER BY name LIMIT "+itoa(limit), args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read patients")
		return
	}
	defer rows.Close()
	out := []patientLookupRow{}
	for rows.Next() {
		var p patientLookupRow
		if err := rows.Scan(&p.ID, &p.Name, &p.MRN, &p.DOB); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not read patients")
			return
		}
		out = append(out, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"patients": out})
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	buf := make([]byte, 0, 12)
	for n > 0 {
		buf = append([]byte{byte('0' + n%10)}, buf...)
		n /= 10
	}
	if neg {
		buf = append([]byte{'-'}, buf...)
	}
	return string(buf)
}
