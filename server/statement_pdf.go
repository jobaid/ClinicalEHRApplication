package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"log"
	"strings"
	"sync"

	"github.com/go-pdf/fpdf"
)

// PDF rendering for patient statements.
//
// Rendered server-side with go-pdf/fpdf, which draws to an explicit coordinate space. That is the
// point: a statement has to paginate predictably, keep a table header on every page, and never
// clip a long patient name or an eleven-column money row. An HTML-to-PDF pass would hand that
// control to whatever renderer happened to be installed.
//
// The unit is the millimetre and the page is A4 portrait in landscape orientation - the line
// table carries eleven columns of currency, and portrait cannot hold them at a readable size.

// statementLogf is the one logging entry point for this feature. It exists so every log line here
// is easy to audit for accidental disclosure: an EHR must not leave patient names, addresses or
// balances in a log file, so callers pass errors and counts, never row contents.
func statementLogf(format string, args ...any) {
	log.Printf(format, args...)
}


// ---------- Text encoding ----------
//
// fpdf's built-in fonts are single-byte and use the CP1252 code page, not UTF-8. Writing a Go
// string straight into a cell renders every non-ASCII byte individually, so "·" arrives as "Â·",
// an en dash as "â€“", and a patient named José or Müller has their name misspelled on their own
// bill. Every string drawn into the document goes through tr() first.
//
// The translator is a pure function over a static table, so it is built once and shared; the
// throwaway Fpdf exists only because fpdf exposes the constructor as a method.
var (
	cp1252Once sync.Once
	cp1252Fn   func(string) string
)

func tr(s string) string {
	cp1252Once.Do(func() {
		cp1252Fn = fpdf.New("P", "mm", "A4", "").UnicodeTranslatorFromDescriptor("")
	})
	return cp1252Fn(s)
}

// Layout constants. Declared once so the header, the rows and the page-break logic cannot
// disagree about where a column starts.
const (
	pageMarginX = 10.0
	pageMarginY = 12.0
	footerSpace = 16.0

	rowHeight    = 5.0
	headerHeight = 6.0
)

// statementColumns is the line table. Widths total 277mm, which is A4 landscape (297mm) less both
// 10mm margins.
var statementColumns = []struct {
	title string
	width float64
	align string
}{
	{"DOS", 20, "L"},
	{"Txn Date", 20, "L"},
	{"Proc", 16, "L"},
	{"CPT", 16, "L"},
	{"Physician", 38, "L"},
	{"Insurance", 38, "L"},
	{"Charges", 21, "R"},
	{"Ins Paid", 21, "R"},
	{"Adjust", 21, "R"},
	{"Copay", 18, "R"},
	{"Deduct", 18, "R"},
	{"Pt Paid", 15, "R"},
	{"Self-Pay", 15, "R"},
}

// money formats integer cents as currency, with thousands separators, for the PDF.
// Negative amounts are parenthesised, which is the accounting convention a billing office reads
// faster than a leading minus sign.
func moneyCents(c int64) string {
	neg := c < 0
	if neg {
		c = -c
	}
	whole := c / 100
	frac := c % 100

	s := fmt.Sprintf("%d", whole)
	var out []byte
	for i, ch := range []byte(s) {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, ch)
	}

	formatted := fmt.Sprintf("$%s.%02d", out, frac)
	if neg {
		return "(" + formatted + ")"
	}
	return formatted
}

// usDate turns an ISO date into MM/DD/YYYY, matching what the application displays everywhere
// else (fmtDate in src/app.jsx). Anything that is not an ISO date passes through untouched so a
// blank field stays blank rather than becoming "01/01/0001".
func usDate(iso string) string {
	if len(iso) < 10 || iso[4] != '-' || iso[7] != '-' {
		return iso
	}
	return iso[5:7] + "/" + iso[8:10] + "/" + iso[0:4]
}

func renderStatementPDF(st *Statement) ([]byte, error) {
	pdf := fpdf.New("L", "mm", "A4", "")
	// Registers the {nb} placeholder the footer uses for the total page count; fpdf substitutes
	// the real figure once the document is closed and the count is finally known.
	pdf.AliasNbPages("{nb}")
	pdf.SetMargins(pageMarginX, pageMarginY, pageMarginX)
	pdf.SetAutoPageBreak(true, footerSpace)
	pdf.SetTitle(fmt.Sprintf("Patient Statement %s", st.Patient.ID), true)

	// The footer runs on every page, so it is registered before the first page is added.
	pdf.SetFooterFunc(func() { drawFooter(pdf, st) })

	// The table header repeats on every page, including ones created by an automatic page break
	// in the middle of the line table.
	pdf.SetHeaderFunc(func() {
		if pdf.PageNo() > 1 {
			pdf.SetY(pageMarginY)
			drawContinuationHeader(pdf, st)
			drawTableHeader(pdf)
		}
	})

	pdf.AddPage()

	drawLetterhead(pdf, st)
	drawPatientBlock(pdf, st)
	drawTableHeader(pdf)
	drawLines(pdf, st)
	drawSummary(pdf, st)
	drawInsurers(pdf, st)
	drawMessage(pdf, st)
	drawPhysicians(pdf, st)

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func drawLetterhead(pdf *fpdf.Fpdf, st *Statement) {
	pdf.SetFont("Helvetica", "B", 16)
	pdf.CellFormat(0, 7, tr(st.Practice.Name), "", 1, "L", false, 0, "")

	pdf.SetFont("Helvetica", "", 9)
	pdf.SetTextColor(90, 90, 90)
	pdf.CellFormat(0, 4.5, tr(st.Practice.Address), "", 1, "L", false, 0, "")

	contact := st.Practice.Phone
	if st.Practice.TaxID != "" {
		contact += "   ·   Tax ID " + st.Practice.TaxID
	}
	pdf.CellFormat(0, 4.5, tr(contact), "", 1, "L", false, 0, "")
	pdf.SetTextColor(0, 0, 0)

	// Title block, right-aligned against the letterhead.
	pdf.SetY(pageMarginY)
	pdf.SetFont("Helvetica", "B", 18)
	pdf.CellFormat(0, 8, tr("PATIENT STATEMENT"), "", 1, "R", false, 0, "")
	pdf.SetFont("Helvetica", "", 9)
	pdf.CellFormat(0, 4.5, "Statement date: "+usDate(st.Generated), "", 1, "R", false, 0, "")
	pdf.CellFormat(0, 4.5,
		tr(fmt.Sprintf("%s: %s – %s", basisLabel(st.Basis), usDate(st.From), usDate(st.To))),
		"", 1, "R", false, 0, "")

	pdf.Ln(2)
	drawRule(pdf)
	pdf.Ln(3)
}

func drawRule(pdf *fpdf.Fpdf) {
	pdf.SetDrawColor(40, 40, 40)
	pdf.SetLineWidth(0.4)
	y := pdf.GetY()
	w, _ := pdf.GetPageSize()
	pdf.Line(pageMarginX, y, w-pageMarginX, y)
}

func drawPatientBlock(pdf *fpdf.Fpdf, st *Statement) {
	startY := pdf.GetY()

	pdf.SetFont("Helvetica", "B", 8)
	pdf.SetTextColor(110, 110, 110)
	pdf.CellFormat(90, 4, tr("STATEMENT FOR"), "", 1, "L", false, 0, "")
	pdf.SetTextColor(0, 0, 0)

	pdf.SetFont("Helvetica", "B", 11)
	// MultiCell wraps rather than clips, so a long patient name takes a second line instead of
	// running under the account block to its right.
	pdf.MultiCell(90, 5, tr(st.Patient.Name), "", "L", false)

	pdf.SetFont("Helvetica", "", 9.5)
	for _, l := range addressLines(st.Patient) {
		pdf.MultiCell(90, 4.5, tr(l), "", "L", false)
	}

	// Account block, set beside the address rather than below it.
	pdf.SetXY(pageMarginX+110, startY)
	pdf.SetFont("Helvetica", "B", 8)
	pdf.SetTextColor(110, 110, 110)
	pdf.CellFormat(60, 4, tr("ACCOUNT NUMBER"), "", 2, "L", false, 0, "")
	pdf.SetTextColor(0, 0, 0)
	pdf.SetFont("Helvetica", "B", 11)
	pdf.CellFormat(60, 5, tr(st.Patient.ID), "", 2, "L", false, 0, "")

	// Amount due, given the visual weight it deserves - it is the one number the patient is
	// looking for.
	pdf.SetXY(pageMarginX+200, startY)
	pdf.SetFont("Helvetica", "B", 8)
	pdf.SetTextColor(110, 110, 110)
	pdf.CellFormat(77, 4, tr("AMOUNT DUE"), "", 2, "R", false, 0, "")
	pdf.SetTextColor(0, 0, 0)
	pdf.SetFont("Helvetica", "B", 20)
	pdf.CellFormat(77, 10, tr(moneyCents(st.Totals.AmountDue)), "", 2, "R", false, 0, "")

	// Whichever column ran longest sets where the table starts.
	if y := pdf.GetY(); y < startY+26 {
		pdf.SetY(startY + 26)
	}
	pdf.SetX(pageMarginX)
	pdf.Ln(1)
}

// addressLines assembles the mailing address, skipping parts the record does not have so a
// patient with no city does not get a line reading ", NY 11426".
func addressLines(p StatementPatient) []string {
	var lines []string
	if p.Address != "" {
		lines = append(lines, p.Address)
	}

	var cityLine string
	switch {
	case p.City != "" && p.State != "":
		cityLine = p.City + ", " + p.State
	case p.City != "":
		cityLine = p.City
	case p.State != "":
		cityLine = p.State
	}
	if p.Zip != "" {
		if cityLine != "" {
			cityLine += " " + p.Zip
		} else {
			cityLine = p.Zip
		}
	}
	if cityLine != "" {
		lines = append(lines, cityLine)
	}
	if len(lines) == 0 {
		lines = append(lines, "No address on file")
	}
	return lines
}

// drawContinuationHeader identifies pages 2+ so a page separated from the rest of the statement
// still says whose account it belongs to.
func drawContinuationHeader(pdf *fpdf.Fpdf, st *Statement) {
	pdf.SetFont("Helvetica", "", 8)
	pdf.SetTextColor(110, 110, 110)
	pdf.CellFormat(0, 4,
		tr(fmt.Sprintf("%s  ·  Statement for %s  ·  Account %s  ·  continued",
			st.Practice.Name, st.Patient.Name, st.Patient.ID)), "", 1, "L", false, 0, "")
	pdf.SetTextColor(0, 0, 0)
	pdf.Ln(1)
}

func drawTableHeader(pdf *fpdf.Fpdf) {
	pdf.SetFont("Helvetica", "B", 7.5)
	pdf.SetFillColor(238, 242, 242)
	pdf.SetDrawColor(200, 210, 210)
	pdf.SetLineWidth(0.2)
	for _, c := range statementColumns {
		pdf.CellFormat(c.width, headerHeight, tr(c.title), "TB", 0, c.align, true, 0, "")
	}
	pdf.Ln(-1)
}

func drawLines(pdf *fpdf.Fpdf, st *Statement) {
	pdf.SetFont("Helvetica", "", 7.5)

	if len(st.Lines) == 0 {
		pdf.SetTextColor(120, 120, 120)
		pdf.CellFormat(0, 8, tr("No activity in the selected period."), "B", 1, "C", false, 0, "")
		pdf.SetTextColor(0, 0, 0)
		pdf.Ln(2)
		return
	}

	for i, l := range st.Lines {
		// Zebra striping makes an eleven-column row traceable across the page.
		fill := i%2 == 1
		if fill {
			pdf.SetFillColor(248, 250, 250)
		}

		values := []string{
			usDate(l.DOS),
			usDate(l.TransactionDate),
			l.ProcedureCode,
			l.CPT,
			truncate(pdf, l.Physician, statementColumns[4].width-2),
			truncate(pdf, insuranceOrDash(l.InsuranceName), statementColumns[5].width-2),
			moneyCents(l.Charge),
			moneyCents(l.InsurancePaid),
			moneyCents(l.Adjustment),
			moneyCents(l.Copay),
			moneyCents(l.Deductible),
			moneyCents(l.PatientPaid),
			moneyCents(l.SelfPay),
		}
		for j, c := range statementColumns {
			pdf.CellFormat(c.width, rowHeight, tr(values[j]), "B", 0, c.align, fill, 0, "")
		}
		pdf.Ln(-1)
	}
	pdf.Ln(2)
}

func insuranceOrDash(name string) string {
	if name == "" {
		return "Unassigned"
	}
	return name
}

// truncate shortens a string with an ellipsis until it fits the given width. Long physician and
// insurer names are common, and a cell that overflows in fpdf writes straight over its neighbour
// rather than wrapping, so this is what keeps the row grid intact.
func truncate(pdf *fpdf.Fpdf, s string, max float64) string {
	// Measured on the translated form, because that is what will actually be drawn - measuring the
	// UTF-8 original would overestimate the width of every accented name and truncate it early.
	if s == "" || pdf.GetStringWidth(tr(s)) <= max {
		return s
	}
	// Trimmed by rune, not by byte: cutting a multi-byte character in half produces a broken
	// sequence the translator cannot map.
	r := []rune(s)
	for len(r) > 1 {
		r = r[:len(r)-1]
		if pdf.GetStringWidth(tr(string(r)+"…")) <= max {
			return string(r) + "…"
		}
	}
	s = string(r)
	return s
}

func drawSummary(pdf *fpdf.Fpdf, st *Statement) {
	// Keep the whole summary block together: breaking it across a page is what makes a statement
	// look like a database dump.
	ensureSpace(pdf, 46)

	pdf.SetFont("Helvetica", "B", 9)
	pdf.CellFormat(0, 5, tr("FINANCIAL SUMMARY"), "", 1, "L", false, 0, "")
	pdf.Ln(1)

	left := pdf.GetX()
	rows := []struct {
		label string
		value int64
		bold  bool
	}{
		{"Total charges", st.Totals.Charges, false},
		{"Insurance paid", -st.Totals.InsurancePaid, false},
		{"Adjustments", -st.Totals.Adjustments, false},
		{"Patient payments", -st.Totals.PatientPayments, false},
	}

	const labelW, valueW = 55.0, 30.0
	for _, r := range rows {
		pdf.SetX(left)
		pdf.SetFont("Helvetica", "", 9)
		pdf.CellFormat(labelW, 5.5, tr(r.label), "", 0, "L", false, 0, "")
		pdf.CellFormat(valueW, 5.5, tr(moneyCents(r.value)), "", 1, "R", false, 0, "")
	}

	// Copay and deductible are reported, not subtracted: they are the parts of the allowed amount
	// the plan assigned to the patient, and the money itself is already counted in the paid and
	// self-pay figures. Listing them under the arithmetic keeps them visible without
	// double-counting them into the balance.
	pdf.SetX(left)
	pdf.SetDrawColor(150, 150, 150)
	pdf.SetLineWidth(0.2)
	pdf.CellFormat(labelW+valueW, 0, "", "T", 1, "", false, 0, "")
	pdf.Ln(1)

	pdf.SetX(left)
	pdf.SetFont("Helvetica", "B", 11)
	pdf.CellFormat(labelW, 7, tr("Amount due"), "", 0, "L", false, 0, "")
	pdf.CellFormat(valueW, 7, tr(moneyCents(st.Totals.AmountDue)), "", 1, "R", false, 0, "")

	pdf.Ln(1)
	pdf.SetX(left)
	pdf.SetFont("Helvetica", "", 8)
	pdf.SetTextColor(110, 110, 110)
	pdf.CellFormat(labelW+valueW, 4,
		fmt.Sprintf("Of which copay %s and deductible %s",
			moneyCents(st.Totals.Copay), moneyCents(st.Totals.Deductible)),
		"", 1, "L", false, 0, "")
	pdf.SetTextColor(0, 0, 0)
	pdf.Ln(3)
}

// drawInsurers prints the per-payer breakdown, and only when there is one to print. A self-pay
// patient gets no empty "Insurance" table.
func drawInsurers(pdf *fpdf.Fpdf, st *Statement) {
	real := make([]StatementInsurer, 0, len(st.Insurers))
	for _, in := range st.Insurers {
		if in.Name != "" && in.Name != "Self / Patient" {
			real = append(real, in)
		}
	}
	if len(real) == 0 {
		return
	}

	ensureSpace(pdf, float64(12+len(real)*6))

	pdf.SetFont("Helvetica", "B", 9)
	pdf.CellFormat(0, 5, tr("INSURANCE ACTIVITY"), "", 1, "L", false, 0, "")
	pdf.Ln(1)

	cols := []struct {
		title string
		width float64
		align string
	}{
		{"Insurance", 60, "L"}, {"Paid", 26, "R"}, {"Adjustment", 26, "R"},
		{"Copay", 24, "R"}, {"Deductible", 26, "R"}, {"Patient responsibility", 40, "R"},
	}

	pdf.SetFont("Helvetica", "B", 7.5)
	pdf.SetFillColor(238, 242, 242)
	for _, c := range cols {
		pdf.CellFormat(c.width, headerHeight, tr(c.title), "TB", 0, c.align, true, 0, "")
	}
	pdf.Ln(-1)

	pdf.SetFont("Helvetica", "", 8)
	for _, in := range real {
		vals := []string{
			truncate(pdf, in.Name, 58),
			moneyCents(in.Paid), moneyCents(in.Adjustment),
			moneyCents(in.Copay), moneyCents(in.Deductible), moneyCents(in.PatientBalance),
		}
		for j, c := range cols {
			pdf.CellFormat(c.width, rowHeight, tr(vals[j]), "B", 0, c.align, false, 0, "")
		}
		pdf.Ln(-1)
	}
	pdf.Ln(3)
}

// drawMessage prints the optional staff message. Nothing is drawn when it is blank - no heading,
// no empty box.
func drawMessage(pdf *fpdf.Fpdf, st *Statement) {
	msg := strings.TrimSpace(st.Message)
	if msg == "" {
		return
	}

	ensureSpace(pdf, 24)

	pdf.SetFont("Helvetica", "B", 9)
	pdf.CellFormat(0, 5, tr("MESSAGE"), "", 1, "L", false, 0, "")
	pdf.Ln(1)

	pdf.SetFont("Helvetica", "", 9)
	pdf.SetFillColor(248, 250, 250)
	pdf.SetDrawColor(210, 220, 220)
	// MultiCell handles both the embedded newlines the user typed and wrapping of long lines.
	w, _ := pdf.GetPageSize()
	pdf.MultiCell(w-2*pageMarginX, 5, tr(msg), "1", "L", true)
	pdf.Ln(3)
}

// drawPhysicians prints a signature block per physician on the statement.
//
// A stored signature image is drawn; a physician without one gets a ruled line to sign by hand.
// Nothing is ever synthesised - a drawn-on "signature" for a physician who never provided one
// would be a forgery on a medical billing document.
func drawPhysicians(pdf *fpdf.Fpdf, st *Statement) {
	if len(st.Physicians) == 0 {
		return
	}

	ensureSpace(pdf, 30)

	pdf.SetFont("Helvetica", "B", 9)
	pdf.CellFormat(0, 5, tr("PHYSICIAN"), "", 1, "L", false, 0, "")
	pdf.Ln(2)

	const blockW = 88.0
	startY := pdf.GetY()
	x := pageMarginX

	for _, p := range st.Physicians {
		pageW, _ := pdf.GetPageSize()
		if x+blockW > pageW-pageMarginX {
			x = pageMarginX
			startY += 26
			pdf.SetY(startY)
		}

		if img := decodeSignature(p.signature); img != nil {
			// Registered under the physician's name so the same signature reused on a later page
			// is embedded once rather than per occurrence.
			opt := fpdf.ImageOptions{ImageType: img.kind, ReadDpi: false}
			pdf.RegisterImageOptionsReader("sig-"+p.Name, opt, bytes.NewReader(img.data))
			// Height fixed, width 0 = keep the aspect ratio, so a wide signature is not squashed.
			pdf.ImageOptions("sig-"+p.Name, x, startY, 0, 12, false, opt, 0, "")
		}

		// The rule sits at a fixed offset whether or not an image was drawn above it.
		lineY := startY + 13
		pdf.SetDrawColor(120, 120, 120)
		pdf.SetLineWidth(0.2)
		pdf.Line(x, lineY, x+blockW-8, lineY)

		pdf.SetXY(x, lineY+0.5)
		pdf.SetFont("Helvetica", "", 8.5)
		pdf.CellFormat(blockW-8, 4, tr(p.Name), "", 2, "L", false, 0, "")

		pdf.SetFont("Helvetica", "", 7.5)
		pdf.SetTextColor(120, 120, 120)
		label := "Physician signature"
		if p.NPI != "" {
			label = "NPI " + p.NPI
		}
		pdf.CellFormat(blockW-8, 3.5, tr(label), "", 2, "L", false, 0, "")
		pdf.SetTextColor(0, 0, 0)

		x += blockW
	}

	pdf.SetY(startY + 26)
	pdf.SetX(pageMarginX)
}

type signatureImage struct {
	data []byte
	kind string
}

// decodeSignature reads a stored `data:image/...;base64,...` URL.
//
// Returns nil for anything it does not fully understand rather than guessing, which is what makes
// "no signature on file" and "a corrupt signature on file" behave identically on the page: both
// fall through to the hand-signing rule.
func decodeSignature(dataURL string) *signatureImage {
	if !strings.HasPrefix(dataURL, "data:image/") {
		return nil
	}
	comma := strings.IndexByte(dataURL, ',')
	if comma < 0 {
		return nil
	}
	meta := dataURL[len("data:image/"):comma]
	if !strings.Contains(meta, "base64") {
		return nil
	}

	kind := strings.ToUpper(strings.SplitN(meta, ";", 2)[0])
	switch kind {
	case "PNG", "JPEG", "GIF":
	case "JPG":
		kind = "JPEG"
	default:
		return nil
	}

	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(dataURL[comma+1:]))
	if err != nil || len(raw) == 0 {
		return nil
	}
	return &signatureImage{data: raw, kind: kind}
}

// ensureSpace starts a new page when the remaining height cannot hold the next block, so a
// summary or a signature block is never split across the fold.
func ensureSpace(pdf *fpdf.Fpdf, needed float64) {
	_, pageH := pdf.GetPageSize()
	if pdf.GetY()+needed > pageH-footerSpace {
		pdf.AddPage()
	}
}

func drawFooter(pdf *fpdf.Fpdf, st *Statement) {
	pdf.SetY(-14)

	pdf.SetDrawColor(200, 210, 210)
	pdf.SetLineWidth(0.2)
	w, _ := pdf.GetPageSize()
	pdf.Line(pageMarginX, pdf.GetY(), w-pageMarginX, pdf.GetY())
	pdf.Ln(1)

	pdf.SetFont("Helvetica", "", 7.5)
	pdf.SetTextColor(120, 120, 120)

	contact := st.Practice.Name
	if st.Practice.Phone != "" {
		contact += "  ·  " + st.Practice.Phone
	}
	pdf.CellFormat(200, 4, tr(contact), "", 0, "L", false, 0, "")

	// {nb} is substituted with the final page count by AliasNbPages, registered below.
	pdf.CellFormat(0, 4, fmt.Sprintf("Page %d of {nb}", pdf.PageNo()), "", 0, "R", false, 0, "")
	pdf.SetTextColor(0, 0, 0)
}
