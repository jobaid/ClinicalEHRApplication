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
	if ok, why := writeAllowed(name, u.Role, u.UID, doc, existing); !ok {
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
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.broadcast(name)
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
	if ok, why := writeAllowed(name, u.Role, u.UID, doc, nil); !ok {
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
	s.hub.broadcast(name)
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

// DELETE /api/collections/{name}/{id}
func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	name, id := r.PathValue("name"), r.PathValue("id")
	if _, ok := collections[name]; !ok {
		writeErr(w, http.StatusNotFound, "unknown collection")
		return
	}
	u := userFrom(r.Context())
	if ok, why := deleteAllowed(name, u.Role); !ok {
		writeErr(w, http.StatusForbidden, why)
		return
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
	s.hub.broadcast(name)
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
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

	// Authorize every operation before opening the transaction, so a rejected op cannot leave
	// a partially applied batch behind.
	for _, op := range ops {
		if _, ok := collections[op.Collection]; !ok {
			writeErr(w, http.StatusNotFound, "unknown collection "+op.Collection)
			return
		}
		if op.Op == "delete" {
			if ok, why := deleteAllowed(op.Collection, u.Role); !ok {
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
		if ok, why := writeAllowed(op.Collection, u.Role, u.UID, op.Data, existing); !ok {
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
		s.hub.broadcast(c)
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
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
