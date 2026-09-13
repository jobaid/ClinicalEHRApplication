package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Patient statement generation.
//
// Every figure on a statement is computed here, from the database, on the server. The frontend
// sends only a patient id, a basis, a date range and an optional message; it never sends an
// amount. The preview endpoint and the PDF endpoint run the exact same assembly, so what the
// reviewer approves and what the PDF prints cannot drift apart, and a tampered preview cannot
// change a printed total.
//
// ---------- Money is integer cents, everywhere ----------
//
// Amounts are pulled out of PostgreSQL already multiplied by 100 and rounded
// (ROUND(col * 100)::bigint), and every sum below is int64. No float64 ever holds a running
// total. This is the one thing a billing statement cannot get wrong: summing 0.1 + 0.2 in
// binary floating point gives 0.30000000000000004, and a column of those errors eventually
// prints a statement whose lines do not add up to its total.
//
// The JSONB postings are the exception - JSON has only floats - so each posting amount is
// converted once at the boundary (see centsFromJSON) and is integer from there on.

// ---------- The shape returned to the client and handed to the PDF renderer ----------

type StatementLine struct {
	ChargeID        string `json:"chargeId"`
	DOS             string `json:"dos"`             // date of service, ISO
	TransactionDate string `json:"transactionDate"` // when it was keyed in, ISO
	ProcedureCode   string `json:"procedureCode"`   // the catalogued procedure
	CPT             string `json:"cpt"`             // the billed CPT
	ProcedureDesc   string `json:"procedureDesc"`
	Physician       string `json:"physician"`
	PhysicianNPI    string `json:"physicianNpi"`
	InsuranceName   string `json:"insuranceName"`

	// All in cents.
	Charge        int64 `json:"charge"`
	InsurancePaid int64 `json:"insurancePaid"`
	Adjustment    int64 `json:"adjustment"`
	Copay         int64 `json:"copay"`
	Deductible    int64 `json:"deductible"`
	PatientPaid   int64 `json:"patientPaid"`
	SelfPay       int64 `json:"selfPay"` // what remains on this line
}

type StatementTotals struct {
	Charges        int64 `json:"charges"`
	InsurancePaid  int64 `json:"insurancePaid"`
	Adjustments    int64 `json:"adjustments"`
	Copay          int64 `json:"copay"`
	Deductible     int64 `json:"deductible"`
	PatientPayments int64 `json:"patientPayments"`
	SelfPay        int64 `json:"selfPay"`
	AmountDue      int64 `json:"amountDue"`
}

// StatementInsurer is the per-payer breakdown. A patient can have several policies and a claim
// per payer, so this is a list rather than a single "the insurance" block.
type StatementInsurer struct {
	Name           string `json:"name"`
	Paid           int64  `json:"paid"`
	Adjustment     int64  `json:"adjustment"`
	Copay          int64  `json:"copay"`
	Deductible     int64  `json:"deductible"`
	PatientBalance int64  `json:"patientBalance"`
}

type StatementPhysician struct {
	Name string `json:"name"`
	NPI  string `json:"npi"`
	// HasSignature says whether a stored signature image exists. The image itself is only sent
	// to the PDF renderer, never in the preview JSON - it is large and the review screen has no
	// use for it.
	HasSignature bool   `json:"hasSignature"`
	signature    string // data URL, server-side only
}

type StatementPatient struct {
	ID      string `json:"id"` // doubles as the account number, as elsewhere in this app
	Name    string `json:"name"`
	Address string `json:"address"`
	City    string `json:"city"`
	State   string `json:"state"`
	Zip     string `json:"zip"`
	Email   string `json:"email"`
	// Date of birth is deliberately absent. A statement identifies the account by account number
	// and mailing address, which is what a billing document needs; a date of birth on a page that
	// gets posted, scanned and filed is identifying data the document never uses. Not selecting it
	// at all is stronger than selecting it and choosing not to print it.
}

type Statement struct {
	Practice   PracticeInfo         `json:"practice"`
	Patient    StatementPatient     `json:"patient"`
	Basis      string               `json:"basis"` // "dos" | "transaction"
	From       string               `json:"from"`
	To         string               `json:"to"`
	Generated  string               `json:"generated"`
	Lines      []StatementLine      `json:"lines"`
	Totals     StatementTotals      `json:"totals"`
	Insurers   []StatementInsurer   `json:"insurers"`
	Physicians []StatementPhysician `json:"physicians"`
	Message    string               `json:"message,omitempty"`
}

// PracticeInfo heads the statement. It is configuration, not patient data, so it comes from the
// environment - a deployment can set its own letterhead without a code change. The defaults
// mirror PRACTICE_INFO in src/app.jsx so a local run looks like the rest of the app.
type PracticeInfo struct {
	Name    string `json:"name"`
	Address string `json:"address"`
	Phone   string `json:"phone"`
	TaxID   string `json:"taxId"`
}

func practiceInfo() PracticeInfo {
	return PracticeInfo{
		Name:    env("PRACTICE_NAME", "Jobaid Clinic"),
		Address: env("PRACTICE_ADDRESS", "400 Harbor Way, Bellerose, NY 11426"),
		Phone:   env("PRACTICE_PHONE", "(516) 555-0100"),
		TaxID:   env("PRACTICE_TAX_ID", "13-5551234"),
	}
}

// ---------- Request validation ----------

type statementRequest struct {
	PatientID string `json:"patientId"`
	Basis     string `json:"basis"`
	From      string `json:"from"`
	To        string `json:"to"`
	Message   string `json:"message"`
}

const (
	basisDOS         = "dos"
	basisTransaction = "transaction"
	maxMessageLen    = 2000
)

var isoDate = func(s string) bool {
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

func (req *statementRequest) validate() error {
	if strings.TrimSpace(req.PatientID) == "" {
		return errors.New("a patient is required")
	}
	if req.Basis != basisDOS && req.Basis != basisTransaction {
		return fmt.Errorf("basis must be %q (date of service) or %q (transaction date)", basisDOS, basisTransaction)
	}
	if !isoDate(req.From) || !isoDate(req.To) {
		return errors.New("from and to must both be dates in YYYY-MM-DD form")
	}
	if req.From > req.To {
		return errors.New("the start date is after the end date")
	}
	if len(req.Message) > maxMessageLen {
		return fmt.Errorf("the statement message is limited to %d characters", maxMessageLen)
	}
	req.Message = sanitizeMessage(req.Message)
	return nil
}

// sanitizeMessage makes the free-text message safe to render.
//
// The message reaches two very different renderers: the PDF (which draws it as literal glyphs and
// cannot execute anything) and the React review screen (which is JSX, so it escapes by default).
// Neither is currently injectable. This strips markup anyway, because the untrusted string would
// otherwise be one refactor - a dangerouslySetInnerHTML, an HTML mail body when sending is added -
// away from mattering, and by then the sanitizing would be somebody's else's job to remember.
//
// Control characters go too: they render as tofu boxes in the PDF and can hide text from a
// reviewer who approves a statement that then prints something different.
func sanitizeMessage(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")

	var b strings.Builder
	depth := 0
	for _, r := range s {
		switch {
		case r == '<':
			depth++
		case r == '>' && depth > 0:
			depth--
		case depth > 0:
			// inside a tag: dropped
		case r == '\n' || r == '\t':
			b.WriteRune(r)
		case r < 0x20 || r == 0x7f:
			// other control characters dropped
		default:
			b.WriteRune(r)
		}
	}

	// Collapse runs of blank lines so a pasted message cannot push the rest of the PDF off a page.
	out := b.String()
	for strings.Contains(out, "\n\n\n") {
		out = strings.ReplaceAll(out, "\n\n\n", "\n\n")
	}
	return strings.TrimSpace(out)
}

// ---------- Assembly ----------

// chargeRow is one charges row with its money already in cents.
type chargeRow struct {
	id           string
	dos          string
	postedAt     string
	cpt          string
	desc         string
	provider     string
	npi          string
	insuranceID  string
	payerOverride string
	charge       int64
	paid         int64
	writeoff     int64
	credits      int64
	postings     []byte
}

// buildStatement is the single source of truth for a statement's contents. Both endpoints call it.
func (s *Server) buildStatement(ctx context.Context, req statementRequest) (*Statement, error) {
	pat, err := s.statementPatient(ctx, req.PatientID)
	if err != nil {
		return nil, err
	}

	rows, err := s.statementCharges(ctx, req)
	if err != nil {
		return nil, err
	}

	insurerByPolicyID, err := s.policyNames(ctx, req.PatientID)
	if err != nil {
		return nil, err
	}
	procByCPT, err := s.procedureDescriptions(ctx)
	if err != nil {
		return nil, err
	}
	physByName, err := s.physicianDirectory(ctx)
	if err != nil {
		return nil, err
	}

	st := &Statement{
		Practice:  practiceInfo(),
		Patient:   pat,
		Basis:     req.Basis,
		From:      req.From,
		To:        req.To,
		Generated: time.Now().Format("2006-01-02"),
		Message:   req.Message,
		Lines:     []StatementLine{},
	}

	// Per-payer rollup, keyed by insurer name, and the physicians actually appearing on lines.
	insurerIdx := map[string]int{}
	physSeen := map[string]bool{}

	for _, r := range rows {
		split, err := splitPostings(r.postings)
		if err != nil {
			return nil, fmt.Errorf("charge %s has unreadable postings: %w", r.id, err)
		}

		insurer := insurerNameFor(r, insurerByPolicyID)

		// Adjustments are write-offs plus credits - the two non-payment ways a charge is reduced,
		// exactly as adjustedOf()/balanceOf() in src/app.jsx treat them.
		adjustment := r.writeoff + r.credits

		// The stored aggregates are authoritative for the balance, because they are what the rest
		// of the application bills from (balanceOf in src/app.jsx). The postings are used only to
		// split the single `paid` figure into its insurance and patient halves, which the
		// aggregates do not record separately.
		selfPay := r.charge - r.paid - r.writeoff - r.credits

		// If the postings do not account for the whole of `paid` (older rows predate posting
		// detail), attribute the unexplained remainder to insurance rather than inventing a
		// patient payment the patient never made - and never let the split exceed the total.
		insurancePaid, patientPaid := reconcileSplit(r.paid, split.insurancePaid, split.patientPaid)

		line := StatementLine{
			ChargeID:        r.id,
			DOS:             r.dos,
			TransactionDate: dateOnly(r.postedAt),
			CPT:             r.cpt,
			ProcedureCode:   procedureCodeFor(r.cpt, procByCPT),
			ProcedureDesc:   r.desc,
			Physician:       r.provider,
			PhysicianNPI:    physicianNPI(r, physByName),
			InsuranceName:   insurer,
			Charge:          r.charge,
			InsurancePaid:   insurancePaid,
			Adjustment:      adjustment,
			Copay:           split.copay,
			Deductible:      split.deductible,
			PatientPaid:     patientPaid,
			SelfPay:         selfPay,
		}
		st.Lines = append(st.Lines, line)

		st.Totals.Charges += line.Charge
		st.Totals.InsurancePaid += line.InsurancePaid
		st.Totals.Adjustments += line.Adjustment
		st.Totals.Copay += line.Copay
		st.Totals.Deductible += line.Deductible
		st.Totals.PatientPayments += line.PatientPaid
		st.Totals.SelfPay += line.SelfPay

		if insurer != "" {
			i, ok := insurerIdx[insurer]
			if !ok {
				insurerIdx[insurer] = len(st.Insurers)
				st.Insurers = append(st.Insurers, StatementInsurer{Name: insurer})
				i = len(st.Insurers) - 1
			}
			st.Insurers[i].Paid += line.InsurancePaid
			st.Insurers[i].Adjustment += line.Adjustment
			st.Insurers[i].Copay += line.Copay
			st.Insurers[i].Deductible += line.Deductible
			st.Insurers[i].PatientBalance += line.SelfPay
		}

		if r.provider != "" && !physSeen[r.provider] {
			physSeen[r.provider] = true
			p := physByName[r.provider]
			st.Physicians = append(st.Physicians, StatementPhysician{
				Name:         r.provider,
				NPI:          p.npi,
				HasSignature: p.signature != "",
				signature:    p.signature,
			})
		}
	}

	// Amount due is the patient's remaining responsibility for this statement's lines. It is the
	// sum of the per-line balances, never a re-derivation from the totals, so one line's
	// overpayment cannot silently cancel another line's balance.
	st.Totals.AmountDue = st.Totals.SelfPay

	return st, nil
}

// reconcileSplit keeps the insurance/patient split consistent with the authoritative paid total.
func reconcileSplit(paid, insurance, patient int64) (int64, int64) {
	if insurance+patient == paid {
		return insurance, patient
	}
	if patient > paid {
		patient = paid
	}
	if patient < 0 {
		patient = 0
	}
	return paid - patient, patient
}

// postingSplit is what one charge's postings say about who paid and how much of the payment was
// patient responsibility under the plan.
type postingSplit struct {
	insurancePaid int64
	patientPaid   int64
	copay         int64
	deductible    int64
}

// splitPostings walks the postings JSONB.
//
// Rules taken from how src/app.jsx writes them:
//   - only postings whose `field` is "paid" are money received; "writeoff"/"credits" postings are
//     adjustments and are already counted in the charge's own writeoff/credits columns, so
//     counting them here too would double-count them.
//   - a posting's live value is `amount - debited`; `debited` records how much of it has been
//     reversed (see remainingDebitable in src/app.jsx).
//   - a "Debit" posting is the reversal's own ledger entry, not a payment. Its effect is already
//     in the `debited` of the posting it reverses, so it is skipped.
//   - "Patient Credit" is money from the patient; "Check" and "Insurance Credit" are from a payer.
//   - copay and deductible ride on Insurance Credit postings and are stored as JSON *strings*.
func splitPostings(raw []byte) (postingSplit, error) {
	var out postingSplit
	if len(raw) == 0 {
		return out, nil
	}

	var postings []map[string]any
	if err := json.Unmarshal(raw, &postings); err != nil {
		return out, err
	}

	for _, p := range postings {
		typ, _ := p["type"].(string)
		if typ == "Debit" {
			continue
		}

		// Copay and deductible are patient-responsibility figures reported on the remittance.
		// They are read regardless of `field` so an EOB posted as an adjustment still reports them.
		out.copay += centsFromJSON(p["copay"])
		out.deductible += centsFromJSON(p["deductible"])

		if f, _ := p["field"].(string); f != "paid" {
			continue
		}

		net := centsFromJSON(p["amount"]) - centsFromJSON(p["debited"])
		if net <= 0 {
			continue
		}
		if typ == "Patient Credit" {
			out.patientPaid += net
		} else {
			out.insurancePaid += net
		}
	}
	return out, nil
}

// centsFromJSON converts one JSONB money value to integer cents.
//
// It accepts both shapes the postings actually contain: real JSON numbers (`"amount": 65`) and
// numeric strings (`"copay": "0"`), which is how the React forms serialise their text inputs.
// Anything unparseable is zero rather than an error - a malformed optional field should not stop
// a patient's statement from being produced.
func centsFromJSON(v any) int64 {
	switch n := v.(type) {
	case float64:
		return roundToCents(n)
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		if err != nil {
			return 0
		}
		return roundToCents(f)
	case json.Number:
		f, err := n.Float64()
		if err != nil {
			return 0
		}
		return roundToCents(f)
	default:
		return 0
	}
}

// roundToCents converts one float64 currency amount to exact integer cents.
//
// math.Round rounds half away from zero, which is the money convention, rather than Go's
// round-half-to-even default.
//
// The guarantee this makes, and its limit: any amount that was genuinely a two-decimal currency
// value converts to its exact cent. That covers everything this system stores - the React money
// inputs and the NUMERIC(14,2) columns behind them cannot express anything finer. A value with
// more decimals than that has no exact float64 representation to begin with (the nearest float64
// to 1.005 is 1.00499999999999989, which is genuinely below the midpoint), so it resolves to
// whichever cent the stored value is actually nearer. That is a property of the input, not a
// rounding bug, and it is why every total downstream of this function is int64: the conversion
// happens once per posting, at the boundary, and never again in a running sum.
func roundToCents(f float64) int64 {
	return int64(math.Round(f * 100))
}

// dateOnly trims an ISO timestamp ("2026-08-24T09:15:00") down to its date.
func dateOnly(s string) string {
	if len(s) >= 10 {
		return s[:10]
	}
	return s
}

func insurerNameFor(r chargeRow, byPolicyID map[string]string) string {
	if r.payerOverride == "self" {
		return "Self / Patient"
	}
	if r.insuranceID != "" {
		if name, ok := byPolicyID[r.insuranceID]; ok {
			return name
		}
	}
	return ""
}

// procedureCodeFor keeps procedure code and CPT distinct.
//
// This application catalogues procedures BY their CPT code - cpt_catalog.id is the code and there
// is no second internal procedure identifier - so the honest answer is that the two are the same
// value here, and the PDF says so by printing the catalogued code only when the charge's CPT is
// actually in the catalogue. Fabricating a different-looking "procedure code" to fill the column
// would invent data the database does not have.
func procedureCodeFor(cpt string, catalog map[string]string) string {
	if _, ok := catalog[cpt]; ok {
		return cpt
	}
	return ""
}

type physicianRec struct {
	npi       string
	signature string
}

func physicianNPI(r chargeRow, byName map[string]physicianRec) string {
	// The charge carries the NPI it was billed under, which is the one that belongs on a
	// statement for that date of service even if the directory has since been corrected.
	if r.npi != "" {
		return r.npi
	}
	return byName[r.provider].npi
}

// ---------- Queries ----------

func (s *Server) statementPatient(ctx context.Context, id string) (StatementPatient, error) {
	var p StatementPatient
	err := s.db.QueryRow(ctx,
		`SELECT id, name, address, city, state, zip, email FROM patients WHERE id = $1`, id,
	).Scan(&p.ID, &p.Name, &p.Address, &p.City, &p.State, &p.Zip, &p.Email)
	if err != nil {
		return p, errNoPatient
	}
	return p, nil
}

var errNoPatient = errors.New("patient not found")

// statementCharges reads the charges the statement covers.
//
// The basis chooses which date column the range filters on, and the two are genuinely different
// questions: "what care was delivered in this window" (dos) versus "what hit the ledger in this
// window" (posted_at). A charge entered in September for an August visit appears in exactly one
// of them, which is why the UI refuses to blur the two.
//
// Dates are stored as ISO TEXT, so lexical comparison is chronological; posted_at additionally
// carries a time, hence the left(...,10) so an end-of-range day is inclusive.
func (s *Server) statementCharges(ctx context.Context, req statementRequest) ([]chargeRow, error) {
	const cols = `id, dos, COALESCE(posted_at, ''), cpt, "desc", provider, npi,
	              COALESCE(charge_insurance_id, ''), COALESCE(payer_override, ''),
	              ROUND(charge   * 100)::bigint,
	              ROUND(paid     * 100)::bigint,
	              ROUND(writeoff * 100)::bigint,
	              ROUND(credits  * 100)::bigint,
	              postings`

	// Parameterised in both branches; the basis only picks which prepared statement runs, and it
	// has already been constrained to one of two constants by validate().
	q := `SELECT ` + cols + ` FROM charges WHERE patient_id = $1 AND dos >= $2 AND dos <= $3 ORDER BY dos, id`
	if req.Basis == basisTransaction {
		q = `SELECT ` + cols + ` FROM charges
		     WHERE patient_id = $1
		       AND COALESCE(NULLIF(left(posted_at, 10), ''), dos) >= $2
		       AND COALESCE(NULLIF(left(posted_at, 10), ''), dos) <= $3
		     ORDER BY posted_at, id`
	}

	rows, err := s.db.Query(ctx, q, req.PatientID, req.From, req.To)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []chargeRow
	for rows.Next() {
		var r chargeRow
		if err := rows.Scan(&r.id, &r.dos, &r.postedAt, &r.cpt, &r.desc, &r.provider, &r.npi,
			&r.insuranceID, &r.payerOverride,
			&r.charge, &r.paid, &r.writeoff, &r.credits, &r.postings); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Server) policyNames(ctx context.Context, patientID string) (map[string]string, error) {
	rows, err := s.db.Query(ctx,
		`SELECT id, insurance_company FROM insurance_policies WHERE patient_id = $1`, patientID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]string{}
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}

func (s *Server) procedureDescriptions(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.Query(ctx, `SELECT code, "desc" FROM cpt_catalog`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]string{}
	for rows.Next() {
		var code, desc string
		if err := rows.Scan(&code, &desc); err != nil {
			return nil, err
		}
		out[code] = desc
	}
	return out, rows.Err()
}

func (s *Server) physicianDirectory(ctx context.Context) (map[string]physicianRec, error) {
	rows, err := s.db.Query(ctx, `SELECT name, npi, COALESCE(signature, '') FROM physicians`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]physicianRec{}
	for rows.Next() {
		var name, npi, sig string
		if err := rows.Scan(&name, &npi, &sig); err != nil {
			return nil, err
		}
		out[name] = physicianRec{npi: npi, signature: sig}
	}
	return out, rows.Err()
}

// ---------- HTTP ----------

// authorizeStatement applies the same grant that governs every other billing record: a caller who
// cannot write billing data cannot assemble a billing document about a patient either. The tab
// grants are read from the database per request (see tabsFor), so revoking billing access takes
// effect immediately rather than at token expiry.
func (s *Server) authorizeStatement(ctx context.Context) (authedUser, bool) {
	u := userFrom(ctx)
	if u.Role == "SUPER_ADMIN" {
		return u, true
	}
	return u, s.tabsFor(ctx, u.Role).has("billing")
}

func (s *Server) decodeStatementRequest(w http.ResponseWriter, r *http.Request) (statementRequest, bool) {
	var req statementRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return req, false
	}
	if err := req.validate(); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return req, false
	}
	return req, true
}

// handleStatementPreview returns the statement as JSON for the review screen.
func (s *Server) handleStatementPreview(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.authorizeStatement(r.Context()); !ok {
		writeErr(w, http.StatusForbidden, "your role cannot generate patient statements")
		return
	}
	req, ok := s.decodeStatementRequest(w, r)
	if !ok {
		return
	}

	st, err := s.buildStatement(r.Context(), req)
	if err != nil {
		if errors.Is(err, errNoPatient) {
			writeErr(w, http.StatusNotFound, "patient not found")
			return
		}
		// The underlying error can quote row contents, so it is logged without the patient id and
		// returned to the caller as a generic failure.
		logStatementFailure("preview", err)
		writeErr(w, http.StatusInternalServerError, "could not assemble the statement")
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// handleStatementPDF rebuilds the statement from the database and streams the rendered PDF.
// It deliberately re-runs the whole assembly rather than accepting the previewed figures.
func (s *Server) handleStatementPDF(w http.ResponseWriter, r *http.Request) {
	u, ok := s.authorizeStatement(r.Context())
	if !ok {
		writeErr(w, http.StatusForbidden, "your role cannot generate patient statements")
		return
	}
	req, ok := s.decodeStatementRequest(w, r)
	if !ok {
		return
	}

	st, err := s.buildStatement(r.Context(), req)
	if err != nil {
		if errors.Is(err, errNoPatient) {
			writeErr(w, http.StatusNotFound, "patient not found")
			return
		}
		logStatementFailure("pdf", err)
		writeErr(w, http.StatusInternalServerError, "could not assemble the statement")
		return
	}

	pdf, err := renderStatementPDF(st)
	if err != nil {
		logStatementFailure("render", err)
		writeErr(w, http.StatusInternalServerError, "could not render the statement PDF")
		return
	}

	s.auditStatement(r.Context(), u, req, st)

	filename := fmt.Sprintf("statement-%s-%s.pdf", st.Patient.ID, st.Generated)
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("Content-Length", strconv.Itoa(len(pdf)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(pdf)
}

// logStatementFailure records that something failed without echoing the row contents that caused
// it. This is an EHR: a stack of patient names and balances in a log file is a disclosure.
func logStatementFailure(stage string, err error) {
	statementLogf("statement %s failed: %v", stage, err)
}

// auditStatement appends to the existing audit_logs table - the same one the React client writes
// through addAudit - so statement generation appears in the patient's audit trail alongside every
// other action taken on their account.
//
// What is recorded is who, which patient, which basis, which window, and how many lines. The
// statement's actual contents are not logged: the audit trail answers "who produced a statement
// for this account", and duplicating the billing detail into a second table would widen the
// surface holding patient financial data for no added accountability.
func (s *Server) auditStatement(ctx context.Context, u authedUser, req statementRequest, st *Statement) {
	summary := fmt.Sprintf("%s %s to %s, %d line(s)", basisLabel(req.Basis), req.From, req.To, len(st.Lines))

	_, err := s.db.Exec(ctx,
		`INSERT INTO audit_logs (id, patient_id, "user", action, entity_type, entity_id, old_values, new_values, timestamp)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		"AUD"+newUID(), req.PatientID, u.Name, "Statement generated", "statement", req.PatientID,
		"", summary, time.Now().Format("2006-01-02T15:04:05"))
	if err != nil {
		// An audit write failing must not deny the user their document, but it must be visible.
		statementLogf("audit write failed for a statement: %v", err)
	}
}

func basisLabel(basis string) string {
	if basis == basisTransaction {
		return "Transaction date"
	}
	return "Date of service"
}
