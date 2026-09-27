package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"strings"
	"time"
)

// Medication dose and duration changes.
//
// Adding a medication still goes through the collections API, exactly as before. What is new is
// changing one AFTER it was submitted, and that deliberately does NOT go through the collections
// API: a plain update would overwrite the old dose, and section 46 requires the old dose to survive.
// So a change is its own endpoint that writes a history row and the new value together, in one
// transaction, or neither.
//
// Nothing here judges whether a dose is appropriate. The application has no drug database, and a
// dose check it invented could be trusted by the person reading it. The prescriber decides; this
// records what they decided, when, why, and that they were the one who decided it.

//go:embed migrations/017_medication_changes.sql
var medicationSchemaSQL string

func (s *Server) ensureMedicationSchema(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, medicationSchemaSQL); err != nil {
		return fmt.Errorf("medication schema: %w", err)
	}
	return nil
}

// validDurationDays enforces section 43 on the SERVER, for both the add path (via writeAllowed) and
// the change path. A positive whole number of days, with a ceiling that catches a typo: ten years
// of a medication entered as 3650 is a real standing order; 36500 is a mistake.
func validDurationDays(v any) (int, string) {
	f, ok := v.(float64)
	if !ok {
		return 0, "the number of days must be a number"
	}
	if f != math.Trunc(f) {
		return 0, "the number of days must be a whole number"
	}
	if f < 1 {
		return 0, "the number of days must be at least 1"
	}
	if f > 3650 {
		return 0, "the number of days cannot be more than 3650"
	}
	return int(f), ""
}

// POST /api/clinical/medications/{id}/change
func (s *Server) handleMedicationChange(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")

	var b struct {
		NewDose         string   `json:"newDose"`
		NewDurationDays *float64 `json:"newDurationDays"`
		EffectiveDate   string   `json:"effectiveDate"`
		Reason          string   `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}

	var patientID, name, dose, status, startDate string
	var duration *float64
	if err := s.db.QueryRow(r.Context(), `
		SELECT coalesce(patient_id,''), name, dose, status, start_date, duration_days::float8
		  FROM medications WHERE id = $1`, id).
		Scan(&patientID, &name, &dose, &status, &startDate, &duration); err != nil {
		writeErr(w, http.StatusNotFound, "medication not found")
		return
	}

	var problems []string
	if status != "Active" {
		problems = append(problems,
			"this medication is "+strings.ToLower(status)+" - only an active medication can have its dose changed")
	}

	newDose := strings.TrimSpace(b.NewDose)
	doseChanged := newDose != "" && newDose != dose

	var newDuration *int
	if b.NewDurationDays != nil {
		d, why := validDurationDays(*b.NewDurationDays)
		if why != "" {
			problems = append(problems, why)
		} else {
			newDuration = &d
		}
	}
	durationChanged := newDuration != nil && (duration == nil || int(*duration) != *newDuration)

	if !doseChanged && !durationChanged && len(problems) == 0 {
		problems = append(problems, "nothing was changed - enter a new dose, a new number of days, or both")
	}

	effective, ok := parseDate(b.EffectiveDate)
	if !ok {
		problems = append(problems, "an effective date is required")
	} else if start, ok := parseDate(startDate); ok && effective.Before(start) {
		problems = append(problems, "the effective date cannot be before the medication was started")
	}

	// A reason is required. A dose change with no recorded reason is exactly the kind of history
	// section 46 exists to prevent: the fact of the change survives, and why it happened does not.
	if strings.TrimSpace(b.Reason) == "" {
		problems = append(problems, "a reason for the change is required")
	}

	if len(problems) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error": "the change was not saved", "problems": problems,
		})
		return
	}

	// Section 48. A prescription for this medication that has actually reached a pharmacy must not
	// be altered by editing the medication list - the pharmacy would still hold the old one. Matched
	// by patient and medication name, because prescriptions carry no medication id.
	var transmitted int
	_ = s.db.QueryRow(r.Context(), `
		SELECT count(*) FROM prescriptions
		 WHERE patient_id = $1 AND lower(medication) = lower($2)
		   AND status IN ('SUBMITTED', 'ACCEPTED')`, patientID, name).Scan(&transmitted)
	if transmitted > 0 {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "a prescription for " + name + " has already been sent to a pharmacy. Changing the " +
				"medication list would not change what the pharmacy holds. Cancel or replace the " +
				"prescription from Rx instead.",
		})
		return
	}

	changeType := "DOSE_AND_DURATION"
	switch {
	case doseChanged && !durationChanged:
		changeType = "DOSE"
	case durationChanged && !doseChanged:
		changeType = "DURATION"
	}

	finalDose := dose
	if doseChanged {
		finalDose = newDose
	}
	var oldDur, newDur any
	if duration != nil {
		oldDur = int(*duration)
	}
	newDur = oldDur
	if durationChanged {
		newDur = *newDuration
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the change")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	if _, err := tx.Exec(r.Context(), `
		INSERT INTO medication_changes (id, medication_id, patient_id, change_type,
		  old_dose, new_dose, old_duration_days, new_duration_days,
		  effective_date, reason, changed_by, changed_by_name)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		"MCH"+newUID(), id, nullable(patientID), changeType,
		dose, finalDose, oldDur, newDur,
		effective, clip(strings.TrimSpace(b.Reason), 1000), u.UID, u.Name); err != nil {
		log.Printf("medications: history write failed: %v", err)
		writeErr(w, http.StatusInternalServerError, "could not save the change")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE medications SET dose = $2, duration_days = $3 WHERE id = $1`,
		id, finalDose, newDur); err != nil {
		log.Printf("medications: update failed: %v", err)
		writeErr(w, http.StatusInternalServerError, "could not save the change")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the change")
		return
	}
	// This wrote to medications directly rather than through the collections API, so it has to
	// announce the change itself - otherwise every open chart keeps showing the old dose.
	s.hub.broadcast("medications")

	// Audited with the values, because the values ARE the event. The reason is not repeated into
	// the general audit log - it lives in the medication history, where access is controlled.
	action := map[string]string{
		"DOSE": "Medication dose changed", "DURATION": "Medication duration changed",
		"DOSE_AND_DURATION": "Medication dose and duration changed",
	}[changeType]
	s.auditClinical(r.Context(), u, patientID, action, "medication", id,
		fmt.Sprintf("%s, %v days", dose, oldDur), fmt.Sprintf("%s, %v days", finalDose, newDur))

	writeJSON(w, http.StatusOK, map[string]any{
		"saved": true, "changeType": changeType, "dose": finalDose, "durationDays": newDur,
	})
}

// GET /api/clinical/medications/{id}/history
func (s *Server) handleMedicationHistory(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	var name, dose, startDate string
	var duration *float64
	if err := s.db.QueryRow(r.Context(),
		`SELECT name, dose, start_date, duration_days::float8 FROM medications WHERE id = $1`, id).
		Scan(&name, &dose, &startDate, &duration); err != nil {
		writeErr(w, http.StatusNotFound, "medication not found")
		return
	}

	rows, err := s.db.Query(r.Context(), `
		SELECT change_type, old_dose, new_dose, old_duration_days, new_duration_days,
		       effective_date, reason, changed_by_name, changed_at
		  FROM medication_changes WHERE medication_id = $1 ORDER BY changed_at, id`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the medication history")
		return
	}
	defer rows.Close()

	changes := []map[string]any{}
	for rows.Next() {
		var kind, oldDose, newDose, reason, by string
		var oldDur, newDur *int
		var eff time.Time
		var at time.Time
		if rows.Scan(&kind, &oldDose, &newDose, &oldDur, &newDur, &eff, &reason, &by, &at) != nil {
			continue
		}
		row := map[string]any{
			"changeType": kind, "oldDose": oldDose, "newDose": newDose,
			"effectiveDate": eff.Format("2006-01-02"), "reason": reason,
			"changedBy": by, "changedAt": at.Format(time.RFC3339),
		}
		if oldDur != nil {
			row["oldDurationDays"] = *oldDur
		}
		if newDur != nil {
			row["newDurationDays"] = *newDur
		}
		changes = append(changes, row)
	}

	// The ORIGINAL order, reconstructed rather than stored: before the first change it is simply
	// the current values; after it, it is what the first change recorded as "old". Nothing needs
	// to have been captured at the time for this to be exact.
	original := map[string]any{"dose": dose, "startDate": startDate}
	if duration != nil {
		original["durationDays"] = int(*duration)
	}
	if len(changes) > 0 {
		original["dose"] = changes[0]["oldDose"]
		delete(original, "durationDays")
		if v, ok := changes[0]["oldDurationDays"]; ok {
			original["durationDays"] = v
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"medication": name, "original": original, "changes": changes,
		"current": map[string]any{"dose": dose, "durationDays": derefFloat(duration)},
	})
}

func derefFloat(p *float64) any {
	if p == nil {
		return nil
	}
	return int(*p)
}
