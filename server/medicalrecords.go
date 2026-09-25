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
	"net/smtp"
	"os"
	"strings"
	"time"
)

// Uploaded medical records.
//
// Purely additive: a new table, new routes and new grants. Nothing existing is touched - the
// timeline, the lab panel, id_documents and every other feature behave exactly as before.
//
// Files are stored base64 in the database, which is how this application already keeps scanned
// identity documents and insurance cards. That choice is what satisfies section 18 without
// building anything: a record survives `git pull`, `npm install`, a rebuild and a restart
// because it was never on the filesystem, and a pg_dump backup already contains it.

//go:embed migrations/011_medical_records.sql
var medicalRecordSchemaSQL string

func (s *Server) ensureMedicalRecordSchema(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, medicalRecordSchemaSQL); err != nil {
		return fmt.Errorf("medical records schema: %w", err)
	}
	return nil
}

// 20 MB. Large enough for a multi-page scanned report, small enough that one upload cannot fill
// the database. Base64 inflates by about a third, so this is roughly 27 MB on the wire - which
// is why the nginx client_max_body_size of 25m in deploy/ is worth checking if uploads of the
// largest permitted size ever fail.
const maxMedicalRecordBytes = 20 << 20

// sniffFileType identifies a file by its LEADING BYTES, not by its name or its declared MIME type.
//
// This is the whole file-type defence. A browser sends whatever Content-Type it likes and a
// filename is just text, so "report.pdf" can be a script and an attacker controls both. Only the
// magic number is evidence. An unrecognised prefix is rejected outright rather than stored with
// a guess.
func sniffFileType(b []byte) (mime, ext string, ok bool) {
	switch {
	case len(b) >= 4 && string(b[:4]) == "%PDF":
		return "application/pdf", ".pdf", true
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return "image/jpeg", ".jpg", true
	case len(b) >= 8 && string(b[:8]) == "\x89PNG\r\n\x1a\n":
		return "image/png", ".png", true
	default:
		return "", "", false
	}
}

type medicalRecord struct {
	ID          string `json:"id"`
	PatientID   string `json:"patientId"`
	RecordName  string `json:"recordName"`
	RecordDate  string `json:"recordDate"`
	RecordType  string `json:"recordType"`
	Provider    string `json:"provider"`
	Facility    string `json:"facility"`
	Description string `json:"description"`

	FileName string `json:"fileName"`
	FileType string `json:"fileType"`
	FileSize int64  `json:"fileSize"`
	SHA256   string `json:"sha256"`

	UploadedByID   string `json:"uploadedById"`
	UploadedByName string `json:"uploadedByName"`
	UploadedAt     string `json:"uploadedAt"`
	Status         string `json:"status"`
}

// POST /api/patients/{id}/records
func (s *Server) handleMedRecUpload(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	patientID := r.PathValue("id")

	if !s.patientExists(r.Context(), patientID) {
		writeErr(w, http.StatusNotFound, "no such patient")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxMedicalRecordBytes+(4<<20))
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "the upload was too large or malformed (limit 20 MB)")
		return
	}

	recordName := strings.TrimSpace(r.FormValue("recordName"))
	recordDate := strings.TrimSpace(r.FormValue("recordDate"))
	if recordName == "" {
		writeErr(w, http.StatusBadRequest, "a record name is required")
		return
	}
	// Required, and validated for shape: section 4 turns on this being the date of the RECORD,
	// so an empty or malformed one must not silently fall back to today.
	if _, err := time.Parse("2006-01-02", recordDate); err != nil {
		writeErr(w, http.StatusBadRequest, "a record date is required, in YYYY-MM-DD form")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "a file is required")
		return
	}
	defer file.Close() //nolint:errcheck // read-only

	raw, err := io.ReadAll(io.LimitReader(file, maxMedicalRecordBytes+1))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the upload")
		return
	}
	if len(raw) == 0 {
		writeErr(w, http.StatusBadRequest, "the file is empty")
		return
	}
	if int64(len(raw)) > maxMedicalRecordBytes {
		writeErr(w, http.StatusBadRequest, "the file is larger than 20 MB")
		return
	}

	mime, ext, ok := sniffFileType(raw)
	if !ok {
		writeErr(w, http.StatusBadRequest,
			"only PDF, JPG and PNG files are accepted. The file's contents do not match any of those.")
		return
	}

	sum := sha256.Sum256(raw)
	dataURL := "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw)

	// The stored filename keeps the extension the CONTENT justifies, not the one it arrived with.
	name := safeBackupName(strings.TrimSpace(header.Filename))
	if name == "" {
		name = "record"
	}
	if !strings.HasSuffix(strings.ToLower(name), ext) {
		name += ext
	}

	id := "MR" + newUID()
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO medical_records
		  (id, patient_id, record_name, record_date, record_type, provider, facility, description,
		   file, file_name, file_type, file_size, sha256,
		   uploaded_by_id, uploaded_by_name, status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active')`,
		id, patientID, recordName, recordDate,
		strings.TrimSpace(r.FormValue("recordType")),
		strings.TrimSpace(r.FormValue("provider")),
		strings.TrimSpace(r.FormValue("facility")),
		strings.TrimSpace(r.FormValue("description")),
		dataURL, name, mime, int64(len(raw)), hex.EncodeToString(sum[:]),
		// Section 5: identity comes from the session, never from the form.
		u.UID, u.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not store the medical record")
		return
	}

	s.auditClinical(r.Context(), u, patientID, "Medical record uploaded", "medicalRecordFile", id,
		"", fmt.Sprintf("%s (%s, %d bytes)", recordName, mime, len(raw)))
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

// GET /api/patients/{id}/records
//
// Metadata only - the file column is never selected here, so listing a chart does not move
// megabytes of scanned documents that nobody has asked to open.
func (s *Server) handleMedRecList(w http.ResponseWriter, r *http.Request) {
	patientID := r.PathValue("id")
	q := r.URL.Query()

	args := []any{patientID}
	where := []string{"patient_id = $1", "status = 'active'"}
	add := func(clause, v string) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(clause, len(args)))
	}

	// Section 13: extends the existing filter vocabulary rather than replacing anything.
	if v := strings.TrimSpace(q.Get("search")); v != "" {
		args = append(args, v)
		n := len(args)
		where = append(where, fmt.Sprintf(
			"(record_name ILIKE '%%'||$%d||'%%' OR record_type ILIKE '%%'||$%d||'%%'"+
				" OR provider ILIKE '%%'||$%d||'%%' OR facility ILIKE '%%'||$%d||'%%')", n, n, n, n))
	}
	if v := strings.TrimSpace(q.Get("recordType")); v != "" {
		add("record_type = $%d", v)
	}
	if v := strings.TrimSpace(q.Get("provider")); v != "" {
		add("provider ILIKE '%%'||$%d||'%%'", v)
	}
	if v := strings.TrimSpace(q.Get("uploadedBy")); v != "" {
		add("uploaded_by_name ILIKE '%%'||$%d||'%%'", v)
	}
	if v := strings.TrimSpace(q.Get("from")); v != "" {
		add("record_date >= $%d", v)
	}
	if v := strings.TrimSpace(q.Get("to")); v != "" {
		add("record_date <= $%d", v)
	}

	rows, err := s.db.Query(r.Context(), `
		SELECT id, patient_id, record_name, record_date, record_type, provider, facility,
		       description, file_name, file_type, file_size, sha256,
		       uploaded_by_id, uploaded_by_name, uploaded_at, status
		  FROM medical_records WHERE `+strings.Join(where, " AND ")+`
		 ORDER BY record_date DESC, uploaded_at DESC LIMIT 200`, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the medical records")
		return
	}
	defer rows.Close()

	out := []medicalRecord{}
	types := map[string]bool{}
	for rows.Next() {
		var m medicalRecord
		var at time.Time
		if err := rows.Scan(&m.ID, &m.PatientID, &m.RecordName, &m.RecordDate, &m.RecordType,
			&m.Provider, &m.Facility, &m.Description, &m.FileName, &m.FileType, &m.FileSize,
			&m.SHA256, &m.UploadedByID, &m.UploadedByName, &at, &m.Status); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not read the medical records")
			return
		}
		m.UploadedAt = at.UTC().Format(time.RFC3339)
		if m.RecordType != "" {
			types[m.RecordType] = true
		}
		out = append(out, m)
	}

	typeList := []string{}
	for t := range types {
		typeList = append(typeList, t)
	}
	writeJSON(w, http.StatusOK, map[string]any{"records": out, "recordTypes": typeList})
}

// loadRecord fetches one record, scoped to the patient in the path.
//
// patient_id is in the WHERE clause on purpose. Without it, editing the record id in the URL
// would read a document belonging to somebody else - section 17's "direct API access must also
// require authorization", applied to the object and not only to the route.
func (s *Server) loadRecord(r *http.Request, withFile bool) (medicalRecord, string, bool) {
	patientID, recID := r.PathValue("id"), r.PathValue("recordId")
	cols := `id, patient_id, record_name, record_date, record_type, provider, facility,
	         description, file_name, file_type, file_size, sha256,
	         uploaded_by_id, uploaded_by_name, uploaded_at, status`
	if withFile {
		cols += ", file"
	}
	var m medicalRecord
	var at time.Time
	var data string
	dest := []any{&m.ID, &m.PatientID, &m.RecordName, &m.RecordDate, &m.RecordType, &m.Provider,
		&m.Facility, &m.Description, &m.FileName, &m.FileType, &m.FileSize, &m.SHA256,
		&m.UploadedByID, &m.UploadedByName, &at, &m.Status}
	if withFile {
		dest = append(dest, &data)
	}
	if err := s.db.QueryRow(r.Context(),
		`SELECT `+cols+` FROM medical_records WHERE id = $1 AND patient_id = $2 AND status = 'active'`,
		recID, patientID).Scan(dest...); err != nil {
		return medicalRecord{}, "", false
	}
	m.UploadedAt = at.UTC().Format(time.RFC3339)
	return m, data, true
}

// GET /api/patients/{id}/records/{recordId}
func (s *Server) handleMedRecGet(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	m, data, ok := s.loadRecord(r, true)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such medical record for this patient")
		return
	}
	s.auditClinical(r.Context(), u, m.PatientID, "Medical record viewed", "medicalRecordFile", m.ID, "", m.RecordName)
	writeJSON(w, http.StatusOK, map[string]any{"record": m, "dataUrl": data})
}

// GET /api/patients/{id}/records/{recordId}/download
func (s *Server) handleMedRecDownload(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	m, data, ok := s.loadRecord(r, true)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such medical record for this patient")
		return
	}
	idx := strings.Index(data, ",")
	if idx < 0 {
		writeErr(w, http.StatusInternalServerError, "the stored file could not be decoded")
		return
	}
	raw, err := base64.StdEncoding.DecodeString(data[idx+1:])
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "the stored file could not be decoded")
		return
	}

	s.auditClinical(r.Context(), u, m.PatientID, "Medical record downloaded", "medicalRecordFile", m.ID, "", m.RecordName)

	w.Header().Set("Content-Type", m.FileType)
	w.Header().Set("Content-Disposition", `attachment; filename="`+m.FileName+`"`)
	w.Header().Set("Content-Length", fmt.Sprint(len(raw)))
	// A patient's medical record must never sit in a shared cache.
	w.Header().Set("Cache-Control", "no-store, private")
	_, _ = w.Write(raw)
}

// DELETE /api/patients/{id}/records/{recordId}
//
// Soft delete. The row stays so the chart's history remains answerable; only status changes.
func (s *Server) handleMedRecDelete(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	m, _, ok := s.loadRecord(r, false)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such medical record for this patient")
		return
	}
	if _, err := s.db.Exec(r.Context(),
		`UPDATE medical_records SET status='deleted', deleted_by=$2, deleted_at=now() WHERE id=$1`,
		m.ID, u.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not remove the medical record")
		return
	}
	s.auditClinical(r.Context(), u, m.PatientID, "Medical record removed", "medicalRecordFile", m.ID, m.RecordName, "")
	writeJSON(w, http.StatusOK, map[string]any{"removed": m.ID})
}

// ---------- email ----------

type smtpConfig struct {
	Host, Port, User, Pass, From string
}

// loadSMTP reads the mail settings. Absent configuration disables emailing entirely.
//
// Nothing is defaulted and no credential appears in this file. The frontend never sees any of
// it - section 12 requires the send to happen on the backend - and an operator who has not
// deliberately configured mail gets a feature that refuses to run rather than one that silently
// fails or, worse, sends patient information somewhere unintended.
func loadSMTP() (smtpConfig, bool) {
	c := smtpConfig{
		Host: strings.TrimSpace(os.Getenv("SMTP_HOST")),
		Port: env("SMTP_PORT", "587"),
		User: strings.TrimSpace(os.Getenv("SMTP_USER")),
		Pass: os.Getenv("SMTP_PASSWORD"),
		From: strings.TrimSpace(os.Getenv("SMTP_FROM")),
	}
	if c.Host == "" || c.From == "" {
		return smtpConfig{}, false
	}
	return c, true
}

// GET /api/email/status - lets the interface disable the button honestly rather than offering
// a send that will fail.
func (s *Server) handleEmailStatus(w http.ResponseWriter, r *http.Request) {
	_, ok := loadSMTP()
	writeJSON(w, http.StatusOK, map[string]any{"enabled": ok})
}

// POST /api/patients/{id}/records/{recordId}/email
func (s *Server) handleMedRecEmail(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())

	var b struct {
		To      string `json:"to"`
		Subject string `json:"subject"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	b.To = strings.TrimSpace(b.To)
	if !strings.Contains(b.To, "@") || strings.ContainsAny(b.To, "\r\n") {
		// Rejecting CR and LF is not cosmetic: a newline in a header is how an attacker injects
		// extra recipients or headers into the message being sent.
		writeErr(w, http.StatusBadRequest, "a valid recipient address is required")
		return
	}

	cfg, ok := loadSMTP()
	if !ok {
		writeErr(w, http.StatusServiceUnavailable,
			"email is not configured on this server. Set SMTP_HOST, SMTP_FROM and credentials to enable it.")
		return
	}

	m, data, found := s.loadRecord(r, true)
	if !found {
		writeErr(w, http.StatusNotFound, "no such medical record for this patient")
		return
	}

	var patientName string
	_ = s.db.QueryRow(r.Context(), `SELECT name FROM patients WHERE id = $1`, m.PatientID).Scan(&patientName)

	subject := strings.TrimSpace(b.Subject)
	if subject == "" {
		subject = "Patient Medical Record"
	}
	subject = strings.ReplaceAll(strings.ReplaceAll(subject, "\r", " "), "\n", " ")

	idx := strings.Index(data, ",")
	if idx < 0 {
		writeErr(w, http.StatusInternalServerError, "the stored file could not be decoded")
		return
	}
	body := buildRecordEmail(cfg.From, b.To, subject, b.Message, m, patientName, data[idx+1:])

	var auth smtp.Auth
	if cfg.User != "" {
		auth = smtp.PlainAuth("", cfg.User, cfg.Pass, cfg.Host)
	}
	if err := smtp.SendMail(cfg.Host+":"+cfg.Port, auth, cfg.From, []string{b.To}, body); err != nil {
		// The recipient is recorded even on failure - an attempted disclosure is worth knowing
		// about - but the SMTP error is not echoed to the browser, since it can leak internals.
		s.auditClinical(r.Context(), u, m.PatientID, "Medical record email failed", "medicalRecordFile", m.ID, "", b.To)
		writeErr(w, http.StatusBadGateway, "the message could not be sent. Check the mail configuration.")
		return
	}

	s.auditClinical(r.Context(), u, m.PatientID, "Medical record emailed", "medicalRecordFile", m.ID,
		"", fmt.Sprintf("%s to %s", m.RecordName, b.To))
	writeJSON(w, http.StatusOK, map[string]any{"sent": true, "to": b.To})
}

// buildRecordEmail assembles a MIME message with the record attached.
//
// Written by hand rather than with a dependency: this is one multipart message and adding a mail
// library to send it would be a larger change than the feature warrants.
func buildRecordEmail(from, to, subject, message string, m medicalRecord, patientName, b64 string) []byte {
	boundary := "medbill" + newUID()
	var sb strings.Builder

	sb.WriteString("From: " + from + "\r\n")
	sb.WriteString("To: " + to + "\r\n")
	sb.WriteString("Subject: " + subject + "\r\n")
	sb.WriteString("MIME-Version: 1.0\r\n")
	sb.WriteString("Content-Type: multipart/mixed; boundary=\"" + boundary + "\"\r\n\r\n")

	sb.WriteString("--" + boundary + "\r\n")
	sb.WriteString("Content-Type: text/plain; charset=utf-8\r\n\r\n")
	if strings.TrimSpace(message) != "" {
		sb.WriteString(message + "\r\n\r\n")
	}
	sb.WriteString("Patient:     " + patientName + " (MRN " + m.PatientID + ")\r\n")
	sb.WriteString("Record:      " + m.RecordName + "\r\n")
	sb.WriteString("Record date: " + m.RecordDate + "\r\n")
	if m.RecordType != "" {
		sb.WriteString("Type:        " + m.RecordType + "\r\n")
	}
	if m.Provider != "" {
		sb.WriteString("Provider:    " + m.Provider + "\r\n")
	}
	sb.WriteString("\r\nThis message contains confidential patient information.\r\n")
	sb.WriteString("If you received it in error, delete it and notify the sender.\r\n\r\n")

	sb.WriteString("--" + boundary + "\r\n")
	sb.WriteString("Content-Type: " + m.FileType + "\r\n")
	sb.WriteString("Content-Transfer-Encoding: base64\r\n")
	sb.WriteString("Content-Disposition: attachment; filename=\"" + m.FileName + "\"\r\n\r\n")

	// Wrapped at 76 characters, which base64 in a MIME body requires.
	for i := 0; i < len(b64); i += 76 {
		end := i + 76
		if end > len(b64) {
			end = len(b64)
		}
		sb.WriteString(b64[i:end] + "\r\n")
	}
	sb.WriteString("\r\n--" + boundary + "--\r\n")
	return []byte(sb.String())
}
