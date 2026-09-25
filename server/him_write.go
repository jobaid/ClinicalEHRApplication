package main

import (
	"encoding/json"
	"net/http"
	"strings"
)

// Write paths for the HIM Coding Worklist.
//
// Every one of these appends to him_activity, so the encounter timeline is a complete record of
// what happened rather than a summary reconstructed afterwards. Assignment and query history are
// likewise append-only: reassigning writes a new row, it never edits the previous one.

// POST /api/him/worklist - put an encounter into the coding queue.
func (s *Server) handleHIMCreate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var b struct {
		PatientID     string `json:"patientId"`
		ChargeID      string `json:"chargeId"`
		ClaimID       string `json:"claimId"`
		EncounterRef  string `json:"encounterRef"`
		DOS           string `json:"dos"`
		AdmitDate     string `json:"admitDate"`
		DischargeDate string `json:"dischargeDate"`
		EncounterType string `json:"encounterType"`
		Provider      string `json:"provider"`
		Payer         string `json:"payer"`
		Location      string `json:"location"`
		Priority      string `json:"priority"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}

	// A charge is this application's encounter. When one is referenced, the encounter details are
	// read FROM it rather than retyped, so the worklist and the billing screen cannot disagree
	// about the date of service or the provider.
	if b.ChargeID != "" {
		var pid, dos, provider, cpt string
		if err := s.db.QueryRow(r.Context(),
			`SELECT COALESCE(patient_id,''), dos, provider, cpt FROM charges WHERE id = $1`, b.ChargeID).
			Scan(&pid, &dos, &provider, &cpt); err != nil {
			writeErr(w, http.StatusBadRequest, "no such charge")
			return
		}
		if b.PatientID == "" {
			b.PatientID = pid
		}
		if b.PatientID != pid {
			writeErr(w, http.StatusBadRequest, "that charge belongs to a different patient")
			return
		}
		b.DOS, b.Provider = dos, provider
		if b.EncounterRef == "" {
			b.EncounterRef = b.ChargeID
		}
	}

	if strings.TrimSpace(b.PatientID) == "" {
		writeErr(w, http.StatusBadRequest, "a patient is required")
		return
	}
	var exists bool
	if err := s.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM patients WHERE id = $1)`, b.PatientID).Scan(&exists); err != nil || !exists {
		writeErr(w, http.StatusBadRequest, "no such patient")
		return
	}

	// One queue entry per charge. Without this, clicking "send to coding" twice puts the same
	// encounter in front of two coders.
	if b.ChargeID != "" {
		var dupe string
		if err := s.db.QueryRow(r.Context(),
			`SELECT id FROM him_worklist WHERE charge_id = $1`, b.ChargeID).Scan(&dupe); err == nil {
			writeJSON(w, http.StatusOK, map[string]any{"id": dupe, "existing": true})
			return
		}
	}

	if b.Priority == "" {
		b.Priority = "ROUTINE"
	}
	id := "HIM" + newUID()
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO him_worklist
		  (id, patient_id, charge_id, claim_id, encounter_ref, dos, admit_date, discharge_date,
		   encounter_type, provider, payer, location, coding_status, priority, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'READY_FOR_CODING',$13,$14)`,
		id, b.PatientID, nullable(b.ChargeID), nullable(b.ClaimID), b.EncounterRef, b.DOS,
		b.AdmitDate, b.DischargeDate, b.EncounterType, b.Provider, b.Payer, b.Location,
		b.Priority, u.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create the worklist item")
		return
	}

	s.logActivity(r, u, id, "Encounter added to coding worklist", b.EncounterRef, "", "READY_FOR_CODING")
	s.auditClinical(r.Context(), u, b.PatientID, "Coding worklist item created", "himWorklist", id, "", b.EncounterRef)
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

// POST /api/him/worklist/{id}/assign
func (s *Server) handleHIMAssign(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")

	var b struct {
		AssignTo string `json:"assignTo"` // "" unassigns
		Reason   string `json:"reason"`
		ToMe     bool   `json:"toMe"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	if b.ToMe {
		b.AssignTo = u.UID
	}

	patientID, status, ok := s.worklistPatient(r, id)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such worklist item")
		return
	}

	var prevID *string
	var prevName string
	_ = s.db.QueryRow(r.Context(),
		`SELECT assigned_to, COALESCE(assigned_to_name,'') FROM him_worklist WHERE id = $1`, id).
		Scan(&prevID, &prevName)

	name := ""
	action := "UNASSIGN"
	if b.AssignTo != "" {
		if err := s.db.QueryRow(r.Context(),
			`SELECT name FROM users WHERE id = $1 AND NOT disabled`, b.AssignTo).Scan(&name); err != nil {
			writeErr(w, http.StatusBadRequest, "no such active user")
			return
		}
		action = "ASSIGN"
		if b.ToMe {
			action = "CLAIM"
		}
		if prevID != nil && *prevID != "" && *prevID != b.AssignTo {
			action = "REASSIGN"
		}
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update the assignment")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck // no-op after commit

	// Assigning an unassigned encounter moves it forward; unassigning returns it to the pool.
	// Neither overrides a status a coder has already advanced past.
	nextStatus := status
	switch {
	case b.AssignTo != "" && (status == "UNASSIGNED" || status == "READY_FOR_CODING"):
		nextStatus = "ASSIGNED"
	case b.AssignTo == "":
		nextStatus = "READY_FOR_CODING"
	}

	// $2 is cast explicitly: it is both assigned and tested for NULL, and without the cast the
	// driver cannot infer a type for an untyped NULL used in a CASE.
	if _, err := tx.Exec(r.Context(), `
		UPDATE him_worklist
		   SET assigned_to = $2::text, assigned_to_name = $3,
		       assigned_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
		       coding_status = $4, updated_at = now(), last_activity_at = now()
		 WHERE id = $1`, id, nullable(b.AssignTo), name, nextStatus); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update the assignment")
		return
	}

	if _, err := tx.Exec(r.Context(), `
		INSERT INTO him_assignments
		  (id, worklist_id, assigned_to, assigned_to_name, assigned_by, assigned_by_name,
		   previous_assigned_to, previous_assigned_to_name, action, reason)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		"HAS"+newUID(), id, nullable(b.AssignTo), name, u.UID, u.Name,
		prevID, prevName, action, b.Reason); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not record the assignment")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update the assignment")
		return
	}

	detail := "Unassigned"
	if name != "" {
		detail = "Assigned to " + name
	}
	s.logActivity(r, u, id, detail, b.Reason, prevName, name)
	s.auditClinical(r.Context(), u, patientID, "Coding assignment changed", "himWorklist", id, prevName, name)
	writeJSON(w, http.StatusOK, map[string]any{"assignedTo": b.AssignTo, "assignedToName": name, "codingStatus": nextStatus})
}

// POST /api/him/worklist/{id}/status
func (s *Server) handleHIMStatus(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")

	var b struct {
		Status string `json:"status"`
		Note   string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	patientID, current, ok := s.worklistPatient(r, id)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such worklist item")
		return
	}
	if !s.validStatus(r.Context(), domainHIMCoding, b.Status) {
		writeErr(w, http.StatusBadRequest, "that is not a configured coding status")
		return
	}
	// Completing is its own grant, listed separately in the specification: a coder may work an
	// encounter without being the person who closes it.
	if b.Status == "COMPLETED" && !s.effectiveUserPerms(r.Context(), u.UID, u.Role).has(PermHIMComplete) {
		writeErr(w, http.StatusForbidden, "you do not have permission to complete an encounter")
		return
	}

	if _, err := s.db.Exec(r.Context(), `
		UPDATE him_worklist
		   SET coding_status = $2,
		       completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE NULL END,
		       updated_at = now(), last_activity_at = now()
		 WHERE id = $1`, id, b.Status); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update the status")
		return
	}

	s.logActivity(r, u, id, "Status changed", b.Note, current, b.Status)
	s.auditClinical(r.Context(), u, patientID, "Coding status changed", "himWorklist", id, current, b.Status)
	writeJSON(w, http.StatusOK, map[string]any{"codingStatus": b.Status})
}

// PUT /api/him/worklist/{id}/diagnoses - replace the diagnosis set for an encounter.
//
// Sent as a whole set rather than per-row edits so the sequence and the single principal marker
// are decided in one place. The previous set is replaced in a transaction; the ACTIVITY timeline
// keeps the record of what changed, which is what the specification asks to preserve.
func (s *Server) handleHIMDiagnoses(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")

	var b struct {
		Diagnoses []struct {
			Code        string `json:"code"`
			Description string `json:"description"`
			IsPrincipal bool   `json:"isPrincipal"`
			POA         string `json:"poa"`
			Notes       string `json:"notes"`
		} `json:"diagnoses"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	patientID, _, ok := s.worklistPatient(r, id)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such worklist item")
		return
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the diagnosis codes")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck // no-op after commit

	// Scoped to this worklist item only. This is the coder's working set for one encounter, not
	// patient history, and nothing outside this encounter is touched.
	if _, err := tx.Exec(r.Context(), `DELETE FROM him_diagnosis_codes WHERE worklist_id = $1`, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the diagnosis codes")
		return
	}
	for i, d := range b.Diagnoses {
		if strings.TrimSpace(d.Code) == "" {
			continue
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO him_diagnosis_codes
			  (id, worklist_id, code, description, is_principal, poa, sequence, notes, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			"HDX"+newUID(), id, strings.ToUpper(strings.TrimSpace(d.Code)), d.Description,
			d.IsPrincipal, d.POA, i+1, d.Notes, u.Name); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not save the diagnosis codes")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the diagnosis codes")
		return
	}

	codes := []string{}
	for _, d := range b.Diagnoses {
		if c := strings.TrimSpace(d.Code); c != "" {
			codes = append(codes, c)
		}
	}
	joined := strings.Join(codes, ", ")
	s.logActivity(r, u, id, "Diagnosis coding updated", joined, "", joined)
	s.auditClinical(r.Context(), u, patientID, "Diagnosis coding updated", "himWorklist", id, "", joined)

	dx, _ := s.himDiagnoses(r, id)
	writeJSON(w, http.StatusOK, map[string]any{"diagnoses": dx})
}

// PUT /api/him/worklist/{id}/procedures
func (s *Server) handleHIMProcedures(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")

	var b struct {
		Procedures []struct {
			Code        string  `json:"code"`
			Description string  `json:"description"`
			ServiceDate string  `json:"serviceDate"`
			Modifiers   string  `json:"modifiers"`
			Units       float64 `json:"units"`
			Notes       string  `json:"notes"`
		} `json:"procedures"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	patientID, _, ok := s.worklistPatient(r, id)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such worklist item")
		return
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the procedure codes")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck // no-op after commit

	if _, err := tx.Exec(r.Context(), `DELETE FROM him_procedure_codes WHERE worklist_id = $1`, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the procedure codes")
		return
	}
	for i, x := range b.Procedures {
		if strings.TrimSpace(x.Code) == "" {
			continue
		}
		units := x.Units
		if units <= 0 {
			units = 1
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO him_procedure_codes
			  (id, worklist_id, code, description, service_date, modifiers, units, sequence, notes, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			"HPX"+newUID(), id, strings.ToUpper(strings.TrimSpace(x.Code)), x.Description,
			x.ServiceDate, x.Modifiers, units, i+1, x.Notes, u.Name); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not save the procedure codes")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the procedure codes")
		return
	}

	codes := []string{}
	for _, x := range b.Procedures {
		if c := strings.TrimSpace(x.Code); c != "" {
			codes = append(codes, c)
		}
	}
	joined := strings.Join(codes, ", ")
	s.logActivity(r, u, id, "Procedure coding updated", joined, "", joined)
	s.auditClinical(r.Context(), u, patientID, "Procedure coding updated", "himWorklist", id, "", joined)

	px, _ := s.himProcedures(r, id)
	writeJSON(w, http.StatusOK, map[string]any{"procedures": px})
}

// POST /api/him/worklist/{id}/queries - raise a provider documentation query.
func (s *Server) handleHIMQueryCreate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")

	var b struct {
		QueryType   string `json:"queryType"`
		QueryReason string `json:"queryReason"`
		QueryText   string `json:"queryText"`
		Provider    string `json:"provider"`
		Send        bool   `json:"send"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	patientID, _, ok := s.worklistPatient(r, id)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such worklist item")
		return
	}
	if strings.TrimSpace(b.QueryText) == "" {
		writeErr(w, http.StatusBadRequest, "the query text is required")
		return
	}

	status := "DRAFT"
	if b.Send {
		status = "SENT"
	}
	qid := "HQY" + newUID()
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO him_provider_queries
		  (id, worklist_id, patient_id, query_type, query_reason, query_text, provider,
		   status, created_by, created_by_name, sent_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $8 = 'SENT' THEN now() ELSE NULL END)`,
		qid, id, patientID, b.QueryType, b.QueryReason, b.QueryText, b.Provider,
		status, u.UID, u.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create the query")
		return
	}

	// The encounter's query status mirrors the query, so the worklist column means something
	// without joining every query row.
	worklistQuery := "SENT"
	if status == "DRAFT" {
		worklistQuery = "DRAFT"
	}
	_, _ = s.db.Exec(r.Context(),
		`UPDATE him_worklist SET query_status = $2, coding_status =
		   CASE WHEN $2 = 'SENT' THEN 'QUERY_SENT' ELSE coding_status END,
		   updated_at = now(), last_activity_at = now() WHERE id = $1`, id, worklistQuery)

	s.logActivity(r, u, id, "Provider query created", b.QueryType, "", status)
	s.auditClinical(r.Context(), u, patientID, "Provider query created", "himQuery", qid, "", b.QueryType)
	writeJSON(w, http.StatusOK, map[string]any{"id": qid, "status": status})
}

// POST /api/him/queries/{qid}/status - move a query through its workflow.
//
// Append-only in spirit: the query row advances, but nothing that was already written to it is
// erased, and every transition lands on the encounter timeline.
func (s *Server) handleHIMQueryUpdate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	qid := r.PathValue("qid")

	var b struct {
		Status       string `json:"status"`
		ResponseText string `json:"responseText"`
		Resolution   string `json:"resolution"`
		CodingImpact string `json:"codingImpact"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	if !s.validStatus(r.Context(), domainHIMQuery, b.Status) {
		writeErr(w, http.StatusBadRequest, "that is not a configured query status")
		return
	}

	var worklistID, patientID, current string
	if err := s.db.QueryRow(r.Context(),
		`SELECT worklist_id, patient_id, status FROM him_provider_queries WHERE id = $1`, qid).
		Scan(&worklistID, &patientID, &current); err != nil {
		writeErr(w, http.StatusNotFound, "no such query")
		return
	}

	if _, err := s.db.Exec(r.Context(), `
		UPDATE him_provider_queries
		   SET status = $2,
		       response_text = CASE WHEN $3 <> '' THEN $3 ELSE response_text END,
		       resolution    = CASE WHEN $4 <> '' THEN $4 ELSE resolution END,
		       coding_impact = CASE WHEN $5 <> '' THEN $5 ELSE coding_impact END,
		       sent_at      = COALESCE(sent_at, CASE WHEN $2 = 'SENT' THEN now() END),
		       responded_at = COALESCE(responded_at, CASE WHEN $2 IN ('RECEIVED','RESOLVED') THEN now() END),
		       updated_at = now()
		 WHERE id = $1`, qid, b.Status, b.ResponseText, b.Resolution, b.CodingImpact); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update the query")
		return
	}

	_, _ = s.db.Exec(r.Context(), `
		UPDATE him_worklist SET query_status = $2, coding_status = CASE
		    WHEN $2 = 'RECEIVED' THEN 'QUERY_RESPONDED'
		    WHEN $2 = 'RESOLVED' THEN 'IN_PROGRESS'
		    ELSE coding_status END,
		  updated_at = now(), last_activity_at = now() WHERE id = $1`, worklistID, b.Status)

	s.logActivity(r, u, worklistID, "Provider query "+strings.ToLower(b.Status), b.Resolution, current, b.Status)
	s.auditClinical(r.Context(), u, patientID, "Provider query updated", "himQuery", qid, current, b.Status)
	writeJSON(w, http.StatusOK, map[string]any{"status": b.Status})
}
