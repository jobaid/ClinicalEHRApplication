package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Claims & Billing Settings backend.
//
// One key/value store table (claim_settings) plus one reason-code catalog table
// (claim_reason_codes). Every write goes through requirePerm(CLAIM_SETTINGS_MANAGE) and every
// change is audited via the existing audit_logs (via auditFrom).
//
// This file adds NO change to existing claim behaviour. Reading these settings from the claim
// workflow is a separate step in Commit B; here we only add the storage and the admin surface.

//go:embed migrations/023_claim_settings.sql
var claimSettingsSchemaSQL string

func (s *Server) ensureClaimSettingsSchema(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, claimSettingsSchemaSQL); err != nil {
		return fmt.Errorf("claim settings schema: %w", err)
	}
	return nil
}

// ---------- key/value settings ----------

// The recognised setting keys. Unknown keys are refused, so the store cannot silently accumulate
// typos that look like settings and do nothing.
var knownClaimSettingKeys = map[string]bool{
	"general":         true, // free-form general defaults (place of service, default payer type)
	"practice":        true, // organisation name, tax ID, billing NPI, taxonomy, service location
	"cms1500":         true, // CMS-1500 template preferences
	"ub04":            true, // UB-04 template preferences (Commit B)
	"claimNumbering":  true, // prefix, next sequence, format
	"validation":      true, // which validators are on
	"timelyFiling":    true, // per-payer filing windows
	"priorAuth":       true, // prior-auth policy
	"workflow":        true, // claim status transitions
	"noteTemplates":   true, // saved claim note snippets
	"clearinghouse":   true, // EDI endpoint config
	"era":             true, // ERA / 835 config
}

// GET /api/admin/claim-settings/{key}
func (s *Server) handleClaimSettingGet(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimSpace(r.PathValue("key"))
	if !knownClaimSettingKeys[key] {
		writeErr(w, http.StatusNotFound, "unknown setting key")
		return
	}
	var raw []byte
	var updatedBy string
	var updated time.Time
	err := s.db.QueryRow(r.Context(),
		`SELECT value, updated_by, updated_at FROM claim_settings WHERE key = $1`, key).
		Scan(&raw, &updatedBy, &updated)
	if err != nil {
		// Missing row is fine - a first-time read returns an empty object.
		writeJSON(w, http.StatusOK, map[string]any{
			"key":       key,
			"value":     map[string]any{},
			"updatedBy": "",
			"updatedAt": "",
		})
		return
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		v = map[string]any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"key":       key,
		"value":     v,
		"updatedBy": updatedBy,
		"updatedAt": updated.UTC().Format(time.RFC3339),
	})
}

// PUT /api/admin/claim-settings/{key}
func (s *Server) handleClaimSettingPut(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	key := strings.TrimSpace(r.PathValue("key"))
	if !knownClaimSettingKeys[key] {
		writeErr(w, http.StatusNotFound, "unknown setting key")
		return
	}
	var body struct {
		Value any `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	raw, err := json.Marshal(body.Value)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "value must be JSON")
		return
	}
	if _, err := s.db.Exec(r.Context(),
		`INSERT INTO claim_settings (key, value, updated_by, updated_at)
		 VALUES ($1, $2::jsonb, $3, now())
		 ON CONFLICT (key) DO UPDATE
		    SET value = EXCLUDED.value,
		        updated_by = EXCLUDED.updated_by,
		        updated_at = now()`,
		key, string(raw), u.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the setting")
		return
	}
	s.auditBackup(r.Context(), u, "Claim setting saved", key)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// GET /api/admin/claim-settings - list every key that has been written.
func (s *Server) handleClaimSettingsList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(),
		`SELECT key, updated_by, updated_at FROM claim_settings ORDER BY key`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read settings")
		return
	}
	defer rows.Close()
	type row struct {
		Key       string    `json:"key"`
		UpdatedBy string    `json:"updatedBy"`
		UpdatedAt time.Time `json:"-"`
	}
	out := []map[string]any{}
	for rows.Next() {
		var v row
		if rows.Scan(&v.Key, &v.UpdatedBy, &v.UpdatedAt) != nil {
			continue
		}
		out = append(out, map[string]any{
			"key":       v.Key,
			"updatedBy": v.UpdatedBy,
			"updatedAt": v.UpdatedAt.UTC().Format(time.RFC3339),
		})
	}
	// Also report which keys the server recognises so the UI can render sections for unseen keys.
	known := []string{}
	for k := range knownClaimSettingKeys {
		known = append(known, k)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"settings":   out,
		"knownKeys":  known,
	})
}

// ---------- reason codes ----------

var reasonKinds = map[string]bool{"writeoff": true, "debit": true, "denial": true}

type reasonCode struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Code        string `json:"code"`
	Description string `json:"description"`
	Category    string `json:"category"`
	Active      bool   `json:"active"`
	SortOrder   int    `json:"sortOrder"`
	CreatedBy   string `json:"createdBy"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

// GET /api/admin/claim-reason-codes?kind=writeoff
func (s *Server) handleReasonCodeList(w http.ResponseWriter, r *http.Request) {
	kind := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("kind")))
	args := []any{}
	where := "TRUE"
	if kind != "" {
		if !reasonKinds[kind] {
			writeErr(w, http.StatusBadRequest, "kind must be writeoff, debit or denial")
			return
		}
		args = append(args, kind)
		where = "kind = $1"
	}
	rows, err := s.db.Query(r.Context(),
		`SELECT id, kind, code, description, category, active, sort_order, created_by,
		        created_at, updated_at
		   FROM claim_reason_codes WHERE `+where+
			` ORDER BY kind, sort_order, lower(description) LIMIT 500`, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read reason codes")
		return
	}
	defer rows.Close()
	out := []reasonCode{}
	for rows.Next() {
		var v reasonCode
		var created, updated time.Time
		if err := rows.Scan(&v.ID, &v.Kind, &v.Code, &v.Description, &v.Category, &v.Active,
			&v.SortOrder, &v.CreatedBy, &created, &updated); err != nil {
			continue
		}
		v.CreatedAt = created.UTC().Format(time.RFC3339)
		v.UpdatedAt = updated.UTC().Format(time.RFC3339)
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"reasons": out})
}

// POST /api/admin/claim-reason-codes
func (s *Server) handleReasonCodeCreate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var body reasonCode
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	body.Kind = strings.ToLower(strings.TrimSpace(body.Kind))
	body.Description = strings.TrimSpace(body.Description)
	if !reasonKinds[body.Kind] {
		writeErr(w, http.StatusBadRequest, "kind must be writeoff, debit or denial")
		return
	}
	if body.Description == "" {
		writeErr(w, http.StatusBadRequest, "description is required")
		return
	}
	id := "CRC" + newUID()
	if _, err := s.db.Exec(r.Context(),
		`INSERT INTO claim_reason_codes
		  (id, kind, code, description, category, active, sort_order, created_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		id, body.Kind, strings.TrimSpace(body.Code), body.Description,
		strings.TrimSpace(body.Category), true, body.SortOrder, u.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the reason code")
		return
	}
	s.auditBackup(r.Context(), u, "Reason code added", body.Kind+": "+body.Description)
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

// PUT /api/admin/claim-reason-codes/{id}
func (s *Server) handleReasonCodeUpdate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")
	var body reasonCode
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	body.Description = strings.TrimSpace(body.Description)
	if body.Description == "" {
		writeErr(w, http.StatusBadRequest, "description is required")
		return
	}
	tag, err := s.db.Exec(r.Context(),
		`UPDATE claim_reason_codes
		    SET code = $2, description = $3, category = $4, active = $5,
		        sort_order = $6, updated_at = now()
		  WHERE id = $1`,
		id, strings.TrimSpace(body.Code), body.Description,
		strings.TrimSpace(body.Category), body.Active, body.SortOrder)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the reason code")
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "no such reason code")
		return
	}
	s.auditBackup(r.Context(), u, "Reason code updated", id+": "+body.Description)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// DELETE /api/admin/claim-reason-codes/{id}
//
// Soft-delete: sets active=false. Historical rows that reference the reason keep their meaning
// even when the entry is retired from the picker.
func (s *Server) handleReasonCodeDelete(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")
	tag, err := s.db.Exec(r.Context(),
		`UPDATE claim_reason_codes SET active = FALSE, updated_at = now() WHERE id = $1`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not retire the reason code")
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "no such reason code")
		return
	}
	s.auditBackup(r.Context(), u, "Reason code retired", id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
