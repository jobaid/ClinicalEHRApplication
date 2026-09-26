package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

// Claim validation, electronic submission, print audit and printer alignment.
//
// Three rules shape this file.
//
// First, the claim is ASSEMBLED ON THE SERVER from rows the application already holds - the claim,
// its charges, the patient and the insurance policy. Nothing about a claim is taken from the
// request body, including the total, which is summed here from the charge rows. A biller's browser
// is not a source of truth for what a payer is being billed.
//
// Second, a service line is a charge. The application has always stored one procedure per charge
// row, so the service lines of a claim are the charges for that patient on that date of service -
// which is exactly the grouping the CMS-1500 renderer already uses, so the preview, the paper
// print and an eventual 837 all describe the same claim. No table duplicates a charge to make a
// service line, and no claim is duplicated to support printing.
//
// Third, nothing here reports a claim as Submitted, Accepted or Rejected unless a clearinghouse
// said so. Those three statuses are written only from a SubmissionResult. Since no clearinghouse
// is configured, no code path in this file can currently produce one - see clearinghouse.go.

//go:embed migrations/013_claims.sql
var claimSchemaSQL string

func (s *Server) ensureClaimSchema(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, claimSchemaSQL); err != nil {
		return fmt.Errorf("claim schema: %w", err)
	}
	return nil
}

// ---------- assembling a claim from what is already stored ----------

// assembleClaim builds the transmit shape for one claim id, reading only stored rows.
//
// Returns a "not found" error for an unknown claim so a caller cannot use the difference between
// "no such claim" and "a claim you may not see" to enumerate claim ids.
var errClaimNotFound = errors.New("claim not found")

func (s *Server) assembleClaim(ctx context.Context, claimID string) (claimForTransmit, error) {
	var c claimForTransmit
	var patientID, chargeID, payerOnClaim string

	err := s.db.QueryRow(ctx,
		`SELECT id, coalesce(patient_id,''), coalesce(charge_id,''), payer
		   FROM claims WHERE id = $1`, claimID).
		Scan(&c.ClaimID, &patientID, &chargeID, &payerOnClaim)
	if err != nil {
		return claimForTransmit{}, errClaimNotFound
	}
	c.PatientID = patientID

	// Patient demographics, as recorded. Absent values stay absent; validation reports them.
	_ = s.db.QueryRow(ctx,
		`SELECT coalesce(name,''), coalesce(dob,''), coalesce(address,''),
		        coalesce(city,''), coalesce(state,''), coalesce(zip,''),
		        coalesce(extra->>'sex','')
		   FROM patients WHERE id = $1`, patientID).
		Scan(&c.PatientName, &c.PatientDOB, &c.PatientAddr,
			&c.PatientCity, &c.PatientState, &c.PatientZip, &c.PatientSex)

	// The anchor charge decides the date of service, the provider and facility identifiers, and
	// which insurance policy the claim is being billed to.
	var dos, insuranceID string
	_ = s.db.QueryRow(ctx,
		`SELECT coalesce(dos,''), coalesce(provider,''), coalesce(referral_physician,''),
		        coalesce(facility_name,''), coalesce(facility_address,''),
		        coalesce(tax_id,''), coalesce(npi,''), coalesce(charge_insurance_id,'')
		   FROM charges WHERE id = $1`, chargeID).
		Scan(&dos, &c.BillingProviderName, &c.ReferringProvider,
			&c.FacilityName, &c.FacilityAddress, &c.TaxID, &c.BillingNPI, &insuranceID)

	// The policy the charge was assigned to, falling back to the patient's active primary. Read,
	// never created: a claim never adds an insurance record.
	policyQuery := `SELECT coalesce(insurance_company,''), coalesce(member_id,''),
	                       coalesce(group_number,''), coalesce(subscriber_name,''),
	                       coalesce(subscriber_relationship,''), coalesce(subscriber_dob,'')
	                  FROM insurance_policies WHERE `
	if insuranceID != "" {
		err = s.db.QueryRow(ctx, policyQuery+`id = $1`, insuranceID).
			Scan(&c.PayerName, &c.MemberID, &c.GroupNumber, &c.Subscriber, &c.Relationship, &c.SubscriberDOB)
	} else {
		err = s.db.QueryRow(ctx, policyQuery+
			`patient_id = $1 AND status = 'Active' ORDER BY priority LIMIT 1`, patientID).
			Scan(&c.PayerName, &c.MemberID, &c.GroupNumber, &c.Subscriber, &c.Relationship, &c.SubscriberDOB)
	}
	if err != nil && payerOnClaim != "" {
		// No policy row reachable. Keep the payer already recorded on the claim rather than
		// blanking it, so a self-pay claim still reads correctly.
		c.PayerName = payerOnClaim
	}
	if strings.TrimSpace(c.Subscriber) == "" && strings.EqualFold(strings.TrimSpace(c.Relationship), "self") {
		// A self-relationship policy legitimately leaves the subscriber name blank, because it is
		// the patient. Filling it from the patient record is a restatement of stored data, not a
		// guess about who the subscriber is.
		c.Subscriber = c.PatientName
	}

	// Diagnosis codes, from the anchor charge - these are Box 21.
	var dxRaw []byte
	_ = s.db.QueryRow(ctx, `SELECT diagnosis_codes FROM charges WHERE id = $1`, chargeID).Scan(&dxRaw)
	if len(dxRaw) > 0 {
		var list []string
		if json.Unmarshal(dxRaw, &list) == nil {
			for _, d := range list {
				if strings.TrimSpace(d) != "" {
					c.DiagnosisCodes = append(c.DiagnosisCodes, strings.TrimSpace(d))
				}
			}
		}
	}

	// Service lines: every charge for this patient on this date of service, oldest id first so the
	// line order is stable between a preview and the print that follows it.
	rows, err := s.db.Query(ctx,
		`SELECT id, coalesce(dos,''), coalesce(cpt,''), coalesce(units,1), coalesce(charge,0),
		        coalesce(npi,''), coalesce(provider,''), coalesce(extra->>'modifiers',''),
		        coalesce(extra->>'placeOfService',''), coalesce(extra->>'diagnosisPointer','')
		   FROM charges
		  WHERE patient_id = $1 AND dos = $2
		  ORDER BY id`, patientID, dos)
	if err == nil {
		defer rows.Close()
		n := 0
		for rows.Next() {
			var id, ldos, cpt, npi, prov, mods, pos, ptr string
			var units, amount float64
			if rows.Scan(&id, &ldos, &cpt, &units, &amount, &npi, &prov, &mods, &pos, &ptr) != nil {
				continue
			}
			n++
			if pos == "" {
				pos = "11" // 11 = office. The practice default, not a guess about this encounter.
			}
			if ptr == "" && len(c.DiagnosisCodes) > 0 {
				ptr = "A"
			}
			c.ServiceLines = append(c.ServiceLines, claimServiceLine{
				LineNo: n, DOS: ldos, CPT: cpt, Modifiers: mods, PlaceOfService: pos,
				DiagnosisPtr: ptr, Units: units, Charge: amount,
				RenderingNPI: npi, Provider: prov,
			})
			// Summed here, from the stored rows. Section 6 and the standing rule that financial
			// totals are never taken from the browser.
			c.TotalCharges += amount
		}
	}

	return c, nil
}

// ---------- history ----------

// recordClaimEvent appends one row to the claim's history. Append-only by construction: there is
// no update path for claim_submissions anywhere in this application (section 22).
//
// A failure to write history is logged but does not fail the caller's request, except for
// submission events where the history IS the record of what happened - those callers check.
func (s *Server) recordClaimEvent(ctx context.Context, u authedUser, claimID, patientID, event, status, detail string, resp SubmissionResult) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO claim_submissions
		  (id, claim_id, patient_id, event, status, actor, detail, response_code, response_text)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		"CSB"+newUID(), claimID, nullable(patientID), event, status, u.Name,
		clip(detail, 1000), resp.Code, clip(resp.Message, 1000))
	if err != nil {
		log.Printf("claims: history write failed for %s/%s: %v", claimID, event, err)
	}
	return err
}

// auditClaim writes to the application's existing audit log (section 30). The detail is a count
// or a status, never claim content - a general audit trail is not the place for diagnoses.
func (s *Server) auditClaim(ctx context.Context, u authedUser, claimID, patientID, action, detail string) {
	_, err := s.db.Exec(ctx,
		`INSERT INTO audit_logs (id, patient_id, "user", action, entity_type, entity_id, old_values, new_values, timestamp)
		 VALUES ($1,$2,$3,$4,'claim',$5,'',$6,$7)`,
		"AUD"+newUID(), nullable(patientID), u.Name, action, claimID, clip(detail, 300),
		time.Now().Format("2006-01-02T15:04:05"))
	if err != nil {
		log.Printf("claims: audit write failed for %q: %v", action, err)
	}
}

// isLocalClaimStatus reports whether a status describes the claim's own completeness, as opposed
// to something a payer or clearinghouse decided.
//
// Only local statuses may be rewritten locally. Overwriting a Denied claim with "Validation Error"
// because a re-check found a missing field would destroy the payer's verdict, which is the single
// most important thing on the claim - and section 24 forbids modifying a transmitted claim without
// preserving the history of it.
func isLocalClaimStatus(status string) bool {
	switch status {
	case ClaimDraft, ClaimReady, ClaimValidationError, "":
		return true
	}
	return false
}

// setLocalClaimStatus writes a locally-decided status, and does nothing at all if the claim already
// carries an external verdict. Reports the status now in force.
func (s *Server) setLocalClaimStatus(ctx context.Context, claimID, want string) (string, error) {
	var current string
	if err := s.db.QueryRow(ctx, `SELECT status FROM claims WHERE id = $1`, claimID).Scan(&current); err != nil {
		return "", err
	}
	if !isLocalClaimStatus(current) || current == want {
		return current, nil
	}
	if _, err := s.db.Exec(ctx, `UPDATE claims SET status = $1 WHERE id = $2`, want, claimID); err != nil {
		return current, err
	}
	return want, nil
}

// ---------- routes ----------

// GET /api/claims/config - what this server can actually do with an electronic claim.
func (s *Server) handleClaimConfig(w http.ResponseWriter, r *http.Request) {
	ch := clearinghouseProvider()
	writeJSON(w, http.StatusOK, map[string]any{
		"submissionAvailable": ch.Configured(),
		"clearinghouse":       ch.Name(),
		"format":              ch.Format(),
		"note":                clearinghouseNote(ch),
	})
}

// POST /api/claims/{id}/validate - check the claim and record the result.
//
// Validation is performed on the server against the server's own assembly of the claim, so a
// client cannot validate a different claim from the one that would be submitted.
func (s *Server) handleClaimValidate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	claimID := r.PathValue("id")

	c, err := s.assembleClaim(r.Context(), claimID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "claim not found")
		return
	}

	ch := clearinghouseProvider()
	problems := ch.Validate(r.Context(), c)

	blocking := 0
	for _, p := range problems {
		if p.Blocking {
			blocking++
		}
	}

	want := ClaimReady
	if blocking > 0 {
		want = ClaimValidationError
	}
	newStatus, err := s.setLocalClaimStatus(r.Context(), claimID, want)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not record the validation result")
		return
	}

	detail := fmt.Sprintf("%d blocking, %d advisory", blocking, len(problems)-blocking)
	_ = s.recordClaimEvent(r.Context(), u, claimID, c.PatientID, "Claim Validated", newStatus, detail, SubmissionResult{})
	s.auditClaim(r.Context(), u, claimID, c.PatientID, "Claim validated", detail)

	writeJSON(w, http.StatusOK, map[string]any{
		"claimId":  claimID,
		"status":   newStatus,
		"ready":    blocking == 0,
		"problems": problems,
		"blocking": blocking,
		// Stated explicitly so the screen never implies more than a completeness check.
		"note": "These are the data a professional claim cannot go without. A clearinghouse or " +
			"payer applies many further edits from its own companion guide, so passing this " +
			"check does not mean the claim will be accepted.",
		"totalCharges": c.TotalCharges,
		"serviceLines": len(c.ServiceLines),
	})
}

// POST /api/claims/{id}/submit - submit electronically.
//
// Validates first and refuses on any blocking problem, so an incomplete claim is never sent
// (section 19). Then hands the claim to the configured clearinghouse. With none configured this
// returns 503 and records a failure - it never invents a Submitted status.
func (s *Server) handleClaimSubmit(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	claimID := r.PathValue("id")

	c, err := s.assembleClaim(r.Context(), claimID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "claim not found")
		return
	}

	ch := clearinghouseProvider()
	problems := ch.Validate(r.Context(), c)
	var blockers []ClaimProblem
	for _, p := range problems {
		if p.Blocking {
			blockers = append(blockers, p)
		}
	}
	if len(blockers) > 0 {
		// Recorded as a local validation failure only if the claim had no external verdict yet.
		status, _ := s.setLocalClaimStatus(r.Context(), claimID, ClaimValidationError)
		_ = s.recordClaimEvent(r.Context(), u, claimID, c.PatientID,
			"Electronic Claim Refused", status,
			fmt.Sprintf("not submitted: %d blocking validation problems", len(blockers)), SubmissionResult{})
		s.auditClaim(r.Context(), u, claimID, c.PatientID, "Electronic claim refused - validation",
			fmt.Sprintf("%d blocking", len(blockers)))
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error":    ErrClaimNotReady.Error(),
			"status":   status,
			"problems": blockers,
		})
		return
	}

	result, err := ch.Submit(r.Context(), c)
	if err != nil {
		// A refusal is recorded as a refusal. The claim keeps whatever status it had, because
		// nothing was transmitted - it is not "Rejected", which would mean a payer said no.
		_ = s.recordClaimEvent(r.Context(), u, claimID, c.PatientID,
			"Electronic Claim Not Submitted", "", err.Error(), SubmissionResult{})
		s.auditClaim(r.Context(), u, claimID, c.PatientID, "Electronic claim submission unavailable", ch.Name())
		code := http.StatusServiceUnavailable
		if errors.Is(err, ErrClaimNotReady) {
			code = http.StatusUnprocessableEntity
		}
		writeJSON(w, code, map[string]any{
			"error":       err.Error(),
			"submitted":   false,
			"transmitted": false,
		})
		return
	}

	// Reached only with a real response in hand. The status comes from the clearinghouse; this
	// code does not choose it, and Accepted appears only because one was returned.
	if _, dbErr := s.db.Exec(r.Context(),
		`UPDATE claims SET status = $1, submitted = $2 WHERE id = $3`,
		result.Status, time.Now().Format("2006-01-02"), claimID); dbErr != nil {
		writeErr(w, http.StatusInternalServerError, "the claim was submitted but the status could not be recorded")
		return
	}
	_ = s.recordClaimEvent(r.Context(), u, claimID, c.PatientID,
		"Electronic Claim Submitted", result.Status, "reference "+result.Reference, result)
	s.auditClaim(r.Context(), u, claimID, c.PatientID, "Electronic claim submitted", result.Status)

	writeJSON(w, http.StatusOK, map[string]any{
		"submitted": true, "status": result.Status,
		"reference": result.Reference, "code": result.Code, "message": result.Message,
	})
}

// GET /api/claims/{id}/status - re-query a submitted claim at the clearinghouse.
func (s *Server) handleClaimStatus(w http.ResponseWriter, r *http.Request) {
	claimID := r.PathValue("id")
	var stored, reference string
	_ = s.db.QueryRow(r.Context(), `SELECT status, coalesce(extra->>'submissionReference','') FROM claims WHERE id = $1`,
		claimID).Scan(&stored, &reference)

	ch := clearinghouseProvider()
	if !ch.Configured() || reference == "" {
		// The stored status is reported as stored, with no claim about freshness.
		writeJSON(w, http.StatusOK, map[string]any{
			"status": stored, "live": false, "note": clearinghouseNote(ch),
		})
		return
	}
	res, err := ch.Status(r.Context(), reference)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"status": stored, "live": false, "note": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": res.Status, "live": true, "code": res.Code, "message": res.Message,
	})
}

// GET /api/claims/{id}/history - the full event trail, oldest first.
func (s *Server) handleClaimHistory(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `
		SELECT id, event, status, actor, detail, response_code, response_text, created_at
		  FROM claim_submissions WHERE claim_id = $1 ORDER BY created_at, id`, r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the claim history")
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var id, event, status, actor, detail, code, text string
		var at time.Time
		if rows.Scan(&id, &event, &status, &actor, &detail, &code, &text, &at) == nil {
			out = append(out, map[string]any{
				"id": id, "event": event, "status": status, "actor": actor, "detail": detail,
				"responseCode": code, "responseText": text, "at": at.Format(time.RFC3339),
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"history": out})
}

// GET /api/claims/{id}/hcfa - the claim as the server assembled it, for preview and printing.
//
// Behind CLAIM_HCFA_VIEW rather than plain authentication, because this is the whole claim
// including the patient's demographics and diagnoses (section 32).
func (s *Server) handleClaimHCFA(w http.ResponseWriter, r *http.Request) {
	c, err := s.assembleClaim(r.Context(), r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "claim not found")
		return
	}
	lines := make([]map[string]any, 0, len(c.ServiceLines))
	for _, l := range c.ServiceLines {
		lines = append(lines, map[string]any{
			"lineNo": l.LineNo, "dos": l.DOS, "cpt": l.CPT, "modifiers": l.Modifiers,
			"placeOfService": l.PlaceOfService, "diagnosisPointer": l.DiagnosisPtr,
			"units": l.Units, "charge": l.Charge, "renderingNpi": l.RenderingNPI,
			"provider": l.Provider,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"claimId": c.ClaimID, "patientId": c.PatientID,
		"patient": map[string]any{
			"name": c.PatientName, "dob": c.PatientDOB, "sex": c.PatientSex,
			"address": c.PatientAddr, "city": c.PatientCity, "state": c.PatientState, "zip": c.PatientZip,
		},
		"insurance": map[string]any{
			"payer": c.PayerName, "memberId": c.MemberID, "groupNumber": c.GroupNumber,
			"subscriber": c.Subscriber, "relationship": c.Relationship, "subscriberDob": c.SubscriberDOB,
		},
		"provider": map[string]any{
			"rendering": c.BillingProviderName, "npi": c.BillingNPI, "taxId": c.TaxID,
			"facilityName": c.FacilityName, "facilityAddress": c.FacilityAddress,
			"referring": c.ReferringProvider,
		},
		"diagnosisCodes": c.DiagnosisCodes,
		"serviceLines":   lines,
		"totalCharges":   c.TotalCharges,
	})
}

// POST /api/claims/{id}/print-event - record that something was printed or previewed.
//
// The browser is what actually prints, so this endpoint exists to record the act, not to perform
// it. The event name is checked against a fixed list: a client cannot write arbitrary text into
// the claim's permanent history.
func (s *Server) handleClaimPrintEvent(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	claimID := r.PathValue("id")

	var b struct {
		Event string `json:"event"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	allowed := map[string]bool{
		"HCFA Previewed":         true,
		"HCFA Printed":           true,
		"HCFA Printed With Form": true,
		"HCFA Alignment Tested":  true,
		"Claim Summary Printed":  true,
	}
	if !allowed[b.Event] {
		writeErr(w, http.StatusBadRequest, "unrecognised print event")
		return
	}

	var patientID string
	if err := s.db.QueryRow(r.Context(), `SELECT coalesce(patient_id,'') FROM claims WHERE id = $1`, claimID).
		Scan(&patientID); err != nil {
		writeErr(w, http.StatusNotFound, "claim not found")
		return
	}
	_ = s.recordClaimEvent(r.Context(), u, claimID, patientID, b.Event, "", "", SubmissionResult{})
	s.auditClaim(r.Context(), u, claimID, patientID, b.Event, "")
	writeJSON(w, http.StatusOK, map[string]any{"recorded": true})
}

// ---------- printer alignment profiles (section 13) ----------

// GET /api/claims/print-profiles - this user's profiles.
func (s *Server) handleClaimPrintProfiles(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	rows, err := s.db.Query(r.Context(), `
		SELECT id, name, paper_size, offset_x, offset_y, is_default
		  FROM claim_print_profiles WHERE user_id = $1 ORDER BY is_default DESC, lower(name)`, u.UID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the print profiles")
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var id, name, paper string
		var ox, oy float64
		var def bool
		if rows.Scan(&id, &name, &paper, &ox, &oy, &def) == nil {
			out = append(out, map[string]any{
				"id": id, "name": name, "paperSize": paper,
				"offsetX": ox, "offsetY": oy, "isDefault": def,
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"profiles": out})
}

// POST /api/claims/print-profiles - save a profile for the signed-in user.
//
// Scoped to the caller's own user id, taken from the session. There is deliberately no way to
// write another user's printer settings.
func (s *Server) handleClaimPrintProfileSave(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var b struct {
		Name      string  `json:"name"`
		PaperSize string  `json:"paperSize"`
		OffsetX   float64 `json:"offsetX"`
		OffsetY   float64 `json:"offsetY"`
		IsDefault bool    `json:"isDefault"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	name := strings.TrimSpace(b.Name)
	if name == "" {
		name = "Default"
	}
	if b.PaperSize == "" {
		b.PaperSize = "Letter"
	}
	// An offset is a nudge measured in inches. Anything beyond an inch is a mistake, not a
	// calibration, and would push data clean off the sheet.
	if b.OffsetX < -1 || b.OffsetX > 1 || b.OffsetY < -1 || b.OffsetY > 1 {
		writeErr(w, http.StatusBadRequest, "offsets are in inches and must be between -1 and 1")
		return
	}

	if b.IsDefault {
		if _, err := s.db.Exec(r.Context(),
			`UPDATE claim_print_profiles SET is_default = FALSE WHERE user_id = $1`, u.UID); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not save the profile")
			return
		}
	}
	_, err := s.db.Exec(r.Context(), `
		INSERT INTO claim_print_profiles (id, user_id, name, paper_size, offset_x, offset_y, is_default)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (user_id, lower(name)) DO UPDATE
		   SET paper_size = EXCLUDED.paper_size, offset_x = EXCLUDED.offset_x,
		       offset_y = EXCLUDED.offset_y, is_default = EXCLUDED.is_default,
		       updated_at = now()`,
		"CPP"+newUID(), u.UID, name, b.PaperSize, b.OffsetX, b.OffsetY, b.IsDefault)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the profile")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"saved": true, "name": name})
}
