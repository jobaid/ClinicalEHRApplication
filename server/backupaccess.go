package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

// Backup Access Management - who may use Backup & Restore, and the record of who decided so.
//
// The grants themselves live in user_permissions and are enforced by requirePerm (see
// userpermissions.go). This file is the administration of them: listing accounts with their
// current grants, changing them, and the read-only history section 58 asks for.

type accessRow struct {
	ID          string   `json:"id"`
	Email       string   `json:"email"`
	Name        string   `json:"name"`
	Role        string   `json:"role"`
	Disabled    bool     `json:"disabled"`
	Permissions []string `json:"permissions"`

	// True for SUPER_ADMIN. Their grants are computed, never stored, so the screen shows every
	// box ticked and locked rather than pretending they are editable - section 51.
	Locked bool `json:"locked"`
}

// handleBackupAccessList returns every account with its current backup grants.
func (s *Server) handleBackupAccessList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(),
		`SELECT u.id, u.email, u.name, u.role, u.disabled,
		        COALESCE(p.permissions, '[]'::jsonb)
		   FROM users u
		   LEFT JOIN user_permissions p ON p.user_id = u.id
		  ORDER BY u.role, lower(u.name), lower(u.email)`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the account list")
		return
	}
	defer rows.Close()

	out := []accessRow{}
	for rows.Next() {
		var a accessRow
		var raw []byte
		if err := rows.Scan(&a.ID, &a.Email, &a.Name, &a.Role, &a.Disabled, &raw); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not read the account list")
			return
		}
		a.Permissions = []string{}
		if a.Role == "SUPER_ADMIN" {
			a.Locked = true
			a.Permissions = append(a.Permissions, backupPermissionOrder...)
		} else {
			var list []string
			if json.Unmarshal(raw, &list) == nil {
				for _, p := range backupPermissionOrder {
					for _, held := range list {
						if held == p {
							a.Permissions = append(a.Permissions, p)
							break
						}
					}
				}
			}
		}
		out = append(out, a)
	}
	if rows.Err() != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the account list")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"users":       out,
		"permissions": backupPermissionOrder,
		"highRisk":    highRiskKeys(),
	})
}

func highRiskKeys() []string {
	out := []string{}
	for _, p := range backupPermissionOrder {
		if isHighRiskPermission(p) {
			out = append(out, p)
		}
	}
	return out
}

// handleBackupAccessUpdate replaces one account's backup grants.
//
// The whole set is sent rather than a delta, so the screen and the database cannot drift: what
// you see ticked is what gets stored. The difference against the previous set is computed here
// for the history, which means the audit records an actual change rather than a restatement.
func (s *Server) handleBackupAccessUpdate(w http.ResponseWriter, r *http.Request) {
	actor := userFrom(r.Context())
	targetID := r.PathValue("userId")

	var body struct {
		Permissions []string `json:"permissions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}

	var targetRole, targetName, targetEmail string
	if err := s.db.QueryRow(r.Context(),
		`SELECT role, name, email FROM users WHERE id = $1`, targetID).
		Scan(&targetRole, &targetName, &targetEmail); err != nil {
		writeErr(w, http.StatusNotFound, "no such account")
		return
	}

	// Section 51. A Super Admin holds every backup permission unconditionally and there is no
	// stored row to edit, so the only honest answer is to refuse rather than to accept a change
	// that would have no effect.
	if targetRole == "SUPER_ADMIN" {
		writeErr(w, http.StatusConflict,
			"a Super Admin always holds full Backup & Restore access and cannot have it removed")
		return
	}

	next, dropped := sanitizeUserPermissions(body.Permissions)

	// Section 50, final line: only a Super Admin may hand out the ability to hand out
	// permissions. Someone holding BACKUP_ACCESS_MANAGEMENT can administer the other seven
	// grants, but cannot mint another administrator of this screen.
	wantsAccessMgmt := false
	for _, p := range next {
		if p == PermBackupAccessManagement {
			wantsAccessMgmt = true
		}
	}
	previous := s.storedUserPermissions(r.Context(), targetID)
	hadAccessMgmt := containsPerm(previous, PermBackupAccessManagement)
	if wantsAccessMgmt != hadAccessMgmt && actor.Role != "SUPER_ADMIN" {
		writeErr(w, http.StatusForbidden,
			"only a Super Admin can grant or revoke Manage Backup Access")
		return
	}

	added, removed := diffPerms(previous, next)
	if len(added) == 0 && len(removed) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"permissions": next, "unchanged": true})
		return
	}

	raw, err := json.Marshal(next)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not encode the permissions")
		return
	}
	if _, err := s.db.Exec(r.Context(),
		`INSERT INTO user_permissions (user_id, permissions, updated_by, updated_at)
		 VALUES ($1, $2::jsonb, $3, now())
		 ON CONFLICT (user_id) DO UPDATE
		    SET permissions = EXCLUDED.permissions,
		        updated_by  = EXCLUDED.updated_by,
		        updated_at  = now()`,
		targetID, string(raw), actor.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the permissions")
		return
	}

	// Section 54: the change must take effect on the target's very next request, not when a
	// cache happens to expire or when their token is renewed.
	s.invalidateUserPerms(targetID)

	action := "BACKUP_PERMISSION_UPDATED"
	switch {
	case len(previous) == 0 && len(next) > 0:
		action = "BACKUP_PERMISSION_GRANTED"
	case len(next) == 0 && len(previous) > 0:
		action = "BACKUP_PERMISSION_REVOKED"
	}

	s.recordPermissionHistory(r, actor, targetID, displayName(targetName, targetEmail), action, added, removed)

	writeJSON(w, http.StatusOK, map[string]any{
		"permissions": next,
		"added":       added,
		"removed":     removed,
		"dropped":     dropped,
	})
}

func displayName(name, email string) string {
	if name != "" {
		return name
	}
	return email
}

// storedUserPermissions reads the grants actually on record, bypassing the cache and the
// SUPER_ADMIN shortcut. The diff for the history has to be against what is stored, not against
// what is computed.
func (s *Server) storedUserPermissions(ctx context.Context, uid string) []string {
	var raw []byte
	if err := s.db.QueryRow(ctx, `SELECT permissions FROM user_permissions WHERE user_id = $1`, uid).
		Scan(&raw); err != nil {
		return []string{}
	}
	var list []string
	if json.Unmarshal(raw, &list) != nil {
		return []string{}
	}
	out := []string{}
	for _, p := range backupPermissionOrder {
		for _, held := range list {
			if held == p {
				out = append(out, p)
				break
			}
		}
	}
	return out
}

func containsPerm(list []string, p string) bool {
	for _, v := range list {
		if v == p {
			return true
		}
	}
	return false
}

func diffPerms(before, after []string) (added, removed []string) {
	added, removed = []string{}, []string{}
	for _, p := range after {
		if !containsPerm(before, p) {
			added = append(added, p)
		}
	}
	for _, p := range before {
		if !containsPerm(after, p) {
			removed = append(removed, p)
		}
	}
	return added, removed
}

// recordPermissionHistory writes the read-only trail section 57 and 58 describe. It also mirrors
// the event into audit_logs, so an administrative change is visible to anyone reading the
// application's main audit trail rather than only to someone who knows this screen exists.
func (s *Server) recordPermissionHistory(r *http.Request, actor authedUser, targetID, targetName, action string, added, removed []string) {
	a, _ := json.Marshal(added)
	rm, _ := json.Marshal(removed)

	if _, err := s.db.Exec(r.Context(),
		`INSERT INTO backup_permission_history
		   (id, actor_id, actor_name, target_id, target_name, action, added, removed)
		 VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
		"BPH"+newUID(), actor.UID, actor.Name, targetID, targetName, action, string(a), string(rm)); err != nil {
		log.Printf("backup: permission history write failed: %v", err)
	}

	detail := targetName + ": "
	if len(added) > 0 {
		detail += "+" + joinPerms(added) + " "
	}
	if len(removed) > 0 {
		detail += "-" + joinPerms(removed)
	}
	s.auditBackup(r.Context(), actor, "Backup access changed", clip(detail, 500))
}

func joinPerms(list []string) string {
	out := ""
	for i, p := range list {
		if i > 0 {
			out += ","
		}
		out += p
	}
	return out
}

type historyRow struct {
	ID         string   `json:"id"`
	ActorName  string   `json:"actorName"`
	TargetName string   `json:"targetName"`
	Action     string   `json:"action"`
	Added      []string `json:"added"`
	Removed    []string `json:"removed"`
	CreatedAt  string   `json:"createdAt"`
}

func (s *Server) handleBackupAccessHistory(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(),
		`SELECT id, actor_name, target_name, action, added, removed, created_at
		   FROM backup_permission_history ORDER BY created_at DESC LIMIT 200`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the permission history")
		return
	}
	defer rows.Close()

	out := []historyRow{}
	for rows.Next() {
		var h historyRow
		var addedRaw, removedRaw []byte
		var created time.Time
		if err := rows.Scan(&h.ID, &h.ActorName, &h.TargetName, &h.Action, &addedRaw, &removedRaw, &created); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not read the permission history")
			return
		}
		h.Added, h.Removed = []string{}, []string{}
		_ = json.Unmarshal(addedRaw, &h.Added)
		_ = json.Unmarshal(removedRaw, &h.Removed)
		h.CreatedAt = created.UTC().Format(time.RFC3339)
		out = append(out, h)
	}
	writeJSON(w, http.StatusOK, map[string]any{"history": out})
}

// handleMyBackupPermissions tells the signed-in browser what it may do.
//
// This drives which controls the interface renders. It is a convenience, never the enforcement:
// every route re-checks the same grants server-side, so a browser that lies to itself about this
// response gains nothing but buttons that return 403.
func (s *Server) handleMyBackupPermissions(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	held := s.effectiveUserPerms(r.Context(), u.UID, u.Role)
	out := []string{}
	for _, p := range backupPermissionOrder {
		if held.has(p) {
			out = append(out, p)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"permissions": out,
		"superAdmin":  u.Role == "SUPER_ADMIN",
	})
}
