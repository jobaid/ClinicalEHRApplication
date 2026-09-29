package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Patient profile picture. Kept in its own table with one row per patient, so a photo update is
// an UPSERT and there is only ever one active picture. The picture bytes are NOT part of the
// patients row - listing patients or opening the demography tab shouldn't move the image bytes
// around unless the caller asks for /photo explicitly.

//go:embed migrations/021_patient_photos.sql
var patientPhotoSchemaSQL string

func (s *Server) ensurePatientPhotoSchema(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, patientPhotoSchemaSQL); err != nil {
		return fmt.Errorf("patient photo schema: %w", err)
	}
	return nil
}

const maxPatientPhotoBytes = 8 << 20 // 8 MB - a scanned ID would fit but this is for a headshot.

// sniffImage identifies JPG, PNG or WebP by their magic bytes. Content-Type from the browser is
// not trusted; the extension is not trusted. Returns "" if the bytes are none of the accepted
// formats.
func sniffImage(b []byte) string {
	switch {
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return "image/jpeg"
	case len(b) >= 8 && string(b[:8]) == "\x89PNG\r\n\x1a\n":
		return "image/png"
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "image/webp"
	}
	return ""
}

// ---------- GET /api/patients/{id}/photo ----------

func (s *Server) handlePatientPhotoGet(w http.ResponseWriter, r *http.Request) {
	pid := r.PathValue("id")
	var mime string
	var raw []byte
	var updated time.Time
	err := s.db.QueryRow(r.Context(),
		`SELECT mime, file_bytes, uploaded_at FROM patient_photos WHERE patient_id = $1`, pid).
		Scan(&mime, &raw, &updated)
	if err != nil {
		writeErr(w, http.StatusNotFound, "no photo on file for this patient")
		return
	}
	sum := sha256.Sum256(raw)
	etag := `"` + hex.EncodeToString(sum[:]) + `"`
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(raw)))
	w.Header().Set("Cache-Control", "private, max-age=60")
	w.Header().Set("Etag", etag)
	w.Header().Set("Last-Modified", updated.UTC().Format(http.TimeFormat))
	_, _ = w.Write(raw)
}

// ---------- POST /api/patients/{id}/photo ----------

func (s *Server) handlePatientPhotoUpload(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	pid := r.PathValue("id")
	if !s.patientExists(r.Context(), pid) {
		writeErr(w, http.StatusNotFound, "no such patient")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxPatientPhotoBytes+(1<<20))
	if err := r.ParseMultipartForm(2 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "the upload was too large or malformed (limit 8 MB)")
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "a photo file is required")
		return
	}
	defer file.Close() //nolint:errcheck

	raw, err := io.ReadAll(io.LimitReader(file, maxPatientPhotoBytes+1))
	if err != nil || len(raw) == 0 {
		writeErr(w, http.StatusBadRequest, "the file is empty or could not be read")
		return
	}
	if int64(len(raw)) > maxPatientPhotoBytes {
		writeErr(w, http.StatusBadRequest, "the photo is larger than 8 MB")
		return
	}
	// A truncated read for the sniff is enough; we already have the whole file in memory.
	mime := sniffImage(raw[:min(64, len(raw))])
	if mime == "" {
		writeErr(w, http.StatusBadRequest,
			"only JPG, PNG and WebP images are accepted. The file's contents do not match any of those.")
		return
	}

	if _, err := s.db.Exec(r.Context(),
		`INSERT INTO patient_photos (patient_id, mime, file_bytes, file_size, uploaded_by, uploaded_at)
		 VALUES ($1, $2, $3, $4, $5, now())
		 ON CONFLICT (patient_id) DO UPDATE
		    SET mime = EXCLUDED.mime,
		        file_bytes = EXCLUDED.file_bytes,
		        file_size = EXCLUDED.file_size,
		        uploaded_by = EXCLUDED.uploaded_by,
		        uploaded_at = now()`,
		pid, mime, raw, len(raw), u.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the photo")
		return
	}

	s.auditClinical(r.Context(), u, pid, "Patient photo saved", "patientPhoto", pid, "",
		fmt.Sprintf("%s (%d bytes)", mime, len(raw)))

	writeJSON(w, http.StatusOK, map[string]any{"mime": mime, "size": len(raw)})
}

// ---------- DELETE /api/patients/{id}/photo ----------

func (s *Server) handlePatientPhotoDelete(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	pid := r.PathValue("id")
	tag, err := s.db.Exec(r.Context(), `DELETE FROM patient_photos WHERE patient_id = $1`, pid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not remove the photo")
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "no photo on file for this patient")
		return
	}
	s.auditClinical(r.Context(), u, pid, "Patient photo removed", "patientPhoto", pid, "", "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------- authorization wrappers ----------

// requirePatientTab reuses the tab-based read gate that governs the patients collection: any role
// whose tabs include one that covers patients (patients, clinical, schedule, record, billing,
// claims, reports) may see the photo. Otherwise no.
func (s *Server) requirePatientPhotoRead(next http.HandlerFunc) http.HandlerFunc {
	return s.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if !s.collectionReadAllowed(r.Context(), "patients", u) {
			writeErr(w, http.StatusForbidden, "your role does not have access to patient information")
			return
		}
		next(w, r)
	})
}

// requirePatientPhotoWrite mirrors the writeAllowed rule for the patients collection: the role
// must hold the "patients" tab. Nothing looser here - a photo is patient data.
func (s *Server) requirePatientPhotoWrite(next http.HandlerFunc) http.HandlerFunc {
	return s.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if u.Role == "SUPER_ADMIN" {
			next(w, r)
			return
		}
		if !s.tabsFor(r.Context(), u.Role).has("patients") {
			writeErr(w, http.StatusForbidden, "your role cannot modify patient records")
			return
		}
		next(w, r)
	})
}

// (bytes import stays reserved for future validation; keeps go fmt happy either way)
var _ = bytes.Equal
var _ = strings.TrimSpace
