package main

import (
	"context"
	_ "embed"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Shared plumbing for the Antimicrobial Review and HIM Coding Worklist modules.
//
// Both are worklists over existing records: they add workflow state and documentation, and they
// join to patients, charges and medications for everything else. Neither copies clinical or
// demographic data into its own tables, so neither can drift out of step with the chart.

//go:embed migrations/009_clinical_worklists.sql
var clinicalSchemaSQL string

// ensureClinicalSchema applies 009 at startup, for the same reason as the backup and demo
// schemas: migrations here are otherwise only applied by the initdb mount, which never runs on a
// database that already has data. The file is additive and idempotent.
func (s *Server) ensureClinicalSchema(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, clinicalSchemaSQL); err != nil {
		return fmt.Errorf("clinical schema: %w", err)
	}
	return nil
}

// ---------- workflow statuses ----------

type workflowStatus struct {
	Domain     string `json:"domain"`
	Code       string `json:"code"`
	Label      string `json:"label"`
	SortOrder  int    `json:"sortOrder"`
	IsTerminal bool   `json:"isTerminal"`
	Tone       string `json:"tone"`
}

// handleWorkflowStatuses serves the status vocabulary for both modules.
//
// The frontend renders badges and builds filter dropdowns from this rather than from hardcoded
// arrays, so relabelling a status is a database change and the API's validation and the screen's
// options can never disagree.
func (s *Server) handleWorkflowStatuses(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(),
		`SELECT domain, code, label, sort_order, is_terminal, tone
		   FROM workflow_statuses WHERE active ORDER BY domain, sort_order`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read workflow statuses")
		return
	}
	defer rows.Close()

	out := map[string][]workflowStatus{}
	for rows.Next() {
		var st workflowStatus
		if err := rows.Scan(&st.Domain, &st.Code, &st.Label, &st.SortOrder, &st.IsTerminal, &st.Tone); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not read workflow statuses")
			return
		}
		out[st.Domain] = append(out[st.Domain], st)
	}
	writeJSON(w, http.StatusOK, out)
}

// validStatus checks a submitted status against the configured vocabulary. An unrecognised value
// is refused rather than stored: a typo that reached the database would create a worklist item
// invisible to every filter.
func (s *Server) validStatus(ctx context.Context, domain, code string) bool {
	var ok bool
	if err := s.db.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM workflow_statuses WHERE domain = $1 AND code = $2 AND active)`,
		domain, code).Scan(&ok); err != nil {
		return false
	}
	return ok
}

// ---------- request helpers ----------

// listParams carries the filter, sort and paging options shared by both worklists.
type listParams struct {
	Search   string
	Status   string
	Priority string
	Assigned string
	From     string
	To       string
	Sort     string
	Dir      string
	Limit    int
	Offset   int
}

func parseListParams(r *http.Request, defaultSort string) listParams {
	q := r.URL.Query()
	p := listParams{
		Search:   strings.TrimSpace(q.Get("search")),
		Status:   strings.TrimSpace(q.Get("status")),
		Priority: strings.TrimSpace(q.Get("priority")),
		Assigned: strings.TrimSpace(q.Get("assigned")),
		From:     strings.TrimSpace(q.Get("from")),
		To:       strings.TrimSpace(q.Get("to")),
		Sort:     strings.TrimSpace(q.Get("sort")),
		Dir:      strings.ToUpper(strings.TrimSpace(q.Get("dir"))),
		Limit:    50,
		Offset:   0,
	}
	if p.Sort == "" {
		p.Sort = defaultSort
	}
	if p.Dir != "ASC" {
		p.Dir = "DESC"
	}
	// Capped rather than trusted. An unbounded limit from a query string is how one curl command
	// pulls every patient record in the database into a single response.
	if n, err := strconv.Atoi(q.Get("limit")); err == nil && n > 0 && n <= 200 {
		p.Limit = n
	}
	if n, err := strconv.Atoi(q.Get("offset")); err == nil && n >= 0 {
		p.Offset = n
	}
	return p
}

// sortColumn maps a client-supplied sort key to a real column through an allowlist.
//
// This is the whole defence against SQL injection on ORDER BY, which cannot be parameterised.
// Anything not in the map falls back to the default rather than being interpolated.
func sortColumn(key string, allowed map[string]string, fallback string) string {
	if col, ok := allowed[key]; ok {
		return col
	}
	return fallback
}

// ---------- audit ----------

// auditClinical writes to the existing audit_logs table, the same one the patient chart reads,
// so activity in these modules appears in the patient's audit trail rather than in a private log.
//
// Deliberately records the reference and the change, never clinical free text: an audit row is
// about accountability, and copying a recommendation note into it would put the same PHI in a
// second place with different retention.
func (s *Server) auditClinical(ctx context.Context, u authedUser, patientID, action, entityType, entityID, oldVal, newVal string) {
	var pid any
	if patientID != "" {
		pid = patientID
	}
	_, err := s.db.Exec(ctx,
		`INSERT INTO audit_logs (id, patient_id, "user", action, entity_type, entity_id, old_values, new_values, timestamp)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		"AUD"+newUID(), pid, u.Name, action, entityType, entityID,
		clip(oldVal, 500), clip(newVal, 500), time.Now().Format("2006-01-02T15:04:05"))
	if err != nil {
		log.Printf("clinical: audit write failed for %q: %v", action, err)
	}
}

// nullable turns an empty string into a SQL NULL, so an unset assignee is NULL rather than the
// empty string - which matters because "unassigned" is queried with IS NULL.
func nullable(v string) any {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return v
}

// deref renders a nullable text column for JSON without the caller needing pointers everywhere.
func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// tsOrEmpty formats a nullable timestamp as RFC3339, or "" when unset. The frontend treats ""
// as "Not available" rather than printing a zero date.
func tsOrEmpty(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
