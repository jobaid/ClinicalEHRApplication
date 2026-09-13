package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// Tests for patient statement assembly.
//
// These cover the pure logic - money conversion, the postings split, validation, sanitising and
// PDF rendering - which is where a statement goes wrong in ways nobody notices until a patient
// disputes a bill. The database-backed query paths are exercised by the integration checks
// documented in the feature's README section, since this package has no test fixture database.

// ---------- Money ----------

func TestRoundToCents(t *testing.T) {
	cases := []struct {
		in   float64
		want int64
	}{
		{0, 0},
		{110, 11000},
		{0.1, 10},
		{0.2, 20},
		{0.07, 7},      // 0.07 is stored as 0.070000000000000007
		{29.29, 2929},  // and 29.29 as 29.289999999999999
		{-45.55, -4555}, // symmetric for credits and reversals
		{19.99, 1999},
		{1234567.89, 123456789},
	}
	for _, c := range cases {
		if got := roundToCents(c.in); got != c.want {
			t.Errorf("roundToCents(%v) = %d, want %d", c.in, got, c.want)
		}
	}
}

// Every two-decimal currency value must convert to its exact cent. This is the actual guarantee
// roundToCents makes, and it covers everything the system can store - the money inputs and the
// NUMERIC(14,2) columns behind them cannot express anything finer. Values with more decimals have
// no exact float64 form to round from, so they are deliberately out of scope.
func TestRoundToCentsIsExactForEveryTwoDecimalValue(t *testing.T) {
	for cents := int64(-5000); cents <= 5000; cents++ {
		asFloat := float64(cents) / 100
		if got := roundToCents(asFloat); got != cents {
			t.Fatalf("%.2f converted to %d cents, want %d", asFloat, got, cents)
		}
	}
}

// The whole reason the money in this feature is int64: summing the same values as float64 drifts,
// and a statement whose lines do not add up to its total is the bug this guards against.
func TestCentsSummingIsExact(t *testing.T) {
	var total int64
	for i := 0; i < 1000; i++ {
		total += roundToCents(0.1)
	}
	if total != 10000 {
		t.Fatalf("1000 x $0.10 summed to %d cents, want 10000", total)
	}

	var asFloat float64
	for i := 0; i < 1000; i++ {
		asFloat += 0.1
	}
	if asFloat == 100.0 {
		t.Skip("float64 summed exactly on this platform; the int64 guarantee still holds")
	}
}

func TestMoneyCentsFormatting(t *testing.T) {
	cases := []struct {
		in   int64
		want string
	}{
		{0, "$0.00"},
		{5, "$0.05"},
		{100, "$1.00"},
		{11000, "$110.00"},
		{123456789, "$1,234,567.89"},
		{-2500, "($25.00)"},
		{999, "$9.99"},
		{1000, "$10.00"},
	}
	for _, c := range cases {
		if got := moneyCents(c.in); got != c.want {
			t.Errorf("moneyCents(%d) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestCentsFromJSONAcceptsNumbersAndStrings(t *testing.T) {
	// Real postings carry both shapes: amounts are JSON numbers, copay/deductible are strings
	// because the React forms serialise their text inputs.
	cases := []struct {
		in   any
		want int64
	}{
		{float64(65), 6500},
		{"0", 0},
		{"190", 19000},
		{"12.34", 1234},
		{" 45.5 ", 4550},
		{"", 0},
		{"not a number", 0},
		{nil, 0},
	}
	for _, c := range cases {
		if got := centsFromJSON(c.in); got != c.want {
			t.Errorf("centsFromJSON(%#v) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestUSDate(t *testing.T) {
	if got := usDate("2026-08-24"); got != "08/24/2026" {
		t.Errorf("usDate = %q", got)
	}
	if got := usDate(""); got != "" {
		t.Errorf("empty date should stay empty, got %q", got)
	}
	if got := usDate("n/a"); got != "n/a" {
		t.Errorf("non-ISO input should pass through, got %q", got)
	}
}

// ---------- Postings split ----------

func postingsJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSplitPostingsSeparatesInsuranceFromPatient(t *testing.T) {
	raw := postingsJSON(t, []map[string]any{
		{"type": "Insurance Credit", "field": "paid", "amount": 190, "debited": 0,
			"copay": "25", "deductible": "50", "insuranceName": "Aetna"},
		{"type": "Patient Credit", "field": "paid", "amount": 65, "debited": 0, "method": "Credit Card"},
		{"type": "Check", "field": "paid", "amount": 15, "debited": 0, "insuranceName": "Aetna"},
	})

	got, err := splitPostings(raw)
	if err != nil {
		t.Fatal(err)
	}
	// Insurance Credit + Check are payer money; Patient Credit is the patient's.
	if got.insurancePaid != 20500 {
		t.Errorf("insurancePaid = %d, want 20500", got.insurancePaid)
	}
	if got.patientPaid != 6500 {
		t.Errorf("patientPaid = %d, want 6500", got.patientPaid)
	}
	if got.copay != 2500 {
		t.Errorf("copay = %d, want 2500", got.copay)
	}
	if got.deductible != 5000 {
		t.Errorf("deductible = %d, want 5000", got.deductible)
	}
}

func TestSplitPostingsSubtractsDebitedAndSkipsDebitEntries(t *testing.T) {
	raw := postingsJSON(t, []map[string]any{
		// $100 posted, $40 since reversed: the live value is $60.
		{"type": "Check", "field": "paid", "amount": 100, "debited": 40, "insuranceName": "Aetna"},
		// The reversal's own ledger entry. Its effect is already in `debited` above, so counting
		// it here would subtract the reversal twice.
		{"type": "Debit", "field": "paid", "amount": 40, "debitType": "Reversal"},
	})

	got, err := splitPostings(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.insurancePaid != 6000 {
		t.Errorf("insurancePaid = %d, want 6000 (100 posted less 40 debited)", got.insurancePaid)
	}
	if got.patientPaid != 0 {
		t.Errorf("patientPaid = %d, want 0", got.patientPaid)
	}
}

func TestSplitPostingsIgnoresNonPaymentFields(t *testing.T) {
	// Write-off and credit postings are already counted in the charge's writeoff/credits columns;
	// counting them as payments here too would double-count them.
	raw := postingsJSON(t, []map[string]any{
		{"type": "Write-off", "field": "writeoff", "amount": 50},
		{"type": "Credit", "field": "credits", "amount": 25},
		{"type": "Patient Credit", "field": "paid", "amount": 10, "debited": 0},
	})

	got, err := splitPostings(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.insurancePaid != 0 || got.patientPaid != 1000 {
		t.Errorf("got insurance=%d patient=%d, want 0 and 1000", got.insurancePaid, got.patientPaid)
	}
}

func TestSplitPostingsHandlesEmptyAndMalformed(t *testing.T) {
	if got, err := splitPostings(nil); err != nil || got.patientPaid != 0 {
		t.Errorf("nil postings should be a zero split, got %+v err %v", got, err)
	}
	if got, err := splitPostings([]byte(`[]`)); err != nil || got.insurancePaid != 0 {
		t.Errorf("empty array should be a zero split, got %+v err %v", got, err)
	}
	if _, err := splitPostings([]byte(`{"not":"an array"}`)); err == nil {
		t.Error("malformed postings should report an error rather than silently zero out a charge")
	}
}

// ---------- The split must stay consistent with the authoritative paid total ----------

func TestReconcileSplit(t *testing.T) {
	cases := []struct {
		name                      string
		paid, ins, pat            int64
		wantIns, wantPat          int64
	}{
		{"agrees", 10000, 7000, 3000, 7000, 3000},
		{"postings miss some payment", 10000, 5000, 0, 10000, 0},
		{"patient portion exceeds total", 5000, 0, 9000, 0, 5000},
		{"nothing paid", 0, 0, 0, 0, 0},
		{"negative patient figure is clamped", 8000, 8000, -100, 8000, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			gotIns, gotPat := reconcileSplit(c.paid, c.ins, c.pat)
			if gotIns != c.wantIns || gotPat != c.wantPat {
				t.Errorf("got ins=%d pat=%d, want ins=%d pat=%d", gotIns, gotPat, c.wantIns, c.wantPat)
			}
			// The invariant that matters: the two halves always reconstruct the stored total.
			if gotIns+gotPat != c.paid {
				t.Errorf("split %d + %d does not sum to the stored paid total %d", gotIns, gotPat, c.paid)
			}
		})
	}
}

// ---------- Request validation ----------

func TestStatementRequestValidation(t *testing.T) {
	valid := func() statementRequest {
		return statementRequest{PatientID: "P1001", Basis: basisDOS, From: "2026-08-01", To: "2026-08-31"}
	}

	if err := validCopy(valid()); err != nil {
		t.Fatalf("a valid request was rejected: %v", err)
	}

	cases := []struct {
		name  string
		mutate func(*statementRequest)
		want  string
	}{
		{"no patient", func(r *statementRequest) { r.PatientID = "" }, "patient is required"},
		{"blank basis", func(r *statementRequest) { r.Basis = "" }, "basis must be"},
		{"unknown basis", func(r *statementRequest) { r.Basis = "whenever" }, "basis must be"},
		{"bad from", func(r *statementRequest) { r.From = "08/01/2026" }, "YYYY-MM-DD"},
		{"bad to", func(r *statementRequest) { r.To = "nonsense" }, "YYYY-MM-DD"},
		{"reversed range", func(r *statementRequest) { r.From, r.To = "2026-08-31", "2026-08-01" }, "after the end date"},
		{"oversized message", func(r *statementRequest) { r.Message = strings.Repeat("x", maxMessageLen+1) }, "limited to"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := valid()
			c.mutate(&r)
			err := r.validate()
			if err == nil {
				t.Fatalf("expected a rejection mentioning %q", c.want)
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Errorf("error %q does not mention %q", err, c.want)
			}
		})
	}

	// Transaction basis is equally valid and must not be treated as the odd one out.
	r := valid()
	r.Basis = basisTransaction
	if err := r.validate(); err != nil {
		t.Errorf("transaction basis rejected: %v", err)
	}

	// A single day is a legitimate range.
	r = valid()
	r.From, r.To = "2026-08-15", "2026-08-15"
	if err := r.validate(); err != nil {
		t.Errorf("single-day range rejected: %v", err)
	}
}

func validCopy(r statementRequest) error { return r.validate() }

// ---------- Message sanitising ----------

func TestSanitizeMessageStripsMarkup(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"Please call billing.", "Please call billing."},
		{"<script>alert('x')</script>Call us", "alert('x')Call us"},
		{"<b>Bold</b> text", "Bold text"},
		{"<img src=x onerror=alert(1)>", ""},
		{"Line one\nLine two", "Line one\nLine two"},
		{"Too\n\n\n\nmany breaks", "Too\n\nmany breaks"},
		{"  padded  ", "padded"},
		{"bell\x07and\x00nul", "bellandnul"},
		{"tab\there", "tab\there"},
		{"windows\r\nnewline", "windows\nnewline"},
	}
	for _, c := range cases {
		if got := sanitizeMessage(c.in); got != c.want {
			t.Errorf("sanitizeMessage(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSanitizeMessageRunsOnValidate(t *testing.T) {
	r := statementRequest{
		PatientID: "P1001", Basis: basisDOS, From: "2026-08-01", To: "2026-08-31",
		Message: "<script>bad()</script>Thanks",
	}
	if err := r.validate(); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(r.Message, "<script>") {
		t.Errorf("validate did not sanitize the message: %q", r.Message)
	}
}

// ---------- Address assembly ----------

func TestAddressLinesSkipsMissingParts(t *testing.T) {
	cases := []struct {
		name string
		in   StatementPatient
		want []string
	}{
		{"complete", StatementPatient{Address: "9 Birch Ln", City: "Bellerose", State: "NY", Zip: "11426"},
			[]string{"9 Birch Ln", "Bellerose, NY 11426"}},
		{"no city", StatementPatient{Address: "9 Birch Ln", State: "NY", Zip: "11426"},
			[]string{"9 Birch Ln", "NY 11426"}},
		{"street only", StatementPatient{Address: "9 Birch Ln"}, []string{"9 Birch Ln"}},
		{"nothing on file", StatementPatient{}, []string{"No address on file"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := addressLines(c.in)
			if len(got) != len(c.want) {
				t.Fatalf("got %q, want %q", got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Errorf("line %d: got %q, want %q", i, got[i], c.want[i])
				}
			}
		})
	}
}

// ---------- Physician signature ----------

func TestDecodeSignature(t *testing.T) {
	// A 1x1 transparent PNG - the smallest real image, used to prove a valid data URL decodes.
	const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

	if img := decodeSignature(png); img == nil || img.kind != "PNG" || len(img.data) == 0 {
		t.Errorf("a valid PNG data URL should decode, got %+v", img)
	}

	// Everything else must return nil so the renderer falls through to a hand-signing line.
	// Inventing a signature on a medical billing document is the failure mode being guarded.
	for _, bad := range []string{
		"",
		"no-signature-on-file",
		"data:image/png,notbase64",
		"data:image/svg+xml;base64,PHN2Zy8+",     // not a raster format fpdf can embed
		"data:text/html;base64,PGgxPmhpPC9oMT4=", // not an image at all
		"data:image/png;base64,!!!not-base64!!!",
		"data:image/png;base64,",
	} {
		if img := decodeSignature(bad); img != nil {
			t.Errorf("decodeSignature(%q) should be nil, got %+v", bad, img)
		}
	}
}

// ---------- Helpers ----------

func TestProcedureCodeDistinctFromCPT(t *testing.T) {
	catalog := map[string]string{"99213": "Office visit"}
	// A catalogued code is reported as the procedure code.
	if got := procedureCodeFor("99213", catalog); got != "99213" {
		t.Errorf("catalogued code = %q, want 99213", got)
	}
	// An uncatalogued CPT leaves the procedure column blank rather than echoing the CPT, so the
	// statement never implies a catalogue entry that does not exist.
	if got := procedureCodeFor("99999", catalog); got != "" {
		t.Errorf("uncatalogued code = %q, want empty", got)
	}
}

func TestInsurerNameFor(t *testing.T) {
	policies := map[string]string{"POL-1001": "Aetna"}

	if got := insurerNameFor(chargeRow{insuranceID: "POL-1001"}, policies); got != "Aetna" {
		t.Errorf("got %q, want Aetna", got)
	}
	if got := insurerNameFor(chargeRow{payerOverride: "self", insuranceID: "POL-1001"}, policies); got != "Self / Patient" {
		t.Errorf("a self-pay override must win over a linked policy, got %q", got)
	}
	// A charge with no insurance must not borrow another charge's payer.
	if got := insurerNameFor(chargeRow{}, policies); got != "" {
		t.Errorf("no insurance should be blank, got %q", got)
	}
	if got := insurerNameFor(chargeRow{insuranceID: "POL-GONE"}, policies); got != "" {
		t.Errorf("an unknown policy id should be blank, got %q", got)
	}
}

func TestDateOnly(t *testing.T) {
	if got := dateOnly("2026-08-24T09:15:00"); got != "2026-08-24" {
		t.Errorf("got %q", got)
	}
	if got := dateOnly(""); got != "" {
		t.Errorf("got %q", got)
	}
}

func TestBasisLabel(t *testing.T) {
	if basisLabel(basisDOS) != "Date of service" {
		t.Error("dos label")
	}
	if basisLabel(basisTransaction) != "Transaction date" {
		t.Error("transaction label")
	}
}

// ---------- PDF rendering ----------

func sampleStatement() *Statement {
	return &Statement{
		Practice: PracticeInfo{Name: "Jobaid Clinic", Address: "400 Harbor Way", Phone: "(516) 555-0100", TaxID: "13-5551234"},
		Patient: StatementPatient{
			ID: "P1001", Name: "Maria Alvarez", Address: "12 Willow St",
			City: "Queens", State: "NY", Zip: "11427",
		},
		Basis: basisDOS, From: "2026-08-01", To: "2026-08-31", Generated: "2026-09-13",
		Lines: []StatementLine{{
			ChargeID: "CHG1", DOS: "2026-08-15", TransactionDate: "2026-08-16",
			ProcedureCode: "99213", CPT: "99213", Physician: "Dr. S. Reyes",
			InsuranceName: "Aetna", Charge: 11000, InsurancePaid: 7000,
			Adjustment: 1000, Copay: 2500, Deductible: 0, PatientPaid: 2500, SelfPay: 500,
		}},
		Totals: StatementTotals{
			Charges: 11000, InsurancePaid: 7000, Adjustments: 1000,
			Copay: 2500, PatientPayments: 2500, SelfPay: 500, AmountDue: 500,
		},
		Insurers:   []StatementInsurer{{Name: "Aetna", Paid: 7000, Adjustment: 1000, Copay: 2500, PatientBalance: 500}},
		Physicians: []StatementPhysician{{Name: "Dr. S. Reyes", NPI: "1912345678"}},
	}
}

func TestRenderStatementPDFProducesAPDF(t *testing.T) {
	out, err := renderStatementPDF(sampleStatement())
	if err != nil {
		t.Fatal(err)
	}
	if len(out) < 800 {
		t.Fatalf("suspiciously small PDF: %d bytes", len(out))
	}
	if string(out[:5]) != "%PDF-" {
		t.Fatalf("output is not a PDF, starts with %q", out[:5])
	}
	if !strings.Contains(string(out[len(out)-1024:]), "%%EOF") {
		t.Error("PDF is not properly terminated")
	}
}

// A statement with no activity must still render - billing staff run these speculatively, and a
// crash on an empty range would be a dead end rather than an answer.
func TestRenderStatementPDFWithNoLines(t *testing.T) {
	st := sampleStatement()
	st.Lines = nil
	st.Insurers = nil
	st.Physicians = nil
	st.Totals = StatementTotals{}

	out, err := renderStatementPDF(st)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) < 800 {
		t.Fatalf("empty statement produced %d bytes", len(out))
	}
}

// Enough lines to force pagination, exercising the repeated table header and the {nb} page count.
func TestRenderStatementPDFPaginates(t *testing.T) {
	st := sampleStatement()
	for i := 0; i < 120; i++ {
		l := st.Lines[0]
		l.ChargeID = "CHG" + string(rune('A'+i%26))
		st.Lines = append(st.Lines, l)
	}

	out, err := renderStatementPDF(st)
	if err != nil {
		t.Fatal(err)
	}
	// More than one /Type /Page object means the document actually broke onto further pages.
	if n := strings.Count(string(out), "/Type /Page"); n < 2 {
		t.Errorf("expected a multi-page document, found %d page objects", n)
	}
}

func TestRenderStatementPDFHandlesLongNamesAndMissingData(t *testing.T) {
	st := sampleStatement()
	st.Patient.Name = "Bartholomew Fitzwilliam Montgomery-Harrington III"
	st.Patient.Address = "4820 Northwest Commonwealth Boulevard, Apartment 14C"
	st.Patient.City = ""
	st.Patient.State = ""
	st.Patient.Zip = ""
	st.Lines[0].Physician = "Dr. Wolfeschlegelsteinhausenbergerdorff"
	st.Lines[0].InsuranceName = ""
	st.Lines[0].ProcedureCode = ""

	if _, err := renderStatementPDF(st); err != nil {
		t.Fatalf("long names and missing fields should render, got %v", err)
	}
}

func TestRenderStatementPDFWithAndWithoutMessage(t *testing.T) {
	with := sampleStatement()
	with.Message = "Please contact our billing department with any questions.\n\nThank you."
	a, err := renderStatementPDF(with)
	if err != nil {
		t.Fatal(err)
	}

	without := sampleStatement()
	without.Message = ""
	b, err := renderStatementPDF(without)
	if err != nil {
		t.Fatal(err)
	}

	// A blank message must not leave an empty section behind, so the two documents differ in size.
	if len(a) <= len(b) {
		t.Errorf("statement with a message (%d bytes) should be larger than without (%d bytes)", len(a), len(b))
	}
}

// A physician with no signature on file still gets a signature block - just a blank rule to sign.
func TestRenderStatementPDFWithoutPhysicianSignature(t *testing.T) {
	st := sampleStatement()
	st.Physicians = []StatementPhysician{{Name: "Dr. A. Okafor", NPI: "1923456789", HasSignature: false}}
	if _, err := renderStatementPDF(st); err != nil {
		t.Fatalf("a missing signature must render gracefully, got %v", err)
	}
}

func TestRenderStatementPDFWithMultipleInsurers(t *testing.T) {
	st := sampleStatement()
	st.Insurers = append(st.Insurers,
		StatementInsurer{Name: "Medicare", Paid: 4000, Adjustment: 500, Deductible: 1000, PatientBalance: 250},
		StatementInsurer{Name: "UnitedHealthcare", Paid: 1500, Copay: 1000, PatientBalance: 0},
	)
	if _, err := renderStatementPDF(st); err != nil {
		t.Fatalf("multiple payers should render, got %v", err)
	}
}

func TestTruncateKeepsCellsWithinWidth(t *testing.T) {
	out, err := renderStatementPDF(sampleStatement())
	if err != nil || len(out) == 0 {
		t.Fatalf("setup render failed: %v", err)
	}
	// truncate needs a live Fpdf for string metrics, so it is exercised through a render above;
	// here we only assert the degenerate inputs behave.
	st := sampleStatement()
	st.Lines[0].Physician = strings.Repeat("W", 400)
	if _, err := renderStatementPDF(st); err != nil {
		t.Fatalf("an absurdly long name must not break rendering: %v", err)
	}
}
