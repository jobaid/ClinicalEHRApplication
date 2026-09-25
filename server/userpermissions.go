package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

// Per-user action grants.
//
// permissions.go already answers "what may this ROLE do", and role_permissions stays exactly as
// it is - section 56 of the specification is explicit that the existing Billing, Reports and
// Claims role grants must not change. But backup access cannot be expressed per role: the same
// specification requires two people who are both MANAGER to be able to hold different backup
// permissions. So this file adds a per-USER layer using the same machinery as the role layer -
// an allowlist, a sanitiser, a cache invalidated on write, and a closed failure mode.
//
// The two allowlists are kept apart on purpose. If BACKUP_* were added to knownPermissions, a
// backup grant could be handed out by editing a ROLE, which would route around "the Super Admin
// decides exactly which users receive which backup permissions" entirely.

const (
	PermBackupView             = "BACKUP_VIEW"
	PermBackupCreate           = "BACKUP_CREATE"
	PermBackupDownload         = "BACKUP_DOWNLOAD"
	PermBackupUpload           = "BACKUP_UPLOAD"
	PermBackupRestore          = "BACKUP_RESTORE"
	PermBackupDelete           = "BACKUP_DELETE"
	PermBackupSettings         = "BACKUP_SETTINGS"
	PermBackupAccessManagement = "BACKUP_ACCESS_MANAGEMENT"

	// Antimicrobial Review. Separate from the HIM grants below because they are different jobs -
	// a pharmacist reviewing therapy and a coder closing an encounter should not inherit each
	// other's access just because both modules are new.
	PermAntimicrobialView     = "ANTIMICROBIAL_VIEW"
	PermAntimicrobialReview   = "ANTIMICROBIAL_REVIEW"
	PermAntimicrobialAssign   = "ANTIMICROBIAL_ASSIGN"
	PermAntimicrobialComplete = "ANTIMICROBIAL_COMPLETE"
	PermAntimicrobialReport   = "ANTIMICROBIAL_REPORT"

	// HIM Coding Worklist.
	PermHIMWorklistView = "HIM_WORKLIST_VIEW"
	PermHIMCodingEdit   = "HIM_CODING_EDIT"
	PermHIMAssign       = "HIM_ASSIGN"
	PermHIMQueryCreate  = "HIM_QUERY_CREATE"
	PermHIMQueryManage  = "HIM_QUERY_MANAGE"
	PermHIMComplete     = "HIM_COMPLETE"
	PermHIMReport       = "HIM_REPORT"

	// Doctor Clinical Workspace. Split finely on purpose: reading a chart, writing a note and
	// SIGNING one are three different responsibilities, and a signature is an attestation that
	// should never be inherited from the ability to type.
	PermDoctorPatientView       = "DOCTOR_PATIENT_VIEW"
	PermDoctorRecordView        = "DOCTOR_MEDICAL_RECORD_VIEW"
	PermDoctorNoteCreate        = "DOCTOR_CLINICAL_NOTE_CREATE"
	PermDoctorNoteEdit          = "DOCTOR_CLINICAL_NOTE_EDIT"
	PermDoctorNoteSign          = "DOCTOR_CLINICAL_NOTE_SIGN"
	PermDoctorLabView           = "DOCTOR_LAB_VIEW"
	PermDoctorDocumentView      = "DOCTOR_DOCUMENT_VIEW"
	PermDoctorDiagnosisManage   = "DOCTOR_DIAGNOSIS_MANAGE"
	PermDoctorMedicationView    = "DOCTOR_MEDICATION_VIEW"
	PermDoctorAntimicrobialView = "DOCTOR_ANTIMICROBIAL_VIEW"
)

// permissionGroup is one block of related grants on the Access Management screen. Grouping is
// presentation, but it lives here rather than in React so the grid cannot drift out of step with
// what the server actually recognises.
type permissionGroup struct {
	Key         string   `json:"key"`
	Label       string   `json:"label"`
	Permissions []string `json:"permissions"`
}

// Fixed order, so a saved list and an audit diff read as a real change rather than a reshuffle.
var backupPermissionOrder = []string{
	PermBackupView,
	PermBackupCreate,
	PermBackupDownload,
	PermBackupUpload,
	PermBackupRestore,
	PermBackupDelete,
	PermBackupSettings,
	PermBackupAccessManagement,
}

var antimicrobialPermissionOrder = []string{
	PermAntimicrobialView,
	PermAntimicrobialReview,
	PermAntimicrobialAssign,
	PermAntimicrobialComplete,
	PermAntimicrobialReport,
}

var himPermissionOrder = []string{
	PermHIMWorklistView,
	PermHIMCodingEdit,
	PermHIMAssign,
	PermHIMQueryCreate,
	PermHIMQueryManage,
	PermHIMComplete,
	PermHIMReport,
}

var doctorPermissionOrder = []string{
	PermDoctorPatientView,
	PermDoctorRecordView,
	PermDoctorNoteCreate,
	PermDoctorNoteEdit,
	PermDoctorNoteSign,
	PermDoctorLabView,
	PermDoctorDocumentView,
	PermDoctorDiagnosisManage,
	PermDoctorMedicationView,
	PermDoctorAntimicrobialView,
}

var permissionGroups = []permissionGroup{
	{Key: "backup", Label: "Backup & Restore", Permissions: backupPermissionOrder},
	{Key: "antimicrobial", Label: "Antimicrobial Review", Permissions: antimicrobialPermissionOrder},
	{Key: "him", Label: "HIM Coding", Permissions: himPermissionOrder},
	{Key: "doctor", Label: "Doctor Clinical Workspace", Permissions: doctorPermissionOrder},
}

// allUserPermissionOrder is every grant, in a stable order. Built from the groups so adding a
// permission in one place cannot leave it unsanitisable or invisible in the grid.
var allUserPermissionOrder = func() []string {
	out := []string{}
	for _, g := range permissionGroups {
		out = append(out, g.Permissions...)
	}
	return out
}()

var knownUserPermissions = func() map[string]bool {
	m := map[string]bool{}
	for _, p := range allUserPermissionOrder {
		m[p] = true
	}
	return m
}()

// The grants that can destroy data or hand out the ability to destroy data. Section 53 asks for
// a confirmation when these are granted; the frontend shows it, and this is the list it uses, so
// the warning and the enforcement cannot drift apart.
var highRiskUserPermissions = map[string]bool{
	PermBackupRestore:          true,
	PermBackupDelete:           true,
	PermBackupSettings:         true,
	PermBackupAccessManagement: true,

	// Completing a review or an encounter closes a clinical or coding record that others rely on
	// being final, and editing codes changes what gets billed. Both deserve the confirmation.
	PermAntimicrobialComplete: true,
	PermHIMCodingEdit:         true,
	PermHIMComplete:           true,

	// Signing a note is a clinical attestation and, once signed, the record is protected from
	// silent edit - so granting the ability to sign deserves the same confirmation as granting
	// the ability to change what gets billed.
	PermDoctorNoteSign:        true,
	PermDoctorDiagnosisManage: true,
}

func isHighRiskPermission(p string) bool { return highRiskUserPermissions[p] }

// allBackupPermissions is what a SUPER_ADMIN holds: every grant in the system. Built fresh each
// call rather than shared, because a permSet is a map and a shared one could be written to by a
// caller.
func allBackupPermissions() permSet {
	all := permSet{}
	for _, p := range allUserPermissionOrder {
		all[p] = true
	}
	return all
}

// effectiveUserPerms returns the backup grants in force for one account, right now.
//
// SUPER_ADMIN is answered without consulting the database, exactly as tabsFor and permsFor do.
// That is section 51 and section 60 in one line: a Super Admin always holds every backup
// permission, so no edit to this table - accidental or hostile - can lock the application out of
// its own backups, and there is no stored row for anyone to tamper with.
//
// Everyone else starts from nothing. A database error returns an EMPTY set rather than a
// permissive one: the safe answer to "may this person restore production over the top of live
// patient data, we cannot tell" is no.
func (s *Server) effectiveUserPerms(ctx context.Context, uid, role string) permSet {
	if role == "SUPER_ADMIN" {
		return allBackupPermissions()
	}
	if uid == "" {
		return permSet{}
	}

	s.userPermMu.RLock()
	cached, ok := s.userPermCache[uid]
	s.userPermMu.RUnlock()
	if ok {
		return cached
	}

	var raw []byte
	err := s.db.QueryRow(ctx, `SELECT permissions FROM user_permissions WHERE user_id = $1`, uid).Scan(&raw)
	set := permSet{}
	if err == nil {
		var list []string
		if json.Unmarshal(raw, &list) == nil {
			for _, p := range list {
				if knownUserPermissions[p] {
					set[p] = true
				}
			}
		}
	}
	// A missing row is not an error - it means "no grants", which is already what set holds.
	// Only a genuine query failure should avoid being cached, so that a transient database
	// problem does not pin an empty set in memory until the next write.
	if err == nil || strings.Contains(err.Error(), "no rows") {
		s.userPermMu.Lock()
		if s.userPermCache == nil {
			s.userPermCache = map[string]permSet{}
		}
		s.userPermCache[uid] = set
		s.userPermMu.Unlock()
	}
	return set
}

// invalidateUserPerms drops one account's cached grants so a revocation takes effect on that
// account's very next request, not at some expiry. Section 54 requires exactly this: "API
// authorization must immediately respect the changed permission."
func (s *Server) invalidateUserPerms(uid string) {
	s.userPermMu.Lock()
	delete(s.userPermCache, uid)
	s.userPermMu.Unlock()
}

// requirePerm is the backend half of the permission system, and the half that actually matters.
//
// Section 63: a user without a permission must not be able to bypass the restriction by calling
// the API directly. Hiding a button achieves nothing on its own, so every backup route is
// registered through this rather than through requireAuth, and the grant is re-read per request
// rather than taken from the session token - a token minted before a revocation would otherwise
// keep working until it expired.
func (s *Server) requirePerm(perm string, next http.HandlerFunc) http.HandlerFunc {
	return s.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if !s.effectiveUserPerms(r.Context(), u.UID, u.Role).has(perm) {
			writeErr(w, http.StatusForbidden, "you do not have permission to do that")
			return
		}
		next(w, r)
	})
}

// sanitizeUserPermissions filters a submitted list to recognised values, de-duplicated and in a
// stable order. Mirrors sanitizePermissions in permissions.go. The bool reports whether anything
// was discarded, so the caller can distinguish "saved what you asked for" from "saved some of it".
func sanitizeUserPermissions(raw any) ([]string, bool) {
	list, ok := raw.([]any)
	if !ok {
		// A JSON body decoded into []string rather than []any is equally acceptable.
		if typed, isTyped := raw.([]string); isTyped {
			list = make([]any, len(typed))
			for i, v := range typed {
				list[i] = v
			}
		} else if raw == nil {
			return []string{}, false
		} else {
			return []string{}, true
		}
	}

	seen := map[string]bool{}
	dropped := false
	for _, v := range list {
		str, isStr := v.(string)
		if !isStr {
			dropped = true
			continue
		}
		str = strings.TrimSpace(str)
		if !knownUserPermissions[str] {
			dropped = true
			continue
		}
		seen[str] = true
	}

	out := []string{}
	for _, p := range allUserPermissionOrder {
		if seen[p] {
			out = append(out, p)
		}
	}
	return out, dropped
}
