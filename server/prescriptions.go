package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Prescriptions.
//
// Two rules shape this file.
//
// First, the prescriber is resolved from the authenticated session and their recorded
// credential - never from anything the browser sent. Section 22 asks for exactly that, and a
// prescriberId in a request body is the one field an attacker would most want to choose.
//
// Second, nothing here decides anything clinical. The medication, strength, dose, frequency,
// quantity and duration are what the prescriber typed. There is no suggestion, no default, no
// interaction check and no dose warning, because this application has no licensed drug database
// and a fabricated warning is worse than none - a prescriber could come to rely on it.

//go:embed migrations/012_prescriptions.sql
var prescriptionSchemaSQL string

func (s *Server) ensurePrescriptionSchema(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, prescriptionSchemaSQL); err != nil {
		return fmt.Errorf("prescription schema: %w", err)
	}
	return nil
}

// ---------- prescriber eligibility ----------

type prescriberProfile struct {
	UserID       string `json:"userId"`
	PhysicianID  string `json:"physicianId"`
	NPI          string `json:"npi"`
	StateLicense string `json:"stateLicense"`
	LicenseState string `json:"licenseState"`
	Verified     bool   `json:"verified"`
	VerifiedBy   string `json:"verifiedBy"`
	VerifiedAt   string `json:"verifiedAt"`
	Active       bool   `json:"active"`
}

var errNotAPrescriber = errors.New(
	"this account is not a verified prescriber. Holding the Rx permission allows the software " +
		"to be used; it does not make someone authorised to prescribe. A practice administrator " +
		"must record and verify the prescriber's NPI and state licence first.")

// prescriberFor returns the caller's verified prescriber record, or an error.
//
// Section 19 in one function. An unverified or inactive profile, or none at all, means no. A
// SUPER_ADMIN is NOT exempt: holding every permission in the application does not make somebody
// a clinician, and this is the one place where that distinction has consequences outside the
// software.
func (s *Server) prescriberFor(ctx context.Context, u authedUser) (prescriberProfile, error) {
	var p prescriberProfile
	var verifiedAt *time.Time
	err := s.db.QueryRow(ctx, `
		SELECT user_id, physician_id, npi, state_license, license_state, verified,
		       verified_by, verified_at, active
		  FROM prescriber_profiles WHERE user_id = $1`, u.UID).
		Scan(&p.UserID, &p.PhysicianID, &p.NPI, &p.StateLicense, &p.LicenseState,
			&p.Verified, &p.VerifiedBy, &verifiedAt, &p.Active)
	if err != nil {
		return prescriberProfile{}, errNotAPrescriber
	}
	p.VerifiedAt = tsOrEmpty(verifiedAt)
	if !p.Verified || !p.Active || strings.TrimSpace(p.NPI) == "" {
		return prescriberProfile{}, errNotAPrescriber
	}
	return p, nil
}

// GET /api/rx/prescriber/me - what the signed-in user may do, and why not.
func (s *Server) handleRxPrescriberMe(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	provider := eprescribingProvider()

	out := map[string]any{
		"isPrescriber":          false,
		"reason":                "",
		"transmissionAvailable": provider.Configured(),
		"transmissionProvider":  provider.Name(),
		"transmissionNote":      erxStatusNote(provider),
	}
	if p, err := s.prescriberFor(r.Context(), u); err == nil {
		out["isPrescriber"] = true
		out["prescriber"] = p
	} else {
		out["reason"] = err.Error()
	}
	writeJSON(w, http.StatusOK, out)
}

// ---------- pharmacies ----------

// GET /api/rx/pharmacies?search=
//
// Searches the pharmacies this practice has recorded. It is an address book, not a directory
// service: a real pharmacy directory comes with the e-prescribing network, and until one is
// configured the NCPDP identifier that makes a pharmacy reachable stays empty.
func (s *Server) handleRxPharmacySearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("search"))
	args := []any{}
	where := "active"
	if q != "" {
		args = append(args, q)
		where += " AND (name ILIKE '%'||$1||'%' OR city ILIKE '%'||$1||'%' OR zip ILIKE '%'||$1||'%')"
	}
	rows, err := s.db.Query(r.Context(),
		`SELECT id, name, address, city, state, zip, phone, fax, ncpdp_id, source
		   FROM pharmacies WHERE `+where+` ORDER BY lower(name) LIMIT 50`, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not search pharmacies")
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var id, name, addr, city, st, zip, phone, fax, ncpdp, src string
		if rows.Scan(&id, &name, &addr, &city, &st, &zip, &phone, &fax, &ncpdp, &src) == nil {
			out = append(out, map[string]any{
				"id": id, "name": name, "address": addr, "city": city, "state": st,
				"zip": zip, "phone": phone, "fax": fax, "ncpdpId": ncpdp, "source": src,
				// Stated per row so the interface can show which pharmacies could actually
				// receive an electronic prescription, rather than implying all of them could.
				"transmittable": ncpdp != "",
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"pharmacies": out})
}

// POST /api/rx/pharmacies - record a pharmacy by hand.
func (s *Server) handleRxPharmacyCreate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var b struct {
		Name, Address, City, State, Zip, Phone, Fax, NCPDPID string
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	if strings.TrimSpace(b.Name) == "" {
		writeErr(w, http.StatusBadRequest, "a pharmacy name is required")
		return
	}
	id := "PH" + newUID()
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO pharmacies (id, name, address, city, state, zip, phone, fax, ncpdp_id, source, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',$10)`,
		id, b.Name, b.Address, b.City, b.State, b.Zip, b.Phone, b.Fax,
		strings.TrimSpace(b.NCPDPID), u.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the pharmacy")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

// GET/PUT /api/rx/patients/{id}/pharmacy - the patient's preferred pharmacy.
func (s *Server) handleRxPreferredPharmacy(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	patientID := r.PathValue("id")

	if r.Method == http.MethodGet {
		var id, name, addr, city, st, zip, phone, ncpdp string
		err := s.db.QueryRow(r.Context(), `
			SELECT ph.id, ph.name, ph.address, ph.city, ph.state, ph.zip, ph.phone, ph.ncpdp_id
			  FROM patient_pharmacies pp JOIN pharmacies ph ON ph.id = pp.pharmacy_id
			 WHERE pp.patient_id = $1`, patientID).
			Scan(&id, &name, &addr, &city, &st, &zip, &phone, &ncpdp)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"pharmacy": nil})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"pharmacy": map[string]any{
			"id": id, "name": name, "address": addr, "city": city, "state": st,
			"zip": zip, "phone": phone, "ncpdpId": ncpdp, "transmittable": ncpdp != "",
		}})
		return
	}

	var b struct {
		PharmacyID string `json:"pharmacyId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	var exists bool
	if err := s.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM pharmacies WHERE id = $1 AND active)`, b.PharmacyID).Scan(&exists); err != nil || !exists {
		writeErr(w, http.StatusBadRequest, "no such pharmacy")
		return
	}
	// Section 6: this rewrites one row. Prescriptions carry their own pharmacy reference, so
	// changing the preference never touches prescription history.
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO patient_pharmacies (patient_id, pharmacy_id, updated_by, updated_at)
		VALUES ($1,$2,$3,now())
		ON CONFLICT (patient_id) DO UPDATE
		  SET pharmacy_id = EXCLUDED.pharmacy_id, updated_by = EXCLUDED.updated_by, updated_at = now()`,
		patientID, b.PharmacyID, u.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the preferred pharmacy")
		return
	}
	s.auditClinical(r.Context(), u, patientID, "Pharmacy changed", "prescription", "", "", b.PharmacyID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------- prescriptions ----------

type prescription struct {
	ID         string `json:"id"`
	PatientID  string `json:"patientId"`
	Medication string `json:"medication"`
	Strength   string `json:"strength"`
	Dose       string `json:"dose"`
	Route      string `json:"route"`
	Frequency  string `json:"frequency"`
	Quantity   string `json:"quantity"`
	DaysSupply string `json:"daysSupply"`
	Refills    string `json:"refills"`
	StartDate  string `json:"startDate"`
	SIG        string `json:"sig"`
	Notes      string `json:"notes"`

	IsControlled bool `json:"isControlled"`

	PharmacyID   string `json:"pharmacyId"`
	PharmacyName string `json:"pharmacyName"`

	PrescriberName string `json:"prescriberName"`
	PrescriberNPI  string `json:"prescriberNpi"`

	Status   string `json:"status"`
	SignedBy string `json:"signedBy"`
	SignedAt string `json:"signedAt"`

	TransmissionProvider string `json:"transmissionProvider"`
	TransmissionRef      string `json:"transmissionRef"`
	TransmissionError    string `json:"transmissionError"`
	TransmittedAt        string `json:"transmittedAt"`

	CancelledReason string `json:"cancelledReason"`
	CreatedBy       string `json:"createdBy"`
	CreatedAt       string `json:"createdAt"`
}

const rxColumns = `p.id, p.patient_id, p.medication, p.strength, p.dose, p.route, p.frequency,
	p.quantity, p.days_supply, p.refills, p.start_date, p.sig, p.notes, p.is_controlled,
	p.pharmacy_id, COALESCE(ph.name,''), p.prescriber_name, p.prescriber_npi, p.status,
	p.signed_by, p.signed_at, p.transmission_provider, p.transmission_ref, p.transmission_error,
	p.transmitted_at, p.cancelled_reason, p.created_by, p.created_at`

func scanRx(scan func(...any) error) (prescription, error) {
	var x prescription
	var signedAt, transmittedAt *time.Time
	var createdAt time.Time
	err := scan(&x.ID, &x.PatientID, &x.Medication, &x.Strength, &x.Dose, &x.Route, &x.Frequency,
		&x.Quantity, &x.DaysSupply, &x.Refills, &x.StartDate, &x.SIG, &x.Notes, &x.IsControlled,
		&x.PharmacyID, &x.PharmacyName, &x.PrescriberName, &x.PrescriberNPI, &x.Status,
		&x.SignedBy, &signedAt, &x.TransmissionProvider, &x.TransmissionRef, &x.TransmissionError,
		&transmittedAt, &x.CancelledReason, &x.CreatedBy, &createdAt)
	if err != nil {
		return prescription{}, err
	}
	x.SignedAt, x.TransmittedAt = tsOrEmpty(signedAt), tsOrEmpty(transmittedAt)
	x.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	return x, nil
}

// GET /api/rx/patients/{id}/prescriptions
func (s *Server) handleRxList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(),
		`SELECT `+rxColumns+` FROM prescriptions p
		   LEFT JOIN pharmacies ph ON ph.id = p.pharmacy_id
		  WHERE p.patient_id = $1 ORDER BY p.created_at DESC LIMIT 200`, r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read prescriptions")
		return
	}
	defer rows.Close()
	out := []prescription{}
	for rows.Next() {
		if x, err := scanRx(rows.Scan); err == nil {
			out = append(out, x)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"prescriptions": out})
}

// POST /api/rx/patients/{id}/prescriptions - create a draft.
func (s *Server) handleRxCreate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	patientID := r.PathValue("id")

	if !s.patientExists(r.Context(), patientID) {
		writeErr(w, http.StatusNotFound, "no such patient")
		return
	}

	var b prescription
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	if strings.TrimSpace(b.Medication) == "" {
		writeErr(w, http.StatusBadRequest, "a medication is required")
		return
	}

	id := "RX" + newUID()
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO prescriptions
		  (id, patient_id, medication, strength, dose, route, frequency, quantity, days_supply,
		   refills, start_date, sig, notes, is_controlled, pharmacy_id, status, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'DRAFT',$16)`,
		id, patientID, b.Medication, b.Strength, b.Dose, b.Route, b.Frequency, b.Quantity,
		b.DaysSupply, b.Refills, b.StartDate, b.SIG, b.Notes, b.IsControlled, b.PharmacyID,
		u.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create the prescription")
		return
	}

	s.rxHistory(r, u, id, "", RxDraft, "created")
	s.auditClinical(r.Context(), u, patientID, "Prescription draft created", "prescription", id, "", b.Medication)
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

// loadRx fetches one prescription scoped to the patient in the path.
func (s *Server) loadRx(r *http.Request) (prescription, bool) {
	x, err := scanRx(s.db.QueryRow(r.Context(),
		`SELECT `+rxColumns+` FROM prescriptions p
		   LEFT JOIN pharmacies ph ON ph.id = p.pharmacy_id
		  WHERE p.id = $1 AND p.patient_id = $2`,
		r.PathValue("rxId"), r.PathValue("id")).Scan)
	return x, err == nil
}

// GET /api/rx/patients/{id}/prescriptions/{rxId}
func (s *Server) handleRxDetail(w http.ResponseWriter, r *http.Request) {
	x, ok := s.loadRx(r)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such prescription for this patient")
		return
	}
	hist := []map[string]any{}
	if rows, err := s.db.Query(r.Context(),
		`SELECT at, from_status, to_status, actor_name, detail
		   FROM prescription_status_history WHERE prescription_id = $1 ORDER BY at DESC`, x.ID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var at time.Time
			var from, to, actor, detail string
			if rows.Scan(&at, &from, &to, &actor, &detail) == nil {
				hist = append(hist, map[string]any{
					"at": at.UTC().Format(time.RFC3339), "from": from, "to": to,
					"actor": actor, "detail": detail,
				})
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"prescription": x, "history": hist})
}

// PUT /api/rx/patients/{id}/prescriptions/{rxId} - edit a DRAFT.
//
// Section 13: a prescription that has been signed or transmitted is never silently rewritten.
// Changing one means cancelling it and writing a new one, which is the workflow a pharmacy
// understands.
func (s *Server) handleRxUpdate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	x, ok := s.loadRx(r)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such prescription for this patient")
		return
	}
	if x.Status != RxDraft && x.Status != RxReadyToSign {
		writeErr(w, http.StatusConflict,
			"this prescription has been signed and cannot be edited. Cancel it and create a new one.")
		return
	}

	var b prescription
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	if _, err := s.db.Exec(r.Context(), `
		UPDATE prescriptions SET medication=$2, strength=$3, dose=$4, route=$5, frequency=$6,
		       quantity=$7, days_supply=$8, refills=$9, start_date=$10, sig=$11, notes=$12,
		       is_controlled=$13, pharmacy_id=$14, updated_at=now()
		 WHERE id=$1`,
		x.ID, b.Medication, b.Strength, b.Dose, b.Route, b.Frequency, b.Quantity, b.DaysSupply,
		b.Refills, b.StartDate, b.SIG, b.Notes, b.IsControlled, b.PharmacyID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update the prescription")
		return
	}
	s.auditClinical(r.Context(), u, x.PatientID, "Prescription updated", "prescription", x.ID, "", b.Medication)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// forTransmit assembles what a provider would need, resolving the pharmacy's network identifier.
func (s *Server) forTransmit(ctx context.Context, x prescription, p prescriberProfile, prescriberName string) prescriptionForTransmit {
	var ncpdp, phName string
	_ = s.db.QueryRow(ctx, `SELECT ncpdp_id, name FROM pharmacies WHERE id = $1`, x.PharmacyID).
		Scan(&ncpdp, &phName)
	return prescriptionForTransmit{
		ID: x.ID, PatientID: x.PatientID, Medication: x.Medication, Strength: x.Strength,
		Dose: x.Dose, Route: x.Route, Frequency: x.Frequency, Quantity: x.Quantity,
		DaysSupply: x.DaysSupply, Refills: x.Refills, SIG: x.SIG,
		IsControlled: x.IsControlled, PharmacyID: x.PharmacyID, PharmacyName: phName,
		PharmacyNCPDPID: ncpdp, PrescriberName: prescriberName, PrescriberNPI: p.NPI,
	}
}

// POST /api/rx/patients/{id}/prescriptions/{rxId}/validate
func (s *Server) handleRxValidate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	x, ok := s.loadRx(r)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such prescription for this patient")
		return
	}
	p, err := s.prescriberFor(r.Context(), u)
	provider := eprescribingProvider()
	problems := provider.Validate(r.Context(), s.forTransmit(r.Context(), x, p, u.Name))
	if err != nil {
		problems = append(problems, err.Error())
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"problems":              problems,
		"transmissionAvailable": provider.Configured(),
		"transmissionNote":      erxStatusNote(provider),
	})
}

// POST /api/rx/patients/{id}/prescriptions/{rxId}/sign
//
// Signing is the act that attaches a prescriber's name. It requires BOTH the RX_SIGN permission
// (enforced on the route) and a verified prescriber profile (enforced here). The prescriber's
// identity is taken from their own record, never from the request.
func (s *Server) handleRxSign(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	x, ok := s.loadRx(r)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such prescription for this patient")
		return
	}
	if x.Status != RxDraft && x.Status != RxReadyToSign {
		writeErr(w, http.StatusConflict, "this prescription has already been signed")
		return
	}

	p, err := s.prescriberFor(r.Context(), u)
	if err != nil {
		writeErr(w, http.StatusForbidden, err.Error())
		return
	}

	provider := eprescribingProvider()
	if problems := provider.Validate(r.Context(), s.forTransmit(r.Context(), x, p, u.Name)); len(problems) > 0 {
		// A pharmacy without a network identifier is reported but does not block signing - a
		// signed prescription can still be printed. Anything else incomplete does block.
		blocking := []string{}
		for _, pr := range problems {
			if !strings.Contains(pr, "NCPDP") {
				blocking = append(blocking, pr)
			}
		}
		if len(blocking) > 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "the prescription is incomplete", "problems": blocking})
			return
		}
	}

	if _, err := s.db.Exec(r.Context(), `
		UPDATE prescriptions SET status=$2, signed_by=$3, signed_at=now(),
		       prescriber_user_id=$4, prescriber_name=$5, prescriber_npi=$6, updated_at=now()
		 WHERE id=$1`, x.ID, RxSigned, u.Name, u.UID, u.Name, p.NPI); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not sign the prescription")
		return
	}

	s.rxHistory(r, u, x.ID, x.Status, RxSigned, "signed by "+u.Name)
	s.auditClinical(r.Context(), u, x.PatientID, "Prescription signed", "prescription", x.ID, x.Status, RxSigned)
	writeJSON(w, http.StatusOK, map[string]any{"status": RxSigned})
}

// POST /api/rx/patients/{id}/prescriptions/{rxId}/send
//
// The only place a prescription can move past SIGNED, and it moves it to whatever the provider
// actually returned. With no provider configured this always fails, loudly and with an
// explanation - section 10 forbids reporting success the backend did not receive.
func (s *Server) handleRxSend(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	x, ok := s.loadRx(r)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such prescription for this patient")
		return
	}
	if x.Status != RxSigned && x.Status != RxFailed {
		writeErr(w, http.StatusConflict, "only a signed prescription can be transmitted")
		return
	}
	p, err := s.prescriberFor(r.Context(), u)
	if err != nil {
		writeErr(w, http.StatusForbidden, err.Error())
		return
	}

	provider := eprescribingProvider()
	res, sendErr := provider.Send(r.Context(), s.forTransmit(r.Context(), x, p, u.Name))

	if sendErr != nil {
		// Recorded as a real failure against the prescription, so the history shows an attempt
		// was made and why it did not succeed.
		_, _ = s.db.Exec(r.Context(), `
			UPDATE prescriptions SET status=$2, transmission_provider=$3, transmission_error=$4,
			       transmitted_at=now(), updated_at=now() WHERE id=$1`,
			x.ID, RxFailed, provider.Name(), clip(sendErr.Error(), 1000))
		s.rxHistory(r, u, x.ID, x.Status, RxFailed, clip(sendErr.Error(), 400))
		s.auditClinical(r.Context(), u, x.PatientID, "Prescription transmission failed", "prescription", x.ID, x.Status, RxFailed)

		status := http.StatusBadGateway
		if errors.Is(sendErr, ErrNoProvider) || errors.Is(sendErr, ErrControlled) {
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, map[string]any{"error": sendErr.Error(), "status": RxFailed})
		return
	}

	// Only a status the provider returned is ever stored.
	if _, err := s.db.Exec(r.Context(), `
		UPDATE prescriptions SET status=$2, transmission_provider=$3, transmission_ref=$4,
		       transmission_error='', transmitted_at=now(), updated_at=now() WHERE id=$1`,
		x.ID, res.Status, provider.Name(), res.Reference); err != nil {
		writeErr(w, http.StatusInternalServerError, "the prescription was transmitted but could not be recorded")
		return
	}
	s.rxHistory(r, u, x.ID, x.Status, res.Status, res.Message)
	s.auditClinical(r.Context(), u, x.PatientID, "Prescription submitted", "prescription", x.ID, x.Status, res.Status)
	writeJSON(w, http.StatusOK, map[string]any{"status": res.Status, "reference": res.Reference})
}

// POST /api/rx/patients/{id}/prescriptions/{rxId}/cancel
func (s *Server) handleRxCancel(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	x, ok := s.loadRx(r)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such prescription for this patient")
		return
	}
	if x.Status == RxCancelled {
		writeErr(w, http.StatusConflict, "this prescription is already cancelled")
		return
	}
	var b struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&b)

	// A prescription that reached a pharmacy must be cancelled through the network, not just
	// marked cancelled here - otherwise the two disagree about what the pharmacy should dispense.
	if x.TransmissionRef != "" {
		provider := eprescribingProvider()
		if _, err := provider.Cancel(r.Context(), x.TransmissionRef, b.Reason); err != nil {
			writeErr(w, http.StatusBadGateway,
				"this prescription was transmitted and the cancellation could not be sent to the pharmacy: "+err.Error())
			return
		}
	}

	if _, err := s.db.Exec(r.Context(), `
		UPDATE prescriptions SET status=$2, cancelled_by=$3, cancelled_at=now(),
		       cancelled_reason=$4, updated_at=now() WHERE id=$1`,
		x.ID, RxCancelled, u.Name, b.Reason); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not cancel the prescription")
		return
	}
	s.rxHistory(r, u, x.ID, x.Status, RxCancelled, b.Reason)
	s.auditClinical(r.Context(), u, x.PatientID, "Prescription cancelled", "prescription", x.ID, x.Status, RxCancelled)
	writeJSON(w, http.StatusOK, map[string]any{"status": RxCancelled})
}

// rxHistory appends to the append-only status trail.
func (s *Server) rxHistory(r *http.Request, u authedUser, rxID, from, to, detail string) {
	_, _ = s.db.Exec(r.Context(), `
		INSERT INTO prescription_status_history
		  (id, prescription_id, from_status, to_status, actor_id, actor_name, detail)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		"RXH"+newUID(), rxID, from, to, u.UID, u.Name, clip(detail, 500))
}
