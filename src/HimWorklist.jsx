// HIM → Coding Worklist.
//
// The backend for this has existed and been permission-gated all along; what was missing was a way
// to look at it. This screen calls those endpoints and nothing else - it derives no status, no
// priority and no days-pending figure of its own, because the server already computes all three and
// two sources would eventually disagree.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClipboardList, Search, X, Loader2, AlertCircle, UserCheck, MessageSquarePlus,
  ChevronLeft, ChevronRight, RefreshCw, Stethoscope,
} from "lucide-react";
import {
  getStatuses, getHimWorklist, getHimSummary, getHimDetail, assignHim, setHimStatus,
  createHimQuery, updateHimQuery,
  statusIndex, labelFor, toneClass, priorityClass, stamp, shortDate,
} from "./clinicalService";

const card = "bg-white border border-slate-200 rounded-xl";
const input = "w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm";
const lbl = "block text-[11px] uppercase tracking-wide text-slate-400 mb-1";
const btn = "text-xs rounded-lg px-3 py-2 flex items-center gap-1.5 whitespace-nowrap";

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

function Card({ label, value, active, onClick }) {
  return (
    <button onClick={onClick}
      className={`rounded-lg px-3 py-2.5 text-left border ${
        active ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-200 hover:bg-slate-50"}`}>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px]">{label}</div>
    </button>
  );
}

export default function HimWorklist({ permissions }) {
  const perms = useMemo(() => new Set(permissions || []), [permissions]);
  const may = useCallback((p) => perms.has(p), [perms]);

  const [statuses, setStatuses] = useState({});
  const [filters, setFilters] = useState({ search: "", status: "", queryStatus: "", priority: "", provider: "", payer: "" });
  const [page, setPage] = useState(1);
  const [limit] = useState(25);
  const [result, setResult] = useState(null);   // { key, list, cards }
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    getStatuses()
      // Keyed by the workflow_statuses domain. These were read as "him" and "himQuery" at first,
      // which do not exist - the coding-status filter rendered empty and every label fell back to
      // the raw code.
      .then((s) => setStatuses({ him: statusIndex(s.him_coding), query: statusIndex(s.him_query) }))
      .catch(() => { /* labels fall back to the raw code */ });
  }, []);

  const query = useMemo(
    () => ({ ...filters, limit, offset: (page - 1) * limit }), [filters, limit, page]);
  const key = useMemo(() => JSON.stringify(query) + "#" + reload, [query, reload]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [list, summary] = await Promise.all([
          getHimWorklist(query),
          getHimSummary({}),
        ]);
        if (!alive) return;
        setResult({ key, list, cards: summary.cards || {} });
        setError("");
      } catch (e) {
        if (alive) setError(e.message || "The worklist could not be loaded.");
      }
    })();
    return () => { alive = false; };
  }, [query, key]);

  const loading = !result || result.key !== key;
  const items = result?.list?.items || [];
  const total = result?.list?.total || 0;
  const cards = result?.cards || {};
  const pages = Math.max(1, Math.ceil(total / limit));

  const set = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };
  const refresh = () => setReload((n) => n + 1);

  const CARDS = [
    { key: "unassigned", label: "Unassigned", status: "UNASSIGNED" },
    { key: "readyForCoding", label: "Ready for coding", status: "READY_FOR_CODING" },
    { key: "inProgress", label: "In progress", status: "IN_PROGRESS" },
    { key: "queriesOutstanding", label: "Queries out", status: "QUERY_SENT" },
    { key: "finalReview", label: "Final review", status: "FINAL_REVIEW" },
    { key: "completedToday", label: "Completed today", status: "COMPLETED" },
  ];

  return (
    <div>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2">
            <ClipboardList size={19} /> HIM coding worklist
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Encounters waiting to be coded. Status, priority and days pending all come from the
            server.
          </p>
        </div>
        <button onClick={refresh} className={`${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-3">
        {CARDS.map((c) => (
          <Card key={c.key} label={c.label} value={cards[c.key] ?? "—"}
            active={filters.status === c.status}
            onClick={() => set("status", filters.status === c.status ? "" : c.status)} />
        ))}
      </div>
      {cards.overdue > 0 && (
        <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5 mb-3 inline-block">
          {cards.overdue} encounter{cards.overdue === 1 ? "" : "s"} past the coding target
        </p>
      )}

      <div className={`${card} p-3 mb-3`}>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          <div className="lg:col-span-2">
            <span className={lbl}>Search</span>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
              <input className={`${input} pl-8`} value={filters.search}
                onChange={(e) => set("search", e.target.value)}
                placeholder="Patient, MRN, encounter" />
            </div>
          </div>
          <label className="block">
            <span className={lbl}>Coding status</span>
            <select className={input} value={filters.status} onChange={(e) => set("status", e.target.value)}>
              <option value="">All</option>
              {Object.entries(statuses.him || {}).map(([code, s]) =>
                <option key={code} value={code}>{s.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={lbl}>Query status</span>
            <select className={input} value={filters.queryStatus} onChange={(e) => set("queryStatus", e.target.value)}>
              <option value="">All</option>
              {Object.entries(statuses.query || {}).map(([code, st]) =>
                <option key={code} value={code}>{st.label}</option>)}
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
            <span className={lbl}>Payer</span>
            <input className={input} value={filters.payer} onChange={(e) => set("payer", e.target.value)} />
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
                {["Patient", "MRN", "Encounter", "DOS", "Type", "Provider", "Payer",
                  "Status", "Query", "Priority", "Coder", "Days"].map((h) => (
                  <th key={h} className="px-3 py-2.5 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={12} className="px-3 py-10 text-center text-slate-400">
                  <Loader2 size={16} className="animate-spin inline mr-2" /> Loading…
                </td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={12} className="px-3 py-10 text-center text-xs text-slate-400">
                  No encounters match these filters.
                </td></tr>
              )}
              {!loading && items.map((it) => (
                <tr key={it.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-3 py-2.5">
                    <button onClick={() => setOpenId(it.id)}
                      className="text-slate-800 font-medium hover:text-teal-700 hover:underline text-left">
                      {it.patientName || "—"}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-500">{it.mrn}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-500">{it.encounterRef || "—"}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">{shortDate(it.dos)}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-500">{it.encounterType || "—"}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">{it.provider || "—"}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">{it.payer || "—"}</td>
                  <td className="px-3 py-2.5">
                    <Pill tone={statuses.him?.[it.codingStatus]?.tone}>
                      {labelFor(statuses.him, it.codingStatus)}
                    </Pill>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-500">
                    {it.queryStatus && it.queryStatus !== "NONE" ? labelFor(statuses.query, it.queryStatus) : "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`text-[11px] px-2 py-0.5 rounded-full border ${priorityClass(it.priority)}`}>
                      {it.priority || "NORMAL"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">{it.assignedToName || "—"}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-600 tabular-nums">{it.daysPending}</td>
                </tr>
              ))}
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
        <HimCodingWorkspace id={openId} statuses={statuses} may={may}
          onClose={() => setOpenId(null)} onChanged={refresh} />
      )}
    </div>
  );
}

// ---------- the coding workspace ----------

function HimCodingWorkspace({ id, statuses, may, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [reload, setReload] = useState(0);
  const [queryText, setQueryText] = useState("");
  const [assignTo, setAssignTo] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await getHimDetail(id);
        if (alive) { setData(d); setError(""); }
      } catch (e) {
        if (alive) setError(e.message || "This encounter could not be loaded.");
      }
    })();
    return () => { alive = false; };
  }, [id, reload]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  const item = data?.item;
  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-start justify-end">
      <div className="bg-white h-full w-full max-w-3xl overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 sticky top-0 bg-white z-10">
          <h3 className="font-semibold text-slate-800">
            {item?.patientName || "Encounter"}{item?.encounterRef ? ` · ${item.encounterRef}` : ""}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        {error && <div className="m-5 bg-rose-50 border border-rose-200 rounded-lg p-2.5 text-xs text-rose-800">{error}</div>}
        {!data && !error && (
          <p className="p-10 text-center text-slate-400 text-sm">
            <Loader2 size={16} className="animate-spin inline mr-2" /> Loading…
          </p>
        )}

        {item && (
          <div className="p-5 space-y-5">
            <section>
              <h4 className="text-sm font-semibold text-slate-800 mb-2">Encounter</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Row label="MRN" value={item.mrn} />
                <Row label="Date of service" value={shortDate(item.dos)} />
                <Row label="Type" value={item.encounterType} />
                <Row label="Location" value={item.location} />
                <Row label="Provider" value={item.provider} />
                <Row label="Payer" value={item.payer} />
                <Row label="Admitted" value={shortDate(item.admitDate)} />
                <Row label="Discharged" value={shortDate(item.dischargeDate)} />
              </div>
              <div className="flex items-center gap-2 mt-3">
                <Pill tone={statuses.him?.[item.codingStatus]?.tone}>
                  {labelFor(statuses.him, item.codingStatus)}
                </Pill>
                <span className={`text-[11px] px-2 py-0.5 rounded-full border ${priorityClass(item.priority)}`}>
                  {item.priority}
                </span>
                <span className="text-xs text-slate-400">
                  {item.assignedToName ? `Assigned to ${item.assignedToName}` : "Unassigned"}
                  {" · "}{item.daysPending} day{item.daysPending === 1 ? "" : "s"} pending
                </span>
              </div>
            </section>

            {/* Coding */}
            <section>
              <h4 className="text-sm font-semibold text-slate-800 mb-2">Diagnosis coding</h4>
              {(data.diagnoses || []).length === 0 ? (
                <p className="text-xs text-slate-400">No diagnosis codes recorded.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase text-slate-400 border-b border-slate-200">
                      <th className="py-1.5 font-medium">Seq</th>
                      <th className="py-1.5 font-medium">Code</th>
                      <th className="py-1.5 font-medium">Description</th>
                      <th className="py-1.5 font-medium">Principal</th>
                      <th className="py-1.5 font-medium">POA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.diagnoses.map((d, i) => (
                      <tr key={i} className="border-b border-slate-100 last:border-0">
                        <td className="py-1.5 text-xs text-slate-500">{d.sequence}</td>
                        <td className="py-1.5 font-mono text-xs text-slate-800">{d.code}</td>
                        <td className="py-1.5 text-xs text-slate-600">{d.description}</td>
                        <td className="py-1.5 text-xs">{d.isPrincipal ? "Yes" : ""}</td>
                        <td className="py-1.5 text-xs text-slate-500">{d.poa}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section>
              <h4 className="text-sm font-semibold text-slate-800 mb-2">Procedure coding</h4>
              {(data.procedures || []).length === 0 ? (
                <p className="text-xs text-slate-400">No procedure codes recorded.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase text-slate-400 border-b border-slate-200">
                      <th className="py-1.5 font-medium">Seq</th>
                      <th className="py-1.5 font-medium">Code</th>
                      <th className="py-1.5 font-medium">Description</th>
                      <th className="py-1.5 font-medium">Mod</th>
                      <th className="py-1.5 font-medium">Units</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.procedures.map((p, i) => (
                      <tr key={i} className="border-b border-slate-100 last:border-0">
                        <td className="py-1.5 text-xs text-slate-500">{p.sequence}</td>
                        <td className="py-1.5 font-mono text-xs text-slate-800">{p.code}</td>
                        <td className="py-1.5 text-xs text-slate-600">{p.description}</td>
                        <td className="py-1.5 text-xs">{p.modifiers || "—"}</td>
                        <td className="py-1.5 text-xs">{p.units}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {/* Provider queries */}
            <section>
              <h4 className="text-sm font-semibold text-slate-800 mb-2">Provider queries</h4>
              {(data.queries || []).length === 0 && (
                <p className="text-xs text-slate-400 mb-2">No queries raised.</p>
              )}
              <div className="space-y-2">
                {(data.queries || []).map((q) => (
                  <div key={q.id} className="border border-slate-200 rounded-lg p-2.5">
                    <div className="flex items-center gap-2 mb-1">
                      <Pill tone={statuses.query?.[q.status]?.tone
                        || (q.status === "RESOLVED" ? "green" : q.status === "RECEIVED" ? "blue" : "amber")}>
                        {labelFor(statuses.query, q.status)}
                      </Pill>
                      <span className="text-[11px] text-slate-400">
                        {q.queryType} · {q.createdByName} · {stamp(q.sentAt || q.createdAt)}
                      </span>
                    </div>
                    <p className="text-xs text-slate-700">{q.queryText}</p>
                    {q.responseText && (
                      <p className="text-xs text-slate-600 mt-1.5 pl-2 border-l-2 border-slate-200">
                        {q.responseText}
                      </p>
                    )}
                    {may("HIM_QUERY_MANAGE") && q.status !== "RESOLVED" && (
                      <button
                        onClick={() => act("q" + q.id, () => updateHimQuery(q.id, { status: "RESOLVED" }))}
                        disabled={busy === "q" + q.id}
                        className="text-[11px] border border-slate-200 rounded px-2 py-1 mt-2 hover:bg-slate-50">
                        Mark resolved
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {may("HIM_QUERY_CREATE") && (
                <div className="mt-3">
                  <textarea className={`${input} h-16 resize-none`} value={queryText}
                    onChange={(e) => setQueryText(e.target.value)}
                    placeholder="Ask the provider to clarify the documentation…" />
                  <button
                    onClick={() => act("newq", async () => {
                      await createHimQuery(id, { queryText, queryType: "SPECIFICITY" });
                      setQueryText("");
                    })}
                    disabled={!queryText.trim() || busy === "newq"}
                    className={`${btn} border border-slate-200 text-slate-700 hover:bg-slate-50 mt-1.5 disabled:opacity-40`}>
                    {busy === "newq" ? <Loader2 size={13} className="animate-spin" /> : <MessageSquarePlus size={13} />}
                    Raise query
                  </button>
                </div>
              )}
            </section>

            {/* Assignment and status */}
            <section className="border-t border-slate-100 pt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {may("HIM_ASSIGN") && (
                  <div>
                    <span className={lbl}>Assign to</span>
                    <div className="flex gap-1.5">
                      <input className={input} value={assignTo} onChange={(e) => setAssignTo(e.target.value)}
                        placeholder="Coder name" />
                      <button
                        onClick={() => act("assign", async () => {
                          await assignHim(id, { assignedToName: assignTo });
                          setAssignTo("");
                        })}
                        disabled={!assignTo.trim() || busy === "assign"}
                        className={`${btn} border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40`}>
                        {busy === "assign" ? <Loader2 size={13} className="animate-spin" /> : <UserCheck size={13} />}
                        Assign
                      </button>
                    </div>
                  </div>
                )}
                {may("HIM_CODING_EDIT") && (
                  <div>
                    <span className={lbl}>Coding status</span>
                    <select className={input} value={item.codingStatus}
                      onChange={(e) => act("status", () => setHimStatus(id, { status: e.target.value }))}>
                      {Object.entries(statuses.him || {}).map(([code, s]) =>
                        <option key={code} value={code}>{s.label}</option>)}
                    </select>
                  </div>
                )}
              </div>
            </section>

            {/* Activity */}
            <section className="border-t border-slate-100 pt-4">
              <h4 className="text-sm font-semibold text-slate-800 mb-2 flex items-center gap-1.5">
                <Stethoscope size={14} /> Activity
              </h4>
              {(data.activity || []).length === 0 ? (
                <p className="text-xs text-slate-400">Nothing recorded yet.</p>
              ) : (
                <ol className="space-y-1.5">
                  {data.activity.map((a, i) => (
                    <li key={i} className="text-xs border-l-2 border-slate-200 pl-2">
                      <span className="text-slate-800">{a.action}</span>
                      <span className="text-slate-400"> · {a.user} · {stamp(a.at)}</span>
                      {a.detail && <div className="text-slate-500">{a.detail}</div>}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
