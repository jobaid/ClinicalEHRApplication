// Settings → Claims & Billing Settings.
//
// All 25 sections the spec calls for are present in the left nav. Sections that already have
// working functionality elsewhere in the app open the existing screen; sections that Commit A
// implemented (Practice Settings, Claim Numbering, Write-Off / Debit / Denial reasons) render
// their real editor; sections planned for Commit B render a clearly labelled placeholder that
// says "wired to the claim workflow next" so nothing pretends to work that does not.
//
// Everything editable here persists through the backend (claim_settings and claim_reason_codes)
// and every write is audited via the existing audit_logs.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Wallet, ScrollText, FileText, Printer, Building2, IdCard, UserCog, Truck, Shield, ListChecks,
  AlertCircle, Clock, KeyRound, Workflow, Hash, MessageSquarePlus, Cable, Receipt, History,
  Loader2, Save, Plus, Trash2, RefreshCw, ExternalLink,
} from "lucide-react";
import { api } from "./firebase/apiClient";

const input = "w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm";
const lbl = "block text-[11px] uppercase tracking-wide text-slate-400 mb-1";
const btn = "text-xs rounded-lg px-3 py-1.5 flex items-center gap-1.5";
const primary = `${btn} bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-40`;
const plain = `${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`;
const danger = `${btn} border border-rose-200 text-rose-600 hover:bg-rose-50`;

// Every section, in the order the spec lists them. Kept flat so the left nav renders top-to
// bottom exactly as requested.
function makeSections({ openPracticeCatalog, openInsuranceAdmin }) {
  return [
    { key: "general",       label: "Claim General Settings",      icon: ScrollText, kind: "kv",       settingKey: "general" },
    { key: "writeoff",      label: "Write-Off Reasons",           icon: Wallet,     kind: "reasons",  reasonKind: "writeoff" },
    { key: "debit",         label: "Debit / Adjustment Reasons",  icon: Receipt,    kind: "reasons",  reasonKind: "debit" },
    { key: "cms1500",       label: "CMS-1500 Settings",           icon: FileText,   kind: "kv",       settingKey: "cms1500" },
    { key: "cms1500Align",  label: "CMS-1500 Print Alignment",    icon: Printer,    kind: "link",     link: "existing", note: "Per-user CMS-1500 print profiles are managed inside the CMS-1500 preview modal. Open a claim to adjust." },
    { key: "ub04",          label: "UB-04 Settings",              icon: FileText,   kind: "kv",       settingKey: "ub04",       phase2: true },
    { key: "ub04Align",     label: "UB-04 Print Alignment",       icon: Printer,    kind: "kv",       settingKey: "ub04",       phase2: true, note: "Alignment is stored inside UB-04 Settings for now; a dedicated preview lands in Commit B." },
    { key: "practice",      label: "Provider / Practice Settings", icon: Building2, kind: "kv",       settingKey: "practice" },
    { key: "taxonomy",      label: "Taxonomy Codes",              icon: IdCard,     kind: "kv",       settingKey: "practice",   focusField: "taxonomy", note: "Practice taxonomy is stored under Provider / Practice Settings." },
    { key: "npi",           label: "NPI / Provider Identifiers",  icon: IdCard,     kind: "external", target: "practiceCatalog", note: "Individual NPI is on each physician row in the Practice Catalog. Practice-level NPI is on Provider / Practice Settings.", action: openPracticeCatalog },
    { key: "billingProv",   label: "Billing Provider",            icon: UserCog,    kind: "external", target: "practiceCatalog", action: openPracticeCatalog },
    { key: "renderingProv", label: "Rendering Provider",          icon: UserCog,    kind: "external", target: "practiceCatalog", action: openPracticeCatalog },
    { key: "referringProv", label: "Referring Provider",          icon: UserCog,    kind: "external", target: "practiceCatalog", action: openPracticeCatalog },
    { key: "serviceLoc",    label: "Service Location",            icon: Truck,      kind: "kv",       settingKey: "practice",   focusField: "serviceLocation", note: "Service location is stored under Provider / Practice Settings." },
    { key: "payers",        label: "Payer Settings",              icon: Shield,     kind: "external", target: "insurance",       action: openInsuranceAdmin },
    { key: "validation",    label: "Claim Validation",            icon: ListChecks, kind: "kv",       settingKey: "validation",  phase2: true },
    { key: "denial",        label: "Denial Reasons",              icon: AlertCircle, kind: "reasons", reasonKind: "denial" },
    { key: "timely",        label: "Timely Filing",               icon: Clock,      kind: "kv",       settingKey: "timelyFiling", phase2: true },
    { key: "priorAuth",     label: "Prior Authorization",         icon: KeyRound,   kind: "kv",       settingKey: "priorAuth",   phase2: true },
    { key: "workflow",      label: "Claim Workflow",              icon: Workflow,   kind: "kv",       settingKey: "workflow",    phase2: true },
    { key: "numbering",     label: "Claim Numbering",             icon: Hash,       kind: "kv",       settingKey: "claimNumbering" },
    { key: "notes",         label: "Claim Notes / Templates",     icon: MessageSquarePlus, kind: "kv", settingKey: "noteTemplates", phase2: true },
    { key: "clearinghouse", label: "Clearinghouse / EDI",         icon: Cable,      kind: "kv",       settingKey: "clearinghouse", phase2: true },
    { key: "era",           label: "ERA / Payment Settings",      icon: Receipt,    kind: "kv",       settingKey: "era",         phase2: true },
    { key: "audit",         label: "Claim Audit History",         icon: History,    kind: "audit" },
  ];
}

export default function ClaimsBillingSettings({ onOpenPracticeCatalog, onOpenInsuranceAdmin }) {
  const sections = useMemo(
    () => makeSections({
      openPracticeCatalog: onOpenPracticeCatalog,
      openInsuranceAdmin: onOpenInsuranceAdmin,
    }),
    [onOpenPracticeCatalog, onOpenInsuranceAdmin]);
  const [activeKey, setActiveKey] = useState(sections[0].key);
  const active = sections.find((s) => s.key === activeKey) || sections[0];

  return (
    <div>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-slate-800">Claims &amp; Billing Settings</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Central configuration for the claims workflow. Sections marked <span className="italic">"Commit B"</span> save
          their values here but the claim workflow will start reading them in the next release.
        </p>
      </div>
      <div className="flex flex-col md:flex-row gap-4">
        <nav className="md:w-64 shrink-0 bg-white border border-slate-200 rounded-xl p-2 h-fit">
          {sections.map((s) => {
            const Icon = s.icon;
            const on = active.key === s.key;
            return (
              <button key={s.key} onClick={() => setActiveKey(s.key)}
                className={`w-full text-left text-xs px-2.5 py-2 rounded-lg flex items-center gap-2 ${
                  on ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-50"}`}>
                <Icon size={13} /> {s.label}
                {s.phase2 && !on && <span className="ml-auto text-[9px] uppercase text-slate-400">B</span>}
              </button>
            );
          })}
        </nav>
        <div className="flex-1 min-w-0 bg-white border border-slate-200 rounded-xl p-5">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-slate-800">{active.label}</h3>
            {active.note && <p className="text-[11px] text-slate-500 mt-0.5">{active.note}</p>}
            {active.phase2 && (
              <div className="mt-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                <strong>Commit B</strong>: the values you save here are persisted, but the claim workflow
                does not yet read them. Wiring lands in the next release. Nothing about existing claim
                behaviour changes today.
              </div>
            )}
          </div>

          {active.kind === "kv" && (
            <KeyValueEditor key={active.key} settingKey={active.settingKey} label={active.label} preset={active.key} />
          )}
          {active.kind === "reasons" && (
            <ReasonCodesEditor key={active.key} kind={active.reasonKind} label={active.label} />
          )}
          {active.kind === "external" && (
            <ExternalLinkPane label={active.label} target={active.target} action={active.action} note={active.note} />
          )}
          {active.kind === "link" && (
            <p className="text-xs text-slate-500">{active.note}</p>
          )}
          {active.kind === "audit" && <ClaimAuditHistory />}
        </div>
      </div>
    </div>
  );
}

// ---------- key/value editor ----------

// Preset field lists so the common sections get sensible labelled fields; a preset that is not
// covered falls back to a generic JSON textarea.
const PRESETS = {
  general: [
    { key: "defaultPlaceOfService", label: "Default place of service", placeholder: "e.g. 11 (Office)" },
    { key: "defaultPayerType",      label: "Default payer type",       placeholder: "Commercial / Medicare / Medicaid" },
    { key: "acceptAssignment",      label: "Accept assignment",        placeholder: "Y / N" },
  ],
  practice: [
    { key: "organizationName", label: "Organization name" },
    { key: "taxId",            label: "Tax ID (EIN)" },
    { key: "billingNPI",       label: "Practice billing NPI" },
    { key: "taxonomy",         label: "Practice taxonomy code" },
    { key: "serviceLocation",  label: "Service location (address)", multi: true },
    { key: "phone",            label: "Phone" },
    { key: "email",            label: "Billing email" },
  ],
  claimNumbering: [
    { key: "prefix",         label: "Claim number prefix",   placeholder: "e.g. CLM-" },
    { key: "nextSequence",   label: "Next sequence number",  placeholder: "e.g. 1001" },
    { key: "padTo",          label: "Zero-pad width",        placeholder: "e.g. 6" },
    { key: "resetYearly",    label: "Reset each year (Y/N)", placeholder: "N" },
  ],
  cms1500: [
    { key: "template",     label: "Template",         placeholder: "0212 / red-drop-out" },
    { key: "font",         label: "Font",             placeholder: "Courier" },
    { key: "printMargin",  label: "Print margin (in)", placeholder: "0.5" },
  ],
  ub04: [
    { key: "template",     label: "Template",         placeholder: "UB-04 CMS-1450" },
    { key: "printMargin",  label: "Print margin (in)", placeholder: "0.5" },
    { key: "offsetX",      label: "Alignment offset X (mm)", placeholder: "0" },
    { key: "offsetY",      label: "Alignment offset Y (mm)", placeholder: "0" },
  ],
  validation: [
    { key: "requireDx",         label: "Require diagnosis codes (Y/N)", placeholder: "Y" },
    { key: "requirePriorAuth",  label: "Require prior-auth number (Y/N)", placeholder: "N" },
    { key: "warnStaleCharge",   label: "Warn if charge is older than N days", placeholder: "60" },
  ],
  timelyFiling: [
    { key: "medicareDays",   label: "Medicare filing window (days)",   placeholder: "365" },
    { key: "medicaidDays",   label: "Medicaid filing window (days)",   placeholder: "180" },
    { key: "commercialDays", label: "Commercial filing window (days)", placeholder: "90" },
  ],
  priorAuth: [
    { key: "policy", label: "Prior-auth policy", placeholder: "warn | block | none" },
    { key: "storeAuthNumber", label: "Store auth number on charge (Y/N)", placeholder: "Y" },
  ],
  workflow: [
    { key: "autoSubmitOnPost", label: "Auto-submit clean claims (Y/N)", placeholder: "N" },
    { key: "requireBillerReview", label: "Require biller review before submit (Y/N)", placeholder: "Y" },
  ],
  noteTemplates: [
    { key: "greeting", label: "Greeting snippet", multi: true },
    { key: "denial",   label: "Denial follow-up snippet", multi: true },
  ],
  clearinghouse: [
    { key: "vendor",    label: "Vendor",     placeholder: "Availity / Change Healthcare / ..." },
    { key: "endpoint",  label: "SFTP/HTTPS endpoint" },
    { key: "username",  label: "Username" },
    { key: "submitterId", label: "Submitter ID" },
  ],
  era: [
    { key: "vendor",       label: "ERA source" },
    { key: "sftpEndpoint", label: "SFTP endpoint" },
    { key: "autoPostThresh", label: "Auto-post threshold ($)", placeholder: "0" },
  ],
};

function KeyValueEditor({ settingKey, label, preset }) {
  const fields = PRESETS[preset] || PRESETS[settingKey] || null;
  const [value, setValue] = useState(fields ? {} : "{}");
  const [meta, setMeta] = useState({ updatedBy: "", updatedAt: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(""); setSaved(false);
    api(`/api/admin/claim-settings/${encodeURIComponent(settingKey)}`)
      .then((r) => {
        if (!alive) return;
        setMeta({ updatedBy: r.updatedBy || "", updatedAt: r.updatedAt || "" });
        if (fields) {
          const merged = {};
          (fields || []).forEach((f) => { merged[f.key] = r.value?.[f.key] || ""; });
          setValue(merged);
        } else {
          setValue(JSON.stringify(r.value || {}, null, 2));
        }
        setLoading(false);
      })
      .catch((e) => { if (alive) { setError(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, [settingKey, fields]);

  async function save() {
    setSaving(true); setError(""); setSaved(false);
    try {
      let out;
      if (fields) {
        out = { ...value };
      } else {
        try { out = JSON.parse(value); }
        catch { throw new Error("Value must be valid JSON."); }
      }
      await api(`/api/admin/claim-settings/${encodeURIComponent(settingKey)}`,
        { method: "PUT", body: { value: out } });
      setSaved(true);
      // Refresh meta from the server so the audit line reflects the new save.
      const r = await api(`/api/admin/claim-settings/${encodeURIComponent(settingKey)}`);
      setMeta({ updatedBy: r.updatedBy || "", updatedAt: r.updatedAt || "" });
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-xs text-slate-400"><Loader2 size={12} className="inline animate-spin mr-1" />Loading {label}…</p>;

  return (
    <div>
      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}
      {saved && <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2 mb-3 text-xs text-emerald-800">Saved.</div>}

      {fields ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {fields.map((f) => (
            <label key={f.key} className={f.multi ? "md:col-span-2 block" : "block"}>
              <span className={lbl}>{f.label}</span>
              {f.multi ? (
                <textarea className={`${input} h-16 resize-none`}
                  value={value[f.key] || ""} placeholder={f.placeholder || ""}
                  onChange={(e) => setValue({ ...value, [f.key]: e.target.value })} />
              ) : (
                <input className={input}
                  value={value[f.key] || ""} placeholder={f.placeholder || ""}
                  onChange={(e) => setValue({ ...value, [f.key]: e.target.value })} />
              )}
            </label>
          ))}
        </div>
      ) : (
        <label className="block">
          <span className={lbl}>Raw JSON</span>
          <textarea className={`${input} h-40 font-mono resize-y`}
            value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
      )}

      <div className="flex items-center justify-between mt-3">
        <p className="text-[11px] text-slate-400">
          {meta.updatedAt
            ? `Last saved ${new Date(meta.updatedAt).toLocaleString()} by ${meta.updatedBy || "—"}`
            : "Never saved."}
        </p>
        <button onClick={save} disabled={saving} className={primary}>
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ---------- reason codes editor ----------

const BLANK_REASON = { code: "", description: "", category: "", sortOrder: 0 };

function ReasonCodesEditor({ kind, label }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [draft, setDraft] = useState(BLANK_REASON);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api(`/api/admin/claim-reason-codes?kind=${encodeURIComponent(kind)}`)
      .then((r) => { if (alive) { setList(r.reasons || []); setError(""); } })
      .catch((e) => { if (alive) { setError(e.message); setList([]); } });
    return () => { alive = false; };
  }, [kind, reloadKey]);

  async function add() {
    if (!draft.description.trim()) return;
    setBusy(true); setError("");
    try {
      await api("/api/admin/claim-reason-codes", {
        method: "POST", body: { ...draft, kind, active: true },
      });
      setDraft(BLANK_REASON);
      setReloadKey((n) => n + 1);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(row) {
    try {
      await api(`/api/admin/claim-reason-codes/${encodeURIComponent(row.id)}`, {
        method: "PUT", body: { ...row, active: !row.active },
      });
      setReloadKey((n) => n + 1);
    } catch (e) {
      alert(e.message);
    }
  }

  async function retire(row) {
    if (!window.confirm(`Retire "${row.description}"? Existing rows that reference it keep working.`)) return;
    try {
      await api(`/api/admin/claim-reason-codes/${encodeURIComponent(row.id)}`, { method: "DELETE" });
      setReloadKey((n) => n + 1);
    } catch (e) {
      alert(e.message);
    }
  }

  return (
    <div>
      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-5 gap-2 mb-3 items-end">
        <label className="block md:col-span-1">
          <span className={lbl}>Code</span>
          <input className={input} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })}
            placeholder="CO-45" />
        </label>
        <label className="block md:col-span-2">
          <span className={lbl}>Description</span>
          <input className={input} value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </label>
        <label className="block md:col-span-1">
          <span className={lbl}>Category</span>
          <input className={input} value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
        </label>
        <button onClick={add} disabled={busy || !draft.description.trim()} className={primary}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add
        </button>
      </div>

      {!list && <p className="text-xs text-slate-400"><Loader2 size={12} className="inline animate-spin mr-1" />Loading…</p>}
      {list && list.length === 0 && <p className="text-xs text-slate-400 py-4 text-center">No {label.toLowerCase()} yet. Add the first one above.</p>}

      {list && list.length > 0 && (
        <div className="border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Code</th>
                <th className="text-left px-3 py-2 font-medium">Description</th>
                <th className="text-left px-3 py-2 font-medium">Category</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 font-mono text-[11px]">{r.code || <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-1.5 text-slate-800">{r.description}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.category || <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-1.5">
                    <button onClick={() => toggleActive(r)}
                      className={`text-[10px] uppercase border rounded px-1.5 py-0.5 ${
                        r.active ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-slate-100 text-slate-500 border-slate-200"}`}>
                      {r.active ? "active" : "retired"}
                    </button>
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {r.active && (
                      <button onClick={() => retire(r)} className={danger}><Trash2 size={11} /> Retire</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-slate-400 mt-3">
        These reasons are the catalog the biller picks from. Commit B replaces the hard-coded lists
        in the posting screens with this data.
      </p>
    </div>
  );
}

// ---------- external-link pane ----------

function ExternalLinkPane({ label, target, action, note }) {
  const targetLabels = {
    practiceCatalog: "Practice Catalog",
    insurance: "Insurance Management",
  };
  return (
    <div>
      {note && <p className="text-xs text-slate-500 mb-3">{note}</p>}
      <button onClick={() => action?.()} className={primary}>
        <ExternalLink size={13} /> Open {targetLabels[target] || label}
      </button>
    </div>
  );
}

// ---------- claim audit history ----------

function ClaimAuditHistory() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(() => {
    setRows(null); setError("");
    api("/api/collections/auditLogs")
      .then((docs) => {
        const claims = (Array.isArray(docs) ? docs : docs?.documents || [])
          .filter((a) => /claim|charge|posting|billing|debit|writeoff/i.test((a.entityType || "") + " " + (a.action || "")))
          .slice(0, 200);
        setRows(claims);
      })
      .catch((e) => { setError(e.message); setRows([]); });
  }, []);
  useEffect(load, [reloadKey, load]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-slate-500">
          Recent claim-related activity from the existing audit log (up to 200 rows).
        </p>
        <button onClick={() => setReloadKey((n) => n + 1)} className={plain}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}
      {!rows && <p className="text-xs text-slate-400"><Loader2 size={12} className="inline animate-spin mr-1" />Loading…</p>}
      {rows && rows.length === 0 && <p className="text-xs text-slate-400 py-4 text-center">No claim events on record yet.</p>}
      {rows && rows.length > 0 && (
        <div className="border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2 font-medium">When</th>
                <th className="text-left px-3 py-2 font-medium">User</th>
                <th className="text-left px-3 py-2 font-medium">Action</th>
                <th className="text-left px-3 py-2 font-medium">Entity</th>
                <th className="text-left px-3 py-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 text-slate-500">{a.timestamp ? new Date(a.timestamp).toLocaleString() : "—"}</td>
                  <td className="px-3 py-1.5 text-slate-700">{a.user || "—"}</td>
                  <td className="px-3 py-1.5 text-slate-700">{a.action || "—"}</td>
                  <td className="px-3 py-1.5 text-slate-500">
                    {a.entityType}{a.entityId ? " · " + a.entityId : ""}
                  </td>
                  <td className="px-3 py-1.5 text-slate-600">{a.newValues || a.oldValues || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
