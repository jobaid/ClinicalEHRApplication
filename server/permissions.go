package main

import (
	"context"
	"encoding/json"
	"strings"
)

// Granular action permissions.
//
// role_permissions.tabs already answers "which screens may this role open", and it stays the
// authority on that. It cannot answer "may this role edit the master insurance list but not
// delete from it" - that is one screen and four different answers - so this file adds a second,
// finer grant stored alongside it in role_permissions.permissions.
//
// The two are deliberately separate rather than one merged list. A tab grant is about navigation
// and is safe to widen; an action grant is about writing shared reference data that every
// patient's billing depends on. Keeping them apart means a well-meant "give Billers the Reports
// tab" can never accidentally hand out the ability to rewrite payer IDs.

// Permission identifiers. Strings rather than an enum because they round-trip through JSONB and
// through the React checkbox list unchanged, which keeps the wire format inspectable.
const (
	PermInsuranceView   = "insurance.view"
	PermInsuranceCreate = "insurance.create"
	PermInsuranceUpdate = "insurance.update"
	PermInsuranceDelete = "insurance.delete"
)

// knownPermissions is the allowlist. A value the server does not recognise is rejected on save
// rather than stored, so the permissions column cannot accumulate typos that silently grant
// nothing while looking like they grant something.
var knownPermissions = map[string]bool{
	PermInsuranceView:   true,
	PermInsuranceCreate: true,
	PermInsuranceUpdate: true,
	PermInsuranceDelete: true,
}

type permSet map[string]bool

func (p permSet) has(perm string) bool { return p[perm] }

// permsFor returns the effective action grants for a role.
//
// SUPER_ADMIN is answered without touching the database: it holds everything, unconditionally and
// unstored, exactly as tabsFor treats it. That is what stops an administrator from editing their
// own role into a corner from which nobody can grant anything back.
//
// Any failure to read the table returns an EMPTY set, not a permissive one. Tabs fall back to the
// shipped defaults on a database hiccup because locking every user out of every screen would be
// worse than the hiccup; these grants fail closed instead, because the safe answer to "may this
// role rewrite master billing data, we cannot tell" is no.
func (s *Server) permsFor(ctx context.Context, role string) permSet {
	if role == "SUPER_ADMIN" {
		all := permSet{}
		for p := range knownPermissions {
			all[p] = true
		}
		return all
	}

	s.permMu.RLock()
	cached, ok := s.permCache[role]
	s.permMu.RUnlock()
	if ok {
		return cached
	}

	loaded := map[string]permSet{}
	rows, err := s.db.Query(ctx, `SELECT id, permissions FROM role_permissions`)
	if err != nil {
		return permSet{}
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			return permSet{}
		}
		var list []string
		if err := json.Unmarshal(raw, &list); err != nil {
			continue
		}
		set := permSet{}
		for _, p := range list {
			if knownPermissions[p] {
				set[p] = true
			}
		}
		loaded[id] = set
	}
	if rows.Err() != nil {
		return permSet{}
	}

	s.permMu.Lock()
	s.permCache = loaded
	s.permMu.Unlock()

	if set, ok := loaded[role]; ok {
		return set
	}
	return permSet{}
}

// invalidatePerms drops the cache after role_permissions changes, so a permission edit takes
// effect on the very next request rather than at some expiry. Mirrors invalidateTabs.
func (s *Server) invalidatePerms() {
	s.permMu.Lock()
	s.permCache = nil
	s.permMu.Unlock()
}

// sanitizePermissions filters a submitted list down to recognised values, de-duplicated and in a
// stable order. Returns the cleaned list and whether anything was discarded, so the caller can
// tell the difference between "saved what you asked" and "saved part of it".
func sanitizePermissions(raw any) ([]string, bool) {
	list, ok := raw.([]any)
	if !ok {
		if raw == nil {
			return []string{}, false
		}
		return []string{}, true
	}

	seen := map[string]bool{}
	dropped := false
	for _, v := range list {
		s, isStr := v.(string)
		if !isStr {
			dropped = true
			continue
		}
		s = strings.TrimSpace(s)
		if !knownPermissions[s] {
			dropped = true
			continue
		}
		seen[s] = true
	}

	// Fixed order, so an audit entry reads as a real diff rather than a reshuffle.
	out := []string{}
	for _, p := range []string{PermInsuranceView, PermInsuranceCreate, PermInsuranceUpdate, PermInsuranceDelete} {
		if seen[p] {
			out = append(out, p)
		}
	}
	return out, dropped
}
