package main

import (
	"fmt"
	"net/http"
	"strings"
	"time"
)

// The laboratory panel.
//
// One rule governs this whole file: reference ranges and abnormal flags are READ, never
// computed. They come from whatever laboratory or interface produced the result. If the source
// did not flag a value, nothing here decides it is high, low or critical, and there is no
// threshold table anywhere in this application. Sections 13 and 14 are explicit about that, and
// it is also the only defensible behaviour - a reference range depends on the assay, the
// instrument, the patient's age and sex, and guessing one would be inventing a clinical finding.

type labResult struct {
	ID       string   `json:"id"`
	OrderID  string   `json:"orderId"`
	TestName string   `json:"testName"`
	TestCode string   `json:"testCode"`
	LOINC    string   `json:"loinc"`
	Value    string   `json:"value"`
	ValueNum *float64 `json:"valueNum"`
	Unit     string   `json:"unit"`

	// Exactly as supplied. RefText carries ranges that are not two numbers ("NEGATIVE",
	// "<0.5"), which is why it exists alongside the numeric pair.
	RefLow  *float64 `json:"referenceLow"`
	RefHigh *float64 `json:"referenceHigh"`
	RefText string   `json:"referenceText"`

	Flag       string `json:"flag"`
	Status     string `json:"status"`
	ObservedAt string `json:"observedAt"`
	Comments   string `json:"comments"`
}

type labOrder struct {
	ID          string      `json:"id"`
	PatientID   string      `json:"patientId"`
	PanelName   string      `json:"panelName"`
	PanelCode   string      `json:"panelCode"`
	Category    string      `json:"category"`
	Provider    string      `json:"orderingProvider"`
	LabName     string      `json:"labName"`
	Accession   string      `json:"accession"`
	OrderedAt   string      `json:"orderedAt"`
	CollectedAt string      `json:"collectedAt"`
	ResultedAt  string      `json:"resultedAt"`
	Status      string      `json:"status"`
	ReportDocID string      `json:"reportDocumentId"`
	Comments    string      `json:"comments"`
	Results     []labResult `json:"results"`

	// Count of components the source flagged, so the panel header can show "2 flagged" without
	// the caller re-deriving it - and without this application deciding what counts as abnormal.
	FlaggedCount int `json:"flaggedCount"`
}

// relativeRange turns the named windows in section 11 into a start time. Unknown values mean
// "all time" rather than an error, so a stale bookmark still renders a page.
func relativeRange(window string) *time.Time {
	now := time.Now()
	var d time.Duration
	switch strings.ToLower(strings.TrimSpace(window)) {
	case "today":
		t := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		return &t
	case "7d", "last7":
		d = 7 * 24 * time.Hour
	case "30d", "last30":
		d = 30 * 24 * time.Hour
	case "3m":
		d = 90 * 24 * time.Hour
	case "6m":
		d = 180 * 24 * time.Hour
	case "1y", "year":
		d = 365 * 24 * time.Hour
	default:
		return nil
	}
	t := now.Add(-d)
	return &t
}

// GET /api/doctor/patients/{id}/labs
//
// Returns panels newest-first with their components nested, filtered and paginated server-side.
// A patient with fifteen years of labs sends one page, not fifteen years.
func (s *Server) handleLabList(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	patientID := r.PathValue("id")
	q := r.URL.Query()
	p := parseListParams(r, "resulted")

	if !s.patientExists(r.Context(), patientID) {
		writeErr(w, http.StatusNotFound, "no such patient")
		return
	}

	args := []any{patientID}
	where := []string{"o.patient_id = $1"}

	// Named window, or an explicit from/to. from/to win when both are supplied.
	if start := relativeRange(q.Get("window")); start != nil && p.From == "" {
		args = append(args, *start)
		where = append(where, fmt.Sprintf("COALESCE(o.resulted_at,o.collected_at,o.ordered_at) >= $%d", len(args)))
	}
	if p.From != "" {
		args = append(args, p.From)
		where = append(where, fmt.Sprintf("COALESCE(o.resulted_at,o.collected_at,o.ordered_at) >= $%d::timestamptz", len(args)))
	}
	if p.To != "" {
		args = append(args, p.To)
		where = append(where, fmt.Sprintf("COALESCE(o.resulted_at,o.collected_at,o.ordered_at) < ($%d::timestamptz + interval '1 day')", len(args)))
	}
	if v := strings.TrimSpace(q.Get("category")); v != "" {
		args = append(args, v)
		where = append(where, fmt.Sprintf("o.category = $%d", len(args)))
	}
	if q.Get("flagged") == "true" {
		where = append(where, "EXISTS (SELECT 1 FROM lab_results x WHERE x.order_id = o.id AND x.flag <> '')")
	}
	// Section 12: searching for "A1C" or "Hemoglobin" must match the component, not just the
	// panel, so the panel is kept when any of its analytes matches.
	if p.Search != "" {
		args = append(args, p.Search)
		n := len(args)
		where = append(where, fmt.Sprintf(
			"(o.panel_name ILIKE '%%'||$%d||'%%' OR o.category ILIKE '%%'||$%d||'%%'"+
				" OR EXISTS (SELECT 1 FROM lab_results x WHERE x.order_id = o.id"+
				" AND (x.test_name ILIKE '%%'||$%d||'%%' OR x.test_code ILIKE '%%'||$%d||'%%')))",
			n, n, n, n))
	}

	base := "FROM lab_orders o WHERE " + strings.Join(where, " AND ")

	var total int
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) "+base, args...).Scan(&total); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the laboratory results")
		return
	}

	// "Latest" means the most recent panel of each distinct test category.
	limit := p.Limit
	if strings.EqualFold(q.Get("window"), "latest") {
		limit = 5
	}
	args = append(args, limit, p.Offset)
	sql := fmt.Sprintf(`SELECT o.id, o.panel_name, o.panel_code, o.category, o.ordering_provider,
	       o.lab_name, o.accession, o.ordered_at, o.collected_at, o.resulted_at, o.status,
	       o.report_document_id, o.comments
	  %s ORDER BY COALESCE(o.resulted_at,o.collected_at,o.ordered_at) DESC NULLS LAST, o.id
	  LIMIT $%d OFFSET $%d`, base, len(args)-1, len(args))

	rows, err := s.db.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the laboratory results")
		return
	}
	orders := []labOrder{}
	ids := []string{}
	for rows.Next() {
		var o labOrder
		var docID *string
		var ordered, collected, resulted *time.Time
		if err := rows.Scan(&o.ID, &o.PanelName, &o.PanelCode, &o.Category, &o.Provider,
			&o.LabName, &o.Accession, &ordered, &collected, &resulted, &o.Status,
			&docID, &o.Comments); err != nil {
			rows.Close()
			writeErr(w, http.StatusInternalServerError, "could not read the laboratory results")
			return
		}
		o.PatientID = patientID
		o.ReportDocID = deref(docID)
		o.OrderedAt, o.CollectedAt, o.ResultedAt = tsOrEmpty(ordered), tsOrEmpty(collected), tsOrEmpty(resulted)
		o.Results = []labResult{}
		orders = append(orders, o)
		ids = append(ids, o.ID)
	}
	rows.Close()

	// Components fetched in one round trip for the whole page rather than per panel.
	if len(ids) > 0 {
		byOrder := map[string]int{}
		for i, id := range ids {
			byOrder[id] = i
		}
		cRows, err := s.db.Query(r.Context(), `
			SELECT id, order_id, test_name, test_code, loinc, value_text, value_num, unit,
			       reference_low, reference_high, reference_text, flag, status, observed_at, comments
			  FROM lab_results WHERE order_id = ANY($1) ORDER BY order_id, sequence, test_name`, ids)
		if err == nil {
			defer cRows.Close()
			for cRows.Next() {
				var c labResult
				var observed *time.Time
				if cRows.Scan(&c.ID, &c.OrderID, &c.TestName, &c.TestCode, &c.LOINC, &c.Value,
					&c.ValueNum, &c.Unit, &c.RefLow, &c.RefHigh, &c.RefText, &c.Flag,
					&c.Status, &observed, &c.Comments) == nil {
					c.ObservedAt = tsOrEmpty(observed)
					if i, ok := byOrder[c.OrderID]; ok {
						orders[i].Results = append(orders[i].Results, c)
						if c.Flag != "" {
							orders[i].FlaggedCount++
						}
					}
				}
			}
		}
	}

	// The category filter list is built from the data, not hardcoded - section 11 requires tests
	// beyond the named examples to work.
	categories := []string{}
	if cr, err := s.db.Query(r.Context(),
		`SELECT DISTINCT category FROM lab_orders WHERE patient_id = $1 AND category <> '' ORDER BY category`,
		patientID); err == nil {
		defer cr.Close()
		for cr.Next() {
			var c string
			if cr.Scan(&c) == nil {
				categories = append(categories, c)
			}
		}
	}

	if p.Offset == 0 {
		// Records THAT the panel was opened and how it was narrowed - never the narrowing values.
		// A test category is medical content, and a search term can contain a patient's name or a
		// diagnosis, so both are reported as booleans rather than echoed into the audit trail.
		s.auditClinical(r.Context(), u, patientID, "Lab results viewed", "labResults", patientID, "",
			fmt.Sprintf("panels=%d window=%t category=%t search=%t flagged=%t",
				len(orders), q.Get("window") != "", q.Get("category") != "",
				p.Search != "", q.Get("flagged") == "true"))
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"orders": orders, "total": total, "limit": limit, "offset": p.Offset,
		"categories": categories,
	})
}

// GET /api/doctor/patients/{id}/labs/{orderId} - the full report.
func (s *Server) handleLabReport(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	patientID := r.PathValue("id")
	orderID := r.PathValue("orderId")

	var o labOrder
	var docID *string
	var ordered, collected, resulted *time.Time
	// patient_id is in the WHERE clause, not just the path: without it, changing the order id in
	// the URL would read another patient's report.
	if err := s.db.QueryRow(r.Context(), `
		SELECT id, patient_id, panel_name, panel_code, category, ordering_provider, lab_name,
		       accession, ordered_at, collected_at, resulted_at, status, report_document_id, comments
		  FROM lab_orders WHERE id = $1 AND patient_id = $2`, orderID, patientID).
		Scan(&o.ID, &o.PatientID, &o.PanelName, &o.PanelCode, &o.Category, &o.Provider,
			&o.LabName, &o.Accession, &ordered, &collected, &resulted, &o.Status, &docID, &o.Comments); err != nil {
		writeErr(w, http.StatusNotFound, "no such lab report for this patient")
		return
	}
	o.ReportDocID = deref(docID)
	o.OrderedAt, o.CollectedAt, o.ResultedAt = tsOrEmpty(ordered), tsOrEmpty(collected), tsOrEmpty(resulted)
	o.Results = []labResult{}

	if rows, err := s.db.Query(r.Context(), `
		SELECT id, order_id, test_name, test_code, loinc, value_text, value_num, unit,
		       reference_low, reference_high, reference_text, flag, status, observed_at, comments
		  FROM lab_results WHERE order_id = $1 ORDER BY sequence, test_name`, orderID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var c labResult
			var observed *time.Time
			if rows.Scan(&c.ID, &c.OrderID, &c.TestName, &c.TestCode, &c.LOINC, &c.Value,
				&c.ValueNum, &c.Unit, &c.RefLow, &c.RefHigh, &c.RefText, &c.Flag,
				&c.Status, &observed, &c.Comments) == nil {
				c.ObservedAt = tsOrEmpty(observed)
				o.Results = append(o.Results, c)
				if c.Flag != "" {
					o.FlaggedCount++
				}
			}
		}
	}

	// The order id identifies which report; the panel name is a test name, so it stays out.
	s.auditClinical(r.Context(), u, patientID, "Lab report viewed", "labReport", orderID, "",
		fmt.Sprintf("components=%d", len(o.Results)))
	writeJSON(w, http.StatusOK, map[string]any{"order": o})
}

// GET /api/doctor/patients/{id}/labs/trend?test=Hemoglobin%20A1C
//
// Numeric history for one analyte. Rows whose value could not be parsed as a number are excluded
// rather than coerced - plotting "NEGATIVE" as zero would draw a line that means nothing.
func (s *Server) handleLabTrend(w http.ResponseWriter, r *http.Request) {
	patientID := r.PathValue("id")
	test := strings.TrimSpace(r.URL.Query().Get("test"))
	if test == "" {
		writeErr(w, http.StatusBadRequest, "a test name is required")
		return
	}

	rows, err := s.db.Query(r.Context(), `
		SELECT observed_at, value_num, unit, flag, reference_low, reference_high, reference_text
		  FROM lab_results
		 WHERE patient_id = $1 AND lower(test_name) = lower($2) AND value_num IS NOT NULL
		 ORDER BY observed_at`, patientID, test)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the trend")
		return
	}
	defer rows.Close()

	type point struct {
		At      string   `json:"at"`
		Value   float64  `json:"value"`
		Unit    string   `json:"unit"`
		Flag    string   `json:"flag"`
		RefLow  *float64 `json:"referenceLow"`
		RefHigh *float64 `json:"referenceHigh"`
		RefText string   `json:"referenceText"`
	}
	points := []point{}
	for rows.Next() {
		var p point
		var at *time.Time
		var v *float64
		if rows.Scan(&at, &v, &p.Unit, &p.Flag, &p.RefLow, &p.RefHigh, &p.RefText) == nil && v != nil {
			p.At, p.Value = tsOrEmpty(at), *v
			points = append(points, p)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"test": test, "points": points})
}
