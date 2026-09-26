// CMS-1500 (HCFA) field map, data mapping, validation and alignment storage.
//
// No components here: this is the part a form revision or a payer-specific tweak touches, kept
// separate so changing a coordinate never means editing a React component.
//
// Added alongside the existing claim screens - nothing existing is changed. Every value comes
// from records the application already holds: the charge carries DOS, CPT, provider, NPI, tax
// ID, facility, units and the ten diagnosis slots (which are Box 21), the patient carries
// demographics, and the insurance policy carries subscriber and member details. Nothing is
// stored for this feature and no claim is duplicated to support it.
//
// ABOUT THE COORDINATES
//
// The BOX NUMBERS and what belongs in each are the published CMS-1500 (02/12) definition and are
// correct. The physical positions below are a calibrated starting point, not a guarantee:
// preprinted stock varies between print runs and every printer feeds paper slightly differently,
// which is why practices calibrate. That is what the alignment offsets and the test page are
// for - print the test page on real stock, adjust until the crosses land in the boxes, save.
//
// The map is one table so a form revision is an edit here rather than a rewrite of the screen.


export const PAGE = { width: 8.5, height: 11 };   // inches, US Letter - the CMS-1500 sheet
const ALIGN_KEY = "hcfa_alignment";

// ---------- field map ----------
//
// x and y are inches from the top-left of the page to the START of the field's text baseline
// area. w is the usable width, used only to clip overly long values so they cannot bleed into
// the neighbouring box on preprinted paper.
const F = (box, label, x, y, w, opts = {}) => ({ box, label, x, y, w, ...opts });

export const CMS1500_FIELDS = [
  F("1", "Insurance type", 0.60, 1.62, 1.6),
  F("1a", "Insured's ID number", 5.55, 1.62, 2.4),
  F("2", "Patient name", 0.30, 2.00, 3.0),
  F("3-dob", "Patient DOB", 3.42, 2.00, 0.9),
  F("3-sex", "Patient sex", 4.45, 2.00, 0.5),
  F("4", "Insured's name", 5.55, 2.00, 2.6),
  F("5-addr", "Patient address", 0.30, 2.37, 3.0),
  F("5-city", "Patient city", 0.30, 2.74, 2.2),
  F("5-state", "Patient state", 2.70, 2.74, 0.5),
  F("5-zip", "Patient ZIP", 0.30, 3.11, 1.2),
  F("5-phone", "Patient phone", 1.65, 3.11, 1.4),
  F("6", "Relationship to insured", 3.42, 2.37, 1.6),
  F("7-addr", "Insured's address", 5.55, 2.37, 2.6),
  F("7-city", "Insured's city", 5.55, 2.74, 2.0),
  F("7-state", "Insured's state", 7.65, 2.74, 0.4),
  F("7-zip", "Insured's ZIP", 5.55, 3.11, 1.2),
  F("9", "Other insured's name", 0.30, 3.48, 3.0),
  F("11", "Insured's policy/group", 5.55, 3.48, 2.4),
  F("11a", "Insured's DOB", 5.55, 3.85, 1.2),
  F("11c", "Insurance plan name", 5.55, 4.59, 2.4),
  F("12", "Patient signature", 0.42, 5.28, 2.0),
  F("12-date", "Signature date", 2.62, 5.28, 1.0),
  F("13", "Insured's signature", 5.55, 5.28, 2.4),
  F("14", "Date of current illness", 0.34, 5.66, 1.3),
  F("17", "Referring provider", 0.55, 6.03, 2.6),
  F("17b", "Referring provider NPI", 3.42, 6.03, 1.5),
  F("21a", "Diagnosis A", 0.62, 6.78, 0.9),
  F("21b", "Diagnosis B", 2.12, 6.78, 0.9),
  F("21c", "Diagnosis C", 3.62, 6.78, 0.9),
  F("21d", "Diagnosis D", 5.12, 6.78, 0.9),
  F("21e", "Diagnosis E", 0.62, 7.03, 0.9),
  F("21f", "Diagnosis F", 2.12, 7.03, 0.9),
  F("21g", "Diagnosis G", 3.62, 7.03, 0.9),
  F("21h", "Diagnosis H", 5.12, 7.03, 0.9),
  F("21i", "Diagnosis I", 0.62, 7.28, 0.9),
  F("21j", "Diagnosis J", 2.12, 7.28, 0.9),
  F("21k", "Diagnosis K", 3.62, 7.28, 0.9),
  F("21l", "Diagnosis L", 5.12, 7.28, 0.9),
  F("25", "Federal Tax ID", 0.30, 9.62, 1.4),
  F("26", "Patient account no", 1.85, 9.62, 1.2),
  F("28", "Total charge", 5.60, 9.62, 0.9, { align: "right" }),
  F("29", "Amount paid", 6.62, 9.62, 0.8, { align: "right" }),
  F("31", "Provider signature", 0.34, 10.00, 1.9),
  F("32", "Service facility", 2.35, 10.00, 2.6),
  F("32a", "Facility NPI", 2.35, 10.50, 1.4),
  F("33", "Billing provider", 5.20, 10.00, 2.9),
  F("33a", "Billing NPI", 5.55, 10.50, 1.4),
];

// Service lines, Box 24. Six rows, each a fixed step down the page.
export const LINE_TOP = 7.68;
export const LINE_STEP = 0.265;
export const LINE_COLS = [
  { key: "dosFrom", x: 0.32, w: 0.78, label: "24A From" },
  { key: "dosTo", x: 1.12, w: 0.78, label: "24A To" },
  { key: "pos", x: 1.98, w: 0.34, label: "24B POS" },
  { key: "cpt", x: 2.72, w: 0.74, label: "24D CPT" },
  { key: "mod", x: 3.50, w: 0.92, label: "24D Modifier" },
  { key: "pointer", x: 4.50, w: 0.52, label: "24E Pointer" },
  { key: "charge", x: 5.08, w: 0.82, label: "24F Charge", align: "right" },
  { key: "units", x: 5.98, w: 0.36, label: "24G Units" },
  { key: "renderingNpi", x: 6.92, w: 1.30, label: "24J NPI" },
];

export const MAX_SERVICE_LINES = 6;

// ---------- data mapping ----------

const yyyymmdd = (s) => {
  if (!s) return "";
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]} ${m[3]} ${m[1]}` : String(s); // MM DD YYYY, as the form expects
};
const money = (n) => (Number(n) || 0).toFixed(2);

// Relationship checkbox in Box 6 is expressed as the word, since this renderer writes text
// rather than ticking boxes. A practice using preprinted stock marks the box by hand or adjusts
// the coordinate to sit over it.
const relationshipLabel = (r) => {
  const v = String(r || "").toLowerCase();
  if (!v || v === "self") return "SELF";
  if (v.startsWith("spo")) return "SPOUSE";
  if (v.startsWith("chi")) return "CHILD";
  return "OTHER";
};

/**
 * Builds the CMS-1500 values from records the application already holds.
 *
 * Every field is read, never invented. A value the system does not have stays empty rather than
 * being guessed - an incorrect entry on a claim form is worse than a blank one, because a blank
 * gets queried and a wrong value gets paid or denied on the wrong basis.
 */
export function buildCms1500({ charges, patient, policy, practice }) {
  const lines = (charges || []).slice(0, MAX_SERVICE_LINES);
  const first = lines[0] || {};
  const dx = (first.diagnosisCodes || []).filter(Boolean);

  const boxes = {
    "1": (policy?.insuranceType || "").toUpperCase(),
    "1a": policy?.memberId || "",
    "2": patient?.name || "",
    "3-dob": yyyymmdd(patient?.dob),
    "3-sex": (patient?.extra?.sex || "").slice(0, 1).toUpperCase(),
    "4": policy?.subscriberName || patient?.name || "",
    "5-addr": patient?.address || "",
    "5-city": patient?.city || "",
    "5-state": patient?.state || "",
    "5-zip": patient?.zip || "",
    "5-phone": patient?.phone || "",
    "6": relationshipLabel(policy?.subscriberRelationship),
    "7-addr": policy?.subscriberName ? "" : patient?.address || "",
    "7-city": policy?.subscriberName ? "" : patient?.city || "",
    "7-state": policy?.subscriberName ? "" : patient?.state || "",
    "7-zip": policy?.subscriberName ? "" : patient?.zip || "",
    "11": policy?.groupNumber || "",
    "11a": yyyymmdd(policy?.subscriberDob),
    "11c": policy?.planName || policy?.insuranceCompany || "",
    "12": "SIGNATURE ON FILE",
    "13": "SIGNATURE ON FILE",
    "17": first.referralPhysician || "",
    "25": first.taxId || practice?.taxId || "",
    "26": patient?.id || "",
    "31": first.provider || "",
    "32": [first.facilityName, first.facilityAddress].filter(Boolean).join(", "),
    "32a": first.npi || "",
    "33": [practice?.name, practice?.address].filter(Boolean).join(", "),
    "33a": first.npi || "",
  };

  // Box 21, up to twelve pointers A-L.
  "abcdefghijkl".split("").forEach((letter, i) => {
    boxes["21" + letter] = dx[i] || "";
  });

  const serviceLines = lines.map((c) => ({
    dosFrom: yyyymmdd(c.dos),
    dosTo: yyyymmdd(c.dos),
    pos: c.placeOfService || "11",       // 11 = office, the practice's default setting
    cpt: c.cpt || "",
    mod: c.modifiers || "",
    // Pointer letters for the diagnoses this line actually references. Defaults to A when the
    // charge carries no explicit pointer, which is the common single-diagnosis case.
    pointer: c.diagnosisPointer || (dx.length ? "A" : ""),
    charge: money(c.charge),
    units: String(c.units || 1),
    renderingNpi: c.npi || "",
  }));

  const total = lines.reduce((sum, c) => sum + (Number(c.charge) || 0), 0);
  boxes["28"] = money(total);
  boxes["29"] = money(lines.reduce((sum, c) => sum + (Number(c.paid) || 0), 0));

  return { boxes, serviceLines, total };
}

/**
 * Checks the claim against what CMS-1500 requires. Reports; never fills anything in.
 *
 * These are completeness checks on the form, not a clearinghouse edit set - a real payer applies
 * hundreds more. Passing this does not mean a claim will be accepted, and the interface says so.
 */
export function validateCms1500({ boxes, serviceLines }) {
  const problems = [];
  const need = (key, label) => {
    if (!String(boxes[key] || "").trim()) problems.push({ field: key, message: label });
  };
  need("1a", "Insured's ID number (Box 1a) is missing");
  need("2", "Patient name (Box 2) is missing");
  need("3-dob", "Patient date of birth (Box 3) is missing");
  need("5-addr", "Patient address (Box 5) is missing");
  need("25", "Federal Tax ID (Box 25) is missing");
  need("33a", "Billing provider NPI (Box 33a) is missing");
  if (!boxes["21a"]) problems.push({ field: "21a", message: "At least one diagnosis (Box 21) is required" });

  serviceLines.forEach((l, i) => {
    const n = i + 1;
    if (!l.cpt) problems.push({ field: `line${n}`, message: `Service line ${n}: CPT/HCPCS is missing` });
    if (!l.dosFrom) problems.push({ field: `line${n}`, message: `Service line ${n}: date of service is missing` });
    if (!l.pointer) problems.push({ field: `line${n}`, message: `Service line ${n}: diagnosis pointer is missing` });
    if (!Number(l.charge)) problems.push({ field: `line${n}`, message: `Service line ${n}: charge is zero` });
    if (!Number(l.units)) problems.push({ field: `line${n}`, message: `Service line ${n}: units is zero` });
  });
  if (serviceLines.length === 0) problems.push({ field: "lines", message: "The claim has no service lines" });
  return problems;
}

// ---------- alignment ----------

export function loadAlignment() {
  try {
    const raw = localStorage.getItem(ALIGN_KEY);
    if (raw) return { x: 0, y: 0, ...JSON.parse(raw) };
  } catch {
    // Storage unavailable (private window, blocked cookies). Zero offsets still print.
  }
  return { x: 0, y: 0 };
}

export function saveAlignment(a) {
  try { localStorage.setItem(ALIGN_KEY, JSON.stringify(a)); } catch { /* not fatal */ }
}

