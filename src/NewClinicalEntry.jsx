// "New encounter" / "New review" dialogs used by the HIM and Antimicrobial screens.
//
// The two backends were already there and gated - the screens just had no way to create work.
// These forms call the same endpoints (POST /api/him/worklist, POST /api/clinical/antimicrobial)
// with the fields the server accepts, and let the server validate and audit.

import { useEffect, useState } from "react";
import { X, Loader2, Save, Search } from "lucide-react";
import { lookupPatients, createHimEncounter, createAmReview } from "./clinicalService";

const input = "w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm";
const lbl = "block text-[11px] uppercase tracking-wide text-slate-400 mb-1";
const btn = "text-xs rounded-lg px-3 py-2 flex items-center gap-1.5";
const primary = `${btn} bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-40`;
const plain = `${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`;

// Small typeahead against the narrow patient lookup. Returns { id, name, mrn, dob } on select.
// Exported so the Lab and Rx workspaces reuse the same picker instead of duplicating it.
export function PatientPicker({ value, onChange }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!open) return undefined;
    setBusy(true);
    const t = setTimeout(() => {
      lookupPatients(q)
        .then((r) => { if (alive) { setList(r.patients || []); setBusy(false); } })
        .catch(() => { if (alive) { setList([]); setBusy(false); } });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [q, open]);

  if (value) {
    return (
      <div className="flex items-center gap-2 border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-slate-800 truncate">{value.name}</div>
          <div className="text-[11px] text-slate-500">{value.id}{value.dob ? " · DOB " + value.dob : ""}</div>
        </div>
        <button type="button" onClick={() => onChange(null)} className="text-slate-400 hover:text-rose-600">
          <X size={13} />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
      <input className={`${input} pl-8`} value={q}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search patient by name or ID" />
      {open && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
          {busy && <div className="text-xs text-slate-400 px-3 py-2">Searching…</div>}
          {!busy && list.length === 0 && (
            <div className="text-xs text-slate-400 px-3 py-2">{q ? "No matches" : "Start typing to search"}</div>
          )}
          {list.map((p) => (
            <button key={p.id} type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange(p); setQ(""); setOpen(false); }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-sm">
              <div className="font-medium text-slate-800">{p.name}</div>
              <div className="text-[11px] text-slate-500">{p.id}{p.dob ? " · DOB " + p.dob : ""}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Dialog({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg my-8">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h3 className="font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

const ENCOUNTER_TYPES = ["Office Visit", "Inpatient", "Outpatient", "Emergency", "Telehealth", "Procedure"];
const PRIORITIES = [
  { code: "ROUTINE", label: "Routine" },
  { code: "HIGH", label: "High" },
  { code: "STAT", label: "Stat" },
];
const ROUTES = ["Oral", "IV", "IM", "Topical", "Inhaled", "Other"];

export function NewHimEncounter({ onClose, onCreated }) {
  const today = new Date().toISOString().slice(0, 10);
  const [patient, setPatient] = useState(null);
  const [form, setForm] = useState({
    dos: today, encounterType: "Office Visit", provider: "", payer: "", location: "", priority: "ROUTINE",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    if (!patient) { setError("Choose a patient."); return; }
    setBusy(true); setError("");
    try {
      const res = await createHimEncounter({ patientId: patient.id, ...form });
      onCreated?.(res);
      onClose();
    } catch (e) {
      setError(e.message || "The encounter could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New coding encounter" onClose={onClose}>
      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}
      <label className="block mb-3">
        <span className={lbl}>Patient</span>
        <PatientPicker value={patient} onChange={setPatient} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className={lbl}>Date of service</span>
          <input type="date" className={input} value={form.dos} onChange={set("dos")} />
        </label>
        <label className="block"><span className={lbl}>Encounter type</span>
          <select className={input} value={form.encounterType} onChange={set("encounterType")}>
            {ENCOUNTER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="block"><span className={lbl}>Provider</span>
          <input className={input} value={form.provider} onChange={set("provider")} placeholder="Rendering physician" />
        </label>
        <label className="block"><span className={lbl}>Payer</span>
          <input className={input} value={form.payer} onChange={set("payer")} placeholder="Optional" />
        </label>
        <label className="block"><span className={lbl}>Location</span>
          <input className={input} value={form.location} onChange={set("location")} placeholder="Optional" />
        </label>
        <label className="block"><span className={lbl}>Priority</span>
          <select className={input} value={form.priority} onChange={set("priority")}>
            {PRIORITIES.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
          </select>
        </label>
      </div>
      <p className="text-[11px] text-slate-400 mt-3">
        The encounter starts in "Ready for coding". Add diagnoses and procedures from the worklist entry.
      </p>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className={plain}>Cancel</button>
        <button onClick={submit} disabled={busy || !patient} className={primary}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          {busy ? "Creating…" : "Create encounter"}
        </button>
      </div>
    </Dialog>
  );
}

export function NewAmReview({ onClose, onCreated }) {
  const today = new Date().toISOString().slice(0, 10);
  const [patient, setPatient] = useState(null);
  const [form, setForm] = useState({
    antimicrobial: "", dose: "", route: "Oral", frequency: "",
    startDate: today, stopDate: "", indication: "", priority: "ROUTINE",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    if (!patient) { setError("Choose a patient."); return; }
    if (!form.antimicrobial.trim()) { setError("Enter the antimicrobial."); return; }
    setBusy(true); setError("");
    try {
      const res = await createAmReview({ patientId: patient.id, ...form });
      onCreated?.(res);
      onClose();
    } catch (e) {
      setError(e.message || "The review could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New antimicrobial review" onClose={onClose}>
      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}
      <label className="block mb-3">
        <span className={lbl}>Patient</span>
        <PatientPicker value={patient} onChange={setPatient} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className={lbl}>Antimicrobial</span>
          <input className={input} value={form.antimicrobial} onChange={set("antimicrobial")} placeholder="e.g. Ceftriaxone" />
        </label>
        <label className="block"><span className={lbl}>Dose</span>
          <input className={input} value={form.dose} onChange={set("dose")} placeholder="e.g. 1 g" />
        </label>
        <label className="block"><span className={lbl}>Route</span>
          <select className={input} value={form.route} onChange={set("route")}>
            {ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="block"><span className={lbl}>Frequency</span>
          <input className={input} value={form.frequency} onChange={set("frequency")} placeholder="e.g. every 24 h" />
        </label>
        <label className="block"><span className={lbl}>Start date</span>
          <input type="date" className={input} value={form.startDate} onChange={set("startDate")} />
        </label>
        <label className="block"><span className={lbl}>Planned stop date</span>
          <input type="date" className={input} value={form.stopDate} onChange={set("stopDate")} />
        </label>
        <label className="block col-span-2"><span className={lbl}>Indication</span>
          <input className={input} value={form.indication} onChange={set("indication")} placeholder="Reason for therapy" />
        </label>
        <label className="block"><span className={lbl}>Priority</span>
          <select className={input} value={form.priority} onChange={set("priority")}>
            {PRIORITIES.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
          </select>
        </label>
      </div>
      <p className="text-[11px] text-slate-400 mt-3">
        Starts in "Pending review". Add day-2 or completion reviews from the entry once it is open.
      </p>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className={plain}>Cancel</button>
        <button onClick={submit} disabled={busy || !patient} className={primary}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          {busy ? "Creating…" : "Create review"}
        </button>
      </div>
    </Dialog>
  );
}
