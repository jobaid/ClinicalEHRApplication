package main

import (
	"fmt"
	"net/http"
	"strings"
	"time"
)

// HIM Coding Worklist.
//
// An "encounter" in this application is a charge: patient, date of service, provider, CPT. There
// is no admissions table, so admit/discharge/encounter type are optional documented fields and
// render as "Not available" when empty rather than being invented.
//
// Procedure codes are validated against the existing cpt_catalog so this module and the billing
// screens agree on what a code means. Diagnosis codes are stored as the coder entered them:
// this application ships no ICD-10 table, and validating against a list that does not exist
// would either reject every real code or accept every typo. That limitation is reported to the
// coder honestly rather than dressed up as validation.

const (
	domainHIMCoding = "him_coding"
	domainHIMQuery  = "him_query"
)

type himItem struct {
	ID           string `json:"id"`
	PatientID    string `json:"patientId"`
	PatientName  string `json:"patientName"`
	MRN          string `json:"mrn"`
	DOB          string `json:"dob"`
	ChargeID     string `json:"chargeId"`
	ClaimID      string `json:"claimId"`
	EncounterRef string `json:"encounterRef"`

	DOS           string `json:"dos"`
	AdmitDate     string `json:"admitDate"`
	DischargeDate string `json:"dischargeDate"`
	EncounterType string `json:"encounterType"`
	Provider      string `json:"provider"`
	Payer         string `json:"payer"`
	Location      string `json:"location"`

	CodingStatus string `json:"codingStatus"`
	QueryStatus  string `json:"queryStatus"`
	Priority     string `json:"priority"`

	AssignedTo     string `json:"assignedTo"`
	AssignedToName string `json:"assignedToName"`
	AssignedAt     string `json:"assignedAt"`

	// Computed from ready_at on read, never stored, so it cannot go stale in the table.
	DaysPending int    `json:"daysPending"`
	AgeBucket   string `json:"ageBucket"`

	ReadyAt      string `json:"readyAt"`
	CompletedAt  string `json:"completedAt"`
	LastActivity string `json:"lastActivity"`
}

// ageBucket groups days pending for the aging report. The boundaries match the specification.
func ageBucket(days int) string {
	switch {
	case days <= 2:
		return "0-2 Days"
	case days <= 5:
		return "3-5 Days"
	case days <= 10:
		return "6-10 Days"
	case days <= 30:
		return "11-30 Days"
	default:
		return "30+ Days"
	}
}

var himSortable = map[string]string{
	"patient":     "p.name",
	"dos":         "h.dos",
	"provider":    "h.provider",
	"payer":       "h.payer",
	"status":      "h.coding_status",
	"query":       "h.query_status",
	"priority":    "h.priority",
	"assigned":    "h.assigned_to_name",
	"daysPending": "h.ready_at",
	"activity":    "h.last_activity_at",
}

// GET /api/him/worklist
func (s *Server) handleHIMList(w http.ResponseWriter, r *http.Request) {
	p := parseListParams(r, "daysPending")
	q := r.URL.Query()
	col := sortColumn(p.Sort, himSortable, "h.ready_at")

	where := []string{"1=1"}
	args := []any{}
	add := func(clause, v string) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(clause, len(args)))
	}

	if p.Search != "" {
		args = append(args, p.Search)
		n := len(args)
		where = append(where, fmt.Sprintf(
			"(p.name ILIKE '%%'||$%d||'%%' OR h.patient_id ILIKE '%%'||$%d||'%%'"+
				" OR h.encounter_ref ILIKE '%%'||$%d||'%%' OR h.provider ILIKE '%%'||$%d||'%%')",
			n, n, n, n))
	}
	if p.Status != "" {
		add("h.coding_status = $%d", p.Status)
	}
	if p.Priority != "" {
		add("h.priority = $%d", p.Priority)
	}
	if v := strings.TrimSpace(q.Get("queryStatus")); v != "" {
		add("h.query_status = $%d", v)
	}
	if v := strings.TrimSpace(q.Get("payer")); v != "" {
		add("h.payer = $%d", v)
	}
	if v := strings.TrimSpace(q.Get("provider")); v != "" {
		add("h.provider = $%d", v)
	}
	if v := strings.TrimSpace(q.Get("encounterType")); v != "" {
		add("h.encounter_type = $%d", v)
	}
	switch p.Assigned {
	case "":
	case "unassigned":
		where = append(where, "h.assigned_to IS NULL")
	default:
		add("h.assigned_to = $%d", p.Assigned)
	}
	if p.From != "" {
		add("h.dos >= $%d", p.From)
	}
	if p.To != "" {
		add("h.dos <= $%d", p.To)
	}
	// Aging filter, expressed in days rather than a date so it keeps meaning tomorrow.
	if v := strings.TrimSpace(q.Get("minDays")); v != "" {
		args = append(args, v)
		where = append(where, fmt.Sprintf("EXTRACT(DAY FROM now() - h.ready_at) >= $%d::int", len(args)))
	}

	base := `FROM him_worklist h LEFT JOIN patients p ON p.id = h.patient_id WHERE ` +
		strings.Join(where, " AND ")

	var total int
	if err := s.db.QueryRow(r.Context(), "SELECT count(*) "+base, args...).Scan(&total); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the worklist")
		return
	}

	args = append(args, p.Limit, p.Offset)
	sql := fmt.Sprintf(`SELECT h.id, h.patient_id, COALESCE(p.name,''), COALESCE(p.dob,''),
	       h.charge_id, h.claim_id, h.encounter_ref, h.dos, h.admit_date, h.discharge_date,
	       h.encounter_type, h.provider, h.payer, h.location, h.coding_status, h.query_status,
	       h.priority, h.assigned_to, h.assigned_to_name, h.assigned_at, h.ready_at,
	       h.completed_at, h.last_activity_at
	  %s ORDER BY %s %s NULLS LAST, h.id LIMIT $%d OFFSET $%d`,
		base, col, p.Dir, len(args)-1, len(args))

	rows, err := s.db.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the worklist")
		return
	}
	defer rows.Close()

	out := []himItem{}
	for rows.Next() {
		var h himItem
		var chargeID, claimID, assigned *string
		var assignedAt, completedAt *time.Time
		var readyAt, lastAct time.Time
		if err := rows.Scan(&h.ID, &h.PatientID, &h.PatientName, &h.DOB, &chargeID, &claimID,
			&h.EncounterRef, &h.DOS, &h.AdmitDate, &h.DischargeDate, &h.EncounterType,
			&h.Provider, &h.Payer, &h.Location, &h.CodingStatus, &h.QueryStatus, &h.Priority,
			&assigned, &h.AssignedToName, &assignedAt, &readyAt, &completedAt, &lastAct); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not read the worklist")
			return
		}
		h.ChargeID, h.ClaimID, h.AssignedTo = deref(chargeID), deref(claimID), deref(assigned)
		h.AssignedAt, h.CompletedAt = tsOrEmpty(assignedAt), tsOrEmpty(completedAt)
		h.ReadyAt = readyAt.UTC().Format(time.RFC3339)
		h.LastActivity = lastAct.UTC().Format(time.RFC3339)
		h.MRN = h.PatientID
		h.DaysPending = int(time.Since(readyAt).Hours() / 24)
		if h.DaysPending < 0 {
			h.DaysPending = 0
		}
		h.AgeBucket = ageBucket(h.DaysPending)
		out = append(out, h)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"items": out, "total": total, "limit": p.Limit, "offset": p.Offset,
	})
}

// GET /api/him/summary
func (s *Server) handleHIMSummary(w http.ResponseWriter, r *http.Request) {
	type bucket struct {
		Key   string `json:"key"`
		Count int    `json:"count"`
	}
	res := map[string]any{}

	var ready, unassigned, assigned, inProgress, queries, finalReview, completedToday, overdue int
	err := s.db.QueryRow(r.Context(), `
		SELECT
		  count(*) FILTER (WHERE coding_status = 'READY_FOR_CODING'),
		  count(*) FILTER (WHERE assigned_to IS NULL AND coding_status <> 'COMPLETED'),
		  count(*) FILTER (WHERE assigned_to IS NOT NULL AND coding_status <> 'COMPLETED'),
		  count(*) FILTER (WHERE coding_status = 'IN_PROGRESS'),
		  count(*) FILTER (WHERE query_status IN ('SENT','AWAITING','RECEIVED')),
		  count(*) FILTER (WHERE coding_status = 'FINAL_REVIEW'),
		  count(*) FILTER (WHERE coding_status = 'COMPLETED' AND completed_at::date = CURRENT_DATE),
		  count(*) FILTER (WHERE coding_status <> 'COMPLETED' AND ready_at < now() - interval '10 days')
		FROM him_worklist`).
		Scan(&ready, &unassigned, &assigned, &inProgress, &queries, &finalReview, &completedToday, &overdue)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not build the summary")
		return
	}
	res["cards"] = map[string]int{
		"readyForCoding": ready, "unassigned": unassigned, "assigned": assigned,
		"inProgress": inProgress, "queriesOutstanding": queries, "finalReview": finalReview,
		"completedToday": completedToday, "overdue": overdue,
	}

	group := func(expr, label string) {
		rows, err := s.db.Query(r.Context(), fmt.Sprintf(
			`SELECT COALESCE(NULLIF(%s,''),'Not available') k, count(*)
			   FROM him_worklist GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 15`, expr))
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
	group("assigned_to_name", "byCoder")
	group("provider", "byProvider")
	group("payer", "byPayer")
	group("coding_status", "byStatus")

	// Aging, bucketed in SQL using the same boundaries as ageBucket().
	rows, err := s.db.Query(r.Context(), `
		SELECT CASE
		         WHEN d <= 2  THEN '0-2 Days'
		         WHEN d <= 5  THEN '3-5 Days'
		         WHEN d <= 10 THEN '6-10 Days'
		         WHEN d <= 30 THEN '11-30 Days'
		         ELSE '30+ Days' END AS k, count(*)
		  FROM (SELECT EXTRACT(DAY FROM now() - ready_at)::int d
		          FROM him_worklist WHERE coding_status <> 'COMPLETED') x
		 GROUP BY 1`)
	if err == nil {
		defer rows.Close()
		list := []bucket{}
		for rows.Next() {
			var b bucket
			if rows.Scan(&b.Key, &b.Count) == nil {
				list = append(list, b)
			}
		}
		res["aging"] = list
	}

	writeJSON(w, http.StatusOK, res)
}

// GET /api/him/worklist/{id} - the coding workspace.
func (s *Server) handleHIMDetail(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	var h himItem
	var chargeID, claimID, assigned *string
	var assignedAt, completedAt *time.Time
	var readyAt, lastAct time.Time
	err := s.db.QueryRow(r.Context(), `
		SELECT h.id, h.patient_id, COALESCE(p.name,''), COALESCE(p.dob,''), h.charge_id, h.claim_id,
		       h.encounter_ref, h.dos, h.admit_date, h.discharge_date, h.encounter_type, h.provider,
		       h.payer, h.location, h.coding_status, h.query_status, h.priority, h.assigned_to,
		       h.assigned_to_name, h.assigned_at, h.ready_at, h.completed_at, h.last_activity_at
		  FROM him_worklist h LEFT JOIN patients p ON p.id = h.patient_id WHERE h.id = $1`, id).
		Scan(&h.ID, &h.PatientID, &h.PatientName, &h.DOB, &chargeID, &claimID, &h.EncounterRef,
			&h.DOS, &h.AdmitDate, &h.DischargeDate, &h.EncounterType, &h.Provider, &h.Payer,
			&h.Location, &h.CodingStatus, &h.QueryStatus, &h.Priority, &assigned,
			&h.AssignedToName, &assignedAt, &readyAt, &completedAt, &lastAct)
	if err != nil {
		writeErr(w, http.StatusNotFound, "no such worklist item")
		return
	}
	h.ChargeID, h.ClaimID, h.AssignedTo = deref(chargeID), deref(claimID), deref(assigned)
	h.AssignedAt, h.CompletedAt = tsOrEmpty(assignedAt), tsOrEmpty(completedAt)
	h.ReadyAt = readyAt.UTC().Format(time.RFC3339)
	h.LastActivity = lastAct.UTC().Format(time.RFC3339)
	h.MRN = h.PatientID
	h.DaysPending = int(time.Since(readyAt).Hours() / 24)
	h.AgeBucket = ageBucket(h.DaysPending)

	// Insurance read live from the patient's policies. No duplicate payer record is created.
	insurance := []map[string]string{}
	if rows, err := s.db.Query(r.Context(), `
		SELECT COALESCE(insurance_company,''), COALESCE(plan_name,''), COALESCE(member_id,''),
		       COALESCE(priority,''), COALESCE(status,'')
		  FROM insurance_policies WHERE patient_id = $1 ORDER BY priority, insurance_company`,
		h.PatientID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var company, plan, member, priority, status string
			if rows.Scan(&company, &plan, &member, &priority, &status) == nil {
				insurance = append(insurance, map[string]string{
					"payer": company, "plan": plan, "memberId": member,
					"priority": priority, "status": status,
				})
			}
		}
	}

	dx, _ := s.himDiagnoses(r, id)
	px, _ := s.himProcedures(r, id)
	queries, _ := s.himQueries(r, id)
	activity, _ := s.himActivity(r, id)
	assignments, _ := s.himAssignments(r, id)

	writeJSON(w, http.StatusOK, map[string]any{
		"item": h, "insurance": insurance, "diagnoses": dx, "procedures": px,
		"queries": queries, "activity": activity, "assignments": assignments,
		"validation": validateCoding(dx, px, h),
	})
}

type himDx struct {
	ID          string `json:"id"`
	Code        string `json:"code"`
	Description string `json:"description"`
	IsPrincipal bool   `json:"isPrincipal"`
	POA         string `json:"poa"`
	Sequence    int    `json:"sequence"`
	Notes       string `json:"notes"`
}

type himPx struct {
	ID          string  `json:"id"`
	Code        string  `json:"code"`
	Description string  `json:"description"`
	ServiceDate string  `json:"serviceDate"`
	Modifiers   string  `json:"modifiers"`
	Units       float64 `json:"units"`
	Sequence    int     `json:"sequence"`
	Notes       string  `json:"notes"`

	// True when the code was found in cpt_catalog. False is a warning, not a rejection: a coder
	// may legitimately use a code this practice has not catalogued yet.
	InCatalog bool `json:"inCatalog"`
}

func (s *Server) himDiagnoses(r *http.Request, id string) ([]himDx, error) {
	rows, err := s.db.Query(r.Context(),
		`SELECT id, code, description, is_principal, poa, sequence, notes
		   FROM him_diagnosis_codes WHERE worklist_id = $1 ORDER BY sequence, created_at`, id)
	if err != nil {
		return []himDx{}, err
	}
	defer rows.Close()
	out := []himDx{}
	for rows.Next() {
		var d himDx
		if rows.Scan(&d.ID, &d.Code, &d.Description, &d.IsPrincipal, &d.POA, &d.Sequence, &d.Notes) == nil {
			out = append(out, d)
		}
	}
	return out, nil
}

func (s *Server) himProcedures(r *http.Request, id string) ([]himPx, error) {
	rows, err := s.db.Query(r.Context(),
		`SELECT x.id, x.code, x.description, x.service_date, x.modifiers, x.units, x.sequence, x.notes,
		        (c.code IS NOT NULL) AS in_catalog
		   FROM him_procedure_codes x
		   LEFT JOIN cpt_catalog c ON c.code = x.code
		  WHERE x.worklist_id = $1 ORDER BY x.sequence, x.created_at`, id)
	if err != nil {
		return []himPx{}, err
	}
	defer rows.Close()
	out := []himPx{}
	for rows.Next() {
		var x himPx
		if rows.Scan(&x.ID, &x.Code, &x.Description, &x.ServiceDate, &x.Modifiers, &x.Units,
			&x.Sequence, &x.Notes, &x.InCatalog) == nil {
			out = append(out, x)
		}
	}
	return out, nil
}

type himValidation struct {
	Level   string `json:"level"` // "error" | "warning"
	Code    string `json:"code"`
	Message string `json:"message"`
}

// validateCoding reports problems; it never edits the coder's work.
//
// Every finding is advisory and shown next to the codes. Nothing here silently corrects,
// reorders or removes a selection - the specification is explicit that a coder's entry must not
// be changed without confirmation, and a validator that quietly "fixes" things is how a wrong
// code reaches a claim with nobody having chosen it.
func validateCoding(dx []himDx, px []himPx, h himItem) []himValidation {
	out := []himValidation{}

	if len(dx) == 0 {
		out = append(out, himValidation{"error", "NO_DIAGNOSIS", "No diagnosis code has been entered."})
	}

	principals := 0
	seenDx := map[string]bool{}
	for _, d := range dx {
		if d.IsPrincipal {
			principals++
		}
		key := strings.ToUpper(strings.TrimSpace(d.Code))
		if key == "" {
			out = append(out, himValidation{"error", "BLANK_CODE", "A diagnosis row has no code."})
			continue
		}
		if seenDx[key] {
			out = append(out, himValidation{"warning", "DUPLICATE_DX", "Diagnosis " + d.Code + " appears more than once."})
		}
		seenDx[key] = true
		if strings.TrimSpace(d.Description) == "" {
			out = append(out, himValidation{"warning", "NO_DESCRIPTION", "Diagnosis " + d.Code + " has no description."})
		}
	}
	if len(dx) > 0 && principals == 0 {
		out = append(out, himValidation{"error", "NO_PRINCIPAL", "No principal diagnosis has been marked."})
	}
	if principals > 1 {
		out = append(out, himValidation{"error", "MULTIPLE_PRINCIPAL", "More than one diagnosis is marked principal."})
	}

	seenPx := map[string]bool{}
	for _, x := range px {
		key := strings.ToUpper(strings.TrimSpace(x.Code)) + "|" + x.Modifiers
		if strings.TrimSpace(x.Code) == "" {
			out = append(out, himValidation{"error", "BLANK_CODE", "A procedure row has no code."})
			continue
		}
		if seenPx[key] {
			out = append(out, himValidation{"warning", "DUPLICATE_PX", "Procedure " + x.Code + " appears more than once with the same modifiers."})
		}
		seenPx[key] = true
		if !x.InCatalog {
			out = append(out, himValidation{"warning", "NOT_IN_CATALOG",
				"Procedure " + x.Code + " is not in this practice's CPT catalog. Confirm before billing."})
		}
	}

	if strings.TrimSpace(h.Provider) == "" {
		out = append(out, himValidation{"warning", "NO_PROVIDER", "No provider is recorded on this encounter."})
	}
	return out
}

// ---------- history readers ----------

func (s *Server) himQueries(r *http.Request, id string) ([]map[string]any, error) {
	rows, err := s.db.Query(r.Context(), `
		SELECT id, query_type, query_reason, query_text, provider, status, created_by_name,
		       created_at, sent_at, responded_at, response_text, resolution, coding_impact
		  FROM him_provider_queries WHERE worklist_id = $1 ORDER BY created_at DESC`, id)
	if err != nil {
		return []map[string]any{}, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var qid, qtype, reason, text, provider, status, by, resp, resolution, impact string
		var created time.Time
		var sent, responded *time.Time
		if rows.Scan(&qid, &qtype, &reason, &text, &provider, &status, &by, &created, &sent,
			&responded, &resp, &resolution, &impact) == nil {
			out = append(out, map[string]any{
				"id": qid, "queryType": qtype, "queryReason": reason, "queryText": text,
				"provider": provider, "status": status, "createdByName": by,
				"createdAt": created.UTC().Format(time.RFC3339),
				"sentAt":    tsOrEmpty(sent), "respondedAt": tsOrEmpty(responded),
				"responseText": resp, "resolution": resolution, "codingImpact": impact,
			})
		}
	}
	return out, nil
}

func (s *Server) himActivity(r *http.Request, id string) ([]map[string]any, error) {
	rows, err := s.db.Query(r.Context(),
		`SELECT at, user_name, action, detail, old_value, new_value
		   FROM him_activity WHERE worklist_id = $1 ORDER BY at DESC LIMIT 200`, id)
	if err != nil {
		return []map[string]any{}, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var at time.Time
		var user, action, detail, oldV, newV string
		if rows.Scan(&at, &user, &action, &detail, &oldV, &newV) == nil {
			out = append(out, map[string]any{
				"at": at.UTC().Format(time.RFC3339), "user": user, "action": action,
				"detail": detail, "oldValue": oldV, "newValue": newV,
			})
		}
	}
	return out, nil
}

func (s *Server) himAssignments(r *http.Request, id string) ([]map[string]any, error) {
	rows, err := s.db.Query(r.Context(), `
		SELECT created_at, action, assigned_to_name, assigned_by_name, previous_assigned_to_name, reason
		  FROM him_assignments WHERE worklist_id = $1 ORDER BY created_at DESC`, id)
	if err != nil {
		return []map[string]any{}, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var at time.Time
		var action, to, by, prev, reason string
		if rows.Scan(&at, &action, &to, &by, &prev, &reason) == nil {
			out = append(out, map[string]any{
				"at": at.UTC().Format(time.RFC3339), "action": action, "assignedToName": to,
				"assignedByName": by, "previousAssignedToName": prev, "reason": reason,
			})
		}
	}
	return out, nil
}

// logActivity appends to the encounter timeline and bumps last_activity_at. Append-only: the
// timeline is never edited, so "status changed to Awaiting Response at 10:35" stays true.
func (s *Server) logActivity(r *http.Request, u authedUser, worklistID, action, detail, oldV, newV string) {
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO him_activity (id, worklist_id, user_id, user_name, action, detail, old_value, new_value)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		"HAC"+newUID(), worklistID, u.UID, u.Name, action, clip(detail, 500), clip(oldV, 200), clip(newV, 200)); err == nil {
		_, _ = s.db.Exec(r.Context(),
			`UPDATE him_worklist SET last_activity_at = now(), updated_at = now() WHERE id = $1`, worklistID)
	}
}

// worklistPatient resolves the patient for an item, and doubles as an existence check.
func (s *Server) worklistPatient(r *http.Request, id string) (string, string, bool) {
	var patientID, status string
	if err := s.db.QueryRow(r.Context(),
		`SELECT patient_id, coding_status FROM him_worklist WHERE id = $1`, id).
		Scan(&patientID, &status); err != nil {
		return "", "", false
	}
	return patientID, status, true
}
