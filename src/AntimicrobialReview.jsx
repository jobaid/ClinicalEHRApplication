// Antimicrobial Review.
//
// The backend existed and was permission-gated; this is the screen for it.
//
// One rule runs through the whole file: it DISPLAYS clinical information and RECORDS what a
// reviewer concluded. It does not decide anything. There is no rule here that calls a dose wrong,
// suggests a de-escalation, or flags an interaction - this application has no licensed drug
// database, and an invented recommendation on an antimicrobial stewardship screen is worse than
// none, because somebody might act on it.
//
// Cultures, organisms, susceptibilities and renal function are shown exactly as they were recorded
// and are blank when nothing was recorded. Nothing is inferred.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Microscope, Search, X, Loader2, AlertCircle, UserCheck, RefreshCw,
  ChevronLeft, ChevronRight, ShieldAlert, History, Plus,
} from "lucide-react";
import {
  getStatuses, getAmWorklist, getAmSummary, getAmDetail, addAmReview, assignAm,
  statusIndex, labelFor, toneClass, priorityClass, stamp, shortDate, dueLabel, hoursOverdue,
} from "./clinicalService";
import { NewAmReview } from "./NewClinicalEntry";

const card = "bg-white border border-slate-200 rounded-xl";
const input = "w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm";
const lbl = "block text-[11px] uppercase tracking-wide text-slate-400 mb-1";
const btn = "text-xs rounded-lg px-3 py-2 flex items-center gap-1.5 whitespace-nowrap";

// The outcomes section 39 lists. Sent to the server as the recommendation category; the server
// stores what it is given and decides nothing from it.
const OUTCOMES = [
  { code: "REVIEWED_NO_CHANGE", label: "Reviewed — no change" },
  { code: "RECOMMENDATION", label: "Recommendation documented" },
  { code: "DISCUSSED_WITH_PROVIDER", label: "Discussed with provider" },
  { code: "FOLLOW_UP_REQUIRED", label: "Follow-up required" },
  { code: "COMPLETED", label: "Completed" },
  { code: "UNABLE_TO_REVIEW", label: "Unable to review" },
];

// Display-only field. At module scope, not defined inside the detail component: a component
// created during render is a new type on every render, so React unmounts and remounts its whole
// subtree each time.
function Row({ label, value, missing = "—" }) {
  return (
    <div>
      <span className={lbl}>{label}</span>
      <div className="text-sm text-slate-800">
        {value || <span className="text-slate-400">{missing}</span>}
      </div>
    </div>
  );
}

function Pill({ tone, children }) {
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border ${toneClass(tone)}`}>{children}</span>;
}

export default function AntimicrobialReview({ permissions }) {
  const perms = useMemo(() => new Set(permissions || []), [permissions]);
  const may = useCallback((p) => perms.has(p), [perms]);

  const [statuses, setStatuses] = useState({});
  const [filters, setFilters] = useState({
    search: "", status: "", priority: "", antimicrobial: "", location: "", provider: "", assigned: "",
  });
  const [page, setPage] = useState(1);
  const [limit] = useState(25);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);
  const [reload, setReload] = useState(0);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    getStatuses()
      .then((s) => setStatuses(statusIndex(s.antimicrobial)))
      .catch(() => { /* labels fall back to the raw code */ });
  }, []);

  const query = useMemo(
    () => ({ ...filters, limit, offset: (page - 1) * limit }), [filters, limit, page]);
  const key = useMemo(() => JSON.stringify(query) + "#" + reload, [query, reload]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [list, summary] = await Promise.all([getAmWorklist(query), getAmSummary({})]);
        if (!alive) return;
        setResult({ key, list, summary });
        setError("");
      } catch (e) {
        if (alive) setError(e.message || "The review worklist could not be loaded.");
      }
    })();
    return () => { alive = false; };
  }, [query, key]);

  const loading = !result || result.key !== key;
  const items = result?.list?.items || [];
  const total = result?.list?.total || 0;
  // The counts are nested under `cards`; reading them from the top level showed "—" in every card.
  const summary = result?.summary?.cards || {};
  const pages = Math.max(1, Math.ceil(total / limit));

  const set = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };
  const refresh = () => setReload((n) => n + 1);

  const CARDS = [
    { key: "pending", label: "Pending review", status: "PENDING_REVIEW" },
    { key: "dueToday", label: "Due today", status: "" },
    { key: "overdue", label: "Overdue", status: "" },
    { key: "followUp", label: "Follow-up", status: "FOLLOW_UP" },
    { key: "completedToday", label: "Completed today", status: "COMPLETED" },
  ];

  return (
    <div>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2">
            <Microscope size={19} /> Antimicrobial review
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Active antimicrobial therapy awaiting stewardship review. This screen records what a
            reviewer concluded; it makes no clinical recommendation of its own.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {may("ANTIMICROBIAL_REVIEW") && (
            <button onClick={() => setShowNew(true)} className={`${btn} bg-teal-600 text-white hover:bg-teal-700`}>
              <Plus size={13} /> New review
            </button>
          )}
          <button onClick={refresh} className={`${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`}>
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>
      {showNew && (
        <NewAmReview onClose={() => setShowNew(false)} onCreated={refresh} />
      )}

      <div className="grid grid-cols-3 md:grid-cols-5 gap-2 mb-3">
        {CARDS.map((c) => (
          <button key={c.key}
            onClick={() => c.status && set("status", filters.status === c.status ? "" : c.status)}
            className={`rounded-lg px-3 py-2.5 text-left border ${
              c.status && filters.status === c.status
                ? "bg-slate-900 text-white border-slate-900"
                : "bg-white border-slate-200 hover:bg-slate-50"}`}>
            <div className="text-lg font-semibold tabular-nums">{summary[c.key] ?? "—"}</div>
            <div className="text-[11px]">{c.label}</div>
          </button>
        ))}
      </div>

      <div className={`${card} p-3 mb-3`}>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          <div className="lg:col-span-2">
            <span className={lbl}>Search</span>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
              <input className={`${input} pl-8`} value={filters.search}
                onChange={(e) => set("search", e.target.value)} placeholder="Patient, MRN" />
            </div>
          </div>
          <label className="block">
            <span className={lbl}>Status</span>
            <select className={input} value={filters.status} onChange={(e) => set("status", e.target.value)}>
              <option value="">All</option>
              {Object.entries(statuses).map(([code, s]) => <option key={code} value={code}>{s.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={lbl}>Priority</span>
            <select className={input} value={filters.priority} onChange={(e) => set("priority", e.target.value)}>
              <option value="">All</option>
              {["URGENT", "HIGH", "NORMAL", "LOW"].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={lbl}>Antimicrobial</span>
            <input className={input} value={filters.antimicrobial}
              onChange={(e) => set("antimicrobial", e.target.value)} />
          </label>
          <label className="block">
            <span className={lbl}>Location</span>
            <input className={input} value={filters.location} onChange={(e) => set("location", e.target.value)} />
          </label>
        </div>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 mb-3 flex items-start gap-2">
          <AlertCircle size={15} className="text-rose-600 mt-0.5 shrink-0" />
          <p className="text-xs text-rose-800">{error}</p>
        </div>
      )}

      <div className={`${card} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 border-b border-slate-200 bg-slate-50">
                {["Patient", "MRN", "Antimicrobial", "Dose / route", "Started", "Days",
                  "Indication", "Location", "Provider", "Review due", "Priority", "Status", "Reviewer"]
                  .map((h) => <th key={h} className="px-3 py-2.5 font-medium whitespace-nowrap">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={13} className="px-3 py-10 text-center text-slate-400">
                  <Loader2 size={16} className="animate-spin inline mr-2" /> Loading…
                </td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={13} className="px-3 py-10 text-center text-xs text-slate-400">
                  Nothing matches these filters.
                </td></tr>
              )}
              {!loading && items.map((it) => {
                const over = hoursOverdue(it.reviewDue);
                return (
                  <tr key={it.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-3 py-2.5">
                      <button onClick={() => setOpenId(it.id)}
                        className="text-slate-800 font-medium hover:text-teal-700 hover:underline text-left">
                        {it.patientName || "—"}
                      </button>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-500">{it.mrn}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-800 font-medium">{it.antimicrobial}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">
                      {[it.dose, it.route, it.frequency].filter(Boolean).join(" · ")}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">{shortDate(it.startDate)}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-600 tabular-nums">{it.durationDays}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-600">{it.indication || "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-500">{it.location || "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-600">{it.orderingProvider || "—"}</td>
                    <td className={`px-3 py-2.5 text-xs whitespace-nowrap ${
                      over !== null ? "text-rose-700 font-medium" : "text-slate-600"}`}>
                      {over !== null && <ShieldAlert size={11} className="inline mr-1" />}
                      {dueLabel(it.reviewDue)}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`text-[11px] px-2 py-0.5 rounded-full border ${priorityClass(it.priority)}`}>
                        {it.priority}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <Pill tone={statuses[it.status]?.tone}>{labelFor(statuses, it.status)}</Pill>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-600">{it.assignedToName || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {total > 0 && (
          <div className="flex items-center justify-between px-3 py-2.5 border-t border-slate-100">
            <p className="text-xs text-slate-500">
              {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
            </p>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
                className="text-xs border border-slate-200 rounded-lg px-2 py-1 disabled:opacity-40 hover:bg-slate-50">
                <ChevronLeft size={13} />
              </button>
              <span className="text-xs text-slate-500 px-1.5">Page {page} of {pages}</span>
              <button onClick={() => setPage((p) => p + 1)} disabled={page >= pages}
                className="text-xs border border-slate-200 rounded-lg px-2 py-1 disabled:opacity-40 hover:bg-slate-50">
                <ChevronRight size={13} />
              </button>
            </div>
          </div>
        )}
      </div>

      {openId && (
        <AmReviewDetail id={openId} statuses={statuses} may={may}
          onClose={() => setOpenId(null)} onChanged={refresh} />
      )}
    </div>
  );
}

// ---------- the review detail ----------

function AmReviewDetail({ id, statuses, may, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [reload, setReload] = useState(0);
  const [assignTo, setAssignTo] = useState("");
  const [form, setForm] = useState({
    assessment: "", recommendationCategory: "REVIEWED_NO_CHANGE", recommendationNotes: "",
    providerContacted: "NO", cultures: "", organism: "", susceptibility: "",
    labs: "", renalFunction: "", allergiesNoted: "", followupDate: "", clinicalNotes: "",
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await getAmDetail(id);
        if (alive) { setData(d); setError(""); }
      } catch (e) {
        if (alive) setError(e.message || "This review could not be loaded.");
      }
    })();
    return () => { alive = false; };
  }, [id, reload]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const act = async (name, fn) => {
    setBusy(name); setError("");
    try {
      await fn();
      setReload((n) => n + 1);
      onChanged?.();
    } catch (e) {
      setError(e.message || "That could not be saved.");
    } finally {
      setBusy("");
    }
  };

  const review = data?.review;
  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-start justify-end">
      <div className="bg-white h-full w-full max-w-3xl overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 sticky top-0 bg-white z-10">
          <h3 className="font-semibold text-slate-800">
            {review?.patientName || "Review"}{review?.antimicrobial ? ` · ${review.antimicrobial}` : ""}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        {error && <div className="m-5 bg-rose-50 border border-rose-200 rounded-lg p-2.5 text-xs text-rose-800">{error}</div>}
        {!data && !error && (
          <p className="p-10 text-center text-slate-400 text-sm">
            <Loader2 size={16} className="animate-spin inline mr-2" /> Loading…
          </p>
        )}

        {review && (
          <div className="p-5 space-y-5">
            <section>
              <h4 className="text-sm font-semibold text-slate-800 mb-2">Therapy</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Row label="MRN" value={review.mrn} missing="Not recorded" />
                <Row label="Location" value={review.location} missing="Not recorded" />
                <Row label="Antimicrobial" value={review.antimicrobial} missing="Not recorded" />
                <Row label="Dose" value={review.dose} missing="Not recorded" />
                <Row label="Route" value={review.route} missing="Not recorded" />
                <Row label="Frequency" value={review.frequency} missing="Not recorded" />
                <Row label="Started" value={shortDate(review.startDate)} missing="Not recorded" />
                <Row label="Stopped" value={shortDate(review.stopDate)} missing="Not recorded" />
                <Row label="Indication" value={review.indication} missing="Not recorded" />
                <Row label="Ordering provider" value={review.orderingProvider} missing="Not recorded" />
                <Row label="Attending" value={review.attending} missing="Not recorded" />
                <Row label="Encounter" value={review.encounterRef} missing="Not recorded" />
              </div>
              <div className="flex items-center gap-2 mt-3">
                <Pill tone={statuses[review.status]?.tone}>{labelFor(statuses, review.status)}</Pill>
                <span className={`text-[11px] px-2 py-0.5 rounded-full border ${priorityClass(review.priority)}`}>
                  {review.priority}
                </span>
                <span className="text-xs text-slate-400">
                  Review due {dueLabel(review.reviewDue)}
                  {review.assignedToName ? ` · ${review.assignedToName}` : " · unassigned"}
                </span>
              </div>
            </section>

            {(data.allergies || []).length > 0 && (
              <section>
                <h4 className="text-sm font-semibold text-slate-800 mb-2">Recorded allergies</h4>
                <div className="flex flex-wrap gap-1.5">
                  {data.allergies.map((a, i) => (
                    <span key={i} className="text-[11px] bg-rose-50 border border-rose-200 text-rose-800 rounded-full px-2 py-0.5">
                      {a.substance}{a.reaction ? ` — ${a.reaction}` : ""}{a.severity ? ` (${a.severity})` : ""}
                    </span>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h4 className="text-sm font-semibold text-slate-800 mb-2 flex items-center gap-1.5">
                <History size={14} /> Review history
              </h4>
              {(data.history || []).length === 0 ? (
                <p className="text-xs text-slate-400">No review recorded yet.</p>
              ) : (
                <div className="space-y-2">
                  {data.history.map((h, i) => (
                    <div key={i} className="border border-slate-200 rounded-lg p-2.5">
                      <div className="flex items-center gap-2 mb-1">
                        <Pill tone="blue">{h.recommendationCategory || "Reviewed"}</Pill>
                        <span className="text-[11px] text-slate-400">
                          {h.reviewerName} · {stamp(h.reviewedAt)}
                        </span>
                      </div>
                      {h.assessment && <p className="text-xs text-slate-700">{h.assessment}</p>}
                      {h.recommendationNotes && (
                        <p className="text-xs text-slate-600 mt-1 pl-2 border-l-2 border-slate-200">
                          {h.recommendationNotes}
                        </p>
                      )}
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5 mt-2 text-[11px] text-slate-500">
                        {h.cultures && <span>Cultures: {h.cultures}</span>}
                        {h.organism && <span>Organism: {h.organism}</span>}
                        {h.susceptibility && <span>Susceptibility: {h.susceptibility}</span>}
                        {h.renalFunction && <span>Renal: {h.renalFunction}</span>}
                        {h.labs && <span>Labs: {h.labs}</span>}
                        {h.followupDate && <span>Follow-up: {shortDate(h.followupDate)}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-slate-400 mt-2">
                Review history is never overwritten — a further review is added, not edited in.
              </p>
            </section>

            {may("ANTIMICROBIAL_REVIEW") && (
              <section className="border-t border-slate-100 pt-4">
                <h4 className="text-sm font-semibold text-slate-800 mb-2">Record a review</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <label className="block md:col-span-2">
                    <span className={lbl}>Assessment</span>
                    <textarea className={`${input} h-16 resize-none`} value={form.assessment}
                      onChange={set("assessment")} placeholder="What you found on review" />
                  </label>
                  <label className="block">
                    <span className={lbl}>Outcome</span>
                    <select className={input} value={form.recommendationCategory}
                      onChange={set("recommendationCategory")}>
                      {OUTCOMES.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                    </select>
                  </label>
                  <label className="block">
                    <span className={lbl}>Provider contacted</span>
                    <select className={input} value={form.providerContacted} onChange={set("providerContacted")}>
                      <option value="NO">No</option>
                      <option value="YES">Yes</option>
                    </select>
                  </label>
                  <label className="block md:col-span-2">
                    <span className={lbl}>Recommendation</span>
                    <textarea className={`${input} h-16 resize-none`} value={form.recommendationNotes}
                      onChange={set("recommendationNotes")}
                      placeholder="What you recommended, in your own words" />
                  </label>
                  <label className="block"><span className={lbl}>Cultures</span>
                    <input className={input} value={form.cultures} onChange={set("cultures")} /></label>
                  <label className="block"><span className={lbl}>Organism</span>
                    <input className={input} value={form.organism} onChange={set("organism")} /></label>
                  <label className="block"><span className={lbl}>Susceptibility</span>
                    <input className={input} value={form.susceptibility} onChange={set("susceptibility")} /></label>
                  <label className="block"><span className={lbl}>Renal function</span>
                    <input className={input} value={form.renalFunction} onChange={set("renalFunction")} /></label>
                  <label className="block"><span className={lbl}>Relevant labs</span>
                    <input className={input} value={form.labs} onChange={set("labs")} /></label>
                  <label className="block"><span className={lbl}>Follow-up date</span>
                    <input type="date" className={input} value={form.followupDate} onChange={set("followupDate")} /></label>
                </div>

                <p className="text-[11px] text-slate-400 mt-2">
                  Every field here is what the reviewer observed and concluded. The application
                  offers no assessment of its own and checks nothing clinically — it has no drug
                  database, and a fabricated warning on this screen could be acted on.
                </p>

                <button
                  onClick={() => act("review", async () => {
                    await addAmReview(id, form);
                    setForm((f) => ({ ...f, assessment: "", recommendationNotes: "" }));
                  })}
                  disabled={!form.assessment.trim() || busy === "review"}
                  className={`${btn} bg-teal-600 text-white hover:bg-teal-700 mt-3 disabled:opacity-40`}>
                  {busy === "review" ? <Loader2 size={13} className="animate-spin" /> : null}
                  Record review
                </button>
              </section>
            )}

            {may("ANTIMICROBIAL_ASSIGN") && (
              <section className="border-t border-slate-100 pt-4">
                <span className={lbl}>Assign to</span>
                <div className="flex gap-1.5 max-w-sm">
                  <input className={input} value={assignTo} onChange={(e) => setAssignTo(e.target.value)}
                    placeholder="Reviewer name" />
                  <button
                    onClick={() => act("assign", async () => {
                      await assignAm(id, { assignedToName: assignTo });
                      setAssignTo("");
                    })}
                    disabled={!assignTo.trim() || busy === "assign"}
                    className={`${btn} border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40`}>
                    {busy === "assign" ? <Loader2 size={13} className="animate-spin" /> : <UserCheck size={13} />}
                    Assign
                  </button>
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
