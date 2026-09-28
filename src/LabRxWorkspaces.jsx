// Cross-patient Lab and Rx tabs.
//
// Both existed inside the Medical Record workspace as per-patient panels; the backends have
// always been able to serve a single patient. These are top-level tabs: pick a patient, then see
// their labs or their prescriptions.
//
// Nothing clinical is derived here. Flags, ranges and prescription statuses are shown exactly as
// the server records them. The application has no drug database and no laboratory-reference
// engine of its own.

import { useEffect, useState } from "react";
import { FlaskConical, Pill, Search, Plus, X, Loader2, RefreshCw, Save, ChevronDown, ChevronRight, Upload, Sparkles, Trash2 } from "lucide-react";
import { api, API_BASE, getToken } from "./firebase/apiClient";
import { PatientPicker } from "./NewClinicalEntry";

const card = "bg-white border border-slate-200 rounded-xl";
const input = "w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm";
const lbl = "block text-[11px] uppercase tracking-wide text-slate-400 mb-1";
const btn = "text-xs rounded-lg px-3 py-2 flex items-center gap-1.5";
const primary = `${btn} bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-40`;
const plain = `${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`;

function PatientHeader({ patient, onClear }) {
  return (
    <div className={`${card} p-3 mb-3 flex items-center justify-between`}>
      <div>
        <div className="text-sm font-semibold text-slate-800">{patient.name}</div>
        <div className="text-xs text-slate-500">
          {patient.id}
          {patient.dob ? " · DOB " + patient.dob : ""}
        </div>
      </div>
      <button onClick={onClear} className={plain}><X size={12} /> Change patient</button>
    </div>
  );
}

// ---------- Labs ----------

export function LabWorkspace({ permissions }) {
  const [patient, setPatient] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const may = (p) => (permissions || []).includes(p);
  const mayManage = may("DOCTOR_LAB_MANAGE");

  useEffect(() => {
    if (!patient) return undefined;
    let alive = true;
    setError("");
    const q = new URLSearchParams({ limit: "50" });
    if (search.trim()) q.set("search", search.trim());
    api(`/api/doctor/patients/${encodeURIComponent(patient.id)}/labs?${q.toString()}`)
      .then((d) => { if (alive) { setData(d); setError(""); } })
      .catch((e) => { if (alive) { setError(e.message || "Laboratory results could not be loaded."); setData(null); } });
    return () => { alive = false; };
  }, [patient, reloadKey, search]);

  if (!patient) {
    return (
      <div>
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2">
            <FlaskConical size={19} /> Laboratory
          </h1>
        </div>
        <div className={`${card} p-4 max-w-lg`}>
          <p className="text-xs text-slate-500 mb-2">Choose a patient to see their laboratory results.</p>
          <PatientPicker value={null} onChange={setPatient} />
          {!may("DOCTOR_LAB_VIEW") && (
            <p className="text-[11px] text-amber-700 mt-2">
              You do not hold the Lab view permission; the server will refuse to send results.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2">
          <FlaskConical size={19} /> Laboratory
        </h1>
        <div className="flex items-center gap-1.5">
          {mayManage && (
            <button onClick={() => setShowUpload(true)} className={primary}>
              <Upload size={13} /> Upload lab report
            </button>
          )}
          <button onClick={() => setReloadKey((n) => n + 1)} className={plain}>
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>
      <PatientHeader patient={patient} onClear={() => { setPatient(null); setData(null); }} />

      {showUpload && (
        <LabUploadDialog patient={patient} onClose={() => setShowUpload(false)}
          onSaved={() => { setShowUpload(false); setReloadKey((n) => n + 1); }} />
      )}

      <div className={`${card} p-3 mb-3`}>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-2.5 text-slate-400" />
          <input className={`${input} pl-8`} value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search labs - A1C, Hemoglobin, Glucose..." />
        </div>
      </div>

      {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mb-3">{error}</div>}
      {!data && !error && <p className="text-xs text-slate-400"><Loader2 size={12} className="inline animate-spin mr-1" />Loading laboratory results…</p>}
      {data && data.orders?.length === 0 && <p className="text-xs text-slate-400 py-4">No laboratory results on file.</p>}

      <div className="space-y-2">
        {(data?.orders || []).map((o) => {
          const isOpen = openId === o.id;
          return (
            <div key={o.id} className={card}>
              <button className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-slate-50"
                onClick={() => setOpenId(isOpen ? null : o.id)}>
                {isOpen ? <ChevronDown size={13} className="text-slate-400" /> : <ChevronRight size={13} className="text-slate-400" />}
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-slate-800 truncate">{o.panelName || "Lab order"}</span>
                  <span className="block text-[11px] text-slate-500">
                    {(o.resultedAt || o.collectedAt || o.orderedAt || "").slice(0, 10)}
                    {o.orderingProvider ? " · " + o.orderingProvider : ""}
                  </span>
                </span>
                {o.flaggedCount > 0 && (
                  <span className="text-[10px] uppercase tracking-wide bg-amber-50 text-amber-800 border border-amber-200 rounded px-1.5 py-0.5">
                    {o.flaggedCount} flagged
                  </span>
                )}
              </button>
              {isOpen && (
                <div className="px-3 pb-2">
                  {(o.results || []).length === 0 && <p className="text-[11px] text-slate-400 py-1">No components recorded.</p>}
                  {(o.results || []).map((r, i) => (
                    <div key={i} className="grid grid-cols-4 gap-2 text-xs py-1 border-t border-slate-100 first:border-t-0">
                      <div className="text-slate-600 truncate">{r.test || r.name}</div>
                      <div className={r.flag ? "font-medium text-rose-700" : "text-slate-800"}>
                        {r.value ?? "—"} {r.unit || ""}
                        {r.flag && <span className="ml-1 text-[10px] uppercase">{r.flag}</span>}
                      </div>
                      <div className="text-slate-400">{r.referenceRange || r.range || ""}</div>
                      <div className="text-slate-400 text-right">{(r.status || "").toLowerCase()}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Rx / Prescriptions ----------

const RX_ROUTES = ["Oral", "IV", "IM", "Topical", "Inhaled", "Ophthalmic", "Otic", "Other"];

export function RxWorkspace({ permissions }) {
  const [patient, setPatient] = useState(null);
  const [list, setList] = useState(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [showNew, setShowNew] = useState(false);
  const may = (p) => (permissions || []).includes(p);
  const mayCreate = may("RX_CREATE");

  useEffect(() => {
    if (!patient) return undefined;
    let alive = true;
    setError("");
    api(`/api/rx/patients/${encodeURIComponent(patient.id)}/prescriptions`)
      .then((r) => { if (alive) { setList(r.prescriptions || []); setError(""); } })
      .catch((e) => { if (alive) { setError(e.message || "Prescriptions could not be loaded."); setList(null); } });
    return () => { alive = false; };
  }, [patient, reloadKey]);

  if (!patient) {
    return (
      <div>
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2">
            <Pill size={19} /> Prescriptions
          </h1>
        </div>
        <div className={`${card} p-4 max-w-lg`}>
          <p className="text-xs text-slate-500 mb-2">Choose a patient to see their prescriptions.</p>
          <PatientPicker value={null} onChange={setPatient} />
          {!may("RX_VIEW") && (
            <p className="text-[11px] text-amber-700 mt-2">
              You do not hold the Rx view permission; the server will refuse to send prescriptions.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2">
          <Pill size={19} /> Prescriptions
        </h1>
        <div className="flex items-center gap-1.5">
          {mayCreate && (
            <button onClick={() => setShowNew(true)} className={primary}>
              <Plus size={13} /> New prescription
            </button>
          )}
          <button onClick={() => setReloadKey((n) => n + 1)} className={plain}>
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>
      <PatientHeader patient={patient} onClear={() => { setPatient(null); setList(null); }} />

      {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mb-3">{error}</div>}
      {!list && !error && <p className="text-xs text-slate-400"><Loader2 size={12} className="inline animate-spin mr-1" />Loading…</p>}
      {list && list.length === 0 && <p className="text-xs text-slate-400 py-4">No prescriptions on file.</p>}

      <div className="space-y-2">
        {(list || []).map((rx) => (
          <div key={rx.id} className={`${card} p-3`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800">
                  {rx.medication}
                  {rx.strength && <span className="text-slate-500 ml-1">· {rx.strength}</span>}
                </div>
                <div className="text-xs text-slate-500">
                  {[rx.dose, rx.route, rx.frequency].filter(Boolean).join(" · ")}
                </div>
                {rx.sig && <div className="text-xs text-slate-600 mt-1">SIG: {rx.sig}</div>}
                <div className="text-[11px] text-slate-400 mt-1">
                  {rx.quantity ? `Qty ${rx.quantity}` : ""}
                  {rx.daysSupply ? ` · ${rx.daysSupply} days` : ""}
                  {rx.refills ? ` · ${rx.refills} refills` : ""}
                  {rx.pharmacyName ? ` · ${rx.pharmacyName}` : ""}
                </div>
              </div>
              <span className="text-[10px] uppercase tracking-wide border border-slate-200 rounded px-1.5 py-0.5 text-slate-600 bg-slate-50 shrink-0">
                {rx.status || "DRAFT"}
              </span>
            </div>
          </div>
        ))}
      </div>

      {showNew && mayCreate && (
        <NewRxDialog patient={patient} onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); setReloadKey((n) => n + 1); }} />
      )}
    </div>
  );
}

// ---------- Lab upload + extract + review ----------
//
// Two round trips. First the PDF is sent to /labs/extract which forwards its text to the
// language model and returns a structured proposal. The user reviews and edits the rows and only
// then sends them to /labs, which writes the lab_orders + lab_results rows and stores the PDF.
// Nothing lands in the database until the user confirms.

const LAB_STATUSES = ["", "final", "preliminary", "corrected", "cancelled"];
const LAB_FLAGS = ["", "H", "L", "A", "AA", "CRIT"];

const BLANK_RESULT = {
  testName: "", valueText: "", valueNum: null, unit: "",
  referenceLow: null, referenceHigh: null, referenceText: "", flag: "",
};

function LabUploadDialog({ patient, onClose, onSaved }) {
  const [file, setFile] = useState(null);
  const [phase, setPhase] = useState("pick");   // pick | extracting | review
  const [error, setError] = useState("");
  const [extracted, setExtracted] = useState(null); // { order, results, pdfBase64, pdfName }

  async function extract() {
    if (!file) { setError("Choose a PDF first."); return; }
    setError(""); setPhase("extracting");
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      const res = await fetch(
        `${API_BASE}/api/doctor/patients/${encodeURIComponent(patient.id)}/labs/extract`,
        { method: "POST", headers: { Authorization: `Bearer ${getToken() || ""}` }, body: fd });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `Extraction failed (${res.status})`);
      }
      const data = await res.json();
      setExtracted({
        order: data.order || {},
        results: Array.isArray(data.results) ? data.results : [],
        pdfBase64: data.pdfBase64 || "",
        pdfName: data.pdfName || file.name,
      });
      setPhase("review");
    } catch (e) {
      setError(e.message || "The report could not be extracted.");
      setPhase("pick");
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl my-4">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h3 className="font-semibold text-slate-800">
            Upload lab report — {patient?.name}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        {phase === "pick" && (
          <div className="p-5">
            {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}
            <p className="text-xs text-slate-500 mb-3">
              The PDF is sent to the language model, which reads the text and proposes rows for a
              lab order plus its analytes. You review and edit the proposal before it is saved.
              Nothing about the value's normality is derived by this application - flags are shown
              exactly as the model finds them printed on the report.
            </p>
            <label className="block mb-3">
              <span className={lbl}>Lab report PDF (max 20 MB)</span>
              <input type="file" accept="application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="text-xs block w-full" />
            </label>
            {file && (
              <p className="text-[11px] text-slate-500 mb-3">
                {file.name} · {(file.size / 1024).toFixed(0)} KB
              </p>
            )}
            <p className="text-[11px] text-slate-400">
              Scanned images without OCR have no text layer and cannot be extracted. Re-scan with
              OCR enabled or enter the values by hand for those.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={onClose} className={plain}>Cancel</button>
              <button onClick={extract} disabled={!file} className={primary}>
                <Sparkles size={13} /> Extract with AI
              </button>
            </div>
          </div>
        )}

        {phase === "extracting" && (
          <div className="p-8 text-center">
            <Loader2 size={20} className="animate-spin inline text-teal-600" />
            <p className="text-sm text-slate-600 mt-3">Reading the PDF and asking the model to extract…</p>
            <p className="text-[11px] text-slate-400 mt-1">This can take up to a minute for a large report.</p>
          </div>
        )}

        {phase === "review" && extracted && (
          <LabReviewForm
            patientId={patient.id}
            initial={extracted}
            onCancel={() => onClose()}
            onSaved={onSaved}
          />
        )}
      </div>
    </div>
  );
}

function LabReviewForm({ patientId, initial, onCancel, onSaved }) {
  const [order, setOrder] = useState(() => ({
    panelName: "", category: "", orderingProvider: "", labName: "", accession: "",
    orderedAt: "", collectedAt: "", resultedAt: "", status: "", comments: "",
    ...(initial.order || {}),
  }));
  const [results, setResults] = useState(() => (initial.results?.length ? initial.results : [BLANK_RESULT]));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const setOrderField = (k) => (e) => setOrder((o) => ({ ...o, [k]: e.target.value }));
  const setRow = (i, k) => (e) => setResults((rs) => {
    const next = rs.slice();
    const v = e.target.value;
    // Numeric fields are strings in the input; store null when empty.
    const numeric = k === "valueNum" || k === "referenceLow" || k === "referenceHigh";
    next[i] = { ...next[i], [k]: numeric ? (v === "" ? null : Number(v)) : v };
    return next;
  });
  const addRow = () => setResults((rs) => [...rs, { ...BLANK_RESULT }]);
  const removeRow = (i) => setResults((rs) => rs.filter((_, idx) => idx !== i));

  async function save() {
    setSaving(true); setError("");
    try {
      const body = {
        order,
        results: results.filter((r) => (r.testName || "").trim() !== ""),
        pdfBase64: initial.pdfBase64,
        pdfName: initial.pdfName,
      };
      await api(`/api/doctor/patients/${encodeURIComponent(patientId)}/labs`, {
        method: "POST", body,
      });
      onSaved();
    } catch (e) {
      setError(e.message || "The lab report could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-5">
      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}
      <p className="text-[11px] text-slate-500 mb-3">
        Review the extracted rows below. Values, ranges and flags come from the PDF via the model -
        correct anything wrong before saving. Reference ranges and flags are stored as shown; the
        application does not compute them.
      </p>

      <h4 className="text-xs uppercase tracking-wide text-slate-400 mb-2">Order</h4>
      <div className="grid grid-cols-3 gap-2 mb-4">
        <label className="block"><span className={lbl}>Panel</span><input className={input} value={order.panelName} onChange={setOrderField("panelName")} /></label>
        <label className="block"><span className={lbl}>Category</span><input className={input} value={order.category} onChange={setOrderField("category")} /></label>
        <label className="block"><span className={lbl}>Status</span>
          <select className={input} value={order.status} onChange={setOrderField("status")}>
            {LAB_STATUSES.map((s) => <option key={s || "empty"} value={s}>{s || "—"}</option>)}
          </select>
        </label>
        <label className="block"><span className={lbl}>Ordering provider</span><input className={input} value={order.orderingProvider} onChange={setOrderField("orderingProvider")} /></label>
        <label className="block"><span className={lbl}>Lab</span><input className={input} value={order.labName} onChange={setOrderField("labName")} /></label>
        <label className="block"><span className={lbl}>Accession</span><input className={input} value={order.accession} onChange={setOrderField("accession")} /></label>
        <label className="block"><span className={lbl}>Ordered</span><input type="date" className={input} value={order.orderedAt} onChange={setOrderField("orderedAt")} /></label>
        <label className="block"><span className={lbl}>Collected</span><input type="date" className={input} value={order.collectedAt} onChange={setOrderField("collectedAt")} /></label>
        <label className="block"><span className={lbl}>Resulted</span><input type="date" className={input} value={order.resultedAt} onChange={setOrderField("resultedAt")} /></label>
        <label className="block col-span-3"><span className={lbl}>Comments</span><textarea className={`${input} h-16 resize-none`} value={order.comments} onChange={setOrderField("comments")} /></label>
      </div>

      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs uppercase tracking-wide text-slate-400">Results ({results.length})</h4>
        <button onClick={addRow} className={plain}><Plus size={12} /> Add row</button>
      </div>
      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-2 py-1.5 font-medium min-w-[10rem]">Test</th>
              <th className="text-left px-2 py-1.5 font-medium">Value</th>
              <th className="text-left px-2 py-1.5 font-medium">Numeric</th>
              <th className="text-left px-2 py-1.5 font-medium">Unit</th>
              <th className="text-left px-2 py-1.5 font-medium">Low</th>
              <th className="text-left px-2 py-1.5 font-medium">High</th>
              <th className="text-left px-2 py-1.5 font-medium">Range text</th>
              <th className="text-left px-2 py-1.5 font-medium">Flag</th>
              <th className="px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="px-1 py-1"><input className={input} value={r.testName || ""} onChange={setRow(i, "testName")} /></td>
                <td className="px-1 py-1"><input className={input} value={r.valueText || ""} onChange={setRow(i, "valueText")} /></td>
                <td className="px-1 py-1"><input className={input} type="number" step="any" value={r.valueNum ?? ""} onChange={setRow(i, "valueNum")} /></td>
                <td className="px-1 py-1"><input className={input} value={r.unit || ""} onChange={setRow(i, "unit")} /></td>
                <td className="px-1 py-1"><input className={input} type="number" step="any" value={r.referenceLow ?? ""} onChange={setRow(i, "referenceLow")} /></td>
                <td className="px-1 py-1"><input className={input} type="number" step="any" value={r.referenceHigh ?? ""} onChange={setRow(i, "referenceHigh")} /></td>
                <td className="px-1 py-1"><input className={input} value={r.referenceText || ""} onChange={setRow(i, "referenceText")} /></td>
                <td className="px-1 py-1">
                  <select className={input} value={r.flag || ""} onChange={setRow(i, "flag")}>
                    {LAB_FLAGS.map((f) => <option key={f || "empty"} value={f}>{f || "—"}</option>)}
                  </select>
                </td>
                <td className="px-1 py-1 text-right">
                  <button onClick={() => removeRow(i)} className="text-slate-400 hover:text-rose-600"><Trash2 size={12} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onCancel} className={plain}>Cancel</button>
        <button onClick={save} disabled={saving} className={primary}>
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          {saving ? "Saving…" : "Save lab report"}
        </button>
      </div>
    </div>
  );
}

function NewRxDialog({ patient, onClose, onCreated }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    medication: "", strength: "", dose: "", route: "Oral", frequency: "",
    quantity: "", daysSupply: "", refills: "0", startDate: today, sig: "", notes: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    if (!form.medication.trim()) { setError("A medication is required."); return; }
    setBusy(true); setError("");
    try {
      const body = {
        medication: form.medication.trim(),
        strength: form.strength.trim(),
        dose: form.dose.trim(),
        route: form.route,
        frequency: form.frequency.trim(),
        quantity: form.quantity ? Number(form.quantity) : 0,
        daysSupply: form.daysSupply ? Number(form.daysSupply) : 0,
        refills: form.refills ? Number(form.refills) : 0,
        startDate: form.startDate,
        sig: form.sig.trim(),
        notes: form.notes.trim(),
      };
      await api(`/api/rx/patients/${encodeURIComponent(patient.id)}/prescriptions`,
        { method: "POST", body });
      onCreated();
    } catch (e) {
      setError(e.message || "The prescription could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg my-8">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h3 className="font-semibold text-slate-800">New prescription</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="p-5">
          {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}
          <p className="text-[11px] text-slate-400 mb-3">
            Starts as a DRAFT. Signing and sending are separate actions with their own permissions.
            The application has no drug database - it accepts whatever is typed.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block col-span-2"><span className={lbl}>Medication</span>
              <input className={input} value={form.medication} onChange={set("medication")} placeholder="e.g. Amoxicillin" />
            </label>
            <label className="block"><span className={lbl}>Strength</span>
              <input className={input} value={form.strength} onChange={set("strength")} placeholder="e.g. 500 mg" />
            </label>
            <label className="block"><span className={lbl}>Dose</span>
              <input className={input} value={form.dose} onChange={set("dose")} placeholder="e.g. 1 capsule" />
            </label>
            <label className="block"><span className={lbl}>Route</span>
              <select className={input} value={form.route} onChange={set("route")}>
                {RX_ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label className="block"><span className={lbl}>Frequency</span>
              <input className={input} value={form.frequency} onChange={set("frequency")} placeholder="e.g. every 8 h" />
            </label>
            <label className="block"><span className={lbl}>Quantity</span>
              <input type="number" min="0" className={input} value={form.quantity} onChange={set("quantity")} />
            </label>
            <label className="block"><span className={lbl}>Days supply</span>
              <input type="number" min="0" className={input} value={form.daysSupply} onChange={set("daysSupply")} />
            </label>
            <label className="block"><span className={lbl}>Refills</span>
              <input type="number" min="0" className={input} value={form.refills} onChange={set("refills")} />
            </label>
            <label className="block"><span className={lbl}>Start date</span>
              <input type="date" className={input} value={form.startDate} onChange={set("startDate")} />
            </label>
            <label className="block col-span-2"><span className={lbl}>SIG (patient instructions)</span>
              <textarea className={`${input} h-16 resize-none`} value={form.sig} onChange={set("sig")}
                placeholder="e.g. Take 1 capsule by mouth every 8 hours for 7 days" />
            </label>
            <label className="block col-span-2"><span className={lbl}>Notes</span>
              <textarea className={`${input} h-16 resize-none`} value={form.notes} onChange={set("notes")} />
            </label>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button onClick={onClose} className={plain}>Cancel</button>
          <button onClick={submit} disabled={busy || !form.medication.trim()} className={primary}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {busy ? "Saving…" : "Create draft"}
          </button>
        </div>
      </div>
    </div>
  );
}
