// HR workforce API calls, filter definitions and the date presets.
//
// No components, so the page can import these without the module exporting a mix of the two.
//
// Every dropdown's options come from the SERVER (getOptions), not from a list in here. Departments,
// job titles, locations, shifts and the employment vocabularies are configured per practice, so
// hard-coding them would mean a deploy to rename a department.

import { api, API_BASE, getToken } from "./firebase/apiClient";

const qs = (params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    if (Array.isArray(v)) v.forEach((item) => item && u.append(k, item));
    else u.set(k, String(v));
  }
  return u.toString();
};

export const getOptions = () => api("/api/hr/options");

export const getWorkforce = (params) => {
  const q = qs(params);
  return api(`/api/hr/workforce${q ? "?" + q : ""}`);
};

export const getWorkforceCounts = (params) => {
  const q = qs(params);
  return api(`/api/hr/workforce/counts${q ? "?" + q : ""}`);
};

export const getEmployee = (userId, date) =>
  api(`/api/hr/employees/${encodeURIComponent(userId)}${date ? "?date=" + date : ""}`);

export const getSavedViews = () => api("/api/hr/saved-views");

export const saveView = (name, filters, shared = false) =>
  api("/api/hr/saved-views", { method: "POST", body: { name, filters, shared } });

export const deleteView = (id) =>
  api(`/api/hr/saved-views/${encodeURIComponent(id)}`, { method: "DELETE" });

/**
 * Downloads the CSV export.
 *
 * Goes through fetch rather than a plain link because the endpoint needs the bearer token, and a
 * link cannot carry one. The blob is released immediately after the click, so a large export does
 * not sit in memory for the rest of the session.
 */
export async function exportWorkforce(params) {
  const q = qs(params);
  const res = await fetch(`${API_BASE}/api/hr/workforce/export${q ? "?" + q : ""}`, {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    let message = "The export could not be produced.";
    try { message = (await res.json()).error || message; } catch { /* keep the default */ }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `workforce-${params?.date || "today"}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- today's workforce statuses ----------

/**
 * The quick filters, in the order section 12 lists them.
 *
 * `key` is what the API expects; these overlap on purpose — somebody present today is also working
 * today and also scheduled today — because the questions HR asks overlap.
 */
export const QUICK_FILTERS = [
  { key: "", label: "All employees", countKey: "all" },
  { key: "scheduled", label: "Scheduled", countKey: "scheduled" },
  { key: "present", label: "Present", countKey: "present" },
  { key: "late", label: "Late", countKey: "late" },
  { key: "absent", label: "Absent", countKey: "absent" },
  // "On leave", not "PTO": the predicate is any approved leave, so sick leave is counted too.
  // Labelling it PTO would show 3 beside a workforce where only one person is actually on PTO.
  { key: "pto", label: "On leave", countKey: "pto" },
  { key: "called_off", label: "Called off", countKey: "called_off" },
  { key: "remote", label: "Remote", countKey: "remote" },
  { key: "day_off", label: "Day off", countKey: "day_off" },
  { key: "not_clocked_in", label: "Not clocked in", countKey: "not_clocked_in" },
];

/** Every today-filter the API accepts, for the More Filters panel. */
export const TODAY_FILTERS = [
  { key: "scheduled", label: "Scheduled today" },
  { key: "working", label: "Working today" },
  { key: "present", label: "Present today" },
  { key: "late", label: "Late today" },
  { key: "absent", label: "Absent today" },
  { key: "pto", label: "On leave today" },
  { key: "sick", label: "Sick today" },
  { key: "called_off", label: "Called off today" },
  { key: "remote", label: "Remote today" },
  { key: "day_off", label: "Day off today" },
  { key: "holiday", label: "Holiday" },
  { key: "not_clocked_in", label: "Not clocked in" },
];

/**
 * How each derived status is shown. `tone` drives the pill colour.
 *
 * These are the values the SERVER derives, so the interface never computes a status of its own —
 * the screen and the filter counts cannot disagree about who is late.
 */
export const STATUS_META = {
  PRESENT: { label: "Present", tone: "emerald" },
  LATE: { label: "Late", tone: "amber" },
  REMOTE: { label: "Remote", tone: "sky" },
  ABSENT: { label: "Absent", tone: "rose" },
  CALLED_OFF: { label: "Called off", tone: "rose" },
  SICK: { label: "Sick", tone: "amber" },
  PTO: { label: "PTO", tone: "violet" },
  DAY_OFF: { label: "Day off", tone: "slate" },
  HOLIDAY: { label: "Holiday", tone: "slate" },
  NOT_CLOCKED_IN: { label: "Not clocked in", tone: "amber" },
};

export const statusMeta = (code) =>
  STATUS_META[code] || { label: code || "—", tone: "slate" };

export const TONE_CLASS = {
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  rose: "bg-rose-50 text-rose-700 border-rose-200",
  sky: "bg-sky-50 text-sky-700 border-sky-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200",
  slate: "bg-slate-100 text-slate-600 border-slate-200",
};

// ---------- dates ----------

const iso = (d) => d.toISOString().slice(0, 10);
const shift = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return iso(d);
};

/** Monday of the week containing `base`, matching Postgres date_trunc('week'). */
function weekStart(base = new Date()) {
  const d = new Date(base);
  const dow = (d.getDay() + 6) % 7;          // 0 = Monday
  d.setDate(d.getDate() - dow);
  return d;
}

/**
 * The date presets from section 5.
 *
 * "This week" and "Next week" set a RANGE, but the workforce view is computed for a single date —
 * attendance is a fact about one day. So a week preset selects that week's Monday and the interface
 * says which date is shown, rather than silently averaging seven days into one answer.
 */
export const DATE_PRESETS = [
  { key: "today", label: "Today", date: () => iso(new Date()) },
  { key: "tomorrow", label: "Tomorrow", date: () => shift(1) },
  { key: "yesterday", label: "Yesterday", date: () => shift(-1) },
  { key: "this_week", label: "This week", date: () => iso(weekStart()) },
  {
    key: "next_week",
    label: "Next week",
    date: () => {
      const d = weekStart();
      d.setDate(d.getDate() + 7);
      return iso(d);
    },
  },
];

export const today = () => iso(new Date());

export const prettyDate = (s) => {
  if (!s) return "—";
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(s);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime())
    ? `${m[2]}/${m[3]}/${m[1]}`
    : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
};

// ---------- the columns (section 14) ----------

/**
 * Every column the table can show.
 *
 * `needs` names the grant whose data the column depends on. A column whose data the server did not
 * send is not offered at all, so ticking a box can never reveal a field the caller is not
 * authorized to see — section 14 is explicit that column choice must not bypass authorization.
 */
export const COLUMNS = [
  { key: "name", label: "Employee", sort: "name", always: true },
  { key: "employeeNo", label: "Employee ID", sort: "employeeNo", default: true },
  { key: "department", label: "Department", sort: "department", default: true },
  { key: "jobTitle", label: "Job Title", sort: "jobTitle", default: true },
  { key: "manager", label: "Manager", sort: "manager", default: true },
  { key: "location", label: "Location", sort: "location", default: true },
  { key: "schedule", label: "Schedule", sort: "scheduleStart", default: true },
  { key: "todayStatus", label: "Today", sort: "attendance", default: true },
  { key: "employmentStatus", label: "Status", sort: "status", default: true },
  { key: "employmentType", label: "Employment Type", sort: "employmentType" },
  { key: "workArrangement", label: "Arrangement" },
  { key: "hireDate", label: "Hire Date", sort: "hireDate", needs: "employee" },
  { key: "email", label: "Email", needs: "employee" },
  { key: "workPhone", label: "Work Phone", needs: "employee" },
  { key: "credential", label: "Credentials", needs: "credential" },
  { key: "training", label: "Training", needs: "credential" },
];

export const DEFAULT_COLUMNS = COLUMNS.filter((c) => c.always || c.default).map((c) => c.key);

const COLUMN_KEY = "hr_workforce_columns";

export function loadColumns() {
  try {
    const raw = localStorage.getItem(COLUMN_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length) return list;
    }
  } catch {
    // Storage unavailable (private window, blocked site data). The defaults still render.
  }
  return DEFAULT_COLUMNS;
}

export function saveColumns(list) {
  try { localStorage.setItem(COLUMN_KEY, JSON.stringify(list)); } catch { /* not fatal */ }
}

// ---------- filter chips (section 11) ----------

/**
 * Turns the active filter state into removable chips.
 *
 * Each chip carries the single state key it clears, so removing one filter leaves the others
 * alone — which is the whole point of section 11.
 */
export function buildChips(filters, options) {
  const chips = [];
  const labelFor = (list, id) => (list || []).find((o) => o.id === id)?.label || id;

  if (filters.search) chips.push({ key: "search", label: `"${filters.search}"` });
  if (filters.departmentId) chips.push({ key: "departmentId", label: labelFor(options.departments, filters.departmentId) });
  if (filters.jobTitleId) chips.push({ key: "jobTitleId", label: labelFor(options.jobTitles, filters.jobTitleId) });
  if (filters.managerId) chips.push({ key: "managerId", label: labelFor(options.managers, filters.managerId) });
  if (filters.locationId) chips.push({ key: "locationId", label: labelFor(options.locations, filters.locationId) });
  if (filters.shiftId) chips.push({ key: "shiftId", label: labelFor(options.shifts, filters.shiftId) });
  if (filters.employmentType) chips.push({ key: "employmentType", label: labelFor(options.employmentTypes, filters.employmentType) });
  if (filters.employmentStatus) chips.push({ key: "employmentStatus", label: labelFor(options.employmentStatuses, filters.employmentStatus) });
  if (filters.workArrangement) chips.push({ key: "workArrangement", label: labelFor(options.workArrangements, filters.workArrangement) });
  if (filters.leaveType) chips.push({ key: "leaveType", label: labelFor(options.leaveTypes, filters.leaveType) });

  for (const state of filters.today || []) {
    const meta = TODAY_FILTERS.find((t) => t.key === state);
    chips.push({ key: "today", value: state, label: meta ? meta.label : state });
  }

  const named = {
    ptoStatus: { today: "On PTO today", pending: "Pending PTO", this_week: "PTO this week", next_week: "PTO next week", upcoming: "Upcoming PTO" },
    tenure: { under_90: "Under 90 days", under_1y: "Under 1 year", "1_3y": "1–3 years", "3_5y": "3–5 years", "5y_plus": "5+ years" },
    hiredWithin: { week: "Hired this week", month: "Hired this month", year: "Hired this year" },
    credential: { expired: "Credentials expired", expiring: "Credentials expiring" },
    training: { overdue: "Training overdue", due: "Training due" },
  };
  for (const [key, map] of Object.entries(named)) {
    if (filters[key] && map[filters[key]]) chips.push({ key, label: map[filters[key]] });
  }
  if (filters.hiredFrom) chips.push({ key: "hiredFrom", label: `Hired from ${filters.hiredFrom}` });
  if (filters.hiredTo) chips.push({ key: "hiredTo", label: `Hired to ${filters.hiredTo}` });

  return chips;
}

/** The empty filter state. Also what Clear All resets to, minus the date. */
export const EMPTY_FILTERS = {
  search: "", departmentId: "", jobTitleId: "", managerId: "", locationId: "", shiftId: "",
  employmentType: "", employmentStatus: "", workArrangement: "",
  today: [], ptoStatus: "", leaveType: "",
  hiredFrom: "", hiredTo: "", hiredWithin: "", tenure: "",
  credential: "", training: "", withinDays: "",
};
