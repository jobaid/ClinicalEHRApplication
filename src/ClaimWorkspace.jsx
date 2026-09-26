// The claim workspace: an organised claim page, server-side validation, the claim summary print,
// and the actions that lead to HCFA printing and electronic submission.
//
// Added alongside the existing claim screens. The Claims list, Edit Claim, the billing ledger and
// every payment action are untouched - this is a place to review and complete a claim before it
// leaves the practice, not a replacement for any of them.
//
// Two things it deliberately does NOT do.
//
// It does not recalculate money. The total comes from the server, which sums the stored charge
// rows, so the figure a biller approves is the figure that would be submitted.
//
// It does not edit patient demographics or insurance policies. Those live on the patient's own
// records and are shown here read-only, with a note saying where to change them. Section 3 is
// explicit that existing insurance history must not be overwritten, and the surest way to honour
// that is for this screen to have no way of writing to it.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  X, CheckCircle2, AlertCircle, AlertTriangle, Printer, Send, Save, FileText,
  ChevronDown, Loader2, History, Crosshair, Info,
} from "lucide-react";
import Cms1500Modal from "./Cms1500";
import {
  getClaimConfig, getClaim, validateClaim, submitClaim, getClaimHistory, recordPrintEvent,
  getPrintProfiles, savePrintProfile,
  money, shortDate, stamp, POINTER_LETTERS, PLACE_OF_SERVICE, groupProblems, CLAIM_SECTIONS,
  sectionAnchor, normalizeDx, DX_SLOTS,
} from "./claimService";

const card = "bg-white border border-slate-200 rounded-xl";
const input = "w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm";
const lbl = "block text-[11px] uppercase tracking-wide text-slate-400 mb-1";
const btn = "text-xs rounded-lg px-3 py-2 flex items-center gap-1.5 whitespace-nowrap";

// ---------- read-only display helpers ----------

function Row({ label, value, missing }) {
  const empty = !String(value ?? "").trim();
  return (
    <div>
      <span className={lbl}>{label}</span>
      <div className={`text-sm ${empty ? "text-rose-500" : "text-slate-800"}`}>
        {empty ? (missing || "Not recorded") : value}
      </div>
    </div>
  );
}

function Section({ id, title, note, children, action }) {
  return (
    <section id={`claim-${id}`} className={`${card} p-4 mb-3 scroll-mt-4`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        {action}
      </div>
      {note && <p className="text-[11px] text-slate-400 mb-3">{note}</p>}
      {children}
    </section>
  );
}

// ---------- the printable claim summary (section 17) ----------

const SUMMARY_CSS = `
@media print {
  body * { visibility: hidden !important; }
  .claim-summary-sheet, .claim-summary-sheet * { visibility: visible !important; }
  .claim-summary-sheet { position: absolute !important; left: 0 !important; top: 0 !important;
                         width: 100% !important; padding: 0.5in !important; }
}`;

/**
 * The normal claim print: a clean summary a person reads, kept entirely separate from the
 * CMS-1500 printout, which is a form a machine reads.
 */
export function ClaimSummarySheet({ claim, data, practice }) {
  return (
    <div className="claim-summary-sheet bg-white text-slate-900" style={{ fontSize: "11pt" }}>
      <div className="text-center mb-5">
        <div className="font-bold text-lg">{practice?.name || "Practice"}</div>
        {practice?.address && <div className="text-xs">{practice.address}</div>}
        <div className="mt-3 font-semibold tracking-wide">CLAIM SUMMARY</div>
        <div className="text-xs">Claim {claim?.id} · printed {new Date().toLocaleDateString()}</div>
      </div>

      <div className="grid grid-cols-2 gap-5 mb-5">
        <div>
          <div className="font-semibold border-b border-slate-400 mb-1.5 pb-0.5 text-xs uppercase">Patient</div>
          <div className="text-sm leading-6">
            <div>{data.patient.name || "—"}</div>
            <div>DOB {shortDate(data.patient.dob)}</div>
            <div>MRN {data.patientId || "—"}</div>
            <div>{[data.patient.address, data.patient.city, data.patient.state, data.patient.zip]
              .filter(Boolean).join(", ") || "—"}</div>
          </div>
        </div>
        <div>
          <div className="font-semibold border-b border-slate-400 mb-1.5 pb-0.5 text-xs uppercase">Insurance</div>
          <div className="text-sm leading-6">
            <div>{data.insurance.payer || "—"}</div>
            <div>Member ID {data.insurance.memberId || "—"}</div>
            <div>Group {data.insurance.groupNumber || "—"}</div>
            <div>Subscriber {data.insurance.subscriber || "—"}</div>
          </div>
        </div>
        <div>
          <div className="font-semibold border-b border-slate-400 mb-1.5 pb-0.5 text-xs uppercase">Provider</div>
          <div className="text-sm leading-6">
            <div>{data.provider.rendering || "—"}</div>
            <div>NPI {data.provider.npi || "—"}</div>
            <div>Tax ID {data.provider.taxId || "—"}</div>
            {data.provider.referring && <div>Referring {data.provider.referring}</div>}
          </div>
        </div>
        <div>
          <div className="font-semibold border-b border-slate-400 mb-1.5 pb-0.5 text-xs uppercase">Service facility</div>
          <div className="text-sm leading-6">
            <div>{data.provider.facilityName || "—"}</div>
            <div>{data.provider.facilityAddress || "—"}</div>
          </div>
        </div>
      </div>

      <div className="font-semibold border-b border-slate-400 mb-1.5 pb-0.5 text-xs uppercase">Diagnosis</div>
      <div className="text-sm mb-5 leading-6">
        {data.diagnosisCodes.length === 0
          ? "None recorded"
          : data.diagnosisCodes.map((d, i) => (
            <span key={i} className="inline-block mr-4">{POINTER_LETTERS[i]}. {d}</span>
          ))}
      </div>

      <div className="font-semibold border-b border-slate-400 mb-1.5 pb-0.5 text-xs uppercase">Services</div>
      <table className="w-full text-sm mb-4" style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr className="text-left border-b border-slate-300">
            <th className="py-1 pr-2 font-medium">DOS</th>
            <th className="py-1 pr-2 font-medium">CPT</th>
            <th className="py-1 pr-2 font-medium">Mod</th>
            <th className="py-1 pr-2 font-medium">POS</th>
            <th className="py-1 pr-2 font-medium">Dx</th>
            <th className="py-1 pr-2 font-medium text-right">Units</th>
            <th className="py-1 font-medium text-right">Charge</th>
          </tr>
        </thead>
        <tbody>
          {data.serviceLines.map((l) => (
            <tr key={l.lineNo} className="border-b border-slate-100">
              <td className="py-1 pr-2">{shortDate(l.dos)}</td>
              <td className="py-1 pr-2">{l.cpt}</td>
              <td className="py-1 pr-2">{l.modifiers || "—"}</td>
              <td className="py-1 pr-2">{l.placeOfService}</td>
              <td className="py-1 pr-2">{l.diagnosisPointer || "—"}</td>
              <td className="py-1 pr-2 text-right">{l.units}</td>
              <td className="py-1 text-right">{money(l.charge)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="text-right font-semibold">
        Total Charges: {money(data.totalCharges)}
      </div>
    </div>
  );
}

// ---------- the workspace ----------

export default function ClaimWorkspace({
  claim, patient, policies, charges, practice, permissions,
  onClose, onSaveCharge, onSaveClaimFields,
}) {
  const perms = useMemo(() => new Set(permissions || []), [permissions]);
  const may = useCallback((p) => perms.has(p), [perms]);

  const [data, setData] = useState(null);          // the server's assembly of this claim
  const [config, setConfig] = useState(null);
  const [history, setHistory] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");

  const [validation, setValidation] = useState(null);
  const [submitError, setSubmitError] = useState("");
  const [printMenu, setPrintMenu] = useState(false);
  const [hcfaMode, setHcfaMode] = useState(null);  // null | "preprinted" | "withform"
  const [showSummary, setShowSummary] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);

  // Local edits are held as an OVERRIDE over the server's assembly rather than as a copy of it.
  // The effective draft is then derived during render, so a re-render can never clobber what a
  // biller is halfway through typing, and "dirty" is simply whether an override exists.
  const [override, setOverride] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [alignment, setAlignment] = useState(null);

  // Reloading is a bump of this counter rather than a callback, which keeps the fetch inside the
  // effect where it belongs and lets the cleanup drop a response that arrived after a close.
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [d, h] = await Promise.all([getClaim(claim.id), getClaimHistory(claim.id)]);
        if (!alive) return;
        setData(d);
        setHistory(h.history || []);
        setLoadError("");
      } catch (e) {
        if (alive) setLoadError(e.message || "The claim could not be loaded.");
      }
    })();
    return () => { alive = false; };
  }, [claim.id, reloadKey]);

  useEffect(() => {
    getClaimConfig().then(setConfig).catch(() => setConfig(null));
    // The saved offsets for this user's printer. A failure here is not worth reporting: the modal
    // falls back to local storage and then to zero offsets, both of which still print.
    getPrintProfiles().then((r) => {
      const def = (r.profiles || []).find((p) => p.isDefault) || (r.profiles || [])[0];
      if (def) setAlignment({ x: Number(def.offsetX) || 0, y: Number(def.offsetY) || 0 });
    }).catch(() => {});
  }, []);

  // What the server says the claim is. Recomputed only when a fresh assembly arrives.
  const baseDraft = useMemo(() => {
    if (!data) return null;
    return {
      diagnosisCodes: normalizeDx(data.diagnosisCodes),
      lines: data.serviceLines.map((l) => ({
        lineNo: l.lineNo, cpt: l.cpt, dos: l.dos,
        modifiers: l.modifiers || "", placeOfService: l.placeOfService || "11",
        diagnosisPointer: l.diagnosisPointer || "", units: String(l.units || 1),
        charge: l.charge, provider: l.provider, renderingNpi: l.renderingNpi,
      })),
      referring: data.provider.referring || "",
      taxId: data.provider.taxId || "",
      npi: data.provider.npi || "",
      facilityName: data.provider.facilityName || "",
      facilityAddress: data.provider.facilityAddress || "",
    };
  }, [data]);

  const draft = override || baseDraft;
  const dirty = override !== null;

  // The charge rows behind this claim, in the same order the server used, so an edit to line 2
  // writes to the charge the server called line 2.
  const lineCharges = useMemo(() => {
    if (!data) return [];
    const anchor = (charges || []).find((c) => c.id === claim.chargeId);
    const dos = anchor?.dos;
    return (charges || [])
      .filter((c) => c.patientId === data.patientId && c.dos === dos)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }, [charges, claim.chargeId, data]);

  const anchorCharge = lineCharges[0] || (charges || []).find((c) => c.id === claim.chargeId);
  const policy = useMemo(
    () => (policies || []).find((p) => p.id === anchorCharge?.chargeInsuranceId) || (policies || [])[0],
    [policies, anchorCharge]);

  const dxEntered = useMemo(
    () => (draft?.diagnosisCodes || []).filter((d) => String(d).trim()).length, [draft]);

  // Every edit starts from the override if there is one, otherwise from the server's assembly.
  const edit = (fn) => setOverride((prev) => fn(prev || baseDraft));

  const setDraftField = (k, v) => edit((d) => ({ ...d, [k]: v }));

  const setLine = (i, k, v) => edit((d) => {
    const lines = d.lines.slice();
    lines[i] = { ...lines[i], [k]: v };
    return { ...d, lines };
  });

  const setDx = (i, v) => edit((d) => {
    const codes = d.diagnosisCodes.slice();
    codes[i] = v.toUpperCase();
    return { ...d, diagnosisCodes: codes };
  });

  // ---------- saving ----------

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy("save");
    try {
      // The diagnosis codes and the billing identifiers belong to the anchor charge; the per-line
      // fields belong to each line's own charge. Nothing else on the charge is written, so the
      // amount, what has been paid, the write-offs and the postings cannot be touched from here.
      if (anchorCharge) {
        await onSaveCharge(anchorCharge.id, {
          diagnosisCodes: draft.diagnosisCodes,
          referralPhysician: draft.referring,
          taxId: draft.taxId,
          npi: draft.npi,
          facilityName: draft.facilityName,
          facilityAddress: draft.facilityAddress,
        });
      }
      for (let i = 0; i < draft.lines.length; i++) {
        const target = lineCharges[i];
        if (!target) continue;
        await onSaveCharge(target.id, {
          modifiers: draft.lines[i].modifiers,
          placeOfService: draft.lines[i].placeOfService,
          diagnosisPointer: draft.lines[i].diagnosisPointer,
          units: Number(draft.lines[i].units) || 1,
        });
      }
      setOverride(null);
      load();
      return true;
    } catch (e) {
      setSubmitError(e.message || "The claim could not be saved.");
      return false;
    } finally {
      setBusy("");
    }
  }, [draft, anchorCharge, lineCharges, onSaveCharge, load]);

  // ---------- actions, each guarded by the unsaved-changes check (section 29) ----------

  const guarded = (fn) => () => {
    setPrintMenu(false);
    if (dirty) { setPendingAction(() => fn); return; }
    fn();
  };

  const runValidate = useCallback(async () => {
    setBusy("validate");
    setSubmitError("");
    try {
      const res = await validateClaim(claim.id);
      setValidation(res);
      if (res.status) onSaveClaimFields?.(claim.id, { status: res.status });
      setHistory((await getClaimHistory(claim.id)).history || []);
    } catch (e) {
      setSubmitError(e.message || "Validation could not be completed.");
    } finally {
      setBusy("");
    }
  }, [claim.id, onSaveClaimFields]);

  const runSubmit = useCallback(async () => {
    setBusy("submit");
    setSubmitError("");
    try {
      const res = await submitClaim(claim.id);
      // Reached only when a clearinghouse actually answered. The status shown is the one it gave.
      onSaveClaimFields?.(claim.id, { status: res.status, submitted: new Date().toISOString().slice(0, 10) });
      load();
    } catch (e) {
      // The server's own explanation, verbatim. Nothing is invented and nothing is softened.
      setSubmitError(e.message || "The claim could not be submitted.");
      try { setValidation(await validateClaim(claim.id)); } catch { /* the error above is enough */ }
      setHistory((await getClaimHistory(claim.id).catch(() => ({ history }))).history || history);
    } finally {
      setBusy("");
    }
  }, [claim.id, onSaveClaimFields, load, history]);

  const openHcfa = useCallback(async (mode = "preprinted") => {
    setHcfaMode(mode);
    // Recorded as a preview, because that is all that has happened so far - the print events are
    // recorded by the modal when the biller actually prints.
    try { await recordPrintEvent(claim.id, "HCFA Previewed"); } catch { /* preview still opens */ }
  }, [claim.id]);

  const printSummary = useCallback(async () => {
    setShowSummary(true);
    try { await recordPrintEvent(claim.id, "Claim Summary Printed"); } catch { /* still prints */ }
    // Let the sheet mount before handing the page to the print dialog.
    setTimeout(() => window.print(), 80);
  }, [claim.id]);

  useEffect(() => {
    if (!showSummary) return;
    const style = document.createElement("style");
    style.textContent = SUMMARY_CSS;
    document.head.appendChild(style);
    const after = () => setShowSummary(false);
    window.addEventListener("afterprint", after);
    return () => { style.remove(); window.removeEventListener("afterprint", after); };
  }, [showSummary]);

  // ---------- derived display ----------

  const problems = useMemo(() => validation?.problems || [], [validation]);
  const blocking = problems.filter((p) => p.blocking);
  const advisory = problems.filter((p) => !p.blocking);
  const grouped = useMemo(() => groupProblems(problems), [problems]);

  // A rejection is shown with whatever the payer or clearinghouse actually returned. If the
  // response text is empty, that is what it says - no reason is invented (section 23).
  const rejection = useMemo(() => {
    if (claim.status !== "Rejected" && claim.status !== "Denied") return null;
    const evt = history.slice().reverse().find((h) => h.responseText || h.responseCode);
    return { code: evt?.responseCode || "", text: evt?.responseText || "" };
  }, [claim.status, history]);

  const jump = (id) => {
    document.getElementById(`claim-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (loadError) {
    return (
      <div className={`${card} p-6`}>
        <div className="flex items-start gap-2 text-sm text-rose-700">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">This claim could not be opened.</p>
            <p className="text-xs mt-1 text-rose-600">{loadError}</p>
          </div>
        </div>
        <button onClick={onClose} className={`${btn} mt-4 border border-slate-200 text-slate-600`}>Back to claims</button>
      </div>
    );
  }

  if (!data || !draft) {
    return (
      <div className={`${card} p-10 flex items-center justify-center gap-2 text-sm text-slate-500`}>
        <Loader2 size={16} className="animate-spin" /> Loading the claim…
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-4 print:hidden">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-slate-800">Claim {claim.id}</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{claim.status || "Draft"}</span>
          </div>
          <p className="text-sm text-slate-500 mt-0.5">
            {data.patient.name} · {shortDate(draft.lines[0]?.dos)} · {data.insurance.payer || "No payer recorded"}
          </p>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1"><X size={18} /></button>
      </div>

      {rejection && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 mb-3 print:hidden">
          <div className="flex items-center gap-2 font-semibold text-rose-800 text-sm mb-1">
            <AlertCircle size={15} /> Claim {claim.status}
          </div>
          {rejection.text || rejection.code ? (
            <p className="text-xs text-rose-700">
              {rejection.code && <span className="font-mono mr-2">{rejection.code}</span>}{rejection.text}
            </p>
          ) : (
            <p className="text-xs text-rose-700">
              No rejection detail was returned with this status, so none is shown. Check the payer
              portal or remittance for the reason.
            </p>
          )}
        </div>
      )}

      <div className="flex gap-4">
        {/* Section nav */}
        <nav className="hidden xl:block w-44 shrink-0 print:hidden">
          <div className="sticky top-4">
            {CLAIM_SECTIONS.map((s) => {
              const count = problems.filter((p) => sectionAnchor(p.section) === s.id && p.blocking).length;
              return (
                <button key={s.id} onClick={() => jump(s.id)}
                  className="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-100 text-slate-600 flex items-center justify-between">
                  <span>{s.label}</span>
                  {count > 0 && <span className="bg-rose-100 text-rose-700 rounded-full px-1.5 text-[10px]">{count}</span>}
                </button>
              );
            })}
          </div>
        </nav>

        <div className="flex-1 min-w-0">
          {/* Patient — read-only, from the patient record (section 2) */}
          <Section id="patient" title="Patient Information"
            note="From the patient's demographic record. Change it on the patient's Demographics tab; a claim never creates or edits a patient.">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Row label="Name" value={data.patient.name} />
              <Row label="Date of birth" value={shortDate(data.patient.dob) === "—" ? "" : shortDate(data.patient.dob)} />
              <Row label="Sex" value={data.patient.sex} />
              <Row label="MRN" value={data.patientId} />
              <Row label="Address" value={data.patient.address} />
              <Row label="City" value={data.patient.city} />
              <Row label="State" value={data.patient.state} />
              <Row label="ZIP" value={data.patient.zip} />
            </div>
          </Section>

          {/* Insurance — read-only, from the policy record (section 3) */}
          <Section id="insurance" title="Insurance Information"
            note="From the policy this charge is assigned to. Insurance is added and versioned on the patient's Insurance tab — nothing here overwrites a previous policy.">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Row label="Insurance" value={data.insurance.payer} />
              <Row label="Member ID" value={data.insurance.memberId} />
              <Row label="Group number" value={data.insurance.groupNumber} />
              <Row label="Subscriber" value={data.insurance.subscriber} />
              <Row label="Relationship" value={data.insurance.relationship} />
              <Row label="Subscriber DOB"
                value={shortDate(data.insurance.subscriberDob) === "—" ? "" : shortDate(data.insurance.subscriberDob)} />
            </div>
          </Section>

          {/* Provider — editable, these live on the charge */}
          <Section id="provider" title="Provider Information">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Row label="Rendering provider" value={data.provider.rendering} />
              <div>
                <span className={lbl}>Billing NPI</span>
                <input className={input} value={draft.npi} onChange={(e) => setDraftField("npi", e.target.value)} />
              </div>
              <div>
                <span className={lbl}>Federal Tax ID</span>
                <input className={input} value={draft.taxId} onChange={(e) => setDraftField("taxId", e.target.value)} />
              </div>
              <div className="md:col-span-3">
                <span className={lbl}>Referring provider</span>
                <input className={input} value={draft.referring}
                  onChange={(e) => setDraftField("referring", e.target.value)} placeholder="Optional" />
              </div>
            </div>
            <p className="text-[11px] text-slate-400 mt-2">
              The rendering provider is set on the charge itself — use Edit Claim from the ledger to change it.
            </p>
          </Section>

          {/* Claim information */}
          <Section id="claim" title="Claim Information">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Row label="Claim ID" value={claim.id} />
              <Row label="Status" value={claim.status || "Draft"} />
              <Row label="Date of service" value={shortDate(draft.lines[0]?.dos)} />
              <Row label="Submitted" value={claim.submitted ? shortDate(claim.submitted) : ""} missing="Not submitted" />
            </div>
          </Section>

          {/* Diagnosis (section 4) */}
          <Section id="diagnosis" title="Diagnosis"
            note="ICD-10 codes as entered on the charge. Codes are never suggested or completed for you — pointers A–L below refer to these slots in order.">
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
              {draft.diagnosisCodes.map((code, i) => (
                <div key={i}>
                  <span className={lbl}>{POINTER_LETTERS[i]}</span>
                  <input className={`${input} text-center font-mono`} value={code}
                    onChange={(e) => setDx(i, e.target.value)} placeholder="—" />
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-2">{dxEntered} of {DX_SLOTS} slots used.</p>
          </Section>

          {/* Service lines (section 5) */}
          <Section id="procedures" title="Procedures / CPT"
            note="One row per charge on this date of service. The CPT code and the amount are set on the charge itself — use Recode from the ledger to change what is billed.">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 border-b border-slate-200">
                    <th className="py-2 pr-2 font-medium">DOS</th>
                    <th className="py-2 pr-2 font-medium">CPT</th>
                    <th className="py-2 pr-2 font-medium">Modifier</th>
                    <th className="py-2 pr-2 font-medium">Place of service</th>
                    <th className="py-2 pr-2 font-medium">Dx pointer</th>
                    <th className="py-2 pr-2 font-medium">Units</th>
                    <th className="py-2 pr-2 font-medium text-right">Charge</th>
                    <th className="py-2 font-medium">Provider</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.lines.map((l, i) => (
                    <tr key={l.lineNo} className="border-b border-slate-100 last:border-0">
                      <td className="py-2 pr-2 whitespace-nowrap text-slate-600">{shortDate(l.dos)}</td>
                      <td className="py-2 pr-2 font-mono text-slate-800">{l.cpt}</td>
                      <td className="py-2 pr-2">
                        <input className={`${input} w-20 font-mono`} value={l.modifiers}
                          onChange={(e) => setLine(i, "modifiers", e.target.value.toUpperCase())} placeholder="—" />
                      </td>
                      <td className="py-2 pr-2">
                        <select className={`${input} w-40`} value={l.placeOfService}
                          onChange={(e) => setLine(i, "placeOfService", e.target.value)}>
                          {PLACE_OF_SERVICE.some((p) => p.code === l.placeOfService)
                            ? null : <option value={l.placeOfService}>{l.placeOfService}</option>}
                          {PLACE_OF_SERVICE.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
                        </select>
                      </td>
                      <td className="py-2 pr-2">
                        <input className={`${input} w-20 font-mono text-center`} value={l.diagnosisPointer}
                          onChange={(e) => setLine(i, "diagnosisPointer", e.target.value.toUpperCase().replace(/[^A-L]/g, ""))}
                          placeholder="A" />
                      </td>
                      <td className="py-2 pr-2">
                        <input type="number" min="1" className={`${input} w-16`} value={l.units}
                          onChange={(e) => setLine(i, "units", e.target.value)} />
                      </td>
                      <td className="py-2 pr-2 text-right whitespace-nowrap text-slate-800">{money(l.charge)}</td>
                      <td className="py-2 text-slate-600 text-xs">{l.provider || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {draft.lines.length > 6 && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mt-2">
                {draft.lines.length} lines. A CMS-1500 sheet holds six, so paper printing needs more than one sheet.
              </p>
            )}
          </Section>

          {/* Service facility (section 3) */}
          <Section id="facility" title="Service Facility">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <span className={lbl}>Facility name</span>
                <input className={input} value={draft.facilityName}
                  onChange={(e) => setDraftField("facilityName", e.target.value)} />
              </div>
              <div>
                <span className={lbl}>Facility address</span>
                <input className={input} value={draft.facilityAddress}
                  onChange={(e) => setDraftField("facilityAddress", e.target.value)} />
              </div>
            </div>
          </Section>

          {/* Claim summary (section 6) */}
          <Section id="summary" title="Claim Summary">
            <div className="space-y-1.5">
              {data.serviceLines.map((l) => (
                <div key={l.lineNo} className="flex justify-between text-sm">
                  <span className="text-slate-600 font-mono">{l.cpt}{l.modifiers ? ` ${l.modifiers}` : ""}</span>
                  <span className="text-slate-800">{money(l.charge)}</span>
                </div>
              ))}
              <div className="border-t border-slate-200 pt-2 flex justify-between text-sm font-semibold">
                <span className="text-slate-700">Total charges</span>
                <span className="text-slate-900">{money(data.totalCharges)}</span>
              </div>
            </div>
            <p className="text-[11px] text-slate-400 mt-2 flex items-start gap-1">
              <Info size={11} className="mt-0.5 shrink-0" />
              Totalled on the server from the stored charge rows, using the same figures as the
              ledger — this screen does not calculate money of its own.
            </p>
          </Section>
        </div>

        {/* Validation + history */}
        <aside className="hidden lg:block w-80 shrink-0 print:hidden">
          <div className="sticky top-4 space-y-3">
            <div className={`${card} p-4`}>
              <h3 className="text-sm font-semibold text-slate-800 mb-2">Validation</h3>
              {!validation ? (
                <p className="text-xs text-slate-500">
                  Not validated yet. Validate Claim checks the data a professional claim cannot go
                  without, on the server.
                </p>
              ) : (
                <>
                  <div className={`flex items-center gap-1.5 text-sm font-medium mb-2 ${
                    validation.ready ? "text-emerald-700" : "text-rose-700"}`}>
                    {validation.ready
                      ? <><CheckCircle2 size={15} /> No missing data found</>
                      : <><AlertCircle size={15} /> {blocking.length} problem{blocking.length === 1 ? "" : "s"} to fix</>}
                  </div>

                  {grouped.map(({ section, problems: ps }) => (
                    <div key={section} className="mb-2.5">
                      <button onClick={() => jump(sectionAnchor(section))}
                        className="text-[11px] uppercase tracking-wide text-slate-400 hover:text-slate-600">
                        {section}
                      </button>
                      <ul className="mt-1 space-y-1">
                        {ps.map((p, i) => (
                          <li key={i}>
                            <button onClick={() => jump(sectionAnchor(p.section))}
                              className={`text-left text-xs flex items-start gap-1.5 hover:underline ${
                                p.blocking ? "text-rose-700" : "text-amber-700"}`}>
                              {p.blocking ? <AlertCircle size={12} className="mt-0.5 shrink-0" />
                                : <AlertTriangle size={12} className="mt-0.5 shrink-0" />}
                              <span>{p.message}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}

                  {advisory.length > 0 && blocking.length === 0 && (
                    <p className="text-[11px] text-amber-700">
                      {advisory.length} advisory note{advisory.length === 1 ? "" : "s"} — the claim can still be submitted.
                    </p>
                  )}
                  <p className="text-[11px] text-slate-400 mt-2 pt-2 border-t border-slate-100">{validation.note}</p>
                </>
              )}
            </div>

            <div className={`${card} p-4`}>
              <h3 className="text-sm font-semibold text-slate-800 mb-2 flex items-center gap-1.5">
                <History size={14} /> Claim history
              </h3>
              {history.length === 0 ? (
                <p className="text-xs text-slate-500">No recorded events yet.</p>
              ) : (
                <ol className="space-y-2 max-h-72 overflow-y-auto">
                  {history.slice().reverse().map((h) => (
                    <li key={h.id} className="text-xs border-l-2 border-slate-200 pl-2">
                      <div className="text-slate-800 font-medium">{h.event}</div>
                      <div className="text-slate-400">{stamp(h.at)} · {h.actor || "—"}</div>
                      {h.detail && <div className="text-slate-500">{h.detail}</div>}
                      {h.responseText && (
                        <div className="text-slate-600 mt-0.5">
                          {h.responseCode && <span className="font-mono mr-1">{h.responseCode}</span>}{h.responseText}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              <p className="text-[11px] text-slate-400 mt-2">Events are never overwritten.</p>
            </div>
          </div>
        </aside>
      </div>

      {submitError && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mt-3 print:hidden">
          <div className="flex items-start gap-2">
            <AlertTriangle size={15} className="text-amber-700 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-900">{submitError}</p>
          </div>
        </div>
      )}

      {/* Action bar (section 28) */}
      <div className="sticky bottom-0 bg-white border-t border-slate-200 mt-4 py-3 flex items-center gap-2 flex-wrap print:hidden">
        {dirty && <span className="text-[11px] text-amber-700 mr-1">Unsaved changes</span>}

        <button onClick={save} disabled={!dirty || busy === "save"}
          className={`${btn} bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-40`}>
          {busy === "save" ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save claim
        </button>

        <button onClick={guarded(runValidate)} disabled={busy === "validate"}
          className={`${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`}>
          {busy === "validate" ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} Validate claim
        </button>

        {may("CLAIM_HCFA_VIEW") && (
          <button onClick={guarded(() => openHcfa("preprinted"))}
            className={`${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`}>
            <FileText size={13} /> HCFA preview
          </button>
        )}

        <div className="relative">
          <button onClick={() => setPrintMenu((v) => !v)}
            className={`${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`}>
            <Printer size={13} /> Print <ChevronDown size={12} />
          </button>
          {printMenu && (
            <div className="absolute bottom-full mb-1 left-0 bg-white border border-slate-200 rounded-lg shadow-lg py-1 w-60 z-10">
              <button onClick={guarded(printSummary)}
                className="w-full text-left text-xs px-3 py-2 hover:bg-slate-50 flex items-center gap-2">
                <FileText size={13} /> Claim summary
              </button>
              {may("CLAIM_HCFA_PRINT") ? (
                <>
                  <button onClick={guarded(() => openHcfa("preprinted"))}
                    className="w-full text-left text-xs px-3 py-2 hover:bg-slate-50 flex items-center gap-2">
                    <Printer size={13} /> HCFA — preprinted paper
                  </button>
                  <button onClick={guarded(() => openHcfa("withform"))}
                    className="w-full text-left text-xs px-3 py-2 hover:bg-slate-50 flex items-center gap-2">
                    <Printer size={13} /> HCFA — with form
                  </button>
                  <button onClick={guarded(() => openHcfa("preprinted"))}
                    className="w-full text-left text-xs px-3 py-2 hover:bg-slate-50 flex items-center gap-2">
                    <Crosshair size={13} /> HCFA preview &amp; alignment
                  </button>
                </>
              ) : (
                <p className="text-[11px] text-slate-400 px-3 py-2">
                  CMS-1500 printing needs the Claim HCFA Print permission.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {config && !config.submissionAvailable && (
            <span className="text-[11px] text-slate-400 max-w-xs text-right hidden md:block">{config.note}</span>
          )}
          <button
            onClick={guarded(runSubmit)}
            disabled={busy === "submit" || !may("CLAIM_ELECTRONIC_SUBMIT") || (config ? !config.submissionAvailable : false)}
            title={config && !config.submissionAvailable ? config.note : undefined}
            className={`${btn} bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed`}>
            {busy === "submit" ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Electronic claim
          </button>
        </div>
      </div>

      {/* Unsaved changes guard (section 29) */}
      {pendingAction && (
        <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-5">
            <h3 className="font-semibold text-slate-800 mb-1.5">You have unsaved changes</h3>
            <p className="text-xs text-slate-500 mb-4">
              Continuing without saving would act on the claim as it is stored, not as it is on
              screen. Nothing you typed is discarded either way.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setPendingAction(null)}
                className={`${btn} border border-slate-200 text-slate-600 flex-1 justify-center`}>Cancel</button>
              <button
                onClick={async () => {
                  const fn = pendingAction;
                  setPendingAction(null);
                  if (await save()) fn();
                }}
                className={`${btn} bg-teal-600 text-white hover:bg-teal-700 flex-1 justify-center`}>
                Save &amp; continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* The CMS-1500 renderer already built for this - same mapping for preview and print */}
      {hcfaMode && anchorCharge && (
        <Cms1500Modal
          charges={lineCharges.length ? lineCharges : [anchorCharge]}
          patient={patient}
          policy={policy}
          practice={practice}
          initialMode={hcfaMode}
          initialAlignment={alignment}
          onSaveAlignment={(a) => {
            setAlignment(a);
            // Kept per user on the server so the calibration survives a different browser. A user
            // without the settings permission still gets the local-storage copy the modal saves.
            if (may("CLAIM_PRINT_SETTINGS")) {
              savePrintProfile({
                name: "Default", paperSize: "Letter",
                offsetX: a.x, offsetY: a.y, isDefault: true,
              }).catch(() => {});
            }
          }}
          onClose={() => setHcfaMode(null)}
          onAudit={(kind) => {
            const map = {
              "HCFA printed (preprinted paper)": "HCFA Printed",
              "HCFA printed (with form)": "HCFA Printed With Form",
              "HCFA alignment test printed": "HCFA Alignment Tested",
            };
            const event = map[kind];
            if (event) recordPrintEvent(claim.id, event).then(
              () => getClaimHistory(claim.id).then((h) => setHistory(h.history || [])).catch(() => {}),
              () => {});
          }}
        />
      )}

      {showSummary && (
        <div className="fixed inset-0 bg-white z-40 overflow-auto p-8 print:p-0 print:static">
          <div className="max-w-3xl mx-auto">
            <div className="flex justify-end gap-2 mb-4 print:hidden">
              <button onClick={() => setShowSummary(false)} className={`${btn} border border-slate-200 text-slate-600`}>Close</button>
              <button onClick={() => window.print()} className={`${btn} bg-slate-900 text-white`}>
                <Printer size={13} /> Print
              </button>
            </div>
            <ClaimSummarySheet claim={claim} data={data} practice={practice} />
          </div>
        </div>
      )}
    </div>
  );
}
