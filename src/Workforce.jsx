// HR → Workforce: search, filters, quick filters, sorting, pagination, export and the employee
// profile.
//
// Added alongside everything else; no existing screen is changed.
//
// The one rule that shapes this file: the SERVER filters, sorts, paginates and derives every
// status. This component holds the filter selections, sends them, and renders what comes back. It
// never filters an array it was given, and it never works out whether somebody is late — because a
// screen that computed its own answer would eventually disagree with the counts beside it, and with
// the export.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search, SlidersHorizontal, X, Download, Save, Trash2, ChevronLeft, ChevronRight,
  Columns3, ArrowUpDown, Loader2, Users, CalendarDays, Bookmark, AlertCircle, Printer,
} from "lucide-react";
import {
  getOptions, getWorkforce, getWorkforceCounts, getEmployee,
  getSavedViews, saveView, deleteView, exportWorkforce,
  QUICK_FILTERS, TODAY_FILTERS, statusMeta, TONE_CLASS, DATE_PRESETS, today, prettyDate,
  COLUMNS, loadColumns, saveColumns, buildChips, EMPTY_FILTERS,
} from "./hrService";

const card = "bg-white border border-slate-200 rounded-xl";
const input = "w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm";
const lbl = "block text-[11px] uppercase tracking-wide text-slate-400 mb-1";
const btn = "text-xs rounded-lg px-3 py-2 flex items-center gap-1.5 whitespace-nowrap";

function Row({ label, value }) {
  return (
    <div>
      <span className={lbl}>{label}</span>
      <div className="text-sm text-slate-800">
        {value || <span className="text-slate-400">Not recorded</span>}
      </div>
    </div>
  );
}

function Pill({ tone, children }) {
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border ${TONE_CLASS[tone] || TONE_CLASS.slate}`}>
      {children}
    </span>
  );
}

function Select({ label, value, onChange, options, allLabel = "All" }) {
  return (
    <div>
      <span className={lbl}>{label}</span>
      <select className={input} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allLabel}</option>
        {(options || []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </div>
  );
}

export default function Workforce({ permissions, initialDate, initialQuick }) {
  const perms = useMemo(() => new Set(permissions || []), [permissions]);
  const mayExport = perms.has("HR_REPORT_EXPORT");

  const [options, setOptions] = useState({});
  // The dashboard tile deep-links in with a filter already chosen (section 17). Seeded from the
  // prop during the initial state rather than applied by an effect, so the first request carries
  // it and the screen never flashes the unfiltered list first.
  const [filters, setFilters] = useState(() => {
    if (initialQuick === "pending") return { ...EMPTY_FILTERS, ptoStatus: "pending" };
    if (initialQuick) return { ...EMPTY_FILTERS, today: [initialQuick] };
    return { ...EMPTY_FILTERS };
  });
  const [date, setDate] = useState(initialDate || today());
  const [sort, setSort] = useState({ key: "name", dir: "asc" });
  const [page, setPage] = useState(1);
  const [limit] = useState(50);

  // One piece of state holds the result AND the query that produced it, so "is this stale?" is
  // derived rather than tracked. That removes a loading flag which would otherwise have to be set
  // synchronously inside the fetch effect, and it stays correct when the filters change while a
  // request is still in flight.
  const [result, setResult] = useState(null);   // { key, list, counts }
  const [error, setError] = useState("");

  const [showMore, setShowMore] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [columns, setColumns] = useState(loadColumns);
  const [views, setViews] = useState([]);
  const [viewName, setViewName] = useState("");
  const [profileId, setProfileId] = useState(null);
  const [exporting, setExporting] = useState(false);

  // A debounce for the search box, so typing a name does not fire a query per keystroke.
  const [searchDraft, setSearchDraft] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.search === searchDraft ? f : { ...f, search: searchDraft }));
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchDraft]);

  // What the API is sent. Kept as one object so the list, the counts and the export cannot be
  // looking at different filters.
  const query = useMemo(
    () => ({ ...filters, date, sort: sort.key, dir: sort.dir, page, limit }),
    [filters, date, sort, page, limit]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const o = await getOptions();
        if (alive) setOptions(o || {});
      } catch { /* the dropdowns simply stay empty; the list still works */ }
      try {
        const v = await getSavedViews();
        if (alive) setViews(v.views || []);
      } catch { /* saved views are optional */ }
    })();
    return () => { alive = false; };
  }, []);

  const queryKey = useMemo(() => JSON.stringify(query), [query]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // The counts deliberately drop the today filter, because each count IS a today filter -
        // otherwise "Present (37)" would only ever count the people already filtered to present.
        const [list, c] = await Promise.all([
          getWorkforce(query),
          getWorkforceCounts({ ...filters, today: undefined, date }),
        ]);
        if (!alive) return;
        setResult({ key: queryKey, list, counts: c.counts || {} });
        setError("");
      } catch (e) {
        if (alive) setError(e.message || "The workforce could not be loaded.");
      }
    })();
    return () => { alive = false; };
  }, [query, queryKey, filters, date]);

  const loading = !result || result.key !== queryKey;
  const data = result?.list || null;
  const counts = result?.counts || {};

  const fields = useMemo(() => data?.fields || {}, [data]);
  const shown = useMemo(
    () => COLUMNS.filter((c) => (c.always || columns.includes(c.key)) && (!c.needs || fields[c.needs])),
    [columns, fields]);

  const chips = useMemo(() => buildChips(filters, options), [filters, options]);

  const set = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };

  const toggleToday = (key) => {
    setFilters((f) => {
      const list = f.today || [];
      return { ...f, today: list.includes(key) ? list.filter((t) => t !== key) : [...list, key] };
    });
    setPage(1);
  };

  const removeChip = (chip) => {
    if (chip.key === "today") {
      setFilters((f) => ({ ...f, today: (f.today || []).filter((t) => t !== chip.value) }));
    } else if (chip.key === "search") {
      setSearchDraft("");
      setFilters((f) => ({ ...f, search: "" }));
    } else {
      setFilters((f) => ({ ...f, [chip.key]: "" }));
    }
    setPage(1);
  };

  const clearAll = () => {
    setSearchDraft("");
    setFilters({ ...EMPTY_FILTERS });
    setPage(1);
  };

  const toggleSort = (key) => {
    if (!key) return;
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
    setPage(1);
  };

  const toggleColumn = (key) => {
    setColumns((cols) => {
      const next = cols.includes(key) ? cols.filter((c) => c !== key) : [...cols, key];
      saveColumns(next);
      return next;
    });
  };

  const doExport = async () => {
    setExporting(true);
    setError("");
    try {
      // Exports what is CURRENTLY filtered - the same query, without the page.
      await exportWorkforce({ ...filters, date, sort: sort.key, dir: sort.dir });
    } catch (e) {
      setError(e.message || "The export could not be produced.");
    } finally {
      setExporting(false);
    }
  };

  const doSaveView = async () => {
    const name = viewName.trim();
    if (!name) return;
    try {
      await saveView(name, filters);
      setViews((await getSavedViews()).views || []);
      setViewName("");
    } catch (e) {
      setError(e.message || "The view could not be saved.");
    }
  };

  const applyView = (v) => {
    setFilters({ ...EMPTY_FILTERS, ...(v.filters || {}) });
    setSearchDraft((v.filters || {}).search || "");
    setPage(1);
  };

  const removeView = async (id) => {
    try {
      await deleteView(id);
      setViews((await getSavedViews()).views || []);
    } catch (e) {
      setError(e.message || "The view could not be deleted.");
    }
  };

  const activeQuick = (filters.today || []).length === 1 ? filters.today[0] : "";

  return (
    <div>
      <div className="flex items-start justify-between mb-1 print:hidden">
        <div>
          <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2">
            <Users size={19} /> Workforce
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Showing {prettyDate(date)}. Attendance, leave and schedule are facts about a single date,
            so the view is always for one day.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {mayExport && (
            <button onClick={doExport} disabled={exporting}
              className={`${btn} border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50`}>
              {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Export CSV
            </button>
          )}
          <button onClick={() => window.print()}
            className={`${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`}>
            <Printer size={13} /> Print
          </button>
        </div>
      </div>

      {/* Search + date */}
      <div className={`${card} p-3 mt-4 mb-3 print:hidden`}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[240px]">
            <span className={lbl}>Search employee</span>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
              <input className={`${input} pl-8`} value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                placeholder="Name, employee ID, email, phone, job title, department, manager or location" />
            </div>
          </div>
          <div>
            <span className={lbl}>Workforce date</span>
            <div className="flex items-center gap-1.5">
              <input type="date" className={input} value={date}
                onChange={(e) => { setDate(e.target.value); setPage(1); }} />
              <CalendarDays size={14} className="text-slate-400" />
            </div>
          </div>
          <div className="flex gap-1">
            {DATE_PRESETS.map((p) => (
              <button key={p.key} onClick={() => { setDate(p.date()); setPage(1); }}
                className={`text-[11px] border rounded-lg px-2 py-1.5 ${
                  date === p.date() ? "bg-slate-900 text-white border-slate-900" : "border-slate-200 hover:bg-slate-50"}`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Basic filters */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 mt-3">
          <Select label="Department" value={filters.departmentId} options={options.departments}
            onChange={(v) => set("departmentId", v)} />
          <Select label="Location" value={filters.locationId} options={options.locations}
            onChange={(v) => set("locationId", v)} />
          <Select label="Manager" value={filters.managerId} options={options.managers}
            onChange={(v) => set("managerId", v)} />
          <Select label="Job title" value={filters.jobTitleId} options={options.jobTitles}
            onChange={(v) => set("jobTitleId", v)} />
          <Select label="Status" value={filters.employmentStatus} options={options.employmentStatuses}
            onChange={(v) => set("employmentStatus", v)} />
          <Select label="Schedule" value={filters.shiftId} options={options.shifts}
            onChange={(v) => set("shiftId", v)} />
        </div>

        <div className="flex items-center gap-2 mt-3">
          <button onClick={() => setShowMore((v) => !v)}
            className={`${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`}>
            <SlidersHorizontal size={13} /> {showMore ? "Fewer filters" : "More filters"}
          </button>
          <button onClick={clearAll} className={`${btn} border border-slate-200 text-slate-600 hover:bg-slate-50`}>
            Clear all
          </button>
          <button onClick={() => setShowColumns((v) => !v)}
            className={`${btn} border border-slate-200 text-slate-700 hover:bg-slate-50 ml-auto`}>
            <Columns3 size={13} /> Columns
          </button>
        </div>

        {showMore && (
          <div className="border-t border-slate-100 mt-3 pt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
            <Select label="Employment type" value={filters.employmentType} options={options.employmentTypes}
              onChange={(v) => set("employmentType", v)} />
            <Select label="Work arrangement" value={filters.workArrangement} options={options.workArrangements}
              onChange={(v) => set("workArrangement", v)} />
            <div>
              <span className={lbl}>PTO / leave</span>
              <select className={input} value={filters.ptoStatus} onChange={(e) => set("ptoStatus", e.target.value)}>
                <option value="">Any</option>
                <option value="today">On PTO today</option>
                <option value="this_week">PTO this week</option>
                <option value="next_week">PTO next week</option>
                <option value="upcoming">Upcoming PTO</option>
                <option value="pending">Pending PTO request</option>
              </select>
            </div>
            <Select label="Leave type" value={filters.leaveType} options={options.leaveTypes}
              onChange={(v) => set("leaveType", v)} allLabel="Any" />

            <div>
              <span className={lbl}>Tenure</span>
              <select className={input} value={filters.tenure} onChange={(e) => set("tenure", e.target.value)}>
                <option value="">Any</option>
                <option value="under_90">Under 90 days</option>
                <option value="under_1y">Under 1 year</option>
                <option value="1_3y">1–3 years</option>
                <option value="3_5y">3–5 years</option>
                <option value="5y_plus">5+ years</option>
              </select>
            </div>
            <div>
              <span className={lbl}>New hires</span>
              <select className={input} value={filters.hiredWithin} onChange={(e) => set("hiredWithin", e.target.value)}>
                <option value="">Any</option>
                <option value="week">Hired this week</option>
                <option value="month">Hired this month</option>
                <option value="year">Hired this year</option>
              </select>
            </div>
            <div>
              <span className={lbl}>Hired from</span>
              <input type="date" className={input} value={filters.hiredFrom}
                onChange={(e) => set("hiredFrom", e.target.value)} />
            </div>
            <div>
              <span className={lbl}>Hired to</span>
              <input type="date" className={input} value={filters.hiredTo}
                onChange={(e) => set("hiredTo", e.target.value)} />
            </div>

            {fields.credential ? (
              <>
                <div>
                  <span className={lbl}>Credentials</span>
                  <select className={input} value={filters.credential} onChange={(e) => set("credential", e.target.value)}>
                    <option value="">Any</option>
                    <option value="expiring">Expiring</option>
                    <option value="expired">Expired</option>
                  </select>
                </div>
                <div>
                  <span className={lbl}>Training</span>
                  <select className={input} value={filters.training} onChange={(e) => set("training", e.target.value)}>
                    <option value="">Any</option>
                    <option value="due">Due</option>
                    <option value="overdue">Overdue</option>
                  </select>
                </div>
                <div>
                  <span className={lbl}>Within</span>
                  <select className={input} value={filters.withinDays} onChange={(e) => set("withinDays", e.target.value)}>
                    <option value="">30 days</option>
                    <option value="7">Next 7 days</option>
                    <option value="30">Next 30 days</option>
                    <option value="60">Next 60 days</option>
                    <option value="90">Next 90 days</option>
                  </select>
                </div>
              </>
            ) : (
              <p className="col-span-2 md:col-span-3 text-[11px] text-slate-400 self-end">
                Credential and training filters need the HR Credential View permission.
              </p>
            )}

            <div className="col-span-2 md:col-span-4 border-t border-slate-100 pt-3">
              <span className={lbl}>Today&apos;s workforce</span>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {TODAY_FILTERS.map((t) => {
                  const on = (filters.today || []).includes(t.key);
                  return (
                    <button key={t.key} onClick={() => toggleToday(t.key)}
                      className={`text-[11px] border rounded-full px-2.5 py-1 ${
                        on ? "bg-slate-900 text-white border-slate-900" : "border-slate-200 hover:bg-slate-50"}`}>
                      {t.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-slate-400 mt-1.5">
                Several may be selected — they widen the result within this category, and narrow it
                against the filters above.
              </p>
            </div>
          </div>
        )}

        {showColumns && (
          <div className="border-t border-slate-100 mt-3 pt-3">
            <span className={lbl}>Columns</span>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-1">
              {COLUMNS.filter((c) => !c.needs || fields[c.needs]).map((c) => (
                <label key={c.key} className="text-xs text-slate-600 flex items-center gap-1.5">
                  <input type="checkbox" checked={c.always || columns.includes(c.key)}
                    disabled={c.always} onChange={() => toggleColumn(c.key)} />
                  {c.label}
                </label>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-2">
              Only columns this account is authorized for are listed — a column whose data the server
              did not send cannot be turned on here.
            </p>
          </div>
        )}
      </div>

      {/* Quick filters with real counts */}
      <div className="flex flex-wrap gap-1.5 mb-3 print:hidden">
        {QUICK_FILTERS.map((q) => {
          const active = q.key ? activeQuick === q.key : (filters.today || []).length === 0;
          const n = counts[q.countKey];
          return (
            <button key={q.key || "all"}
              onClick={() => { setFilters((f) => ({ ...f, today: q.key ? [q.key] : [] })); setPage(1); }}
              className={`text-xs border rounded-lg px-2.5 py-1.5 ${
                active ? "bg-slate-900 text-white border-slate-900" : "border-slate-200 bg-white hover:bg-slate-50"}`}>
              {q.label}{typeof n === "number" ? ` (${n})` : ""}
            </button>
          );
        })}
        {counts.pending_requests > 0 && (
          <button onClick={() => set("ptoStatus", "pending")}
            className="text-xs border border-amber-200 bg-amber-50 text-amber-800 rounded-lg px-2.5 py-1.5">
            Pending requests ({counts.pending_requests})
          </button>
        )}
      </div>

      {/* Active filter chips */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-3 print:hidden">
          <span className="text-[11px] uppercase tracking-wide text-slate-400 mr-1">Active filters</span>
          {chips.map((chip, i) => (
            <button key={`${chip.key}-${chip.value || i}`} onClick={() => removeChip(chip)}
              className="text-[11px] bg-slate-100 border border-slate-200 rounded-full px-2 py-0.5 flex items-center gap-1 hover:bg-slate-200">
              {chip.label} <X size={11} />
            </button>
          ))}
          <button onClick={clearAll} className="text-[11px] text-slate-500 underline ml-1">Clear all</button>
        </div>
      )}

      {/* Saved views */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3 print:hidden">
        <span className="text-[11px] uppercase tracking-wide text-slate-400 flex items-center gap-1">
          <Bookmark size={11} /> Saved views
        </span>
        {views.length === 0 && <span className="text-[11px] text-slate-400">none yet</span>}
        {views.map((v) => (
          <span key={v.id} className="text-[11px] border border-slate-200 rounded-full pl-2.5 pr-1 py-0.5 flex items-center gap-1 bg-white">
            <button onClick={() => applyView(v)} className="hover:underline">{v.name}</button>
            {v.mine && (
              <button onClick={() => removeView(v.id)} title="Delete this view" className="text-slate-400 hover:text-rose-600">
                <Trash2 size={11} />
              </button>
            )}
          </span>
        ))}
        <div className="flex items-center gap-1 ml-2">
          <input className="border border-slate-200 rounded-lg px-2 py-1 text-[11px] w-36"
            placeholder="Save current as…" value={viewName} onChange={(e) => setViewName(e.target.value)} />
          <button onClick={doSaveView} disabled={!viewName.trim()}
            className="text-[11px] border border-slate-200 rounded-lg px-2 py-1 hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1">
            <Save size={11} /> Save
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 mb-3 flex items-start gap-2 print:hidden">
          <AlertCircle size={15} className="text-rose-600 mt-0.5 shrink-0" />
          <p className="text-xs text-rose-800">{error}</p>
        </div>
      )}

      {/* The table */}
      <div className={`${card} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 border-b border-slate-200 bg-slate-50">
                {shown.map((c) => (
                  <th key={c.key} className="px-3 py-2.5 font-medium whitespace-nowrap">
                    {c.sort ? (
                      <button onClick={() => toggleSort(c.sort)} className="flex items-center gap-1 hover:text-slate-700">
                        {c.label}
                        <ArrowUpDown size={11} className={sort.key === c.sort ? "text-slate-700" : "text-slate-300"} />
                      </button>
                    ) : c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={shown.length} className="px-3 py-10 text-center text-slate-400">
                  <Loader2 size={16} className="animate-spin inline mr-2" /> Loading…
                </td></tr>
              )}
              {!loading && (data?.employees || []).length === 0 && (
                <tr><td colSpan={shown.length} className="px-3 py-10 text-center text-slate-400 text-xs">
                  No employees match these filters.
                  {chips.length > 0 && <> <button onClick={clearAll} className="underline">Clear all</button> to start again.</>}
                </td></tr>
              )}
              {!loading && (data?.employees || []).map((e) => (
                <tr key={e.userId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  {shown.map((c) => (
                    <td key={c.key} className="px-3 py-2.5 align-top">
                      {c.key === "name" ? (
                        <button onClick={() => setProfileId(e.userId)}
                          className="text-slate-800 font-medium hover:text-teal-700 hover:underline text-left">
                          {e.name}
                        </button>
                      ) : c.key === "todayStatus" ? (
                        <Pill tone={statusMeta(e.todayStatus).tone}>{statusMeta(e.todayStatus).label}</Pill>
                      ) : c.key === "schedule" ? (
                        <span className="text-slate-600 text-xs whitespace-nowrap">
                          {e.isScheduled && e.scheduleStart
                            ? `${e.scheduleStart}–${e.scheduleEnd}${e.shift ? ` · ${e.shift}` : ""}`
                            : e.isScheduled ? (e.shift || "Scheduled") : "—"}
                        </span>
                      ) : c.key === "credential" ? (
                        <span className="text-xs">
                          {e.credentialsExpired > 0
                            ? <Pill tone="rose">{e.credentialsExpired} expired</Pill>
                            : e.nextCredentialExpiry ? <span className="text-slate-500">to {e.nextCredentialExpiry}</span>
                              : <span className="text-slate-300">—</span>}
                        </span>
                      ) : c.key === "training" ? (
                        <span className="text-xs">
                          {e.trainingOverdue > 0
                            ? <Pill tone="amber">{e.trainingOverdue} overdue</Pill>
                            : e.nextTrainingDue ? <span className="text-slate-500">due {e.nextTrainingDue}</span>
                              : <span className="text-slate-300">—</span>}
                        </span>
                      ) : (
                        <span className="text-slate-600 text-xs">{e[c.key] || "—"}</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data && data.total > 0 && (
          <div className="flex items-center justify-between px-3 py-2.5 border-t border-slate-100 print:hidden">
            <p className="text-xs text-slate-500">
              Showing {data.from.toLocaleString()}–{data.to.toLocaleString()} of {data.total.toLocaleString()} employees
            </p>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
                className="text-xs border border-slate-200 rounded-lg px-2 py-1 disabled:opacity-40 hover:bg-slate-50">
                <ChevronLeft size={13} />
              </button>
              <span className="text-xs text-slate-500 px-1.5">Page {page} of {data.pages || 1}</span>
              <button onClick={() => setPage((p) => p + 1)} disabled={page >= (data.pages || 1)}
                className="text-xs border border-slate-200 rounded-lg px-2 py-1 disabled:opacity-40 hover:bg-slate-50">
                <ChevronRight size={13} />
              </button>
            </div>
          </div>
        )}
      </div>

      {profileId && (
        <EmployeeProfile userId={profileId} date={date} onClose={() => setProfileId(null)} />
      )}
    </div>
  );
}

// ---------- the employee profile (section 16) ----------
//
// The one profile, not a second one. There was no HR module in this application before this change,
// so there was no existing Employee Profile to reuse; this is it, and the Workforce table links here
// rather than rendering its own version of an employee's details.

function EmployeeProfile({ userId, date, onClose }) {
  const [emp, setEmp] = useState(null);
  const [error, setError] = useState("");
  const closeRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const e = await getEmployee(userId, date);
        if (alive) setEmp(e);
      } catch (e) {
        if (alive) setError(e.message || "This employee could not be loaded.");
      }
    })();
    return () => { alive = false; };
  }, [userId, date]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-start justify-end">
      <div className="bg-white h-full w-full max-w-xl overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 sticky top-0 bg-white">
          <h3 className="font-semibold text-slate-800">{emp?.name || "Employee"}</h3>
          <button ref={closeRef} onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>

        {error && <p className="text-xs text-rose-700 p-5">{error}</p>}
        {!emp && !error && (
          <p className="p-10 text-center text-slate-400 text-sm">
            <Loader2 size={16} className="animate-spin inline mr-2" /> Loading…
          </p>
        )}

        {emp && (
          <div className="p-5 space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <Row label="Employee ID" value={emp.employeeNo} />
              <Row label="Job title" value={emp.jobTitle} />
              <Row label="Department" value={emp.department} />
              <Row label="Manager" value={emp.manager} />
              <Row label="Location" value={emp.location} />
              <Row label="Arrangement" value={emp.workArrangement} />
              <Row label="Employment type" value={emp.employmentType} />
              <Row label="Employment status" value={emp.employmentStatus} />
              {"email" in emp && <Row label="Email" value={emp.email} />}
              {"workPhone" in emp && <Row label="Work phone" value={emp.workPhone} />}
              {"hireDate" in emp && <Row label="Hire date" value={emp.hireDate} />}
              {"terminationDate" in emp && emp.terminationDate && (
                <Row label="Termination date" value={emp.terminationDate} />
              )}
            </div>

            <div>
              <h4 className="text-sm font-semibold text-slate-800 mb-2">The fortnight around {date}</h4>
              <div className="space-y-1">
                {(emp.days || []).map((d) => (
                  <div key={d.date} className={`flex items-center justify-between text-xs px-2 py-1.5 rounded-lg ${
                    d.date === date ? "bg-slate-100" : ""}`}>
                    <span className="text-slate-600 w-28">{d.date}</span>
                    <span className="text-slate-500 flex-1">
                      {d.holiday ? d.holiday
                        : d.isDayOff ? "Day off"
                          : d.start ? `${d.start}–${d.end}${d.shift ? ` · ${d.shift}` : ""}`
                            : "Not scheduled"}
                    </span>
                    {d.leaveType
                      ? <Pill tone="violet">{d.leaveType}</Pill>
                      : d.attendance
                        ? <Pill tone={statusMeta(d.attendance).tone}>{statusMeta(d.attendance).label}</Pill>
                        : <span className="text-slate-300">—</span>}
                  </div>
                ))}
              </div>
            </div>

            {(emp.leave || []).length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-slate-800 mb-2">Leave</h4>
                <div className="space-y-1">
                  {emp.leave.map((l, i) => (
                    <div key={i} className="flex items-center justify-between text-xs px-2 py-1.5">
                      <span className="text-slate-700 w-28">{l.leaveType}</span>
                      <span className="text-slate-500 flex-1">{l.start} → {l.end}</span>
                      <Pill tone={l.status === "APPROVED" ? "emerald" : l.status === "PENDING" ? "amber" : "slate"}>
                        {l.status}
                      </Pill>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-slate-400 mt-1.5">
                  The reason for leave is not shown here — it can be a medical matter, and nothing on
                  this screen needs it.
                </p>
              </div>
            )}

            {(emp.credentials || []).length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-slate-800 mb-2">Credentials</h4>
                <div className="space-y-1">
                  {emp.credentials.map((c, i) => (
                    <div key={i} className="flex items-center justify-between text-xs px-2 py-1.5">
                      <span className="text-slate-700">{c.type}{c.identifier ? ` · ${c.identifier}` : ""}</span>
                      <span className="text-slate-500">{c.expiry ? `expires ${c.expiry}` : "no expiry"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(emp.training || []).length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-slate-800 mb-2">Training</h4>
                <div className="space-y-1">
                  {emp.training.map((t, i) => (
                    <div key={i} className="flex items-center justify-between text-xs px-2 py-1.5">
                      <span className="text-slate-700">{t.course}</span>
                      <span className="text-slate-500">
                        {t.completed ? `completed ${t.completed}` : t.due ? `due ${t.due}` : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
