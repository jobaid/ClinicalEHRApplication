// Doctor Clinical Workspace transport.
//
// Every call is filtered, searched and paginated on the SERVER. Nothing here pulls a patient's
// whole record into the browser to filter it afterwards - a patient with years of history would
// make that unusable, and it would also hand the browser data the caller's permissions exclude.

import { api } from "./apiClient";

// Record kinds the timeline can show. `perm` is the grant that reveals each one; the server
// enforces it, and this list only decides which checkboxes are worth drawing.
export const RECORD_TYPES = [
  { key: "encounter", label: "Encounters", perm: "DOCTOR_MEDICAL_RECORD_VIEW" },
  { key: "note", label: "Clinical Notes", perm: "DOCTOR_MEDICAL_RECORD_VIEW" },
  { key: "diagnosis", label: "Diagnoses", perm: "DOCTOR_MEDICAL_RECORD_VIEW" },
  { key: "procedure", label: "Procedures", perm: "DOCTOR_MEDICAL_RECORD_VIEW" },
  { key: "medication", label: "Medications", perm: "DOCTOR_MEDICATION_VIEW" },
  { key: "allergy", label: "Allergies", perm: "DOCTOR_MEDICAL_RECORD_VIEW" },
  { key: "vital", label: "Vitals", perm: "DOCTOR_MEDICAL_RECORD_VIEW" },
  { key: "lab", label: "Lab Results", perm: "DOCTOR_LAB_VIEW" },
  { key: "document", label: "Documents", perm: "DOCTOR_DOCUMENT_VIEW" },
  { key: "antimicrobial", label: "Antimicrobial Reviews", perm: "DOCTOR_ANTIMICROBIAL_VIEW" },
];

// Date presets from section 7. `days: null` means all time.
export const DATE_PRESETS = [
  { key: "all", label: "All Time", days: null },
  { key: "today", label: "Today", days: 0 },
  { key: "7d", label: "Last 7 Days", days: 7 },
  { key: "30d", label: "Last 30 Days", days: 30 },
  { key: "3m", label: "Last 3 Months", days: 90 },
  { key: "6m", label: "Last 6 Months", days: 180 },
  { key: "1y", label: "Last Year", days: 365 },
  { key: "custom", label: "Custom Range", days: undefined },
];

export const LAB_WINDOWS = [
  { key: "", label: "All Labs" },
  { key: "latest", label: "Latest" },
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 Days" },
  { key: "30d", label: "Last 30 Days" },
  { key: "3m", label: "Last 3 Months" },
  { key: "6m", label: "Last 6 Months" },
  { key: "1y", label: "Last Year" },
];

// Turns a preset into a from-date. Returns "" for all-time so the parameter is simply omitted.
export function presetFrom(key) {
  const p = DATE_PRESETS.find((d) => d.key === key);
  if (!p || p.days === null || p.days === undefined) return "";
  const d = new Date();
  d.setDate(d.getDate() - p.days);
  return d.toISOString().slice(0, 10);
}

const qs = (params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)) {
      u.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
  }
  const s = u.toString();
  return s ? "?" + s : "";
};

export const patientHeader = (patientId) =>
  api(`/api/doctor/patients/${encodeURIComponent(patientId)}/header`);

export const patientTimeline = (patientId, opts = {}) =>
  api(`/api/doctor/patients/${encodeURIComponent(patientId)}/timeline` + qs(opts));

export const patientLabs = (patientId, opts = {}) =>
  api(`/api/doctor/patients/${encodeURIComponent(patientId)}/labs` + qs(opts));

export const labReport = (patientId, orderId) =>
  api(`/api/doctor/patients/${encodeURIComponent(patientId)}/labs/${encodeURIComponent(orderId)}`);

export const labTrend = (patientId, test) =>
  api(`/api/doctor/patients/${encodeURIComponent(patientId)}/labs/trend` + qs({ test }));

export const myPermissions = () => api("/api/admin/backup-permissions/me");

// ---------- presentation ----------

// Flags come from the laboratory, never from this application. This maps the source's code to a
// label and a tone; it does not decide that anything is abnormal.
export function flagMeta(flag) {
  switch ((flag || "").toUpperCase()) {
    case "H": return { label: "High", tone: "amber" };
    case "L": return { label: "Low", tone: "amber" };
    case "A": return { label: "Abnormal", tone: "amber" };
    case "AA":
    case "CRIT": return { label: "Critical", tone: "rose" };
    case "": return null;
    default: return { label: flag, tone: "amber" };
  }
}

// Renders the range the laboratory supplied. Never computed, and "Not available" when the
// source did not send one.
export function referenceLabel(r) {
  if (r.referenceText) return r.referenceText;
  if (r.referenceLow !== null && r.referenceHigh !== null) return `${r.referenceLow}–${r.referenceHigh}`;
  if (r.referenceLow !== null) return `> ${r.referenceLow}`;
  if (r.referenceHigh !== null) return `< ${r.referenceHigh}`;
  return "Not available";
}

export function fmtDateTime(iso) {
  if (!iso) return "Not available";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "Not available" : d.toLocaleString();
}

export function fmtDay(iso) {
  if (!iso) return "Not available";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "Not available" : d.toLocaleDateString();
}
