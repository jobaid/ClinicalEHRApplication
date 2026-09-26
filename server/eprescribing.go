package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
)

// The e-prescribing boundary.
//
// Everything that would talk to a prescribing network lives behind this interface, so the rest
// of the application never knows which provider is configured - section 9.
//
// THERE IS NO PROVIDER CONFIGURED, AND THAT IS NOT AN OVERSIGHT.
//
// Transmitting a prescription to a real pharmacy in the United States goes through Surescripts.
// That is a commercial contract plus a certification process for the application, not a public
// API. There is no sandbox anyone can call without onboarding, and there is no honest way to
// write code today that delivers a prescription to a pharmacy counter.
//
// So the default implementation REFUSES. It does not queue, it does not pretend, and it never
// returns a status the caller could mistake for delivery. Section 10 puts it plainly: never
// display "Sent Successfully" unless the backend received confirmation. The most reliable way to
// honour that is for the unconfigured path to be incapable of reporting success at all.
//
// When a provider is contracted, implementing this interface is the whole integration. Nothing
// else in the application changes.

// Statuses. SUBMITTED and beyond are written ONLY in response to what a provider returned.
const (
	RxDraft       = "DRAFT"
	RxReadyToSign = "READY_TO_SIGN"
	RxSigned      = "SIGNED"
	RxSubmitted   = "SUBMITTED"
	RxAccepted    = "ACCEPTED"
	RxFailed      = "FAILED"
	RxCancelled   = "CANCELLED"
)

// TransmissionResult is what a provider said. Status is never invented by the caller.
type TransmissionResult struct {
	Status    string // RxSubmitted, RxAccepted or RxFailed
	Reference string // the provider's own id for the transmission
	Message   string
}

// EPrescribingService is the contract a provider implementation fulfils. Only operations a
// provider genuinely supports should be implemented; the rest return ErrNotSupported rather
// than a plausible-looking lie.
type EPrescribingService interface {
	// Name identifies the configured provider, or reports that there is none.
	Name() string

	// Configured reports whether transmission is possible at all. The interface exposes this so
	// the frontend can disable the Send control honestly instead of offering an action that
	// will fail.
	Configured() bool

	// Validate checks a prescription against the provider's requirements. The null provider
	// still performs the checks that are true regardless of provider, because a prescription
	// missing a SIG is wrong whether or not it can be sent.
	Validate(ctx context.Context, rx prescriptionForTransmit) []string

	// Send transmits. It must return an error, not a successful-looking result, when it cannot.
	Send(ctx context.Context, rx prescriptionForTransmit) (TransmissionResult, error)

	// Status re-queries a previously submitted prescription.
	Status(ctx context.Context, reference string) (TransmissionResult, error)

	// Cancel requests cancellation through the provider's own workflow.
	Cancel(ctx context.Context, reference, reason string) (TransmissionResult, error)
}

var (
	// ErrNoProvider is returned by every transmitting operation when nothing is configured. The
	// message is written for the person reading it on screen, because that is where it ends up.
	ErrNoProvider = errors.New(
		"no e-prescribing provider is configured on this server, so this prescription cannot be " +
			"transmitted electronically. It has been saved and can be printed. Electronic " +
			"transmission requires a contracted e-prescribing network (for example Surescripts) " +
			"to be set up and certified for this application.")

	ErrNotSupported = errors.New("the configured e-prescribing provider does not support that operation")

	// ErrControlled guards section 20. Controlled substances require an EPCS-certified pathway
	// with DEA identity proofing and two-factor signing. Refusing is the only correct behaviour
	// until such a pathway exists; a workaround here would be the kind of thing that ends a
	// practice's ability to prescribe at all.
	ErrControlled = errors.New(
		"controlled-substance prescriptions cannot be transmitted electronically by this " +
			"application. That requires an EPCS-certified e-prescribing solution with DEA " +
			"identity proofing and two-factor signing.")
)

// prescriptionForTransmit is the shape a provider needs. Deliberately a flat struct rather than
// the database row, so adding a column to prescriptions does not silently change what gets sent.
type prescriptionForTransmit struct {
	ID         string
	PatientID  string
	Medication string
	Strength   string
	Dose       string
	Route      string
	Frequency  string
	Quantity   string
	DaysSupply string
	Refills    string
	SIG        string

	IsControlled bool

	PharmacyID      string
	PharmacyName    string
	PharmacyNCPDPID string

	PrescriberName string
	PrescriberNPI  string
}

// ---------- the default provider ----------

type nullProvider struct{}

func (nullProvider) Name() string     { return "none" }
func (nullProvider) Configured() bool { return false }

// Validate runs the checks that hold regardless of provider.
//
// These are completeness checks on what the prescriber wrote - not clinical judgements. Nothing
// here decides whether a dose is appropriate, whether two medications interact, or whether the
// medication suits the patient. This application has no licensed drug database and inventing
// such warnings would be worse than showing none, because a prescriber could come to rely on
// them (section 16).
func (nullProvider) Validate(_ context.Context, rx prescriptionForTransmit) []string {
	var problems []string
	req := func(v, label string) {
		if strings.TrimSpace(v) == "" {
			problems = append(problems, label+" is required")
		}
	}
	req(rx.Medication, "Medication")
	req(rx.Strength, "Strength")
	req(rx.Dose, "Dose")
	req(rx.Route, "Route")
	req(rx.Frequency, "Frequency")
	req(rx.Quantity, "Quantity")
	req(rx.SIG, "Directions (SIG)")

	if strings.TrimSpace(rx.PharmacyID) == "" {
		problems = append(problems, "A pharmacy must be selected")
	}
	if strings.TrimSpace(rx.PrescriberNPI) == "" {
		problems = append(problems, "The prescriber has no NPI recorded")
	}
	// Reported as a finding rather than an error: a pharmacy with no network identifier is a
	// perfectly good address to print and hand to a patient, it just cannot be transmitted to.
	if strings.TrimSpace(rx.PharmacyNCPDPID) == "" {
		problems = append(problems,
			"The selected pharmacy has no NCPDP network identifier, so it cannot receive an electronic prescription")
	}
	if rx.IsControlled {
		problems = append(problems, ErrControlled.Error())
	}
	return problems
}

func (nullProvider) Send(_ context.Context, rx prescriptionForTransmit) (TransmissionResult, error) {
	if rx.IsControlled {
		return TransmissionResult{}, ErrControlled
	}
	return TransmissionResult{}, ErrNoProvider
}

func (nullProvider) Status(context.Context, string) (TransmissionResult, error) {
	return TransmissionResult{}, ErrNoProvider
}

func (nullProvider) Cancel(context.Context, string, string) (TransmissionResult, error) {
	return TransmissionResult{}, ErrNoProvider
}

// eprescribingProvider returns the configured implementation.
//
// Selected by environment variable so a provider can be introduced without touching calling
// code. An unrecognised name is treated as "none" rather than ignored quietly, because the
// alternative is a server that looks configured and is not.
func eprescribingProvider() EPrescribingService {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("ERX_PROVIDER"))) {
	case "", "none":
		return nullProvider{}
	default:
		// No provider implementations exist yet. Anything else is a misconfiguration, and
		// falling back to the refusing provider is the safe direction to fail.
		return nullProvider{}
	}
}

// erxStatusNote explains, in one line, what the configured provider can do. Shown next to the
// Send control so a prescriber knows before writing a prescription whether it can be sent.
func erxStatusNote(p EPrescribingService) string {
	if p.Configured() {
		return fmt.Sprintf("Electronic transmission is available through %s.", p.Name())
	}
	return "Electronic transmission is not configured on this server. Prescriptions can be " +
		"created, signed and printed, but not sent to a pharmacy electronically."
}
