package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Antimicrobial Review.
//
// A documentation and workflow module. It records what a reviewer observed and what they
// recommended; it does not prescribe, discontinue, adjust, or advise. There is no rule engine
// here and no derived clinical value anywhere in this file - every clinical field is text a
// person typed, and an empty one is reported as "not documented", never filled in.
//
// Therapy details are READ from the medications table when the review references a medication
// row, so the review and the chart cannot disagree about a dose.

const domainAntimicrobial = "antimicrobial"

type amReview struct {
	ID        string `json:"id"`
	PatientID string `json:"patientId"`

	// Joined from patients at read time, never stored here.
	PatientName string `json:"patientName"`
	MRN         string `json:"mrn"`
	DOB         string `json:"dob"`

	MedicationID  string `json:"medicationId"`
	Antimicrobial string `json:"antimicrobial"`
	Dose          string `json:"dose"`
	Route         string `json:"route"`
	Frequency     string `json:"frequency"`
	StartDate     string `json:"startDate"`
	StopDate      string `json:"stopDate"`
	OrderProvider string `json:"orderingProvider"`
	Indication    string `json:"indication"`
	OrderStatus   string `json:"orderStatus"`

	Location     string `json:"location"`
	Attending    string `json:"attending"`
	EncounterRef string `json:"encounterRef"`

	ReviewDue      string `json:"reviewDue"`
	Priority       string `json:"priority"`
	Status         string `json:"status"`
	AssignedTo     string `json:"assignedTo"`
	AssignedToName string `json:"assignedToName"`
	LastReviewedAt string `json:"lastReviewedAt"`

	// Whole days of therapy so far, computed from start_date. Presented as a number of days, not
	// as a clinical judgement about whether that duration is appropriate.
	DurationDays int `json:"durationDays"`

	CreatedBy string `json:"createdBy"`
	CreatedAt string `json:"createdAt"`
}

// durationDays counts whole days from an ISO date to today, or -1 when the date is unusable.
// Compared as strings-to-time rather than with SQL date maths so a malformed legacy value
// degrades to "not available" instead of failing the whole query.
func durationDays(start string) int {
	t, err := time.Parse("2006-01-02", strings.TrimSpace(start))
	if err != nil {
		return -1
	}
	d := int(time.Since(t).Hours() / 24)
	if d < 0 {
		return 0
	}
	return d
}

var amSortable = map[string]string{
	"patient":       "p.name",
	"antimicrobial": "a.antimicrobial",
	"startDate":     "a.start_date",
	"reviewDue":     "a.review_due",
	"status":        "a.status",
	"priority":      "a.priority",
	"assigned":      "a.assigned_to_name",
	"location":      "a.location",
	"provider":      "a.ordering_provider",
	"lastReviewed":  "a.last_reviewed_at",
}

// GET /api/clinical/antimicrobial
func (s *Server) handleAMList(w http.ResponseWriter, r *http.Request) {
	p := parseListParams(r, "reviewDue")
	col := sortColumn(p.Sort, amSortable, "a.review_due")

	// Every value is bound; only the column and direction come from the allowlist above.
	where := []string{"1=1"}
	args := []any{}
	add := func(clause string, v any) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(clause, len(args)))
	}

	if p.Search != "" {
		// Bound once and referenced four times. Written out rather than routed through add(),
		// which formats a single placeholder.
		args = append(args, p.Search)
		n := len(args)
		where = append(where, fmt.Sprintf(
			"(p.name ILIKE '%%'||$%d||'%%' OR a.patient_id ILIKE '%%'||$%d||'%%'"+
				" OR a.antimicrobial ILIKE '%%'||$%d||'%%' OR a.ordering_provider ILIKE '%%'||$%d||'%%')",
			n, n, n, n))
	}
	if p.Status != "" {
		add("a.status = $%d", p.Status)
	}
	if p.Priority != "" {
		add("a.priority = $%d", p.Priority)
	}
	switch p.Assigned {
	case "":
	case "unassigned":
		where = append(where, "a.assigned_to IS NULL")
	default:
		add("a.assigned_to = $%d", p.Assigned)
	}
	if p.From != "" {
		add("a.start_date >= $%d", p.From)
	}
	if p.To != "" {
		add("a.start_date <= $%d", p.To)
	}

	base := `FROM antimicrobial_reviews a LEFT JOIN patients p ON p.id = a.patient_id WHERE ` +
		strings.Join(where, " AND ")

	var total int
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) "+base, args...).Scan(&total); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the worklist")
		return
	}

	args = append(args, p.Limit, p.Offset)
	q := fmt.Sprintf(`SELECT a.id, a.patient_id, COALESCE(p.name,''), COALESCE(p.dob,''),
	       a.medication_id, a.antimicrobial, a.dose, a.route, a.frequency, a.start_date, a.stop_date,
	       a.ordering_provider, a.indication, a.order_status, a.location, a.attending, a.encounter_ref,
	       a.review_due, a.priority, a.status, a.assigned_to, a.assigned_to_name, a.last_reviewed_at,
	       a.created_by, a.created_at
	  %s ORDER BY %s %s NULLS LAST, a.id LIMIT $%d OFFSET $%d`,
		base, col, p.Dir, len(args)-1, len(args))

	rows, err := s.db.Query(r.Context(), q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the worklist")
		return
	}
	defer rows.Close()

	out := []amReview{}
	for rows.Next() {
		var a amReview
		var medID, assigned *string
		var due, lastRev *time.Time
		var created time.Time
		if err := rows.Scan(&a.ID, &a.PatientID, &a.PatientName, &a.DOB, &medID, &a.Antimicrobial,
			&a.Dose, &a.Route, &a.Frequency, &a.StartDate, &a.StopDate, &a.OrderProvider,
			&a.Indication, &a.OrderStatus, &a.Location, &a.Attending, &a.EncounterRef,
			&due, &a.Priority, &a.Status, &assigned, &a.AssignedToName, &lastRev,
			&a.CreatedBy, &created); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not read the worklist")
			return
		}
		a.MedicationID, a.AssignedTo = deref(medID), deref(assigned)
		a.ReviewDue, a.LastReviewedAt = tsOrEmpty(due), tsOrEmpty(lastRev)
		a.CreatedAt = created.UTC().Format(time.RFC3339)
		// This application has no separate medical record number; the patient id is it.
		a.MRN = a.PatientID
		a.DurationDays = durationDays(a.StartDate)
		out = append(out, a)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"items": out, "total": total, "limit": p.Limit, "offset": p.Offset,
	})
}

// GET /api/clinical/antimicrobial/summary
func (s *Server) handleAMSummary(w http.ResponseWriter, r *http.Request) {
	type bucket struct {
		Key   string `json:"key"`
		Count int    `json:"count"`
	}
	res := map[string]any{}

	var pending, dueToday, overdue, followUp, completedToday int
	err := s.db.QueryRow(r.Context(), `
		SELECT
		  count(*) FILTER (WHERE status = 'PENDING_REVIEW'),
		  count(*) FILTER (WHERE review_due::date = CURRENT_DATE AND status NOT IN ('COMPLETED','CANCELLED')),
		  count(*) FILTER (WHERE review_due < now() AND status NOT IN ('COMPLETED','CANCELLED')),
		  count(*) FILTER (WHERE status = 'FOLLOW_UP'),
		  count(*) FILTER (WHERE status = 'COMPLETED' AND last_reviewed_at::date = CURRENT_DATE)
		FROM antimicrobial_reviews`).
		Scan(&pending, &dueToday, &overdue, &followUp, &completedToday)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not build the summary")
		return
	}
	res["cards"] = map[string]int{
		"pending": pending, "dueToday": dueToday, "overdue": overdue,
		"followUp": followUp, "completedToday": completedToday,
	}

	// Operational breakdowns. Grouped in SQL rather than in the browser so a large worklist does
	// not have to be shipped to the client to be counted.
	group := func(expr, label string) {
		rows, err := s.db.Query(r.Context(), fmt.Sprintf(
			`SELECT COALESCE(NULLIF(%s,''),'Not available') k, count(*)
			   FROM antimicrobial_reviews GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 15`, expr))
		if err != nil {
			return
		}
		defer rows.Close()
		list := []bucket{}
		for rows.Next() {
			var b bucket
			if rows.Scan(&b.Key, &b.Count) == nil {
				list = append(list, b)
			}
		}
		res[label] = list
	}
	group("antimicrobial", "byAntimicrobial")
	group("location", "byLocation")
	group("ordering_provider", "byProvider")
	group("assigned_to_name", "byReviewer")
	group("status", "byStatus")

	writeJSON(w, http.StatusOK, res)
}

// GET /api/clinical/antimicrobial/{id}
//
// Returns the review, its full append-only history, and the patient/medication context read live
// from the chart. Nothing clinical is duplicated into the response that is not either documented
// on the review or read from its source table this instant.
func (s *Server) handleAMDetail(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	var a amReview
	var medID, assigned *string
	var due, lastRev *time.Time
	var created time.Time
	err := s.db.QueryRow(r.Context(), `
		SELECT a.id, a.patient_id, COALESCE(p.name,''), COALESCE(p.dob,''),
		       a.medication_id, a.antimicrobial, a.dose, a.route, a.frequency, a.start_date, a.stop_date,
		       a.ordering_provider, a.indication, a.order_status, a.location, a.attending, a.encounter_ref,
		       a.review_due, a.priority, a.status, a.assigned_to, a.assigned_to_name, a.last_reviewed_at,
		       a.created_by, a.created_at
		  FROM antimicrobial_reviews a LEFT JOIN patients p ON p.id = a.patient_id
		 WHERE a.id = $1`, id).
		Scan(&a.ID, &a.PatientID, &a.PatientName, &a.DOB, &medID, &a.Antimicrobial, &a.Dose,
			&a.Route, &a.Frequency, &a.StartDate, &a.StopDate, &a.OrderProvider, &a.Indication,
			&a.OrderStatus, &a.Location, &a.Attending, &a.EncounterRef, &due, &a.Priority,
			&a.Status, &assigned, &a.AssignedToName, &lastRev, &a.CreatedBy, &created)
	if err != nil {
		writeErr(w, http.StatusNotFound, "no such review")
		return
	}
	a.MedicationID, a.AssignedTo = deref(medID), deref(assigned)
	a.ReviewDue, a.LastReviewedAt = tsOrEmpty(due), tsOrEmpty(lastRev)
	a.CreatedAt = created.UTC().Format(time.RFC3339)
	a.MRN = a.PatientID
	a.DurationDays = durationDays(a.StartDate)

	// Therapy read from the chart, so the review page shows the CURRENT order rather than a copy
	// taken when the review was created.
	medication := map[string]any{}
	if a.MedicationID != "" {
		var name, dose, route, freq, start, end, status, prescriber, instructions string
		if s.db.QueryRow(r.Context(),
			`SELECT name, dose, route, frequency, start_date, end_date, status, prescriber, instructions
			   FROM medications WHERE id = $1`, a.MedicationID).
			Scan(&name, &dose, &route, &freq, &start, &end, &status, &prescriber, &instructions) == nil {
			medication = map[string]any{
				"id": a.MedicationID, "name": name, "dose": dose, "route": route,
				"frequency": freq, "startDate": start, "endDate": end, "status": status,
				"prescriber": prescriber, "instructions": instructions,
			}
		}
	}

	// Allergies are the one piece of clinical context this application genuinely holds.
	allergies := []map[string]string{}
	if rows, err := s.db.Query(r.Context(),
		`SELECT substance, reaction, severity, status FROM allergies WHERE patient_id = $1 ORDER BY substance`,
		a.PatientID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var sub, reac, sev, st string
			if rows.Scan(&sub, &reac, &sev, &st) == nil {
				allergies = append(allergies, map[string]string{
					"substance": sub, "reaction": reac, "severity": sev, "status": st,
				})
			}
		}
	}

	history, err := s.amHistory(r, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the review history")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"review": a, "history": history, "medication": medication, "allergies": allergies,
	})
}

type amEntry struct {
	ID            string `json:"id"`
	ReviewedAt    string `json:"reviewedAt"`
	ReviewerName  string `json:"reviewerName"`
	Assessment    string `json:"assessment"`
	RecCategory   string `json:"recommendationCategory"`
	RecNotes      string `json:"recommendationNotes"`
	ProviderCont  string `json:"providerContacted"`
	ContactAt     string `json:"contactAt"`
	ProviderResp  string `json:"providerResponse"`
	FollowupDate  string `json:"followupDate"`
	FollowupNotes string `json:"followupNotes"`

	Cultures       string `json:"cultures"`
	Organism       string `json:"organism"`
	Susceptibility string `json:"susceptibility"`
	Labs           string `json:"labs"`
	RenalFunction  string `json:"renalFunction"`
	AllergiesNoted string `json:"allergiesNoted"`
	ClinicalNotes  string `json:"clinicalNotes"`
	PriorTherapy   string `json:"priorTherapy"`
	Duration       string `json:"therapyDuration"`
	StatusAfter    string `json:"statusAfter"`
}

func (s *Server) amHistory(r *http.Request, reviewID string) ([]amEntry, error) {
	rows, err := s.db.Query(r.Context(), `
		SELECT id, reviewed_at, reviewer_name, assessment, recommendation_category, recommendation_notes,
		       provider_contacted, contact_at, provider_response, followup_date, followup_notes,
		       cultures, organism, susceptibility, labs, renal_function, allergies_noted,
		       clinical_notes, prior_therapy, therapy_duration, status_after
		  FROM antimicrobial_review_entries WHERE review_id = $1 ORDER BY reviewed_at DESC`, reviewID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []amEntry{}
	for rows.Next() {
		var e amEntry
		var at time.Time
		var contact *time.Time
		if err := rows.Scan(&e.ID, &at, &e.ReviewerName, &e.Assessment, &e.RecCategory, &e.RecNotes,
			&e.ProviderCont, &contact, &e.ProviderResp, &e.FollowupDate, &e.FollowupNotes,
			&e.Cultures, &e.Organism, &e.Susceptibility, &e.Labs, &e.RenalFunction,
			&e.AllergiesNoted, &e.ClinicalNotes, &e.PriorTherapy, &e.Duration, &e.StatusAfter); err != nil {
			return nil, err
		}
		e.ReviewedAt, e.ContactAt = at.UTC().Format(time.RFC3339), tsOrEmpty(contact)
		out = append(out, e)
	}
	return out, rows.Err()
}

// POST /api/clinical/antimicrobial
func (s *Server) handleAMCreate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var b struct {
		PatientID     string `json:"patientId"`
		MedicationID  string `json:"medicationId"`
		Antimicrobial string `json:"antimicrobial"`
		Dose          string `json:"dose"`
		Route         string `json:"route"`
		Frequency     string `json:"frequency"`
		StartDate     string `json:"startDate"`
		StopDate      string `json:"stopDate"`
		OrderProvider string `json:"orderingProvider"`
		Indication    string `json:"indication"`
		OrderStatus   string `json:"orderStatus"`
		Location      string `json:"location"`
		Attending     string `json:"attending"`
		EncounterRef  string `json:"encounterRef"`
		ReviewDue     string `json:"reviewDue"`
		Priority      string `json:"priority"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	if strings.TrimSpace(b.PatientID) == "" {
		writeErr(w, http.StatusBadRequest, "a patient is required")
		return
	}

	// The patient must exist. Creating a review against an id that resolves to nothing would put
	// a row on the worklist that can never be opened.
	var exists bool
	if err := s.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM patients WHERE id = $1)`, b.PatientID).Scan(&exists); err != nil || !exists {
		writeErr(w, http.StatusBadRequest, "no such patient")
		return
	}

	// Therapy details come from the chart when a medication is referenced, so the review cannot
	// record a dose the medication list disagrees with.
	if b.MedicationID != "" {
		var name, dose, route, freq, start, end, status, prescriber string
		if err := s.db.QueryRow(r.Context(),
			`SELECT name, dose, route, frequency, start_date, end_date, status, prescriber
			   FROM medications WHERE id = $1 AND patient_id = $2`, b.MedicationID, b.PatientID).
			Scan(&name, &dose, &route, &freq, &start, &end, &status, &prescriber); err != nil {
			writeErr(w, http.StatusBadRequest, "that medication does not belong to this patient")
			return
		}
		b.Antimicrobial, b.Dose, b.Route, b.Frequency = name, dose, route, freq
		b.StartDate, b.StopDate, b.OrderStatus, b.OrderProvider = start, end, status, prescriber
	}
	if strings.TrimSpace(b.Antimicrobial) == "" {
		writeErr(w, http.StatusBadRequest, "an antimicrobial is required")
		return
	}
	if b.Priority == "" {
		b.Priority = "ROUTINE"
	}

	id := "AMR" + newUID()
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO antimicrobial_reviews
		  (id, patient_id, medication_id, antimicrobial, dose, route, frequency, start_date, stop_date,
		   ordering_provider, indication, order_status, location, attending, encounter_ref,
		   review_due, priority, status, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
		        NULLIF($16,'')::timestamptz, $17, 'PENDING_REVIEW', $18)`,
		id, b.PatientID, nullable(b.MedicationID), b.Antimicrobial, b.Dose, b.Route, b.Frequency,
		b.StartDate, b.StopDate, b.OrderProvider, b.Indication, b.OrderStatus, b.Location,
		b.Attending, b.EncounterRef, b.ReviewDue, b.Priority, u.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create the review")
		return
	}

	s.auditClinical(r.Context(), u, b.PatientID, "Antimicrobial review created", "antimicrobialReview", id, "", b.Antimicrobial)
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

// POST /api/clinical/antimicrobial/{id}/reviews
//
// Appends a review. It NEVER updates a previous entry: the specification asks for the whole chain
// to stay readable, and a stewardship record that can be rewritten afterwards is not a record.
// The parent row's status and last_reviewed_at move forward; the history behind it does not change.
func (s *Server) handleAMAddReview(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")

	var b struct {
		Assessment     string `json:"assessment"`
		RecCategory    string `json:"recommendationCategory"`
		RecNotes       string `json:"recommendationNotes"`
		ProviderCont   string `json:"providerContacted"`
		ContactAt      string `json:"contactAt"`
		ProviderResp   string `json:"providerResponse"`
		FollowupDate   string `json:"followupDate"`
		FollowupNotes  string `json:"followupNotes"`
		Cultures       string `json:"cultures"`
		Organism       string `json:"organism"`
		Susceptibility string `json:"susceptibility"`
		Labs           string `json:"labs"`
		RenalFunction  string `json:"renalFunction"`
		AllergiesNoted string `json:"allergiesNoted"`
		ClinicalNotes  string `json:"clinicalNotes"`
		PriorTherapy   string `json:"priorTherapy"`
		Duration       string `json:"therapyDuration"`
		NextStatus     string `json:"nextStatus"`
		ReviewDue      string `json:"reviewDue"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}

	var patientID, current string
	if err := s.db.QueryRow(r.Context(),
		`SELECT patient_id, status FROM antimicrobial_reviews WHERE id = $1`, id).
		Scan(&patientID, &current); err != nil {
		writeErr(w, http.StatusNotFound, "no such review")
		return
	}

	if strings.TrimSpace(b.Assessment) == "" {
		writeErr(w, http.StatusBadRequest, "an assessment is required")
		return
	}
	next := strings.TrimSpace(b.NextStatus)
	if next == "" {
		next = current
	}
	if !s.validStatus(r.Context(), domainAntimicrobial, next) {
		writeErr(w, http.StatusBadRequest, "that is not a configured review status")
		return
	}
	// Completing is a separate grant: documenting a review and closing the record are different
	// responsibilities, and the specification lists ANTIMICROBIAL_COMPLETE separately.
	if next == "COMPLETED" && !s.effectiveUserPerms(r.Context(), u.UID, u.Role).has(PermAntimicrobialComplete) {
		writeErr(w, http.StatusForbidden, "you do not have permission to complete a review")
		return
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not record the review")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck // no-op after commit

	entryID := "AME" + newUID()
	if _, err := tx.Exec(r.Context(), `
		INSERT INTO antimicrobial_review_entries
		  (id, review_id, reviewer_id, reviewer_name, assessment, recommendation_category,
		   recommendation_notes, provider_contacted, contact_at, provider_response,
		   followup_date, followup_notes, cultures, organism, susceptibility, labs,
		   renal_function, allergies_noted, clinical_notes, prior_therapy, therapy_duration, status_after)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,'')::timestamptz,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
		entryID, id, u.UID, u.Name, b.Assessment, b.RecCategory, b.RecNotes, b.ProviderCont,
		b.ContactAt, b.ProviderResp, b.FollowupDate, b.FollowupNotes, b.Cultures, b.Organism,
		b.Susceptibility, b.Labs, b.RenalFunction, b.AllergiesNoted, b.ClinicalNotes,
		b.PriorTherapy, b.Duration, next); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not record the review")
		return
	}

	if _, err := tx.Exec(r.Context(), `
		UPDATE antimicrobial_reviews
		   SET status = $2, last_reviewed_at = now(), updated_at = now(),
		       review_due = COALESCE(NULLIF($3,'')::timestamptz, review_due)
		 WHERE id = $1`, id, next, b.ReviewDue); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update the review")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not record the review")
		return
	}

	s.auditClinical(r.Context(), u, patientID, "Antimicrobial review documented",
		"antimicrobialReview", id, current, next)
	writeJSON(w, http.StatusOK, map[string]any{"id": entryID, "status": next})
}

// POST /api/clinical/antimicrobial/{id}/assign
func (s *Server) handleAMAssign(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")

	var b struct {
		AssignTo string `json:"assignTo"` // "" unassigns
		Name     string `json:"assignToName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}

	var patientID, prev string
	if err := s.db.QueryRow(r.Context(),
		`SELECT patient_id, COALESCE(assigned_to_name,'') FROM antimicrobial_reviews WHERE id = $1`, id).
		Scan(&patientID, &prev); err != nil {
		writeErr(w, http.StatusNotFound, "no such review")
		return
	}

	// The assignee must be a real account, so the worklist cannot point at somebody who does not
	// exist and quietly become nobody's job.
	if b.AssignTo != "" {
		var name string
		if err := s.db.QueryRow(r.Context(),
			`SELECT name FROM users WHERE id = $1 AND NOT disabled`, b.AssignTo).Scan(&name); err != nil {
			writeErr(w, http.StatusBadRequest, "no such active user")
			return
		}
		b.Name = name
	} else {
		b.Name = ""
	}

	if _, err := s.db.Exec(r.Context(),
		`UPDATE antimicrobial_reviews SET assigned_to = $2::text, assigned_to_name = $3, updated_at = now() WHERE id = $1`,
		id, nullable(b.AssignTo), b.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update the assignment")
		return
	}

	s.auditClinical(r.Context(), u, patientID, "Antimicrobial review assigned", "antimicrobialReview", id, prev, b.Name)
	writeJSON(w, http.StatusOK, map[string]any{"assignedTo": b.AssignTo, "assignedToName": b.Name})
}
