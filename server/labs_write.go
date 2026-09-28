package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/ledongthuc/pdf"
)

// Upload a lab report PDF and turn it into a filed lab order plus results.
//
// Two steps to keep the AI call reviewable. The frontend uploads a PDF and receives structured
// rows that the model extracted from it. The user reviews and edits, and only then sends them
// back to be saved. Nothing goes into lab_orders / lab_results without human confirmation, which
// is what section 13's "no clinical value is derived by this application" requires.
//
// Reference ranges and abnormal flags are stored EXACTLY as the model reported them from the PDF.
// The model is prompted to leave a flag empty when the source did not print one, and never to
// derive one from a value.

//go:embed migrations/019_lab_upload.sql
var labUploadSchemaSQL string

func (s *Server) ensureLabUploadSchema(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, labUploadSchemaSQL); err != nil {
		return fmt.Errorf("lab upload schema: %w", err)
	}
	return nil
}

const maxLabPdfBytes = 20 << 20 // 20 MB
const maxLabPdfChars = 200000    // upper bound on the text sent to the model

// ---------- extraction ----------

type labOrderExtract struct {
	PanelName        string `json:"panelName"`
	Category         string `json:"category"`
	OrderingProvider string `json:"orderingProvider"`
	LabName          string `json:"labName"`
	Accession        string `json:"accession"`
	OrderedAt        string `json:"orderedAt"`
	CollectedAt      string `json:"collectedAt"`
	ResultedAt       string `json:"resultedAt"`
	Status           string `json:"status"`
	Comments         string `json:"comments"`
}

type labResultExtract struct {
	TestName      string   `json:"testName"`
	ValueText     string   `json:"valueText"`
	ValueNum      *float64 `json:"valueNum,omitempty"`
	Unit          string   `json:"unit"`
	ReferenceLow  *float64 `json:"referenceLow,omitempty"`
	ReferenceHigh *float64 `json:"referenceHigh,omitempty"`
	ReferenceText string   `json:"referenceText"`
	Flag          string   `json:"flag"`
}

type labExtraction struct {
	Order   labOrderExtract    `json:"order"`
	Results []labResultExtract `json:"results"`
}

// POST /api/doctor/patients/{id}/labs/extract
//
// Accepts a PDF, extracts text, sends the text to the LLM, returns the structured extraction
// PLUS the PDF back to the client (base64) so save can persist it without a second upload.
func (s *Server) handleLabExtract(w http.ResponseWriter, r *http.Request) {
	patientID := r.PathValue("id")
	if !s.patientExists(r.Context(), patientID) {
		writeErr(w, http.StatusNotFound, "no such patient")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxLabPdfBytes+(2<<20))
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "the upload was too large or malformed (limit 20 MB)")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "a PDF file is required")
		return
	}
	defer file.Close() //nolint:errcheck
	raw, err := io.ReadAll(io.LimitReader(file, maxLabPdfBytes+1))
	if err != nil || len(raw) == 0 {
		writeErr(w, http.StatusBadRequest, "the file is empty or could not be read")
		return
	}
	if int64(len(raw)) > maxLabPdfBytes {
		writeErr(w, http.StatusBadRequest, "the file is larger than 20 MB")
		return
	}
	if !bytes.HasPrefix(raw, []byte("%PDF")) {
		writeErr(w, http.StatusBadRequest, "only PDF files are accepted")
		return
	}

	apiKey := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
	if apiKey == "" {
		writeErr(w, http.StatusServiceUnavailable,
			"ANTHROPIC_API_KEY is not configured on the server, so PDF extraction is disabled")
		return
	}

	text, err := extractPdfText(raw)
	if err != nil || strings.TrimSpace(text) == "" {
		writeErr(w, http.StatusUnprocessableEntity,
			"could not read text from this PDF. It may be a scan without OCR - re-scan with OCR or enter the values by hand.")
		return
	}
	if len(text) > maxLabPdfChars {
		text = text[:maxLabPdfChars]
	}

	extraction, err := callAnthropicLabExtract(r.Context(), text, apiKey)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "the language model could not extract this report: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"order":     extraction.Order,
		"results":   extraction.Results,
		"pdfBase64": base64.StdEncoding.EncodeToString(raw),
		"pdfName":   safeBackupName(strings.TrimSpace(header.Filename)),
	})
}

// extractPdfText pulls the plain text out of a PDF, page by page. Digital PDFs (a lab that emails
// a report as a PDF) come through cleanly. A scanned image without OCR has no text layer and
// returns empty - which the caller reports honestly rather than pretending to have extracted.
func extractPdfText(raw []byte) (string, error) {
	rd, err := pdf.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return "", err
	}
	var buf strings.Builder
	pages := rd.NumPage()
	for i := 1; i <= pages; i++ {
		p := rd.Page(i)
		if p.V.IsNull() {
			continue
		}
		txt, err := p.GetPlainText(nil)
		if err != nil {
			continue
		}
		buf.WriteString(txt)
		buf.WriteString("\n")
	}
	return buf.String(), nil
}

// ---------- Anthropic call ----------

const labExtractSystemPrompt = `You extract laboratory report data from raw PDF text and return a strict JSON object.

Schema, exactly:
{
  "order": {
    "panelName": string,
    "category": string,
    "orderingProvider": string,
    "labName": string,
    "accession": string,
    "orderedAt": "YYYY-MM-DD" or "",
    "collectedAt": "YYYY-MM-DD" or "",
    "resultedAt": "YYYY-MM-DD" or "",
    "status": "final" | "preliminary" | "corrected" | "cancelled" | "",
    "comments": string
  },
  "results": [
    {
      "testName": string,
      "valueText": string,
      "valueNum": number | null,
      "unit": string,
      "referenceLow": number | null,
      "referenceHigh": number | null,
      "referenceText": string,
      "flag": "H" | "L" | "A" | "AA" | "CRIT" | ""
    }
  ]
}

Rules, strict:
1. Extract only what the text explicitly says. If a value is not present, use "" or null. Never invent a number, a range, a date or a flag.
2. flag is empty unless the source printed an abnormal-flag marker (usually H, L, A, AA, or a red/asterisked value with a marker). Do NOT compute a flag from the value vs the range. That is the source's job.
3. valueNum is populated ONLY when valueText is a plain number. "NEGATIVE", "POSITIVE", "<0.01", ">150", "TNP", ratios like "1:80" and anything else non-numeric leave valueNum as null.
4. When the source range is text ("Negative", "See comment"), put it in referenceText and leave referenceLow / referenceHigh null.
5. Return ONLY the JSON object. No commentary, no code fences.`

type anthropicMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type anthropicRequest struct {
	Model     string             `json:"model"`
	MaxTokens int                `json:"max_tokens"`
	System    string             `json:"system"`
	Messages  []anthropicMessage `json:"messages"`
}

type anthropicResponse struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

func callAnthropicLabExtract(ctx context.Context, text, apiKey string) (labExtraction, error) {
	// The model is deliberately configurable, so a deployment can point at a smaller or larger
	// Claude without a rebuild. Haiku 4.5 is the default: it handles structured extraction from
	// straight text well and is cheap per call.
	model := strings.TrimSpace(os.Getenv("ANTHROPIC_MODEL"))
	if model == "" {
		model = "claude-haiku-4-5-20251001"
	}

	req := anthropicRequest{
		Model:     model,
		MaxTokens: 4000,
		System:    labExtractSystemPrompt,
		Messages: []anthropicMessage{
			{Role: "user", Content: "Lab report text follows.\n\n" + text},
		},
	}
	body, err := json.Marshal(req)
	if err != nil {
		return labExtraction{}, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, "POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(body))
	if err != nil {
		return labExtraction{}, err
	}
	httpReq.Header.Set("x-api-key", apiKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")
	httpReq.Header.Set("content-type", "application/json")

	client := &http.Client{Timeout: 90 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return labExtraction{}, fmt.Errorf("could not reach api.anthropic.com: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))

	var ar anthropicResponse
	if jerr := json.Unmarshal(respBody, &ar); jerr != nil {
		return labExtraction{}, fmt.Errorf("HTTP %d: %s", resp.StatusCode, clip(string(respBody), 300))
	}
	if ar.Error != nil {
		return labExtraction{}, fmt.Errorf("%s: %s", ar.Error.Type, ar.Error.Message)
	}
	if resp.StatusCode != 200 {
		return labExtraction{}, fmt.Errorf("HTTP %d from api.anthropic.com", resp.StatusCode)
	}
	if len(ar.Content) == 0 || strings.TrimSpace(ar.Content[0].Text) == "" {
		return labExtraction{}, fmt.Errorf("the model returned no content")
	}

	txt := ar.Content[0].Text
	// Some models wrap the response in a markdown code fence even when told not to. Strip either
	// form so the JSON survives.
	if idx := strings.Index(txt, "```json"); idx >= 0 {
		txt = txt[idx+len("```json"):]
	} else if idx := strings.Index(txt, "```"); idx >= 0 {
		txt = txt[idx+3:]
	}
	if idx := strings.LastIndex(txt, "```"); idx >= 0 {
		txt = txt[:idx]
	}
	start := strings.Index(txt, "{")
	end := strings.LastIndex(txt, "}")
	if start < 0 || end <= start {
		return labExtraction{}, fmt.Errorf("no JSON object in the response")
	}
	var out labExtraction
	if err := json.Unmarshal([]byte(txt[start:end+1]), &out); err != nil {
		return labExtraction{}, fmt.Errorf("could not parse the extracted JSON: %v", err)
	}
	if out.Results == nil {
		out.Results = []labResultExtract{}
	}
	return out, nil
}

// ---------- save ----------

type labSaveRequest struct {
	Order     labOrderExtract    `json:"order"`
	Results   []labResultExtract `json:"results"`
	PdfBase64 string             `json:"pdfBase64"`
	PdfName   string             `json:"pdfName"`
}

// POST /api/doctor/patients/{id}/labs
func (s *Server) handleLabCreate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	patientID := r.PathValue("id")
	if !s.patientExists(r.Context(), patientID) {
		writeErr(w, http.StatusNotFound, "no such patient")
		return
	}

	// Enough headroom for the base64 PDF plus the extracted rows.
	r.Body = http.MaxBytesReader(w, r.Body, 32<<20)

	var body labSaveRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	if strings.TrimSpace(body.Order.PanelName) == "" && len(body.Results) == 0 {
		writeErr(w, http.StatusBadRequest, "the report needs a panel name or at least one result row")
		return
	}

	// If a PDF was carried over from the extract step, keep it. A base64 payload larger than the
	// upload limit is refused outright - somebody sending a bigger one would be trying to skip the
	// extract path.
	pdfDataURL := ""
	pdfName := ""
	if body.PdfBase64 != "" {
		if !isProbablyBase64PDF(body.PdfBase64) {
			writeErr(w, http.StatusBadRequest, "the attached PDF is malformed")
			return
		}
		if len(body.PdfBase64) > (maxLabPdfBytes*4/3)+64 {
			writeErr(w, http.StatusBadRequest, "the attached PDF is larger than 20 MB")
			return
		}
		pdfDataURL = "data:application/pdf;base64," + body.PdfBase64
		pdfName = safeBackupName(strings.TrimSpace(body.PdfName))
		if pdfName == "" {
			pdfName = "lab-report.pdf"
		} else if !strings.HasSuffix(strings.ToLower(pdfName), ".pdf") {
			pdfName += ".pdf"
		}
	}

	orderedAt := parseDateOrEmpty(body.Order.OrderedAt)
	collectedAt := parseDateOrEmpty(body.Order.CollectedAt)
	resultedAt := parseDateOrEmpty(body.Order.ResultedAt)

	orderID := "LAB" + newUID()

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the lab report")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck

	if _, err := tx.Exec(r.Context(), `
		INSERT INTO lab_orders
		  (id, patient_id, panel_name, category, ordering_provider, lab_name, accession,
		   ordered_at, collected_at, resulted_at, status, comments, created_by,
		   report_pdf, report_pdf_name)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
		orderID, patientID,
		strings.TrimSpace(body.Order.PanelName),
		strings.TrimSpace(body.Order.Category),
		strings.TrimSpace(body.Order.OrderingProvider),
		strings.TrimSpace(body.Order.LabName),
		strings.TrimSpace(body.Order.Accession),
		orderedAt, collectedAt, resultedAt,
		strings.TrimSpace(body.Order.Status),
		strings.TrimSpace(body.Order.Comments),
		u.Name,
		pdfDataURL, pdfName,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the lab order: "+err.Error())
		return
	}

	// Observed time falls back to resulted -> collected -> now, so the results still trend even
	// when the report did not print a per-analyte timestamp.
	observed := firstNonEmpty(resultedAt, collectedAt)

	for i, res := range body.Results {
		if strings.TrimSpace(res.TestName) == "" {
			continue
		}
		rid := fmt.Sprintf("LR%s-%d", newUID()[:8], i)
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO lab_results
			  (id, order_id, patient_id, test_name, value_text, value_num, unit,
			   reference_low, reference_high, reference_text, flag, status, observed_at, sequence)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
			rid, orderID, patientID,
			strings.TrimSpace(res.TestName),
			strings.TrimSpace(res.ValueText),
			res.ValueNum,
			strings.TrimSpace(res.Unit),
			res.ReferenceLow,
			res.ReferenceHigh,
			strings.TrimSpace(res.ReferenceText),
			strings.TrimSpace(strings.ToUpper(res.Flag)),
			strings.TrimSpace(body.Order.Status),
			observed,
			i,
		); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not save a lab result: "+err.Error())
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the lab report")
		return
	}

	s.auditClinical(r.Context(), u, patientID, "Lab report uploaded", "labOrder", orderID, "",
		body.Order.PanelName)

	writeJSON(w, http.StatusOK, map[string]any{"id": orderID})
}

// ---------- small helpers ----------

// parseDateOrEmpty returns a timestamp string ("2026-09-27T00:00:00Z") for a YYYY-MM-DD, or an
// empty string for anything else (including empty). The caller inserts it as a nullable
// timestamptz using NULLIF at the SQL level.
func parseDateOrEmpty(s string) any {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return nil
	}
	return t.UTC()
}

func firstNonEmpty(vs ...any) any {
	for _, v := range vs {
		if v != nil {
			return v
		}
	}
	return nil
}

func isProbablyBase64PDF(s string) bool {
	if len(s) < 40 {
		return false
	}
	// A PDF starts with "%PDF-", which base64-encodes to "JVBERi0..." for standard alphabet.
	return strings.HasPrefix(s, "JVBER")
}
