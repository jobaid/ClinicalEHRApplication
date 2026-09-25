// Uploaded medical records: the upload form, the list, and the viewer with print, PDF, download
// and email.
//
// Added alongside the existing Medical Record workspace, not in place of anything. The timeline,
// its filters and the lab panel are untouched.

import { useCallback, useEffect, useState } from "react";
import {
  X, Upload, FileText, Printer, Download, Mail, Trash2, ZoomIn, ZoomOut, Maximize2, Search,
} from "lucide-react";
import { api, apiUpload, API_BASE, getToken } from "./firebase/apiClient";

const card = "bg-white border border-slate-200 rounded-xl";
const input = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm";
const label = "block text-xs text-slate-500 mb-1";

const ACCEPT = ".pdf,.jpg,.jpeg,.png";

const listRecords = (patientId, opts = {}) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) if (v) u.set(k, v);
  const q = u.toString();
  return api(`/api/patients/${encodeURIComponent(patientId)}/records${q ? "?" + q : ""}`);
};

const getRecord = (patientId, id) =>
  api(`/api/patients/${encodeURIComponent(patientId)}/records/${encodeURIComponent(id)}`);

const emailRecord = (patientId, id, body) =>
  api(`/api/patients/${encodeURIComponent(patientId)}/records/${encodeURIComponent(id)}/email`,
    { method: "POST", body });

const removeRecord = (patientId, id) =>
  api(`/api/patients/${encodeURIComponent(patientId)}/records/${encodeURIComponent(id)}`,
    { method: "DELETE" });

const fmt = (iso) => {
  if (!iso) return "Not available";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "Not available" : d.toLocaleString();
};
const fmtDate = (s) => {
  if (!s) return "Not available";
  const d = new Date(s + (s.length === 10 ? "T00:00:00" : ""));
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
};
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

// ---------- upload ----------

function UploadRecordModal({ patientId, onClose, onUploaded }) {
  const [form, setForm] = useState({
    recordName: "", recordDate: "", recordType: "", provider: "", facility: "", description: "",
  });
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (!form.recordName.trim()) return setError("A record name is required.");
    if (!form.recordDate) return setError("A record date is required.");
    if (!file) return setError("A file is required.");

    setBusy(true);
    setError("");
    try {
      await apiUpload(`/api/patients/${encodeURIComponent(patientId)}/records`, file,
        { field: "file", extra: form });
      onUploaded();
      onClose();
    } catch (err) {
      setError(err?.message || "The upload did not complete.");
    }
    setBusy(false);
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 sticky top-0 bg-white">
          <h3 className="font-semibold text-slate-800">Upload Medical Record</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-3">
          <div>
            <label className={label}>Record Name <span className="text-rose-500">*</span></label>
            <input className={input} value={form.recordName} onChange={set("recordName")}
              placeholder="Cardiology Consultation" autoFocus />
          </div>

          <div>
            <label className={label}>Record Date <span className="text-rose-500">*</span></label>
            <input type="date" className={input} value={form.recordDate} onChange={set("recordDate")} />
            {/* The distinction section 4 turns on, stated where it is entered. */}
            <p className="text-[11px] text-slate-400 mt-1">
              The date of the record itself, not today. The upload date is recorded separately.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Record Type</label>
              <input className={input} value={form.recordType} onChange={set("recordType")} placeholder="Specialist Report" />
            </div>
            <div>
              <label className={label}>Provider / Doctor</label>
              <input className={input} value={form.provider} onChange={set("provider")} placeholder="Dr. Smith" />
            </div>
          </div>

          <div>
            <label className={label}>Facility / Source</label>
            <input className={input} value={form.facility} onChange={set("facility")} placeholder="ABC Hospital" />
          </div>

          <div>
            <label className={label}>Description / Notes</label>
            <textarea className={input} rows={2} value={form.description} onChange={set("description")} />
          </div>

          <div>
            <label className={label}>File <span className="text-rose-500">*</span></label>
            <input type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="w-full text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-slate-200 file:text-xs file:bg-slate-50" />
            <p className="text-[11px] text-slate-400 mt-1">
              PDF, JPG or PNG, up to 20 MB. The file's contents are checked on the server, not its name.
            </p>
            {file && <p className="text-xs text-slate-600 mt-1">{file.name} · {kb(file.size)}</p>}
          </div>

          {error && <p className="text-sm text-rose-700">{error}</p>}
        </div>

        <div className="px-5 py-4 border-t border-slate-200 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="text-sm px-3 py-2 text-slate-600 hover:bg-slate-50 rounded-lg">Cancel</button>
          <button type="submit" disabled={busy}
            className="text-sm px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50">
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------- viewer ----------

function Viewer({ patientId, header, recordId, perms, onClose, onDeleted }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(100);
  const [emailOpen, setEmailOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const can = useCallback((p) => perms.includes(p), [perms]);

  useEffect(() => {
    let live = true;
    getRecord(patientId, recordId)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e?.message || "Could not open this record."));
    return () => { live = false; };
  }, [patientId, recordId]);

  const rec = data?.record;
  const isPdf = rec?.fileType === "application/pdf";

  // Print builds its own document rather than printing the application page - section 10. The
  // practice header, patient identification and the record itself are laid out for paper; the
  // navigation, buttons and filters of the app are not in it at all.
  function print() {
    if (!data) return;
    const w = window.open("", "_blank", "width=900,height=1000");
    if (!w) { setError("The browser blocked the print window. Allow pop-ups for this site."); return; }
    const esc = (v) => String(v ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
    const body = isPdf
      ? `<embed src="${data.dataUrl}" type="application/pdf" style="width:100%;height:80vh;border:1px solid #ddd" />`
      : `<img src="${data.dataUrl}" style="max-width:100%;border:1px solid #ddd" />`;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(rec.recordName)}</title>
<style>
  body{font:12px/1.5 Calibri,Arial,sans-serif;color:#111;margin:24px}
  h1{font-size:16px;margin:0 0 2px}
  .sub{color:#555;font-size:11px;margin-bottom:12px}
  table{border-collapse:collapse;width:100%;margin-bottom:14px}
  td{padding:2px 0;vertical-align:top}
  td.k{color:#666;width:120px}
  hr{border:0;border-top:1px solid #bbb;margin:10px 0}
  footer{margin-top:16px;color:#777;font-size:10px;border-top:1px solid #ddd;padding-top:6px}
  @media print{ body{margin:12mm} }
</style></head><body>
<h1>Patient Medical Record</h1>
<div class="sub">Obaid Clinic · Practice management &amp; billing</div>
<hr/>
<table>
  <tr><td class="k">Patient</td><td>${esc(header?.name)}</td><td class="k">Record</td><td>${esc(rec.recordName)}</td></tr>
  <tr><td class="k">MRN</td><td>${esc(header?.mrn)}</td><td class="k">Record date</td><td>${esc(fmtDate(rec.recordDate))}</td></tr>
  <tr><td class="k">DOB</td><td>${esc(header?.dob)}</td><td class="k">Type</td><td>${esc(rec.recordType || "Not available")}</td></tr>
  <tr><td class="k"></td><td></td><td class="k">Provider</td><td>${esc(rec.provider || "Not available")}</td></tr>
  <tr><td class="k"></td><td></td><td class="k">Facility</td><td>${esc(rec.facility || "Not available")}</td></tr>
  <tr><td class="k">Uploaded by</td><td>${esc(rec.uploadedByName)}</td><td class="k">Uploaded</td><td>${esc(fmt(rec.uploadedAt))}</td></tr>
</table>
<hr/>
${body}
<footer>Generated ${new Date().toLocaleString()} · Confidential patient information</footer>
</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  }

  // A PDF is handed over as it was uploaded, byte for byte - section 11 asks not to degrade it.
  // Re-rendering a scanned report through a canvas would lose exactly the detail a clinician
  // needs, so "Generate PDF" downloads the original for a PDF and, for an image, opens the
  // print layout where the browser's own "Save as PDF" produces the identification page plus
  // the image at full resolution.
  function pdf() {
    if (!data) return;
    if (isPdf) { downloadFile(); return; }
    print();
  }

  async function downloadFile() {
    try {
      const res = await fetch(
        `${API_BASE}/api/patients/${encodeURIComponent(patientId)}/records/${encodeURIComponent(recordId)}/download`,
        { headers: { authorization: "Bearer " + getToken() } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Download refused");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = rec.fileName; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      setError(e?.message || "Could not download this record.");
    }
  }

  const field = (l, v) => (
    <div><div className="text-[10px] uppercase tracking-wide text-slate-400">{l}</div>
      <div className="text-sm text-slate-800">{v || "Not available"}</div></div>
  );

  return (
    <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-full max-w-5xl h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h3 className="font-semibold text-slate-800">Patient Medical Record</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        {error && <div className="px-5 py-2 text-sm text-rose-700 bg-rose-50 border-b border-rose-200">{error}</div>}
        {!data && !error && <div className="p-8 text-sm text-slate-400">Loading record…</div>}

        {rec && (
          <>
            <div className="px-5 py-3 border-b border-slate-200 grid grid-cols-2 md:grid-cols-4 gap-3 shrink-0">
              {field("Patient", header?.name)}
              {field("MRN", header?.mrn)}
              {field("DOB", header?.dob)}
              {field("Record", rec.recordName)}
              {field("Record Date", fmtDate(rec.recordDate))}
              {field("Type", rec.recordType)}
              {field("Provider", rec.provider)}
              {field("Facility", rec.facility)}
              {field("Uploaded By", rec.uploadedByName)}
              {field("Uploaded", fmt(rec.uploadedAt))}
              {field("File", `${rec.fileName} · ${kb(rec.fileSize)}`)}
            </div>

            <div className="flex-1 overflow-auto bg-slate-100 p-3">
              {isPdf ? (
                <embed src={data.dataUrl} type="application/pdf" className="w-full h-full min-h-[400px] bg-white" />
              ) : (
                <div className="flex justify-center">
                  <img src={data.dataUrl} alt={rec.recordName}
                    style={{ width: `${zoom}%` }} className="bg-white shadow-sm" />
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-slate-200 flex items-center gap-2 flex-wrap shrink-0">
              {!isPdf && (
                <>
                  <button onClick={() => setZoom((z) => Math.max(25, z - 25))} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 hover:bg-slate-50"><ZoomOut size={13} /></button>
                  <span className="text-xs text-slate-500 w-12 text-center">{zoom}%</span>
                  <button onClick={() => setZoom((z) => Math.min(400, z + 25))} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 hover:bg-slate-50"><ZoomIn size={13} /></button>
                  <button onClick={() => setZoom(100)} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 hover:bg-slate-50">Fit</button>
                </>
              )}
              <button onClick={() => window.open(data.dataUrl, "_blank")} className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-50 flex items-center gap-1">
                <Maximize2 size={13} /> Full screen
              </button>

              <div className="ml-auto flex items-center gap-2 flex-wrap">
                <button onClick={print} className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-50 flex items-center gap-1">
                  <Printer size={13} /> Print
                </button>
                <button onClick={pdf} className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-50 flex items-center gap-1">
                  <FileText size={13} /> PDF
                </button>
                {can("MEDICAL_RECORD_DOWNLOAD") && (
                  <button onClick={downloadFile} className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-50 flex items-center gap-1">
                    <Download size={13} /> Download
                  </button>
                )}
                {can("MEDICAL_RECORD_EMAIL") && (
                  <button onClick={() => setEmailOpen(true)} className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-50 flex items-center gap-1">
                    <Mail size={13} /> Email
                  </button>
                )}
                {can("MEDICAL_RECORD_DELETE") && (
                  <button onClick={() => setConfirmDelete(true)} className="text-xs border border-rose-200 text-rose-700 rounded-lg px-2.5 py-1.5 hover:bg-rose-50 flex items-center gap-1">
                    <Trash2 size={13} /> Remove
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {emailOpen && rec && (
        <EmailModal patientId={patientId} record={rec} patientName={header?.name}
          onClose={() => setEmailOpen(false)} />
      )}

      {confirmDelete && rec && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-[60] p-4" onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}>
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-xl shadow-xl w-full max-w-sm p-5">
            <h3 className="font-semibold text-slate-800 mb-1">Remove this record?</h3>
            <p className="text-sm text-slate-600 mb-4">
              <span className="font-medium">{rec.recordName}</span> will no longer appear in the chart.
              The entry is retained for the audit trail rather than erased.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(false)} className="text-sm px-3 py-2 text-slate-600 hover:bg-slate-50 rounded-lg">Cancel</button>
              <button onClick={async () => {
                try { await removeRecord(patientId, rec.id); onDeleted(); onClose(); }
                catch (e) { setError(e?.message || "Could not remove the record."); setConfirmDelete(false); }
              }} className="text-sm px-3 py-2 bg-rose-600 text-white rounded-lg hover:bg-rose-700">Remove</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- email ----------

function EmailModal({ patientId, record, patientName, onClose }) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("Patient Medical Record");
  const [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(null);

  useEffect(() => {
    let live = true;
    api("/api/email/status")
      .then((d) => live && setEnabled(!!d.enabled))
      .catch(() => live && setEnabled(false));
    return () => { live = false; };
  }, []);

  async function send() {
    setBusy(true);
    setError("");
    try {
      await emailRecord(patientId, record.id, { to: to.trim(), subject, message });
      setSent(true);
    } catch (e) {
      setError(e?.message || "The message could not be sent.");
      setConfirming(false);
    }
    setBusy(false);
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-[60] p-4" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h3 className="font-semibold text-slate-800">Email Medical Record</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        <div className="p-5">
          {sent ? (
            <>
              <p className="text-sm text-emerald-700 mb-4">Sent to {to}.</p>
              <div className="flex justify-end"><button onClick={onClose} className="text-sm px-3 py-2 bg-slate-900 text-white rounded-lg">Close</button></div>
            </>
          ) : enabled === false ? (
            <>
              <p className="text-sm text-slate-600">
                Email is not configured on this server, so nothing can be sent. An administrator
                needs to set <code className="text-xs">SMTP_HOST</code>, <code className="text-xs">SMTP_FROM</code> and
                credentials before this works.
              </p>
              <div className="flex justify-end mt-4"><button onClick={onClose} className="text-sm px-3 py-2 text-slate-600 hover:bg-slate-50 rounded-lg">Close</button></div>
            </>
          ) : confirming ? (
            <>
              {/* Section 12: confirm the patient, the record and the recipient before anything
                  leaves the building. */}
              <p className="text-sm text-slate-600 mb-3">This will send patient information to an external address. Confirm:</p>
              <div className="border border-amber-200 bg-amber-50 rounded-lg p-3 space-y-1 mb-4 text-sm">
                <div><span className="text-slate-500">Patient:</span> <span className="text-slate-900 font-medium">{patientName}</span></div>
                <div><span className="text-slate-500">Record:</span> <span className="text-slate-900 font-medium">{record.recordName}</span></div>
                <div><span className="text-slate-500">Recipient:</span> <span className="text-slate-900 font-medium">{to}</span></div>
              </div>
              {error && <p className="text-sm text-rose-700 mb-3">{error}</p>}
              <div className="flex justify-end gap-2">
                <button onClick={() => setConfirming(false)} className="text-sm px-3 py-2 text-slate-600 hover:bg-slate-50 rounded-lg">Back</button>
                <button onClick={send} disabled={busy} className="text-sm px-4 py-2 bg-rose-600 text-white rounded-lg hover:bg-rose-700 disabled:opacity-50">
                  {busy ? "Sending…" : "Send"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-3">
                <div>
                  <label className={label}>To</label>
                  <input className={input} value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@example.com" autoFocus />
                </div>
                <div>
                  <label className={label}>Subject</label>
                  <input className={input} value={subject} onChange={(e) => setSubject(e.target.value)} />
                </div>
                <div>
                  <label className={label}>Message</label>
                  <textarea className={input} rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
                </div>
                <div className="text-xs text-slate-500">
                  Record: <span className="text-slate-700">{record.recordName}</span>
                </div>
              </div>
              {error && <p className="text-sm text-rose-700 mt-3">{error}</p>}
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={onClose} className="text-sm px-3 py-2 text-slate-600 hover:bg-slate-50 rounded-lg">Cancel</button>
                <button onClick={() => setConfirming(true)} disabled={!to.includes("@")}
                  className="text-sm px-4 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-40">
                  Continue
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- the section that goes on the Medical Record tab ----------

export default function UploadedRecords({ patientId, header, perms }) {
  const can = useCallback((p) => perms.includes(p), [perms]);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [nonce, setNonce] = useState(0);

  const mayView = perms.includes("MEDICAL_RECORD_DOCUMENT_VIEW");

  useEffect(() => {
    if (!mayView) return undefined;
    let live = true;
    listRecords(patientId, { search: search.trim(), recordType: type })
      .then((d) => { if (live) { setData(d); setError(""); } })
      .catch((e) => { if (live) setError(e?.message || "Could not load uploaded records."); });
    return () => { live = false; };
  }, [patientId, search, type, nonce, mayView]);

  if (!mayView && !can("MEDICAL_RECORD_UPLOAD")) return null;

  return (
    <div className={`${card} mt-4`}>
      <div className="px-3 py-2.5 border-b border-slate-200 flex items-center gap-2 flex-wrap">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mr-auto">
          Uploaded Medical Records{data ? ` (${data.records.length})` : ""}
        </h2>
        {mayView && (
          <>
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-2 text-slate-400" />
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search records"
                className="border border-slate-200 rounded-lg pl-7 pr-2 py-1.5 text-xs w-44" />
            </div>
            <select value={type} onChange={(e) => setType(e.target.value)}
              className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs">
              <option value="">All types</option>
              {(data?.recordTypes || []).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </>
        )}
        {can("MEDICAL_RECORD_UPLOAD") && (
          <button onClick={() => setUploadOpen(true)}
            className="text-xs bg-teal-600 text-white rounded-lg px-3 py-1.5 hover:bg-teal-700 flex items-center gap-1">
            <Upload size={13} /> Upload Medical Record
          </button>
        )}
      </div>

      {error && <p className="px-3 py-2 text-sm text-rose-700">{error}</p>}

      {data && data.records.length === 0 && (
        <p className="px-3 py-6 text-sm text-slate-400 text-center">No medical records uploaded for this patient.</p>
      )}

      {data && data.records.length > 0 && (
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Record Date</th>
              <th className="text-left px-3 py-2 font-medium">Record Name</th>
              <th className="text-left px-3 py-2 font-medium">Type</th>
              <th className="text-left px-3 py-2 font-medium">Provider</th>
              <th className="text-left px-3 py-2 font-medium">Uploaded By</th>
              <th className="text-left px-3 py-2 font-medium">Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {data.records.map((r) => (
              <tr key={r.id} onClick={() => setViewing(r.id)}
                className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer">
                <td className="px-3 py-2 text-slate-700">{fmtDate(r.recordDate)}</td>
                <td className="px-3 py-2 text-slate-800">{r.recordName}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.recordType || "—"}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.provider || "—"}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.uploadedByName}</td>
                <td className="px-3 py-2 text-xs text-slate-400">{fmt(r.uploadedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {uploadOpen && (
        <UploadRecordModal patientId={patientId} onClose={() => setUploadOpen(false)}
          onUploaded={() => setNonce((n) => n + 1)} />
      )}
      {viewing && (
        <Viewer patientId={patientId} header={header} recordId={viewing} perms={perms}
          onClose={() => setViewing(null)} onDeleted={() => setNonce((n) => n + 1)} />
      )}
    </div>
  );
}
