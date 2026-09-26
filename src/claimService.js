// Claim workflow API calls and the small amount of formatting the claim screens share.
//
// No components here, so the claim workspace can import helpers without the module also exporting
// non-component values - which the react-refresh rule rightly objects to.
//
// The server assembles the claim and computes the total. Nothing in this file recalculates money:
// getClaim returns what the server billed, and that is what the screen shows and what the form
// prints, so a biller can never be looking at a different total from the one being submitted.

import { api } from "./firebase/apiClient";

const enc = encodeURIComponent;

/** What this server can do with an electronic claim. Read once when the workspace opens. */
export const getClaimConfig = () => api("/api/claims/config");

/** The claim as the SERVER assembled it: patient, insurance, provider, diagnoses, lines, total. */
export const getClaim = (claimId) => api(`/api/claims/${enc(claimId)}/hcfa`);

/** Server-side validation. The answer that gates submission - the screen only displays it. */
export const validateClaim = (claimId) =>
  api(`/api/claims/${enc(claimId)}/validate`, { method: "POST", body: {} });

/**
 * Submit electronically. Resolves only when a clearinghouse genuinely accepted the transmission;
 * otherwise it throws, and the message is the server's own explanation.
 */
export const submitClaim = (claimId) =>
  api(`/api/claims/${enc(claimId)}/submit`, { method: "POST", body: {} });

/** The append-only event trail. */
export const getClaimHistory = (claimId) => api(`/api/claims/${enc(claimId)}/history`);

/** Record a print or a preview. The browser prints; this records that it happened. */
export const recordPrintEvent = (claimId, event) =>
  api(`/api/claims/${enc(claimId)}/print-event`, { method: "POST", body: { event } });

export const getPrintProfiles = () => api("/api/claims/print-profiles");

export const savePrintProfile = (profile) =>
  api("/api/claims/print-profiles", { method: "POST", body: profile });

// ---------- formatting ----------

export const money = (n) =>
  (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** A stored date, shown as entered. Never substitutes today for a missing date. */
export const shortDate = (s) => {
  if (!s) return "—";
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(s);
};

export const stamp = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
};

// The twelve diagnosis pointer letters a professional claim supports.
export const POINTER_LETTERS = "ABCDEFGHIJKL".split("");

// A professional claim carries twelve diagnoses, pointers A-L.
export const DX_SLOTS = 12;

/**
 * Pads or trims a stored diagnosis array to the twelve slots the form has.
 *
 * Padding rather than discarding matters: charges have been stored with a ten-slot array since
 * long before this screen existed, and a guard that only accepted exactly ten would silently drop
 * codes from anything else.
 */
export function normalizeDx(arr, slots = DX_SLOTS) {
  const out = Array(slots).fill("");
  (arr || []).forEach((v, i) => { if (i < slots) out[i] = v || ""; });
  return out;
}

/**
 * Place of service codes.
 *
 * A short list of the codes a practice like this one actually bills, not the full CMS set - an
 * incomplete list a biller can read beats a hundred-row dropdown, and the field accepts a typed
 * code for anything absent. The codes and their meanings are the published CMS place-of-service
 * list; none is invented.
 */
export const PLACE_OF_SERVICE = [
  { code: "11", label: "11 — Office" },
  { code: "02", label: "02 — Telehealth (away from home)" },
  { code: "10", label: "10 — Telehealth in patient home" },
  { code: "12", label: "12 — Home" },
  { code: "19", label: "19 — Off-campus outpatient hospital" },
  { code: "21", label: "21 — Inpatient hospital" },
  { code: "22", label: "22 — On-campus outpatient hospital" },
  { code: "23", label: "23 — Emergency room, hospital" },
  { code: "24", label: "24 — Ambulatory surgical center" },
  { code: "31", label: "31 — Skilled nursing facility" },
  { code: "32", label: "32 — Nursing facility" },
  { code: "81", label: "81 — Independent laboratory" },
];

/**
 * Groups validation problems by the section of the form they belong to, preserving order, so the
 * panel in section 20 can list them under the heading the biller needs to scroll to.
 */
export function groupProblems(problems) {
  const order = [];
  const bySection = {};
  for (const p of problems || []) {
    const key = p.section || "Claim";
    if (!bySection[key]) { bySection[key] = []; order.push(key); }
    bySection[key].push(p);
  }
  return order.map((section) => ({ section, problems: bySection[section] }));
}

/** The sections the claim workspace shows, in the order section 1 asks for. */
export const CLAIM_SECTIONS = [
  { id: "patient", label: "Patient Information" },
  { id: "insurance", label: "Insurance Information" },
  { id: "provider", label: "Provider Information" },
  { id: "claim", label: "Claim Information" },
  { id: "diagnosis", label: "Diagnosis" },
  { id: "procedures", label: "Procedures / CPT" },
  { id: "facility", label: "Service Facility" },
  { id: "summary", label: "Claim Summary" },
];

// Which form section a validation problem belongs to, so an unmatched section name still lands
// somewhere a biller can find rather than being dropped.
export const sectionAnchor = (section) => {
  const s = String(section || "").toLowerCase();
  if (s.startsWith("patient")) return "patient";
  if (s.startsWith("insur")) return "insurance";
  if (s.startsWith("provid")) return "provider";
  if (s.startsWith("diagn")) return "diagnosis";
  if (s.startsWith("proced")) return "procedures";
  return "claim";
};
