package main

import (
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Server-Sent Events change feed - the replacement for Firestore's onSnapshot.
//
// Firestore pushed live updates to every listening client, which is why the app never merges
// local state after a write. Here the API keeps one SSE stream per browser tab and pushes the
// name of any collection that changed; the client shim then refetches just that collection.
// Cross-user updates therefore keep working exactly as they do today.

type hub struct {
	mu      sync.RWMutex
	clients map[chan string]struct{}
}

func newHub() *hub {
	return &hub{clients: make(map[chan string]struct{})}
}

func (h *hub) add() chan string {
	ch := make(chan string, 32)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *hub) remove(ch chan string) {
	h.mu.Lock()
	if _, ok := h.clients[ch]; ok {
		delete(h.clients, ch)
		close(ch)
	}
	h.mu.Unlock()
}

// broadcast notifies every connected client that a collection changed. A slow client that has
// filled its buffer is skipped rather than blocking the write path - it will catch up on its
// next poll or reconnect.
func (h *hub) broadcast(collection string) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.clients {
		select {
		case ch <- collection:
		default:
		}
	}
}

// GET /api/stream
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	ch := s.hub.add()
	defer s.hub.remove(ch)

	fmt.Fprint(w, "event: ready\ndata: {}\n\n")
	flusher.Flush()

	// Keep-alive comments stop idle proxies from dropping the connection.
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case collection, open := <-ch:
			if !open {
				return
			}
			fmt.Fprintf(w, "event: change\ndata: {\"collection\":%q}\n\n", collection)
			flusher.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}
