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
import { FlaskConical, Pill, Search, Plus, X, Loader2, RefreshCw, Save, ExternalLink, ChevronDown, ChevronRight } from "lucide-react";
import { api } from "./firebase/apiClient";
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
  const may = (p) => (permissions || []).includes(p);

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
        <button onClick={() => setReloadKey((n) => n + 1)} className={plain}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>
      <PatientHeader patient={patient} onClear={() => { setPatient(null); setData(null); }} />

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
