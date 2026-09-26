package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
)

// The electronic claim boundary.
//
// Everything that would talk to a clearinghouse lives behind this interface, so the rest of the
// application never knows which one is configured - section 18.
//
// THERE IS NO CLEARINGHOUSE CONFIGURED, AND THAT IS NOT AN OVERSIGHT.
//
// A professional electronic claim in the United States is an X12 837P transaction delivered to a
// clearinghouse or payer over a contracted connection. Two things make that impossible to write
// honestly today: the ISA/GS envelope needs trading-partner identifiers that only the
// clearinghouse issues, and the companion guide - which says which of the optional loops that
// particular payer requires - arrives with the contract. Generating an 837 with invented
// identifiers would produce a file that is syntactically plausible and certain to be rejected,
// which is the worst of both outcomes, because it looks like the feature works.
//
// So the default implementation REFUSES to submit. It does not queue, it does not write a file to
// disk and call that a submission, and it cannot report a status it was not given. Section 21
// requires that "Accepted" never appear without an external response confirming it; the surest
// way to honour that is for the unconfigured path to have no way of producing one.
//
// What the default implementation DOES do is validate. The data an 837P requires is knowable
// without a contract - it is the same data the CMS-1500 asks for, in the same boxes, because both
// carry the same professional claim - so a biller gets a real list of what is missing today, and
// that list will not change when a clearinghouse is eventually connected.
//
// When one is contracted, implementing this interface is the whole integration.

// Claim statuses.
//
// Draft, Ready and Validation Error are reachable locally, because they describe the claim's own
// completeness. Submitted, Accepted and Rejected describe what happened at a clearinghouse and
// are written ONLY from a response. Paid and Denied are pre-existing values used by remittance
// posting and are left exactly as they were.
const (
	ClaimDraft           = "Draft"
	ClaimReady           = "Ready"
	ClaimValidationError = "Validation Error"
	ClaimSubmitted       = "Submitted"
	ClaimAccepted        = "Accepted"
	ClaimRejected        = "Rejected"
)

// SubmissionResult is what a clearinghouse said. Status is never chosen by the caller.
type SubmissionResult struct {
	Status    string // ClaimSubmitted, ClaimAccepted or ClaimRejected
	Reference string // the clearinghouse's own control number for the submission
	Code      string // its response or rejection code, verbatim
	Message   string // its response text, verbatim - never paraphrased, never invented
}

// ClearinghouseService is the contract an integration fulfils.
type ClearinghouseService interface {
	// Name identifies the configured clearinghouse, or reports that there is none.
	Name() string

	// Format names the transaction format and version this integration produces, so the
	// interface can state it rather than implying a generic "electronic claim".
	Format() string

	// Configured reports whether submission is possible at all, so the frontend can disable the
	// control honestly instead of offering an action that is certain to fail.
	Configured() bool

	// Validate checks a claim against what the format requires. The null implementation still
	// performs every check that holds regardless of clearinghouse.
	Validate(ctx context.Context, c claimForTransmit) []ClaimProblem

	// Submit transmits. It must return an error, not a successful-looking result, when it cannot.
	Submit(ctx context.Context, c claimForTransmit) (SubmissionResult, error)

	// Status re-queries a previously submitted claim.
	Status(ctx context.Context, reference string) (SubmissionResult, error)
}

var (
	// ErrNoClearinghouse is returned by every transmitting operation when nothing is configured.
	// Written for the person reading it on screen, because that is where it ends up.
	ErrNoClearinghouse = errors.New(
		"no clearinghouse is configured on this server, so this claim cannot be submitted " +
			"electronically. The claim has been saved and validated, and can be printed on " +
			"CMS-1500 paper. Electronic submission requires a contracted clearinghouse or payer " +
			"connection, which supplies the trading-partner identifiers and companion guide that " +
			"an 837P transaction needs.")

	ErrClaimNotReady = errors.New(
		"this claim has validation errors and was not submitted. Correct them and validate again.")
)

// ClaimProblem is one thing wrong with a claim. Field is a hint the interface uses to move the
// biller to the right input (section 20); it is not a security boundary.
type ClaimProblem struct {
	Field    string `json:"field"`
	Section  string `json:"section"`
	Message  string `json:"message"`
	Blocking bool   `json:"blocking"`
}

// claimServiceLine is one procedure line as the transaction carries it.
type claimServiceLine struct {
	LineNo         int
	DOS            string
	CPT            string
	Modifiers      string
	PlaceOfService string
	DiagnosisPtr   string
	Units          float64
	Charge         float64
	RenderingNPI   string
	Provider       string
}

// claimForTransmit is the shape an integration needs. Deliberately a flat struct rather than the
// database rows, so adding a column to claims or charges does not silently change what is sent.
type claimForTransmit struct {
	ClaimID   string
	PatientID string

	PatientName  string
	PatientDOB   string
	PatientSex   string
	PatientAddr  string
	PatientCity  string
	PatientState string
	PatientZip   string

	PayerName     string
	MemberID      string
	GroupNumber   string
	Subscriber    string
	Relationship  string
	SubscriberDOB string

	BillingProviderName string
	BillingNPI          string
	TaxID               string
	FacilityName        string
	FacilityAddress     string
	ReferringProvider   string

	DiagnosisCodes []string
	ServiceLines   []claimServiceLine

	// TotalCharges is computed on the server from the charge rows, never accepted from a client.
	TotalCharges float64
}

// ---------- the default implementation ----------

type nullClearinghouse struct{}

func (nullClearinghouse) Name() string     { return "none" }
func (nullClearinghouse) Configured() bool { return false }

// Format states what an integration would produce. Named even when unconfigured, so the screen
// can say which format the practice would be submitting rather than "electronic claim".
func (nullClearinghouse) Format() string { return "X12 837P (005010X222A1)" }

// Validate checks the claim for the data a professional claim cannot go without.
//
// Every rule here is a requirement of the professional claim itself - the same data the CMS-1500
// asks for in the same boxes - so none of it is guesswork about a particular payer, and none of
// it will need revisiting when a clearinghouse is connected. A real clearinghouse applies
// hundreds of further edits from its companion guide; that is why passing this is reported as
// "no missing data found" rather than as "this claim will be accepted".
func (nullClearinghouse) Validate(_ context.Context, c claimForTransmit) []ClaimProblem {
	// Empty rather than nil, so a clean claim serialises as [] and no caller has to distinguish
	// "no problems" from "the field is missing".
	out := []ClaimProblem{}
	need := func(v, field, section, label string) {
		if strings.TrimSpace(v) == "" {
			out = append(out, ClaimProblem{Field: field, Section: section, Message: label, Blocking: true})
		}
	}

	need(c.PatientName, "patientName", "Patient", "Patient name is required")
	need(c.PatientDOB, "patientDob", "Patient", "Patient date of birth is required")
	need(c.PatientAddr, "patientAddress", "Patient", "Patient address is required")
	need(c.PatientCity, "patientCity", "Patient", "Patient city is required")
	need(c.PatientState, "patientState", "Patient", "Patient state is required")
	need(c.PatientZip, "patientZip", "Patient", "Patient ZIP code is required")

	need(c.PayerName, "payer", "Insurance", "Insurance company is required")
	need(c.MemberID, "memberId", "Insurance", "Subscriber member ID is required")
	need(c.Subscriber, "subscriber", "Insurance", "Subscriber name is required")

	need(c.BillingProviderName, "provider", "Provider", "Rendering provider is required")
	need(c.BillingNPI, "billingNpi", "Provider", "Billing provider NPI is required")
	need(c.TaxID, "taxId", "Provider", "Federal Tax ID is required")

	// An NPI is ten digits whose last digit is a Luhn check over "80840" plus the first nine.
	// Checking the shape catches a transposed digit before a payer does; it does not confirm the
	// NPI belongs to this provider, which only the NPPES registry can answer.
	if n := strings.TrimSpace(c.BillingNPI); n != "" && !validNPI(n) {
		out = append(out, ClaimProblem{Field: "billingNpi", Section: "Provider",
			Message:  "Billing provider NPI is not a valid NPI (10 digits, and the check digit must match)",
			Blocking: true})
	}

	dx := 0
	for _, d := range c.DiagnosisCodes {
		if strings.TrimSpace(d) != "" {
			dx++
		}
	}
	if dx == 0 {
		out = append(out, ClaimProblem{Field: "diagnosis", Section: "Diagnosis",
			Message: "At least one diagnosis code is required", Blocking: true})
	}
	// A professional claim carries at most twelve diagnoses, pointers A-L.
	if dx > 12 {
		out = append(out, ClaimProblem{Field: "diagnosis", Section: "Diagnosis",
			Message:  fmt.Sprintf("A claim carries at most 12 diagnosis codes; %d are entered", dx),
			Blocking: true})
	}

	if len(c.ServiceLines) == 0 {
		out = append(out, ClaimProblem{Field: "lines", Section: "Procedures",
			Message: "The claim has no service lines", Blocking: true})
	}

	for _, l := range c.ServiceLines {
		where := fmt.Sprintf("line%d", l.LineNo)
		lbl := fmt.Sprintf("Service line %d", l.LineNo)
		add := func(msg string) {
			out = append(out, ClaimProblem{Field: where, Section: "Procedures",
				Message: lbl + ": " + msg, Blocking: true})
		}
		if strings.TrimSpace(l.CPT) == "" {
			add("CPT/HCPCS code is required")
		}
		if strings.TrimSpace(l.DOS) == "" {
			add("date of service is required")
		}
		if strings.TrimSpace(l.PlaceOfService) == "" {
			add("place of service is required")
		}
		if strings.TrimSpace(l.DiagnosisPtr) == "" {
			add("diagnosis pointer is required")
		} else if bad := unknownPointer(l.DiagnosisPtr, dx); bad != "" {
			add("diagnosis pointer " + bad + " refers to a diagnosis that is not entered")
		}
		if l.Units <= 0 {
			add("units must be greater than zero")
		}
		if l.Charge <= 0 {
			add("charge must be greater than zero")
		}
	}

	// Not blocking: a claim with more than six lines is still a valid claim, it just needs a
	// second sheet on paper. Reported so the biller is not surprised at the printer.
	if len(c.ServiceLines) > 6 {
		out = append(out, ClaimProblem{Field: "lines", Section: "Procedures",
			Message: fmt.Sprintf("%d service lines: a CMS-1500 sheet holds 6, so printing on paper needs more than one sheet",
				len(c.ServiceLines)), Blocking: false})
	}

	return out
}

func (nullClearinghouse) Submit(context.Context, claimForTransmit) (SubmissionResult, error) {
	return SubmissionResult{}, ErrNoClearinghouse
}

func (nullClearinghouse) Status(context.Context, string) (SubmissionResult, error) {
	return SubmissionResult{}, ErrNoClearinghouse
}

// ---------- helpers ----------

// validNPI checks the ten-digit National Provider Identifier check digit, which is a Luhn check
// over "80840" prepended to the first nine digits.
func validNPI(npi string) bool {
	digits := strings.TrimSpace(npi)
	if len(digits) != 10 {
		return false
	}
	for i := 0; i < len(digits); i++ {
		if digits[i] < '0' || digits[i] > '9' {
			return false
		}
	}
	full := "80840" + digits[:9]
	sum, double := 0, true // the rightmost of the 14 positions is doubled first
	for i := len(full) - 1; i >= 0; i-- {
		d := int(full[i] - '0')
		if double {
			if d *= 2; d > 9 {
				d -= 9
			}
		}
		double = !double
		sum += d
	}
	return (10-sum%10)%10 == int(digits[9]-'0')
}

// unknownPointer returns the first pointer letter that points past the diagnoses entered, or "".
// Pointers are letters A-L referring to the diagnosis slots, so "AB" on a claim with one
// diagnosis is a real error that a payer would reject.
func unknownPointer(ptr string, dxCount int) string {
	for _, r := range strings.ToUpper(strings.TrimSpace(ptr)) {
		if r == ',' || r == ' ' {
			continue
		}
		if r < 'A' || r > 'L' {
			return string(r)
		}
		if int(r-'A') >= dxCount {
			return string(r)
		}
	}
	return ""
}

// clearinghouseProvider returns the configured implementation. Selected by environment variable
// so an integration can be introduced without touching calling code. An unrecognised name falls
// back to the refusing implementation, because a server that looks configured and is not is the
// more dangerous of the two failures.
func clearinghouseProvider() ClearinghouseService {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("CLEARINGHOUSE_PROVIDER"))) {
	case "", "none":
		return nullClearinghouse{}
	default:
		return nullClearinghouse{}
	}
}

// clearinghouseNote explains in one line what submission is available, shown next to the control.
func clearinghouseNote(p ClearinghouseService) string {
	if p.Configured() {
		return fmt.Sprintf("Electronic claims are submitted to %s as %s.", p.Name(), p.Format())
	}
	return "Electronic claim submission is not configured on this server. Claims can be created, " +
		"validated and printed on CMS-1500 paper, but not transmitted to a payer."
}
