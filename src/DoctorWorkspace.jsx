// Doctor Clinical Workspace - the one-page medical record.
//
// Layout is the point: the longitudinal record on the left at roughly 70%, laboratory results
// pinned on the right at roughly 30% and sticky while the record scrolls, collapsing below the
// record on a narrow screen. Filters and search run on the server, so a patient with years of
// history loads one page at a time rather than everything at once.
//
// Nothing clinical is computed here. Abnormal flags and reference ranges are printed exactly as
// the laboratory supplied them, and a missing value reads "Not available" rather than a guess.

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown, ChevronRight, Search, X, TrendingUp, FileText, AlertTriangle, Pill,
} from "lucide-react";
import {
  RECORD_TYPES, DATE_PRESETS, LAB_WINDOWS, presetFrom,
  patientHeader, patientTimeline, patientLabs, labReport, labTrend,
  flagMeta, referenceLabel, fmtDateTime, fmtDay,
} from "./firebase/doctorService";

const card = "bg-white border border-slate-200 rounded-xl";
const input = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm";

const KIND_TONE = {
  encounter: "bg-teal-50 text-teal-700 border-teal-200",
  note: "bg-blue-50 text-blue-700 border-blue-200",
  diagnosis: "bg-violet-50 text-violet-700 border-violet-200",
  procedure: "bg-cyan-50 text-cyan-700 border-cyan-200",
  medication: "bg-emerald-50 text-emerald-700 border-emerald-200",
  allergy: "bg-rose-50 text-rose-700 border-rose-200",
  vital: "bg-slate-50 text-slate-600 border-slate-200",
  lab: "bg-amber-50 text-amber-800 border-amber-200",
  document: "bg-slate-50 text-slate-600 border-slate-200",
  antimicrobial: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200",
};

const TONE = {
  amber: "bg-amber-50 text-amber-800 border-amber-200",
  rose: "bg-rose-50 text-rose-700 border-rose-200",
};

function Badge({ children, className = "" }) {
  return (
    <span className={`text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 ${className}`}>
      {children}
    </span>
  );
}

// ---------- patient header ----------

function Header({ header }) {
  if (!header) return <div className={`${card} p-4 text-sm text-slate-400`}>Loading patient…</div>;
  const field = (label, value) => (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-sm text-slate-800">{value || "Not available"}</div>
    </div>
  );
  return (
    <div className={`${card} p-4 mb-4`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-slate-800">{header.name || "Not available"}</h1>
          <p className="text-xs text-slate-500">
            MRN {header.mrn} · DOB {header.dob || "Not available"} ·{" "}
            {header.age >= 0 ? `${header.age} yrs` : "Age not available"}
            {header.sex ? ` · ${header.sex}` : ""}
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 flex-1 min-w-[260px]">
          {field("Provider", header.provider)}
          {field("Insurance", header.insurance?.payer)}
          {field("Last Visit", header.lastVisit)}
          {field("Next Appointment", header.nextAppointment)}
        </div>
      </div>

      {/* Pinned safety information - section 23. Allergies stay visible whatever the record
          is filtered to, because scrolling past them is the failure mode that matters. */}
      <div className="mt-3 pt-3 border-t border-slate-100 grid md:grid-cols-2 gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-400 mb-1">
            <AlertTriangle size={11} /> Allergies
          </div>
          {header.allergies?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {header.allergies.map((a, i) => (
                <Badge key={i} className={TONE.rose}>
                  {a.substance}{a.severity ? ` · ${a.severity}` : ""}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-xs text-slate-400">No known allergies recorded</span>
          )}
        </div>
        <div>
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-400 mb-1">
            <Pill size={11} /> Active medications
          </div>
          {header.medications?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {header.medications.map((m, i) => (
                <Badge key={i} className="bg-emerald-50 text-emerald-700 border-emerald-200">
                  {m.name}{m.dose ? ` ${m.dose}` : ""}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-xs text-slate-400">None recorded</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- timeline ----------

function TimelineEntry({ entry }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!entry.detail;
  return (
    <div className="border-b border-slate-100 last:border-0">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        className={`w-full text-left px-3 py-2.5 flex items-start gap-2 ${hasDetail ? "hover:bg-slate-50" : ""}`}
      >
        <span className="mt-0.5 text-slate-300 shrink-0">
          {hasDetail ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span className="inline-block w-[14px]" />}
        </span>
        <span className="w-24 shrink-0 text-xs text-slate-500">{fmtDay(entry.at)}</span>
        <Badge className={`shrink-0 ${KIND_TONE[entry.kind] || KIND_TONE.vital}`}>{entry.kind}</Badge>
        <span className="flex-1 min-w-0">
          <span className="text-sm text-slate-800">{entry.title || "Not available"}</span>
          {entry.subtitle && <span className="text-xs text-slate-500 ml-2">{entry.subtitle}</span>}
          {open && hasDetail && (
            <span className="block text-xs text-slate-600 mt-1 whitespace-pre-wrap">{entry.detail}</span>
          )}
        </span>
        {entry.status && <Badge className="shrink-0 bg-slate-50 text-slate-500 border-slate-200">{entry.status}</Badge>}
      </button>
    </div>
  );
}

function MedicalRecord({ patientId, perms }) {
  const has = useCallback((p) => perms.includes(p), [perms]);
  const visibleTypes = RECORD_TYPES.filter((t) => has(t.perm));

  const [types, setTypes] = useState([]);           // empty = all permitted kinds
  const [preset, setPreset] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState({ types: [], from: "", to: "", search: "", order: "desc" });
  const [order, setOrder] = useState("desc");

  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const LIMIT = 40;

  useEffect(() => {
    let live = true;
    patientTimeline(patientId, { ...applied, limit: LIMIT, offset })
      .then((d) => { if (live) { setData(d); setError(""); } })
      .catch((e) => { if (live) setError(e?.message || "Could not load the medical record."); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [patientId, applied, offset]);

  function apply(next = {}) {
    const f = preset === "custom" ? from : presetFrom(preset);
    const t = preset === "custom" ? to : "";
    setBusy(true);
    setOffset(0);
    setApplied({ types, from: f, to: t, search: search.trim(), order, ...next });
  }

  function clear() {
    setBusy(true);
    setTypes([]); setPreset("all"); setFrom(""); setTo(""); setSearch(""); setOrder("desc");
    setOffset(0);
    setApplied({ types: [], from: "", to: "", search: "", order: "desc" });
  }

  const toggleType = (k) =>
    setTypes((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));

  return (
    <div className={card}>
      <div className="p-3 border-b border-slate-200">
        <div className="flex items-center gap-2 mb-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input
              className={`${input} pl-8`}
              placeholder="Search medical record — diagnosis, note, medication, provider…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apply()}
            />
          </div>
          <button onClick={() => apply()} className="text-xs bg-slate-900 text-white rounded-lg px-3 py-2 hover:bg-slate-800">
            Apply
          </button>
          <button onClick={clear} className="text-xs border border-slate-200 rounded-lg px-3 py-2 hover:bg-slate-50">
            Clear
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5 mb-2">
          {visibleTypes.map((t) => (
            <button
              key={t.key}
              onClick={() => toggleType(t.key)}
              className={`text-[11px] border rounded-lg px-2 py-1 ${
                types.includes(t.key) ? "bg-slate-900 text-white border-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              {t.label}
            </button>
          ))}
          {types.length > 0 && (
            <button onClick={() => setTypes([])} className="text-[11px] text-slate-500 px-2 py-1 hover:underline">
              All records
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select value={preset} onChange={(e) => setPreset(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs">
            {DATE_PRESETS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
          {preset === "custom" && (
            <>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs" />
              <span className="text-xs text-slate-400">to</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs" />
            </>
          )}
          <button
            onClick={() => { const n = order === "desc" ? "asc" : "desc"; setOrder(n); apply({ order: n }); }}
            className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 hover:bg-slate-50"
          >
            {order === "desc" ? "Newest first" : "Oldest first"}
          </button>
          {data && <span className="text-xs text-slate-400 ml-auto">{data.total} record{data.total === 1 ? "" : "s"}</span>}
        </div>
      </div>

      {error && <div className="p-3 text-sm text-rose-700 bg-rose-50 border-b border-rose-200">{error}</div>}

      {busy && !data && <div className="p-6 text-sm text-slate-400">Loading medical record…</div>}

      {data && data.entries.length === 0 && (
        <div className="p-8 text-center">
          <p className="text-sm text-slate-500">No records match these filters.</p>
          <button onClick={clear} className="text-xs text-teal-700 hover:underline mt-1">Clear filters</button>
        </div>
      )}

      {data && data.entries.map((e, i) => <TimelineEntry key={`${e.kind}-${e.ref}-${i}`} entry={e} />)}

      {data && data.total > LIMIT && (
        <div className="p-3 flex items-center justify-between border-t border-slate-100">
          <button
            disabled={offset === 0 || busy}
            onClick={() => { setBusy(true); setOffset((o) => Math.max(0, o - LIMIT)); }}
            className="text-xs border border-slate-200 rounded-lg px-3 py-1.5 disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-xs text-slate-500">
            {offset + 1}–{Math.min(offset + LIMIT, data.total)} of {data.total}
          </span>
          <button
            disabled={offset + LIMIT >= data.total || busy}
            onClick={() => { setBusy(true); setOffset((o) => o + LIMIT); }}
            className="text-xs border border-slate-200 rounded-lg px-3 py-1.5 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- laboratory panel ----------

function ResultRow({ r, onTrend }) {
  const meta = flagMeta(r.flag);
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-slate-50 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-800 truncate">{r.testName}</div>
        <div className="text-[10px] text-slate-400">Ref {referenceLabel(r)}</div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-xs text-slate-900 font-medium">
          {r.value || "Not available"} <span className="text-slate-400 font-normal">{r.unit}</span>
        </div>
        {meta && <Badge className={TONE[meta.tone]}>{meta.label}</Badge>}
      </div>
      {/* Only numeric results can be trended - a qualitative value has nothing to plot. */}
      {r.valueNum !== null && r.valueNum !== undefined && (
        <button onClick={() => onTrend(r.testName)} title="View trend" className="text-slate-300 hover:text-teal-700 shrink-0 mt-0.5">
          <TrendingUp size={13} />
        </button>
      )}
    </div>
  );
}

function LabPanel({ patientId, onReport, onTrend }) {
  const [win, setWin] = useState("");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState({ window: "", category: "", search: "" });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState({});

  useEffect(() => {
    let live = true;
    patientLabs(patientId, { ...applied, limit: 25 })
      .then((d) => { if (live) { setData(d); setError(""); } })
      .catch((e) => { if (live) setError(e?.message || "Could not load laboratory results."); });
    return () => { live = false; };
  }, [patientId, applied]);

  const apply = () => setApplied({ window: win, category, search: search.trim() });

  return (
    <div className={`${card} p-3`}>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Lab Results</h2>
        {data && <span className="text-[10px] text-slate-400">{data.total} panel{data.total === 1 ? "" : "s"}</span>}
      </div>

      <div className="relative mb-2">
        <Search size={13} className="absolute left-2.5 top-2.5 text-slate-400" />
        <input
          className={`${input} pl-8 py-1.5 text-xs`}
          placeholder="Search labs — A1C, Hemoglobin, Glucose…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apply()}
        />
      </div>

      <div className="flex gap-1.5 mb-3">
        <select value={win} onChange={(e) => { setWin(e.target.value); setApplied({ window: e.target.value, category, search: search.trim() }); }}
          className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-xs">
          {LAB_WINDOWS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        {/* Categories come from the data, so tests beyond the common panels appear here too. */}
        <select value={category} onChange={(e) => { setCategory(e.target.value); setApplied({ window: win, category: e.target.value, search: search.trim() }); }}
          className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-xs">
          <option value="">All types</option>
          {(data?.categories || []).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {error && <p className="text-xs text-rose-700 mb-2">{error}</p>}
      {!data && !error && <p className="text-xs text-slate-400">Loading…</p>}
      {data && data.orders.length === 0 && <p className="text-xs text-slate-400">No laboratory results match.</p>}

      <div className="space-y-2">
        {data?.orders.map((o) => {
          const isOpen = open[o.id] !== false; // panels start expanded
          return (
            <div key={o.id} className="border border-slate-200 rounded-lg">
              <button
                onClick={() => setOpen((s) => ({ ...s, [o.id]: !isOpen }))}
                className="w-full text-left px-2.5 py-2 flex items-center gap-1.5 hover:bg-slate-50"
              >
                {isOpen ? <ChevronDown size={13} className="text-slate-400" /> : <ChevronRight size={13} className="text-slate-400" />}
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-medium text-slate-800 truncate">{o.panelName}</span>
                  <span className="block text-[10px] text-slate-400">{fmtDay(o.resultedAt || o.collectedAt || o.orderedAt)}</span>
                </span>
                {o.flaggedCount > 0 && <Badge className={TONE.amber}>{o.flaggedCount} flagged</Badge>}
              </button>

              {isOpen && (
                <div className="px-2.5 pb-2">
                  {o.results.length === 0 && <p className="text-[11px] text-slate-400 py-1">No components recorded.</p>}
                  {o.results.map((r) => <ResultRow key={r.id} r={r} onTrend={onTrend} />)}
                  <button
                    onClick={() => onReport(o.id)}
                    className="mt-2 w-full text-[11px] text-teal-700 border border-teal-200 rounded-lg py-1.5 hover:bg-teal-50 flex items-center justify-center gap-1"
                  >
                    <FileText size={12} /> View Full Report
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- modals ----------

function ReportModal({ patientId, orderId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    labReport(patientId, orderId)
      .then((d) => live && setData(d.order))
      .catch((e) => live && setError(e?.message || "Could not load the report."));
    return () => { live = false; };
  }, [patientId, orderId]);

  const field = (l, v) => (
    <div><div className="text-[10px] uppercase tracking-wide text-slate-400">{l}</div>
      <div className="text-sm text-slate-800">{v || "Not available"}</div></div>
  );

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 sticky top-0 bg-white">
          <h3 className="font-semibold text-slate-800">{data?.panelName || "Laboratory report"}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="p-5">
          {error && <p className="text-sm text-rose-700">{error}</p>}
          {!data && !error && <p className="text-sm text-slate-400">Loading…</p>}
          {data && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                {field("Ordering provider", data.orderingProvider)}
                {field("Laboratory", data.labName)}
                {field("Accession", data.accession)}
                {field("Status", data.status)}
                {field("Ordered", fmtDateTime(data.orderedAt))}
                {field("Collected", fmtDateTime(data.collectedAt))}
                {field("Resulted", fmtDateTime(data.resultedAt))}
                {field("Category", data.category)}
              </div>

              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-medium">Test</th>
                    <th className="text-right px-2 py-1.5 font-medium">Result</th>
                    <th className="text-left px-2 py-1.5 font-medium">Unit</th>
                    <th className="text-left px-2 py-1.5 font-medium">Reference</th>
                    <th className="text-left px-2 py-1.5 font-medium">Flag</th>
                    <th className="text-left px-2 py-1.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((r) => {
                    const meta = flagMeta(r.flag);
                    return (
                      <tr key={r.id} className="border-t border-slate-100">
                        <td className="px-2 py-1.5 text-slate-800">{r.testName}</td>
                        <td className="px-2 py-1.5 text-right font-medium text-slate-900">{r.value || "Not available"}</td>
                        <td className="px-2 py-1.5 text-slate-500 text-xs">{r.unit}</td>
                        <td className="px-2 py-1.5 text-slate-500 text-xs">{referenceLabel(r)}</td>
                        <td className="px-2 py-1.5">{meta ? <Badge className={TONE[meta.tone]}>{meta.label}</Badge> : <span className="text-slate-300 text-xs">—</span>}</td>
                        <td className="px-2 py-1.5 text-slate-500 text-xs">{r.status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {data.comments && (
                <div className="mt-4">
                  <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">Comments</div>
                  <p className="text-sm text-slate-700 whitespace-pre-wrap">{data.comments}</p>
                </div>
              )}
              {data.reportDocumentId && (
                <p className="text-xs text-slate-500 mt-3">
                  An original report document is attached to this order (id {data.reportDocumentId}).
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TrendModal({ patientId, test, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    labTrend(patientId, test)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e?.message || "Could not load the trend."));
    return () => { live = false; };
  }, [patientId, test]);

  const pts = data?.points || [];
  const vals = pts.map((p) => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h3 className="font-semibold text-slate-800">{test}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="p-5">
          {error && <p className="text-sm text-rose-700">{error}</p>}
          {!data && !error && <p className="text-sm text-slate-400">Loading…</p>}
          {data && pts.length === 0 && (
            <p className="text-sm text-slate-500">No numeric results are recorded for this test, so there is nothing to trend.</p>
          )}
          {pts.length > 0 && (
            <>
              {/* Plotted from stored values only. No interpolation, no projection. */}
              <svg viewBox="0 0 320 120" className="w-full h-32 mb-3">
                <polyline
                  fill="none" stroke="#0d9488" strokeWidth="2"
                  points={pts.map((p, i) => {
                    const x = pts.length === 1 ? 160 : 10 + (i * 300) / (pts.length - 1);
                    const y = 110 - ((p.value - min) / span) * 95;
                    return `${x},${y}`;
                  }).join(" ")}
                />
                {pts.map((p, i) => {
                  const x = pts.length === 1 ? 160 : 10 + (i * 300) / (pts.length - 1);
                  const y = 110 - ((p.value - min) / span) * 95;
                  return <circle key={i} cx={x} cy={y} r="3" fill="#0d9488" />;
                })}
              </svg>
              <table className="w-full text-sm">
                <tbody>
                  {pts.map((p, i) => {
                    const meta = flagMeta(p.flag);
                    return (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="py-1.5 text-xs text-slate-500">{fmtDay(p.at)}</td>
                        <td className="py-1.5 text-right text-slate-900 font-medium">{p.value} <span className="text-slate-400 font-normal text-xs">{p.unit}</span></td>
                        <td className="py-1.5 pl-2 w-20">{meta ? <Badge className={TONE[meta.tone]}>{meta.label}</Badge> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- the workspace ----------

export default function DoctorWorkspace({ patientId, perms, onBack }) {
  const [header, setHeader] = useState(null);
  const [error, setError] = useState("");
  const [report, setReport] = useState(null);
  const [trend, setTrend] = useState(null);
  const [labsOpen, setLabsOpen] = useState(false); // mobile disclosure

  useEffect(() => {
    let live = true;
    patientHeader(patientId)
      .then((h) => live && setHeader(h))
      .catch((e) => live && setError(e?.message || "Could not load this patient."));
    return () => { live = false; };
  }, [patientId]);

  const canSeeLabs = perms.includes("DOCTOR_LAB_VIEW");

  if (error) {
    return (
      <div className={`${card} p-6`}>
        <p className="text-sm text-rose-700">{error}</p>
        <button onClick={onBack} className="text-xs text-teal-700 hover:underline mt-2">Back</button>
      </div>
    );
  }

  return (
    <div>
      <button onClick={onBack} className="text-sm text-slate-500 hover:text-slate-700 mb-3">← Back to patient list</button>
      <Header header={header} />

      {/* 70/30 on desktop; the lab panel drops below the record on narrow screens rather than
          forcing horizontal scrolling. */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)] gap-4 items-start">
        <MedicalRecord patientId={patientId} perms={perms} />

        {canSeeLabs && (
          <>
            <div className="hidden lg:block lg:sticky lg:top-4">
              <LabPanel patientId={patientId} onReport={setReport} onTrend={setTrend} />
            </div>
            <div className="lg:hidden">
              <button
                onClick={() => setLabsOpen((o) => !o)}
                className={`${card} w-full px-3 py-2.5 flex items-center justify-between text-sm text-slate-700`}
              >
                <span className="font-medium">Lab Results</span>
                {labsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
              {labsOpen && <div className="mt-2"><LabPanel patientId={patientId} onReport={setReport} onTrend={setTrend} /></div>}
            </div>
          </>
        )}
      </div>

      {report && <ReportModal patientId={patientId} orderId={report} onClose={() => setReport(null)} />}
      {trend && <TrendModal patientId={patientId} test={trend} onClose={() => setTrend(null)} />}
    </div>
  );
}
