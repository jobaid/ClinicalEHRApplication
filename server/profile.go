package main

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// User profile settings, personal certificates, and HR employee documents.
//
// The user's own profile is edited through /api/me/*. Name and email are NEVER modified here -
// they identify the account and belong to User accounts / HR. Only fields the user is entitled
// to change ride on these routes, and the server enforces that rather than trusting the browser:
// changing name or email from this endpoint is refused even if the client sends them.

//go:embed migrations/018_profiles_and_documents.sql
var profileSchemaSQL string

func (s *Server) ensureProfileSchema(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, profileSchemaSQL); err != nil {
		return fmt.Errorf("profile schema: %w", err)
	}
	return nil
}

const maxCertificateBytes = 10 << 20    // 10 MB, same shape as medical records
const maxEmployeeDocBytes = 20 << 20    // 20 MB, matches medical_records

// A phone entered by the user. Not a full E.164 check - this is US-style and defensive: digits,
// spaces, dashes, parentheses, +, dot, up to 32 characters. Section 8 forbids alphabetic input.
var phonePattern = regexp.MustCompile(`^[0-9+\-\s().]{0,32}$`)

// ---------- Personal information (phone, address, skills) ----------

// GET /api/me/profile
func (s *Server) handleMyProfile(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var extra []byte
	var name, email string
	if err := s.db.QueryRow(r.Context(),
		`SELECT name, email, COALESCE(extra, '{}'::jsonb) FROM users WHERE id = $1`, u.UID).
		Scan(&name, &email, &extra); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read your profile")
		return
	}
	var e map[string]any
	if json.Unmarshal(extra, &e) != nil {
		e = map[string]any{}
	}
	phone, _ := e["phone"].(string)
	address, _ := e["address"].(string)
	skills := []string{}
	if arr, ok := e["skills"].([]any); ok {
		for _, v := range arr {
			if str, ok := v.(string); ok && strings.TrimSpace(str) != "" {
				skills = append(skills, strings.TrimSpace(str))
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"uid": u.UID, "name": name, "email": email, "role": u.Role,
		"phone": phone, "address": address, "skills": skills,
	})
}

// PATCH /api/me/profile
//
// Only phone and address are accepted. Name, email, role, disabled, permissions - not editable
// here. The server never reads them from the request body, so a hostile client that sends them
// changes nothing.
func (s *Server) handleMyProfilePatch(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var body struct {
		Phone   *string `json:"phone"`
		Address *string `json:"address"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	if body.Phone != nil {
		v := strings.TrimSpace(*body.Phone)
		if !phonePattern.MatchString(v) {
			writeErr(w, http.StatusBadRequest, "phone number may contain only digits and separators, no letters")
			return
		}
		body.Phone = &v
	}
	if body.Address != nil {
		v := strings.TrimSpace(*body.Address)
		if len(v) > 500 {
			writeErr(w, http.StatusBadRequest, "address is too long")
			return
		}
		body.Address = &v
	}

	patch := map[string]any{}
	if body.Phone != nil {
		patch["phone"] = *body.Phone
	}
	if body.Address != nil {
		patch["address"] = *body.Address
	}
	if len(patch) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "unchanged": true})
		return
	}

	if err := s.mergeUserExtra(r.Context(), u.UID, patch); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save your profile")
		return
	}
	s.hub.broadcast("users")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// mergeUserExtra merges a partial map into the users.extra JSONB, leaving keys not in the patch
// unchanged. Uses jsonb || operator, which is a shallow merge - which is what we want: skills is
// an array replaced wholesale, phone and address are strings replaced wholesale.
func (s *Server) mergeUserExtra(ctx context.Context, uid string, patch map[string]any) error {
	raw, err := json.Marshal(patch)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx,
		`UPDATE users SET extra = COALESCE(extra, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
		uid, string(raw))
	return err
}

// PUT /api/me/skills - replaces the skills list.
func (s *Server) handleMySkillsPut(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var body struct {
		Skills []string `json:"skills"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	seen := map[string]bool{}
	out := []string{}
	for _, s := range body.Skills {
		s = strings.TrimSpace(s)
		if s == "" || len(s) > 60 || seen[strings.ToLower(s)] {
			continue
		}
		seen[strings.ToLower(s)] = true
		out = append(out, s)
		if len(out) >= 100 {
			break
		}
	}
	if err := s.mergeUserExtra(r.Context(), u.UID, map[string]any{"skills": out}); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save your skills")
		return
	}
	s.hub.broadcast("users")
	writeJSON(w, http.StatusOK, map[string]any{"skills": out})
}

// ---------- Personal certificates ----------

type certificateRow struct {
	ID            string `json:"id"`
	UserID        string `json:"userId"`
	Name          string `json:"name"`
	Issuer        string `json:"issuer"`
	IssueDate     string `json:"issueDate"`
	ExpiryDate    string `json:"expiryDate"`
	CredentialID  string `json:"credentialId"`
	Notes         string `json:"notes"`
	FileName      string `json:"fileName"`
	FileType      string `json:"fileType"`
	FileSize      int64  `json:"fileSize"`
	HasFile       bool   `json:"hasFile"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
}

// GET /api/me/certificates
func (s *Server) handleMyCertificatesList(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	rows, err := s.db.Query(r.Context(),
		`SELECT id, user_id, name, issuer, issue_date, expiry_date, credential_id, notes,
		        file_name, file_type, file_size, (file <> '' AND file IS NOT NULL),
		        created_at, updated_at
		   FROM user_certificates WHERE user_id = $1 ORDER BY issue_date DESC, created_at DESC`, u.UID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read your certificates")
		return
	}
	defer rows.Close()
	out := []certificateRow{}
	for rows.Next() {
		var c certificateRow
		var created, updated time.Time
		if err := rows.Scan(&c.ID, &c.UserID, &c.Name, &c.Issuer, &c.IssueDate, &c.ExpiryDate,
			&c.CredentialID, &c.Notes, &c.FileName, &c.FileType, &c.FileSize, &c.HasFile,
			&created, &updated); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not read your certificates")
			return
		}
		c.CreatedAt = created.UTC().Format(time.RFC3339)
		c.UpdatedAt = updated.UTC().Format(time.RFC3339)
		out = append(out, c)
	}
	writeJSON(w, http.StatusOK, map[string]any{"certificates": out})
}

type certForm struct {
	Name         string `json:"name"`
	Issuer       string `json:"issuer"`
	IssueDate    string `json:"issueDate"`
	ExpiryDate   string `json:"expiryDate"`
	CredentialID string `json:"credentialId"`
	Notes        string `json:"notes"`
}

func trimCertForm(c *certForm) []string {
	c.Name = strings.TrimSpace(c.Name)
	c.Issuer = strings.TrimSpace(c.Issuer)
	c.IssueDate = strings.TrimSpace(c.IssueDate)
	c.ExpiryDate = strings.TrimSpace(c.ExpiryDate)
	c.CredentialID = strings.TrimSpace(c.CredentialID)
	c.Notes = strings.TrimSpace(c.Notes)
	problems := []string{}
	if c.Name == "" {
		problems = append(problems, "a certificate name is required")
	}
	if len(c.Name) > 200 {
		problems = append(problems, "the certificate name is too long")
	}
	if c.IssueDate != "" {
		if _, err := time.Parse("2006-01-02", c.IssueDate); err != nil {
			problems = append(problems, "issue date must be in YYYY-MM-DD form")
		}
	}
	if c.ExpiryDate != "" {
		if _, err := time.Parse("2006-01-02", c.ExpiryDate); err != nil {
			problems = append(problems, "expiration date must be in YYYY-MM-DD form")
		}
	}
	if len(c.Notes) > 2000 {
		problems = append(problems, "notes are too long")
	}
	return problems
}

// POST /api/me/certificates
func (s *Server) handleMyCertificateCreate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var form certForm
	if err := json.NewDecoder(r.Body).Decode(&form); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	if problems := trimCertForm(&form); len(problems) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"problems": problems})
		return
	}
	id := "CERT" + newUID()
	if _, err := s.db.Exec(r.Context(),
		`INSERT INTO user_certificates
		  (id, user_id, name, issuer, issue_date, expiry_date, credential_id, notes)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		id, u.UID, form.Name, form.Issuer, form.IssueDate, form.ExpiryDate,
		form.CredentialID, form.Notes); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the certificate")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

// PUT /api/me/certificates/{id}
func (s *Server) handleMyCertificateUpdate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")
	if !s.ownsCertificate(r.Context(), id, u.UID) {
		writeErr(w, http.StatusNotFound, "no such certificate")
		return
	}
	var form certForm
	if err := json.NewDecoder(r.Body).Decode(&form); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	if problems := trimCertForm(&form); len(problems) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"problems": problems})
		return
	}
	if _, err := s.db.Exec(r.Context(),
		`UPDATE user_certificates
		    SET name = $2, issuer = $3, issue_date = $4, expiry_date = $5,
		        credential_id = $6, notes = $7, updated_at = now()
		  WHERE id = $1 AND user_id = $8`,
		id, form.Name, form.Issuer, form.IssueDate, form.ExpiryDate,
		form.CredentialID, form.Notes, u.UID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the certificate")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// DELETE /api/me/certificates/{id}
func (s *Server) handleMyCertificateDelete(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")
	tag, err := s.db.Exec(r.Context(),
		`DELETE FROM user_certificates WHERE id = $1 AND user_id = $2`, id, u.UID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not remove the certificate")
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "no such certificate")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// POST /api/me/certificates/{id}/file
func (s *Server) handleMyCertificateUpload(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")
	if !s.ownsCertificate(r.Context(), id, u.UID) {
		writeErr(w, http.StatusNotFound, "no such certificate")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxCertificateBytes+(2<<20))
	if err := r.ParseMultipartForm(4 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "the upload was too large or malformed (limit 10 MB)")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "a file is required")
		return
	}
	defer file.Close() //nolint:errcheck
	raw, err := io.ReadAll(io.LimitReader(file, maxCertificateBytes+1))
	if err != nil || len(raw) == 0 {
		writeErr(w, http.StatusBadRequest, "the file is empty or could not be read")
		return
	}
	if int64(len(raw)) > maxCertificateBytes {
		writeErr(w, http.StatusBadRequest, "the file is larger than 10 MB")
		return
	}
	mime, ext, ok := sniffFileType(raw)
	if !ok {
		writeErr(w, http.StatusBadRequest,
			"only PDF, JPG and PNG files are accepted. The file's contents do not match any of those.")
		return
	}
	sum := sha256.Sum256(raw)
	_ = sum
	dataURL := "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw)
	name := safeBackupName(strings.TrimSpace(header.Filename))
	if name == "" {
		name = "certificate"
	}
	if !strings.HasSuffix(strings.ToLower(name), ext) {
		name += ext
	}
	if _, err := s.db.Exec(r.Context(),
		`UPDATE user_certificates
		    SET file = $2, file_name = $3, file_type = $4, file_size = $5, updated_at = now()
		  WHERE id = $1 AND user_id = $6`,
		id, dataURL, name, mime, int64(len(raw)), u.UID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not store the file")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "fileName": name, "fileType": mime, "fileSize": len(raw)})
}

// GET /api/me/certificates/{id}/file
func (s *Server) handleMyCertificateDownload(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")
	var dataURL, name, mime string
	if err := s.db.QueryRow(r.Context(),
		`SELECT file, file_name, file_type FROM user_certificates WHERE id = $1 AND user_id = $2`,
		id, u.UID).Scan(&dataURL, &name, &mime); err != nil {
		writeErr(w, http.StatusNotFound, "no such certificate")
		return
	}
	body, ok := decodeDataURL(dataURL)
	if !ok {
		writeErr(w, http.StatusNotFound, "no file is attached to this certificate")
		return
	}
	sum := sha256.Sum256(body)
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename=%q`, name))
	w.Header().Set("Etag", `"`+hex.EncodeToString(sum[:])+`"`)
	_, _ = w.Write(body)
}

func (s *Server) ownsCertificate(ctx context.Context, id, uid string) bool {
	var exists bool
	_ = s.db.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM user_certificates WHERE id = $1 AND user_id = $2)`,
		id, uid).Scan(&exists)
	return exists
}

// ---------- HR Employee Documents ----------

type employeeDocument struct {
	ID           string `json:"id"`
	EmployeeID   string `json:"employeeId"`
	DocumentName string `json:"documentName"`
	Category     string `json:"category"`
	Description  string `json:"description"`
	ExpiryDate   string `json:"expiryDate"`
	FileName     string `json:"fileName"`
	FileType     string `json:"fileType"`
	FileSize     int64  `json:"fileSize"`
	UploadedBy   string `json:"uploadedBy"`
	UploadedAt   string `json:"uploadedAt"`
}

var employeeDocCategories = map[string]bool{
	"Employment Document":   true,
	"Resume":                true,
	"Offer Letter":          true,
	"Employment Agreement":  true,
	"Employee ID Document":  true,
	"Training Document":     true,
	"License":               true,
	"Certification":         true,
	"Education Document":    true,
	"Performance Document":  true,
	"Other":                 true,
}

// GET /api/hr/employees/{userId}/documents
func (s *Server) handleEmployeeDocumentsList(w http.ResponseWriter, r *http.Request) {
	employeeID := r.PathValue("userId")
	rows, err := s.db.Query(r.Context(),
		`SELECT id, employee_id, document_name, category, description, expiry_date,
		        file_name, file_type, file_size, uploaded_by, uploaded_at
		   FROM employee_documents
		  WHERE employee_id = $1 AND archived_at IS NULL
		  ORDER BY uploaded_at DESC`, employeeID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the documents")
		return
	}
	defer rows.Close()
	out := []employeeDocument{}
	for rows.Next() {
		var d employeeDocument
		var at time.Time
		if err := rows.Scan(&d.ID, &d.EmployeeID, &d.DocumentName, &d.Category, &d.Description,
			&d.ExpiryDate, &d.FileName, &d.FileType, &d.FileSize, &d.UploadedBy, &at); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not read the documents")
			return
		}
		d.UploadedAt = at.UTC().Format(time.RFC3339)
		out = append(out, d)
	}
	writeJSON(w, http.StatusOK, map[string]any{"documents": out})
}

// POST /api/hr/employees/{userId}/documents
func (s *Server) handleEmployeeDocumentUpload(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	employeeID := r.PathValue("userId")

	var exists bool
	if err := s.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)`, employeeID).Scan(&exists); err != nil || !exists {
		writeErr(w, http.StatusNotFound, "no such employee")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxEmployeeDocBytes+(4<<20))
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "the upload was too large or malformed (limit 20 MB)")
		return
	}
	documentName := strings.TrimSpace(r.FormValue("documentName"))
	if documentName == "" {
		writeErr(w, http.StatusBadRequest, "a document name is required")
		return
	}
	category := strings.TrimSpace(r.FormValue("category"))
	if !employeeDocCategories[category] {
		category = "Other"
	}
	description := strings.TrimSpace(r.FormValue("description"))
	expiryDate := strings.TrimSpace(r.FormValue("expiryDate"))
	if expiryDate != "" {
		if _, err := time.Parse("2006-01-02", expiryDate); err != nil {
			writeErr(w, http.StatusBadRequest, "expiry date must be in YYYY-MM-DD form")
			return
		}
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "a file is required")
		return
	}
	defer file.Close() //nolint:errcheck
	raw, err := io.ReadAll(io.LimitReader(file, maxEmployeeDocBytes+1))
	if err != nil || len(raw) == 0 {
		writeErr(w, http.StatusBadRequest, "the file is empty or could not be read")
		return
	}
	if int64(len(raw)) > maxEmployeeDocBytes {
		writeErr(w, http.StatusBadRequest, "the file is larger than 20 MB")
		return
	}
	mime, ext, ok := sniffFileType(raw)
	if !ok {
		writeErr(w, http.StatusBadRequest,
			"only PDF, JPG and PNG files are accepted. The file's contents do not match any of those.")
		return
	}
	dataURL := "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw)
	name := safeBackupName(strings.TrimSpace(header.Filename))
	if name == "" {
		name = "document"
	}
	if !strings.HasSuffix(strings.ToLower(name), ext) {
		name += ext
	}

	id := "EDOC" + newUID()
	if _, err := s.db.Exec(r.Context(),
		`INSERT INTO employee_documents
		  (id, employee_id, document_name, category, description, expiry_date,
		   file, file_name, file_type, file_size, uploaded_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		id, employeeID, documentName, category, description, expiryDate,
		dataURL, name, mime, int64(len(raw)), u.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not store the document")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

// GET /api/hr/employees/{userId}/documents/{docId}/download
func (s *Server) handleEmployeeDocumentDownload(w http.ResponseWriter, r *http.Request) {
	employeeID := r.PathValue("userId")
	docID := r.PathValue("docId")
	var dataURL, name, mime string
	if err := s.db.QueryRow(r.Context(),
		`SELECT file, file_name, file_type
		   FROM employee_documents
		  WHERE id = $1 AND employee_id = $2 AND archived_at IS NULL`,
		docID, employeeID).Scan(&dataURL, &name, &mime); err != nil {
		writeErr(w, http.StatusNotFound, "no such document")
		return
	}
	body, ok := decodeDataURL(dataURL)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "the stored document is corrupted")
		return
	}
	sum := sha256.Sum256(body)
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename=%q`, name))
	w.Header().Set("Etag", `"`+hex.EncodeToString(sum[:])+`"`)
	_, _ = w.Write(body)
}

// DELETE /api/hr/employees/{userId}/documents/{docId}
//
// Archives, does not hard-delete. The row keeps a non-null archived_at so the fact that a
// document was on file at some point remains discoverable.
func (s *Server) handleEmployeeDocumentDelete(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	employeeID := r.PathValue("userId")
	docID := r.PathValue("docId")
	tag, err := s.db.Exec(r.Context(),
		`UPDATE employee_documents
		    SET archived_at = now(), archived_by = $3
		  WHERE id = $1 AND employee_id = $2 AND archived_at IS NULL`,
		docID, employeeID, u.Name)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not archive the document")
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "no such document")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// decodeDataURL turns a "data:...;base64,..." back into its raw bytes. Returns ok=false if the
// argument is empty or not a base64 data URL.
func decodeDataURL(s string) ([]byte, bool) {
	if s == "" {
		return nil, false
	}
	i := strings.Index(s, ";base64,")
	if !strings.HasPrefix(s, "data:") || i < 0 {
		return nil, false
	}
	raw, err := base64.StdEncoding.DecodeString(s[i+len(";base64,"):])
	if err != nil {
		return nil, false
	}
	return raw, true
}
