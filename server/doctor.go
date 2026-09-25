package main

import (
	"context"
	_ "embed"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Doctor Clinical Workspace.
//
// One page over records that already exist. Nothing here stores a second copy of a diagnosis, a
// medication or a note - the timeline is a UNION over the tables the chart already keeps, built
// in SQL and paginated, so opening a patient with twenty years of history transfers one page of
// rows rather than the whole record.
//
// The permission model is not cosmetic. A doctor without DOCTOR_LAB_VIEW does not merely lose
// the lab panel: lab entries are excluded from the timeline query itself, so the data never
// reaches the browser to be un-hidden.

//go:embed migrations/010_doctor_and_labs.sql
var doctorSchemaSQL string

func (s *Server) ensureDoctorSchema(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, doctorSchemaSQL); err != nil {
		return fmt.Errorf("doctor schema: %w", err)
	}
	return nil
}

// Record kinds the timeline can carry, each mapped to the permission that reveals it.
//
// A kind with no entry here is not selectable at all, which is what stops a crafted ?types=
// parameter from reaching a table the workspace was never meant to expose.
var timelineKindPermission = map[string]string{
	"encounter":     PermDoctorRecordView,
	"note":          PermDoctorRecordView,
	"diagnosis":     PermDoctorRecordView,
	"procedure":     PermDoctorRecordView,
	"allergy":       PermDoctorRecordView,
	"vital":         PermDoctorRecordView,
	"medication":    PermDoctorMedicationView,
	"lab":           PermDoctorLabView,
	"document":      PermDoctorDocumentView,
	"antimicrobial": PermDoctorAntimicrobialView,

	// Uploaded medical records. Gated on its own grant, so an account that may read the chart
	// does not automatically get the uploaded documents.
	"medicalrecord": PermMedRecView,
}

// allowedKinds intersects what the caller asked for with what their grants permit.
func (s *Server) allowedKinds(ctx context.Context, u authedUser, requested []string) []string {
	held := s.effectiveUserPerms(ctx, u.UID, u.Role)
	want := map[string]bool{}
	for _, k := range requested {
		if k = strings.TrimSpace(k); k != "" {
			want[k] = true
		}
	}
	// Sorted, not map order. Go randomises map iteration, which made the UNION's leading branch
	// vary between requests - and the leading branch is the one whose aliases name the result
	// columns. It also kept pagination from being stable across pages.
	out := []string{}
	for _, kind := range timelineKindOrder {
		if !held.has(timelineKindPermission[kind]) {
			continue
		}
		if len(want) == 0 || want[kind] {
			out = append(out, kind)
		}
	}
	return out
}

// Stable order for the union branches.
var timelineKindOrder = []string{
	"encounter", "note", "diagnosis", "procedure", "medication",
	"allergy", "vital", "lab", "document", "antimicrobial", "medicalrecord",
}

// A date column in this application is TEXT. Legacy rows can hold anything, so every conversion
// is guarded by a shape check: a malformed value becomes NULL and sorts last, instead of raising
// an error that would fail the entire timeline query.
const tsOf = `CASE WHEN %s ~ '^\d{4}-\d{2}-\d{2}' THEN (substring(%s from 1 for 10))::timestamptz ELSE NULL END`

func dateExpr(col string) string { return fmt.Sprintf(tsOf, col, col) }

// timelineSQL builds the UNION for the requested kinds only. Branches for kinds the caller may
// not see are never added, so the planner never touches those tables.
func timelineSQL(kinds []string) string {
	branch := map[string]string{
		"encounter": `SELECT 'encounter' kind, ` + dateExpr("dos") + ` at, id ref,
		       COALESCE(NULLIF(cpt,''),'Encounter') title, provider subtitle,
		       COALESCE(NULLIF(facility_name,''),'') detail, '' status,
		       concat_ws(' ', cpt, provider, facility_name) search
		  FROM charges WHERE patient_id = $1`,

		"note": `SELECT 'note' kind, ` + dateExpr("date") + `, id,
		       COALESCE(NULLIF(type,''),'Clinical note'), provider,
		       concat_ws(' | ', NULLIF(assessment,''), NULLIF(plan,'')), status,
		       concat_ws(' ', type, provider, subjective, objective, assessment, plan)
		  FROM clinical_notes WHERE patient_id = $1`,

		"diagnosis": `SELECT 'diagnosis' kind, ` + dateExpr("onset_date") + `, id,
		       diagnosis, COALESCE(NULLIF(icd10,''),''), '', status,
		       concat_ws(' ', diagnosis, icd10, status)
		  FROM problems WHERE patient_id = $1`,

		"procedure": `SELECT 'procedure' kind, ` + dateExpr("dos") + `, id,
		       cpt, provider, '', '', concat_ws(' ', cpt, provider)
		  FROM charges WHERE patient_id = $1 AND cpt <> ''`,

		"medication": `SELECT 'medication' kind, ` + dateExpr("start_date") + `, id,
		       name, concat_ws(' ', dose, route, frequency), prescriber, status,
		       concat_ws(' ', name, dose, route, frequency, prescriber, instructions)
		  FROM medications WHERE patient_id = $1`,

		"allergy": `SELECT 'allergy' kind, ` + dateExpr("recorded_date") + `, id,
		       substance, reaction, severity, status,
		       concat_ws(' ', substance, reaction, severity)
		  FROM allergies WHERE patient_id = $1`,

		"vital": `SELECT 'vital' kind, ` + dateExpr("date") + `, id,
		       'Vitals', '', concat_ws(' ', NULLIF(bp,''), NULLIF(pulse,''), NULLIF(temp,'')), '',
		       concat_ws(' ', bp, pulse, temp)
		  FROM vitals WHERE patient_id = $1`,

		"lab": `SELECT 'lab' kind, COALESCE(resulted_at, collected_at, ordered_at), id,
		       COALESCE(NULLIF(panel_name,''),'Laboratory'), ordering_provider,
		       COALESCE(NULLIF(category,''),''), status,
		       concat_ws(' ', panel_name, category, ordering_provider, lab_name, accession)
		  FROM lab_orders WHERE patient_id = $1`,

		"document": `SELECT 'document' kind, ` + dateExpr("uploaded_at") + `, id,
		       COALESCE(NULLIF(id_type,''),'Document'), COALESCE(NULLIF(uploaded_by,''),''),
		       COALESCE(NULLIF(file_name,''),''), COALESCE(NULLIF(status,''),''),
		       concat_ws(' ', id_type, file_name, uploaded_by)
		  FROM id_documents WHERE patient_id = $1`,

		// Positioned by RECORD DATE, not upload date - section 14. A discharge summary from last
		// May belongs in last May's place in the chart however recently it was scanned in.
		"medicalrecord": `SELECT 'medicalrecord' kind, ` + dateExpr("record_date") + `, id,
		       record_name, COALESCE(NULLIF(provider,''),''),
		       concat_ws(' · ', NULLIF(record_type,''), NULLIF(facility,''),
		                 'Uploaded by ' || uploaded_by_name), record_type,
		       concat_ws(' ', record_name, record_type, provider, facility, description, uploaded_by_name)
		  FROM medical_records WHERE patient_id = $1 AND status = 'active'`,

		"antimicrobial": `SELECT 'antimicrobial' kind, created_at, id,
		       antimicrobial, ordering_provider, indication, status,
		       concat_ws(' ', antimicrobial, ordering_provider, indication)
		  FROM antimicrobial_reviews WHERE patient_id = $1`,
	}

	parts := []string{}
	for _, k := range kinds {
		if sql, ok := branch[k]; ok {
			parts = append(parts, sql)
		}
	}
	if len(parts) == 0 {
		// A caller with no qualifying grants gets a query that is valid and returns nothing,
		// rather than a SQL syntax error.
		return `SELECT NULL::text kind, NULL::timestamptz at, NULL::text ref, NULL::text title,
		        NULL::text subtitle, NULL::text detail, NULL::text status, NULL::text search
		        WHERE false`
	}
	// Wrapped in a subquery whose alias list names the columns.
	//
	// In a UNION the FIRST branch names the result columns, and the branches included here depend
	// on the caller's filter and grants - so without this, selecting any subset that did not
	// happen to start with the one aliased branch produced "column t.kind does not exist". Naming
	// them here makes the query correct for every combination, including a single branch.
	return "SELECT * FROM (\n" + strings.Join(parts, "\nUNION ALL\n") +
		"\n) b(kind, at, ref, title, subtitle, detail, status, search)"
}

type timelineEntry struct {
	Kind     string `json:"kind"`
	At       string `json:"at"`
	Ref      string `json:"ref"`
	Title    string `json:"title"`
	Subtitle string `json:"subtitle"`
	Detail   string `json:"detail"`
	Status   string `json:"status"`
}

// GET /api/doctor/patients/{id}/timeline
func (s *Server) handleDoctorTimeline(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	patientID := r.PathValue("id")
	q := r.URL.Query()

	if !s.patientExists(r.Context(), patientID) {
		writeErr(w, http.StatusNotFound, "no such patient")
		return
	}

	kinds := s.allowedKinds(r.Context(), u, strings.Split(q.Get("types"), ","))
	p := parseListParams(r, "at")

	inner := timelineSQL(kinds)
	args := []any{patientID}
	where := []string{"1=1"}

	if p.From != "" {
		args = append(args, p.From)
		where = append(where, fmt.Sprintf("t.at >= $%d::timestamptz", len(args)))
	}
	if p.To != "" {
		args = append(args, p.To)
		// Inclusive of the whole end day, which is what a person picking a date means.
		where = append(where, fmt.Sprintf("t.at < ($%d::timestamptz + interval '1 day')", len(args)))
	}
	if p.Search != "" {
		args = append(args, p.Search)
		where = append(where, fmt.Sprintf("t.search ILIKE '%%'||$%d||'%%'", len(args)))
	}
	if v := strings.TrimSpace(q.Get("provider")); v != "" {
		args = append(args, v)
		where = append(where, fmt.Sprintf("t.subtitle ILIKE '%%'||$%d||'%%'", len(args)))
	}
	if v := strings.TrimSpace(q.Get("status")); v != "" {
		args = append(args, v)
		where = append(where, fmt.Sprintf("t.status = $%d", len(args)))
	}

	dir := "DESC" // newest first by default, per section 5
	if strings.EqualFold(q.Get("order"), "asc") {
		dir = "ASC"
	}

	base := fmt.Sprintf("FROM (%s) t WHERE %s", inner, strings.Join(where, " AND "))

	var total int
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) "+base, args...).Scan(&total); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the medical record")
		return
	}

	args = append(args, p.Limit, p.Offset)
	sql := fmt.Sprintf(`SELECT t.kind, t.at, t.ref, t.title, t.subtitle, t.detail, t.status
		%s ORDER BY t.at %s NULLS LAST, t.ref LIMIT $%d OFFSET $%d`,
		base, dir, len(args)-1, len(args))

	rows, err := s.db.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the medical record")
		return
	}
	defer rows.Close()

	out := []timelineEntry{}
	for rows.Next() {
		var e timelineEntry
		var at *time.Time
		var title, subtitle, detail, status *string
		if err := rows.Scan(&e.Kind, &at, &e.Ref, &title, &subtitle, &detail, &status); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not read the medical record")
			return
		}
		e.At = tsOrEmpty(at)
		e.Title, e.Subtitle = deref(title), deref(subtitle)
		e.Detail, e.Status = deref(detail), deref(status)
		out = append(out, e)
	}

	// Section 26: opening a record is itself an event worth recording. Logged once per page of
	// the timeline, with the filter that produced it and never the clinical content.
	if p.Offset == 0 {
		s.auditClinical(r.Context(), u, patientID, "Medical record accessed", "medicalRecord", patientID,
			"", fmt.Sprintf("types=%s from=%s to=%s search=%t", strings.Join(kinds, "|"), p.From, p.To, p.Search != ""))
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"entries": out, "total": total, "limit": p.Limit, "offset": p.Offset,
		"kinds": kinds,
	})
}

func (s *Server) patientExists(ctx context.Context, id string) bool {
	var ok bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM patients WHERE id = $1)`, id).Scan(&ok); err != nil {
		return false
	}
	return ok
}

// GET /api/doctor/patients/{id}/header
//
// The banner that stays visible: demographics, allergies, active medications and the next
// appointment. Every value is read from its own table; nothing is cached or copied.
func (s *Server) handleDoctorHeader(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	patientID := r.PathValue("id")

	var name, dob, phone, sex string
	if err := s.db.QueryRow(r.Context(),
		`SELECT name, dob, phone, COALESCE(extra->>'sex','') FROM patients WHERE id = $1`, patientID).
		Scan(&name, &dob, &phone, &sex); err != nil {
		writeErr(w, http.StatusNotFound, "no such patient")
		return
	}

	header := map[string]any{
		"patientId": patientID, "mrn": patientID, "name": name, "dob": dob,
		"phone": phone, "sex": sex, "age": ageFromDOB(dob),
	}

	// Allergies are a safety banner, so they are shown to anyone who may open the record at all.
	allergies := []map[string]string{}
	if rows, err := s.db.Query(r.Context(),
		`SELECT substance, reaction, severity, status FROM allergies
		  WHERE patient_id = $1 AND (status = '' OR status ILIKE 'active') ORDER BY substance`,
		patientID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var a, b, c, d string
			if rows.Scan(&a, &b, &c, &d) == nil {
				allergies = append(allergies, map[string]string{
					"substance": a, "reaction": b, "severity": c, "status": d})
			}
		}
	}
	header["allergies"] = allergies

	held := s.effectiveUserPerms(r.Context(), u.UID, u.Role)
	meds := []map[string]string{}
	if held.has(PermDoctorMedicationView) {
		if rows, err := s.db.Query(r.Context(),
			`SELECT name, dose, route, frequency, status FROM medications
			  WHERE patient_id = $1 AND (status = '' OR status ILIKE 'active') ORDER BY name`,
			patientID); err == nil {
			defer rows.Close()
			for rows.Next() {
				var n, d, ro, f, st string
				if rows.Scan(&n, &d, &ro, &f, &st) == nil {
					meds = append(meds, map[string]string{
						"name": n, "dose": d, "route": ro, "frequency": f, "status": st})
				}
			}
		}
	}
	header["medications"] = meds

	// Insurance is shown because a clinician needs to know coverage exists - not the billing
	// detail, which section 29 keeps out of this workspace.
	var payer, plan string
	_ = s.db.QueryRow(r.Context(),
		`SELECT COALESCE(insurance_company,''), COALESCE(plan_name,'') FROM insurance_policies
		  WHERE patient_id = $1 ORDER BY priority LIMIT 1`, patientID).Scan(&payer, &plan)
	header["insurance"] = map[string]string{"payer": payer, "plan": plan}

	var lastVisit, nextAppt, provider string
	_ = s.db.QueryRow(r.Context(),
		`SELECT COALESCE(max(dos),''), COALESCE((SELECT provider FROM charges WHERE patient_id=$1
		   AND dos = (SELECT max(dos) FROM charges WHERE patient_id=$1) LIMIT 1),'')
		   FROM charges WHERE patient_id = $1`, patientID).Scan(&lastVisit, &provider)
	_ = s.db.QueryRow(r.Context(),
		`SELECT COALESCE(min(date),'') FROM appointments
		  WHERE patient_id = $1 AND date >= to_char(now(),'YYYY-MM-DD')`, patientID).Scan(&nextAppt)
	header["lastVisit"], header["nextAppointment"], header["provider"] = lastVisit, nextAppt, provider

	writeJSON(w, http.StatusOK, header)
}

// ageFromDOB returns whole years, or -1 when the stored date is unusable. The interface shows
// "Not available" for -1 rather than printing a nonsensical age.
func ageFromDOB(dob string) int {
	t, err := time.Parse("2006-01-02", strings.TrimSpace(dob))
	if err != nil {
		return -1
	}
	now := time.Now()
	years := now.Year() - t.Year()
	if now.YearDay() < t.YearDay() {
		years--
	}
	if years < 0 || years > 150 {
		return -1
	}
	return years
}
