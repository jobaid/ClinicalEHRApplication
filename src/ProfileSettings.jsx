// The signed-in user's own profile: personal information, skills, and certificates.
//
// Name and email are shown but are NOT editable here. They identify the account: name changes
// through User accounts (an admin action, so the audit log records who), and email is the
// login identity. The server refuses to change either through /api/me/profile even if a request
// includes them, so the disabled inputs are a hint, not the guarantee.

import { useEffect, useMemo, useState } from "react";
import { UserRound, Wrench, Award, X, Plus, Trash2, Save, Upload, Loader2, Download } from "lucide-react";
import { api, API_BASE, getToken } from "./firebase/apiClient";

const input = "w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500";
const inputRO = "w-full border border-slate-200 bg-slate-50 rounded-lg px-3 py-2 text-sm text-slate-500 cursor-not-allowed";
const btn = "text-xs rounded-lg px-3 py-2 flex items-center gap-1.5";
const primary = `${btn} bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-40`;
const plain = `${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`;
const danger = `${btn} border border-rose-200 text-rose-600 hover:bg-rose-50`;

function Field({ label, hint, children }) {
  return (
    <label className="block mb-3">
      <span className="block text-xs font-medium text-slate-500 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-400 mt-1">{hint}</span>}
    </label>
  );
}

// Digits, spaces, dashes, parentheses, +, dot. Letters are refused - the server enforces the same.
// A softer rule than a strict E.164, so a US-format "(212) 555-1234" is accepted verbatim.
const PHONE_RE = /^[0-9+\-\s().]*$/;

// The categories offered by the server (see profile.go). Kept in the same order so a list looks
// the same everywhere.
const DOC_CATEGORIES = [
  "Employment Document", "Resume", "Offer Letter", "Employment Agreement",
  "Employee ID Document", "Training Document", "License", "Certification",
  "Education Document", "Performance Document", "Other",
];

export default function ProfileSettings({ onClose }) {
  const [tab, setTab] = useState("info");
  const tabs = [
    { key: "info", label: "Personal Information", icon: UserRound },
    { key: "skills", label: "Skills", icon: Wrench },
    { key: "certs", label: "Certificates", icon: Award },
  ];

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-start justify-center p-4 overflow-y-auto print:hidden">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl my-8">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h3 className="font-semibold text-slate-800">Profile Settings</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        <div className="px-5 pt-4 flex gap-1.5 border-b border-slate-100">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`text-xs rounded-t-lg px-3 py-2 flex items-center gap-1.5 border-b-2 -mb-px ${
                  active ? "border-teal-500 text-teal-700 font-medium" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
                <Icon size={13} /> {t.label}
              </button>
            );
          })}
        </div>

        <div className="p-5">
          {tab === "info" && <PersonalInfo />}
          {tab === "skills" && <SkillsSection />}
          {tab === "certs" && <CertificatesSection />}
        </div>
      </div>
    </div>
  );
}

// ---------- Personal information ----------

function PersonalInfo() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState({ phone: "", address: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let alive = true;
    api("/api/me/profile")
      .then((p) => {
        if (!alive) return;
        setProfile(p);
        setForm({ phone: p.phone || "", address: p.address || "" });
        setLoading(false);
      })
      .catch((e) => { if (alive) { setError(e.message || "Could not load your profile."); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  function setPhone(v) {
    setOk(false);
    if (PHONE_RE.test(v)) setForm((f) => ({ ...f, phone: v }));
  }

  async function save() {
    setSaving(true); setError(""); setOk(false);
    try {
      await api("/api/me/profile", {
        method: "PATCH",
        body: { phone: form.phone.trim(), address: form.address.trim() },
      });
      setOk(true);
    } catch (e) {
      setError(e.message || "The change could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-slate-400 py-6 text-center"><Loader2 size={14} className="animate-spin inline mr-2" />Loading…</p>;
  if (!profile) return <p className="text-rose-600 text-sm">{error || "Profile unavailable."}</p>;

  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Full name" hint="Set by an administrator from User accounts">
          <input className={inputRO} value={profile.name} disabled readOnly />
        </Field>
        <Field label="Email address" hint="Your sign-in identity - cannot be changed here">
          <input className={inputRO} value={profile.email} disabled readOnly />
        </Field>
        <Field label="Phone" hint="Digits and separators only, no letters">
          <input className={input} value={form.phone} onChange={(e) => setPhone(e.target.value)} placeholder="(212) 555-1234" />
        </Field>
        <Field label="Role" hint="Managed by an administrator">
          <input className={inputRO} value={profile.role} disabled readOnly />
        </Field>
      </div>
      <Field label="Address">
        <textarea className={`${input} h-20 resize-none`} value={form.address}
          onChange={(e) => { setOk(false); setForm((f) => ({ ...f, address: e.target.value })); }}
          placeholder="Street, city, state, ZIP" />
      </Field>
      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}
      {ok && <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2 mb-3 text-xs text-emerald-800">Saved.</div>}
      <div className="flex justify-end">
        <button onClick={save} disabled={saving} className={primary}>
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

// ---------- Skills ----------

function SkillsSection() {
  const [skills, setSkills] = useState([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api("/api/me/profile")
      .then((p) => { if (alive) { setSkills(p.skills || []); setLoading(false); } })
      .catch((e) => { if (alive) { setError(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  async function commit(next) {
    setBusy(true); setError("");
    try {
      const r = await api("/api/me/skills", { method: "PUT", body: { skills: next } });
      setSkills(r.skills || []);
    } catch (e) {
      setError(e.message || "The change could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  function add() {
    const v = draft.trim();
    if (!v) return;
    if (skills.some((s) => s.toLowerCase() === v.toLowerCase())) { setDraft(""); return; }
    commit([...skills, v]);
    setDraft("");
  }

  function remove(i) {
    commit(skills.filter((_, idx) => idx !== i));
  }

  if (loading) return <p className="text-sm text-slate-400 py-6 text-center"><Loader2 size={14} className="animate-spin inline mr-2" />Loading…</p>;

  return (
    <div>
      <p className="text-xs text-slate-500 mb-3">Skills you want colleagues to see on your profile. Duplicates and empty entries are ignored.</p>
      <div className="flex gap-2 mb-3">
        <input className={input} value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="e.g. Medical Billing, React, Patient Care" />
        <button onClick={add} disabled={!draft.trim() || busy} className={primary}><Plus size={13} /> Add</button>
      </div>
      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}
      {skills.length === 0 ? (
        <p className="text-sm text-slate-400 py-6 text-center">No skills added yet.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {skills.map((s, i) => (
            <span key={`${s}-${i}`} className="inline-flex items-center gap-1 bg-slate-100 text-slate-700 text-xs rounded-full pl-3 pr-1 py-1">
              {s}
              <button onClick={() => remove(i)} disabled={busy}
                className="w-5 h-5 rounded-full text-slate-500 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center"
                aria-label={`Remove ${s}`}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Certificates ----------

const BLANK_CERT = { name: "", issuer: "", issueDate: "", expiryDate: "", credentialId: "", notes: "" };

function CertificatesSection() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // null | "new" | id
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((n) => n + 1);

  useEffect(() => {
    let alive = true;
    api("/api/me/certificates")
      .then((r) => { if (alive) { setList(r.certificates || []); setError(""); setLoading(false); } })
      .catch((e) => { if (alive) { setError(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, [reloadKey]);

  const editingRow = useMemo(
    () => (typeof editing === "string" && editing !== "new" ? list.find((c) => c.id === editing) : null),
    [editing, list],
  );

  async function remove(id) {
    if (!window.confirm("Remove this certificate?")) return;
    try {
      await api(`/api/me/certificates/${encodeURIComponent(id)}`, { method: "DELETE" });
      reload();
    } catch (e) {
      alert(e.message || "The certificate could not be removed.");
    }
  }

  function download(id, name) {
    const url = `${API_BASE}/api/me/certificates/${encodeURIComponent(id)}/file`;
    // File served with a Bearer token, so we cannot just open it in a new tab. Fetch, then
    // stream to a hidden anchor with an object URL, which downloads or opens correctly.
    fetch(url, { headers: { Authorization: `Bearer ${getToken() || ""}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("Could not open the file."))))
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl; a.download = name || "certificate";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      })
      .catch((e) => alert(e.message));
  }

  if (loading) return <p className="text-sm text-slate-400 py-6 text-center"><Loader2 size={14} className="animate-spin inline mr-2" />Loading…</p>;

  if (editing) {
    return (
      <CertificateForm
        cert={editing === "new" ? null : editingRow}
        onDone={() => { setEditing(null); reload(); }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-slate-500">Certifications and credentials on your profile.</p>
        <button onClick={() => setEditing("new")} className={primary}><Plus size={13} /> Add certificate</button>
      </div>
      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}
      {list.length === 0 ? (
        <p className="text-sm text-slate-400 py-8 text-center">No certificates yet.</p>
      ) : (
        <div className="space-y-2">
          {list.map((c) => (
            <div key={c.id} className="border border-slate-200 rounded-lg p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800">{c.name}</div>
                  <div className="text-xs text-slate-500">
                    {c.issuer || "—"}
                    {c.credentialId && <> · ID {c.credentialId}</>}
                  </div>
                  <div className="text-xs text-slate-500">
                    {c.issueDate ? `Issued ${c.issueDate}` : "No issue date"}
                    {c.expiryDate && <> · Expires {c.expiryDate}</>}
                  </div>
                  {c.notes && <p className="text-xs text-slate-600 mt-1">{c.notes}</p>}
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  {c.hasFile && (
                    <button onClick={() => download(c.id, c.fileName)} className={plain}>
                      <Download size={12} /> View file
                    </button>
                  )}
                  <button onClick={() => setEditing(c.id)} className={plain}>Edit</button>
                  <button onClick={() => remove(c.id)} className={danger}><Trash2 size={12} /> Remove</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CertificateForm({ cert, onDone, onCancel }) {
  const isNew = !cert;
  const [form, setForm] = useState(() => cert ? {
    name: cert.name || "", issuer: cert.issuer || "", issueDate: cert.issueDate || "",
    expiryDate: cert.expiryDate || "", credentialId: cert.credentialId || "", notes: cert.notes || "",
  } : { ...BLANK_CERT });
  const [file, setFile] = useState(null);
  const [problems, setProblems] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    setBusy(true); setProblems([]); setError("");
    try {
      let id = cert?.id;
      if (isNew) {
        const r = await api("/api/me/certificates", { method: "POST", body: form });
        id = r.id;
      } else {
        await api(`/api/me/certificates/${encodeURIComponent(id)}`, { method: "PUT", body: form });
      }
      if (file) {
        const fd = new FormData();
        fd.append("file", file, file.name);
        const res = await fetch(`${API_BASE}/api/me/certificates/${encodeURIComponent(id)}/file`, {
          method: "POST",
          headers: { Authorization: `Bearer ${getToken() || ""}` },
          body: fd,
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(b.error || `Upload failed (${res.status})`);
        }
      }
      onDone();
    } catch (e) {
      if (e.body?.problems) setProblems(e.body.problems);
      else setError(e.message || "The certificate could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h4 className="text-sm font-semibold text-slate-800 mb-3">{isNew ? "Add certificate" : "Edit certificate"}</h4>
      {problems.length > 0 && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3">
          <ul className="text-xs text-rose-800 list-disc pl-4">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      )}
      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Certificate name"><input className={input} value={form.name} onChange={set("name")} /></Field>
        <Field label="Issuing organisation"><input className={input} value={form.issuer} onChange={set("issuer")} /></Field>
        <Field label="Issue date"><input type="date" className={input} value={form.issueDate} onChange={set("issueDate")} /></Field>
        <Field label="Expiration date" hint="Leave blank if it does not expire">
          <input type="date" className={input} value={form.expiryDate} onChange={set("expiryDate")} />
        </Field>
        <Field label="Credential ID"><input className={input} value={form.credentialId} onChange={set("credentialId")} /></Field>
      </div>
      <Field label="Notes">
        <textarea className={`${input} h-16 resize-none`} value={form.notes} onChange={set("notes")} />
      </Field>
      <Field label="Certificate document" hint={cert?.hasFile ? "A file is already attached. Choose a new one to replace it." : "Optional. PDF, JPG or PNG up to 10 MB."}>
        <input type="file" accept="application/pdf,image/jpeg,image/png"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="text-xs" />
      </Field>
      <div className="flex justify-end gap-2 mt-2">
        <button onClick={onCancel} className={plain}>Cancel</button>
        <button onClick={save} disabled={busy} className={primary}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ---------- HR Employee Documents ----------
//
// Rendered from inside the HR Employee edit modal. Not part of Profile Settings, but shares the
// upload / fetch pattern above and keeps that pattern in one file. Exported for HrManage.

export function EmployeeDocuments({ userId, canManage }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((n) => n + 1);

  useEffect(() => {
    if (!userId) return undefined;
    let alive = true;
    api(`/api/hr/employees/${encodeURIComponent(userId)}/documents`)
      .then((r) => { if (alive) { setList(r.documents || []); setError(""); setLoading(false); } })
      .catch((e) => { if (alive) { setError(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, [userId, reloadKey]);

  async function remove(id) {
    if (!window.confirm("Archive this document?")) return;
    try {
      await api(`/api/hr/employees/${encodeURIComponent(userId)}/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
      reload();
    } catch (e) {
      alert(e.message || "The document could not be archived.");
    }
  }

  function view(id, name) {
    const url = `${API_BASE}/api/hr/employees/${encodeURIComponent(userId)}/documents/${encodeURIComponent(id)}/download`;
    fetch(url, { headers: { Authorization: `Bearer ${getToken() || ""}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("Could not open the file."))))
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl; a.download = name || "document";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      })
      .catch((e) => alert(e.message));
  }

  if (!userId) {
    return <p className="text-xs text-slate-400 py-4 text-center">Save this employee first to attach documents.</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-slate-800">Employee Documents</h4>
        {canManage && (
          <button onClick={() => setShowAdd(true)} className={primary}><Upload size={13} /> Upload</button>
        )}
      </div>
      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-2 text-xs text-rose-800">{error}</div>}
      {loading ? (
        <p className="text-xs text-slate-400 py-4 text-center"><Loader2 size={12} className="animate-spin inline mr-1" />Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-xs text-slate-400 py-4 text-center">No documents yet.</p>
      ) : (
        <div className="space-y-1.5">
          {list.map((d) => (
            <div key={d.id} className="border border-slate-200 rounded-lg p-2.5 text-xs flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium text-slate-800">{d.documentName}</div>
                <div className="text-slate-500">
                  {d.category} · {d.fileName} · {formatBytes(d.fileSize)}
                  {d.expiryDate && <> · Expires {d.expiryDate}</>}
                </div>
                <div className="text-[11px] text-slate-400">By {d.uploadedBy} · {new Date(d.uploadedAt).toLocaleString()}</div>
                {d.description && <div className="text-slate-600 mt-1">{d.description}</div>}
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                <button onClick={() => view(d.id, d.fileName)} className={plain}><Download size={11} /> View</button>
                {canManage && <button onClick={() => remove(d.id)} className={danger}><Trash2 size={11} /> Remove</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {showAdd && (
        <EmployeeDocumentUpload userId={userId} onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); reload(); }} />
      )}
    </div>
  );
}

function EmployeeDocumentUpload({ userId, onClose, onDone }) {
  const [form, setForm] = useState({ documentName: "", category: "Other", description: "", expiryDate: "" });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    if (!form.documentName.trim()) { setError("A document name is required."); return; }
    if (!file) { setError("Please choose a file."); return; }
    setBusy(true); setError("");
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      fd.append("documentName", form.documentName.trim());
      fd.append("category", form.category);
      fd.append("description", form.description.trim());
      fd.append("expiryDate", form.expiryDate);
      const res = await fetch(`${API_BASE}/api/hr/employees/${encodeURIComponent(userId)}/documents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken() || ""}` },
        body: fd,
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `Upload failed (${res.status})`);
      }
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-[60] flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h3 className="font-semibold text-slate-800">Upload employee document</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="p-5">
          {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}
          <Field label="Document name"><input className={input} value={form.documentName} onChange={set("documentName")} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              <select className={input} value={form.category} onChange={set("category")}>
                {DOC_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Expiration date" hint="Optional">
              <input type="date" className={input} value={form.expiryDate} onChange={set("expiryDate")} />
            </Field>
          </div>
          <Field label="Description / notes">
            <textarea className={`${input} h-16 resize-none`} value={form.description} onChange={set("description")} />
          </Field>
          <Field label="File" hint="PDF, JPG or PNG up to 20 MB">
            <input type="file" accept="application/pdf,image/jpeg,image/png"
              onChange={(e) => setFile(e.target.files?.[0] || null)} className="text-xs" />
          </Field>
        </div>
        <div className="px-5 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button onClick={onClose} className={plain}>Cancel</button>
          <button onClick={submit} disabled={busy} className={primary}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
