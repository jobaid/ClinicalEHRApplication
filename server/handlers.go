package main

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// Collection CRUD. These endpoints are a one-for-one replacement for the Firestore client SDK
// calls the app used to make, so src/firebase/firestoreService.js keeps its exact signatures.

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func newUID() string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, 20)
	for i := range b {
		b[i] = alphabet[rand.Intn(len(alphabet))]
	}
	return string(b)
}

// GET /api/collections/{name}
func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if _, ok := collections[name]; !ok {
		writeErr(w, http.StatusNotFound, "unknown collection")
		return
	}
	docs, err := List(r.Context(), s.db, name)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, docs)
}

// PUT /api/collections/{name}/{id}   -> setDocument (full replace)
// PATCH /api/collections/{name}/{id} -> updateDocument (merge)
func (s *Server) handleWrite(w http.ResponseWriter, r *http.Request) {
	name, id := r.PathValue("name"), r.PathValue("id")
	if _, ok := collections[name]; !ok {
		writeErr(w, http.StatusNotFound, "unknown collection")
		return
	}
	var doc Document
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed document")
		return
	}
	u := userFrom(r.Context())

	existing, err := Get(r.Context(), s.db, name, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if ok, why := writeAllowed(name, u.Role, u.UID, s.tabsFor(r.Context(), u.Role), s.permsFor(r.Context(), u.Role), doc, existing); !ok {
		writeErr(w, http.StatusForbidden, why)
		return
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer tx.Rollback(r.Context())

	if r.Method == http.MethodPatch {
		err = Update(r.Context(), tx, name, id, doc)
	} else {
		err = Set(r.Context(), tx, name, id, doc)
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, friendlyWriteError(name, err))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.changed(name)
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

// POST /api/collections/{name} -> addDocument with a server-generated id
func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if _, ok := collections[name]; !ok {
		writeErr(w, http.StatusNotFound, "unknown collection")
		return
	}
	var doc Document
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed document")
		return
	}
	u := userFrom(r.Context())
	if ok, why := writeAllowed(name, u.Role, u.UID, s.tabsFor(r.Context(), u.Role), s.permsFor(r.Context(), u.Role), doc, nil); !ok {
		writeErr(w, http.StatusForbidden, why)
		return
	}

	id := newUID()
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer tx.Rollback(r.Context())
	if err := Set(r.Context(), tx, name, id, doc); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.changed(name)
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

// changed announces a collection write to every connected client, and drops the cached role
// grants when the write was to rolePermissions - otherwise a permission change would keep being
// judged against the previous grants until the process restarted.
func (s *Server) changed(name string) {
	if name == "rolePermissions" {
		s.invalidateTabs()
		s.invalidatePerms()
	}
	s.hub.broadcast(name)
}

// DELETE /api/collections/{name}/{id}
func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	name, id := r.PathValue("name"), r.PathValue("id")
	if _, ok := collections[name]; !ok {
		writeErr(w, http.StatusNotFound, "unknown collection")
		return
	}
	u := userFrom(r.Context())
	if ok, why := deleteAllowed(name, u.Role, s.tabsFor(r.Context(), u.Role), s.permsFor(r.Context(), u.Role)); !ok {
		writeErr(w, http.StatusForbidden, why)
		return
	}
	if name == "insurance" {
		var inUse int
		if err := s.db.QueryRow(r.Context(),
			`SELECT count(*) FROM insurance_policies WHERE insurance_id = $1`, id).Scan(&inUse); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not check whether this insurance is in use")
			return
		}
		if inUse > 0 {
			// 409, not 403: the caller is allowed to do this, the data will not permit it.
			writeErr(w, http.StatusConflict,
				"this insurance is used by patient policies and cannot be deleted - deactivate it instead, which keeps those records intact")
			return
		}
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer tx.Rollback(r.Context())
	if err := Delete(r.Context(), tx, name, id); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.changed(name)
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

// friendlyWriteError turns a database constraint violation into something the person who typed
// the form can act on.
//
// Two reasons this is not just cosmetic. A raw driver message ("duplicate key value violates
// unique constraint idx_insurance_payer_unique") names internal schema objects to anyone who can
// reach the endpoint, and it tells the biller who typed a payer ID twice nothing about what to do.
// Anything unrecognised is passed through unchanged rather than swallowed, so a genuine fault
// still surfaces in full.
func friendlyWriteError(collection string, err error) string {
	msg := err.Error()
	if !strings.Contains(msg, "23505") && !strings.Contains(msg, "duplicate key") {
		return msg
	}
	switch {
	case strings.Contains(msg, "idx_insurance_name_unique"):
		return "an insurance company with that name already exists"
	case strings.Contains(msg, "idx_insurance_payer_unique"):
		return "that payer ID is already used by another insurance company"
	case collection == "insurance":
		return "that insurance company duplicates one that already exists"
	}
	return msg
}

// BatchOp is one write inside an atomic batch, mirroring Firestore's writeBatch API.
type BatchOp struct {
	Op         string   `json:"op"` // "set" | "update" | "delete"
	Collection string   `json:"collection"`
	ID         string   `json:"id"`
	Data       Document `json:"data"`
}

// POST /api/batch
//
// The app posts several related writes together - a charge plus its transaction and audit rows,
// say - and they must all land or none of them. Firestore's writeBatch gave that for free; here
// it is a single SQL transaction.
func (s *Server) handleBatch(w http.ResponseWriter, r *http.Request) {
	var ops []BatchOp
	if err := json.NewDecoder(r.Body).Decode(&ops); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed batch")
		return
	}
	if len(ops) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"applied": 0})
		return
	}
	u := userFrom(r.Context())
	tabs := s.tabsFor(r.Context(), u.Role)
	perms := s.permsFor(r.Context(), u.Role)

	// Authorize every operation before opening the transaction, so a rejected op cannot leave
	// a partially applied batch behind.
	for _, op := range ops {
		if _, ok := collections[op.Collection]; !ok {
			writeErr(w, http.StatusNotFound, "unknown collection "+op.Collection)
			return
		}
		if op.Op == "delete" {
			if ok, why := deleteAllowed(op.Collection, u.Role, tabs, perms); !ok {
				writeErr(w, http.StatusForbidden, why)
				return
			}
			continue
		}
		existing, err := Get(r.Context(), s.db, op.Collection, op.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		if ok, why := writeAllowed(op.Collection, u.Role, u.UID, tabs, perms, op.Data, existing); !ok {
			writeErr(w, http.StatusForbidden, why)
			return
		}
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer tx.Rollback(r.Context())

	touched := map[string]bool{}
	for i, op := range ops {
		var err error
		switch op.Op {
		case "set":
			err = Set(r.Context(), tx, op.Collection, op.ID, op.Data)
		case "update":
			err = Update(r.Context(), tx, op.Collection, op.ID, op.Data)
		case "delete":
			err = Delete(r.Context(), tx, op.Collection, op.ID)
		default:
			err = fmt.Errorf("unknown op %q", op.Op)
		}
		if err != nil {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("batch op %d (%s %s/%s): %v", i, op.Op, op.Collection, op.ID, err))
			return
		}
		touched[op.Collection] = true
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	for c := range touched {
		s.changed(c)
	}
	writeJSON(w, http.StatusOK, map[string]any{"applied": len(ops)})
}

// originAllowed decides whether a browser origin may call the API.
//
// The configured CORS_ORIGINS list is matched exactly (not as a substring - "localhost:5173"
// must not accidentally authorise "evil-localhost:51730"). On top of that, any origin served
// from this machine or the local network is accepted, because Vite prints several URLs for the
// same dev server - Local (localhost:5173) AND Network (e.g. 192.168.1.183:5173) - and
// `npm run preview` uses yet another port. Opening any of those should just work; previously
// only localhost:5173 did, and a blocked request surfaced in the UI as "Invalid email or
// password", because the login handler cannot tell a rejected request from a rejected password.
//
// Set CORS_ORIGINS to an explicit list and ALLOW_LOCAL_ORIGINS=false to lock this down for a
// real deployment.
func originAllowed(allowed string, allowLocal bool, origin string) bool {
	if origin == "" {
		return false
	}
	if allowed == "*" {
		return true
	}
	for _, a := range strings.Split(allowed, ",") {
		if strings.EqualFold(strings.TrimSpace(a), origin) {
			return true
		}
	}
	if !allowLocal {
		return false
	}

	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	// Loopback plus RFC1918 / link-local, i.e. this machine or the LAN it is on.
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

// withCORS lets the frontend (Vite dev server, preview build, or a LAN client) call the API.
func withCORS(allowed string, next http.Handler) http.Handler {
	allowLocal := env("ALLOW_LOCAL_ORIGINS", "true") != "false"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if originAllowed(allowed, allowLocal, origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			// Cross-origin JavaScript can only read a short allowlist of response headers unless
			// the server says otherwise. Without this the statement download reaches the browser
			// with its filename stripped and saves as "download.pdf" instead of the name the
			// audit trail refers to. Only relevant when the frontend is served from a different
			// origin than the API - the Docker image proxies /api onto the same origin, where
			// every header is readable anyway.
			w.Header().Set("Access-Control-Expose-Headers", "Content-Disposition")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
