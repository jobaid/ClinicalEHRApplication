// HIM coding worklist and Antimicrobial Review: API calls and shared display helpers.
//
// Both backends were already complete and permission-gated before these screens existed - this
// file only calls them. Nothing here derives a status, a priority or a clinical judgement; every
// one of those comes from the server, which reads it from the database.

import { api } from "./firebase/apiClient";

const qs = (params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? "?" + s : "";
};

// ---------- statuses ----------
//
// The vocabularies live in workflow_statuses, so a practice can rename or deactivate one without
// a deploy. Fetched once per screen rather than hard-coded here.
export const getStatuses = () => api("/api/clinical/statuses");

// ---------- HIM ----------

export const getHimWorklist = (params) => api(`/api/him/worklist${qs(params)}`);
export const getHimSummary = (params) => api(`/api/him/summary${qs(params)}`);
export const getHimDetail = (id) => api(`/api/him/worklist/${encodeURIComponent(id)}`);

export const assignHim = (id, body) =>
  api(`/api/him/worklist/${encodeURIComponent(id)}/assign`, { method: "POST", body });

export const setHimStatus = (id, body) =>
  api(`/api/him/worklist/${encodeURIComponent(id)}/status`, { method: "POST", body });

export const saveHimDiagnoses = (id, diagnoses) =>
  api(`/api/him/worklist/${encodeURIComponent(id)}/diagnoses`, { method: "PUT", body: { diagnoses } });

export const saveHimProcedures = (id, procedures) =>
  api(`/api/him/worklist/${encodeURIComponent(id)}/procedures`, { method: "PUT", body: { procedures } });

export const createHimQuery = (id, body) =>
  api(`/api/him/worklist/${encodeURIComponent(id)}/queries`, { method: "POST", body });

export const updateHimQuery = (qid, body) =>
  api(`/api/him/queries/${encodeURIComponent(qid)}/status`, { method: "POST", body });

// ---------- antimicrobial ----------

export const getAmWorklist = (params) => api(`/api/clinical/antimicrobial${qs(params)}`);
export const getAmSummary = (params) => api(`/api/clinical/antimicrobial/summary${qs(params)}`);
export const getAmDetail = (id) => api(`/api/clinical/antimicrobial/${encodeURIComponent(id)}`);

export const addAmReview = (id, body) =>
  api(`/api/clinical/antimicrobial/${encodeURIComponent(id)}/reviews`, { method: "POST", body });

export const assignAm = (id, body) =>
  api(`/api/clinical/antimicrobial/${encodeURIComponent(id)}/assign`, { method: "POST", body });

// ---------- display ----------

/**
 * Tone for a status pill.
 *
 * The server sends a `tone` with each configured status, so this is only the fallback for a value
 * that predates the vocabulary or was renamed. It maps appearance, never meaning.
 */
export const TONE_CLASS = {
  green: "bg-emerald-50 text-emerald-700 border-emerald-200",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  warning: "bg-amber-50 text-amber-700 border-amber-200",
  red: "bg-rose-50 text-rose-700 border-rose-200",
  danger: "bg-rose-50 text-rose-700 border-rose-200",
  blue: "bg-sky-50 text-sky-700 border-sky-200",
  info: "bg-sky-50 text-sky-700 border-sky-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200",
  neutral: "bg-slate-100 text-slate-600 border-slate-200",
};

export const toneClass = (tone) => TONE_CLASS[tone] || TONE_CLASS.neutral;

/** Priority styling. Urgent and high are the two a worklist is scanned for. */
export const PRIORITY_CLASS = {
  URGENT: "bg-rose-100 text-rose-800 border-rose-300",
  HIGH: "bg-amber-100 text-amber-800 border-amber-300",
  NORMAL: "bg-slate-100 text-slate-600 border-slate-200",
  LOW: "bg-slate-50 text-slate-500 border-slate-200",
};

export const priorityClass = (p) => PRIORITY_CLASS[p] || PRIORITY_CLASS.NORMAL;

/** Turns a status list from the server into a code -> {label, tone} lookup. */
export function statusIndex(list) {
  const out = {};
  for (const s of list || []) out[s.code] = { label: s.label, tone: s.tone };
  return out;
}

/** A status code shown as its configured label, falling back to the code made readable. */
export const labelFor = (index, code) =>
  index?.[code]?.label || String(code || "").replace(/_/g, " ").toLowerCase()
    .replace(/(^|\s)\w/g, (c) => c.toUpperCase()) || "—";

export const stamp = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
};

export const shortDate = (s) => {
  if (!s) return "—";
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(s);
};

/**
 * How overdue something is, in whole hours, or null when it is not.
 *
 * Used only to decide whether to draw attention to a row. The DUE DATE itself comes from the
 * server; this does not decide when a review should happen.
 */
export function hoursOverdue(iso) {
  if (!iso) return null;
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return null;
  const diff = Date.now() - due.getTime();
  return diff > 0 ? Math.floor(diff / 3600000) : null;
}

export const dueLabel = (iso) => {
  const over = hoursOverdue(iso);
  if (over === null) return stamp(iso);
  if (over < 48) return `${over}h overdue`;
  return `${Math.floor(over / 24)}d overdue`;
};
