// Print medical records by date of service (sections 3-7).
//
// Pick a DOS, tick the records on that DOS, print. The selection is remembered per DOS while the
// dialog is open, so switching between dates and back does not clear it. The DOS is the REAL DOS
// stored on the record (section 3) - upload date is shown separately and never used as a
// substitute.
//
// Nothing existing changes: the list endpoint already supports a from/to date filter, and the
// download endpoint hands back file bytes.
//
// About printing:
//
// The professional print header (section 7) and the record separators are rendered in an isolated
// print window. That window has no application chrome and no responsive layout, so it prints
// cleanly regardless of the browser's normal reset styles.
//
// PDFs are embedded with <object>, which triggers each embedded PDF's own printer output when the
// window prints. Images are drawn as <img>. Anything else is refused with a stated reason - the
// print produces PAPER, so binary formats the browser cannot render on paper would print blank.
// The existing uploader accepts only PDF, JPEG and PNG, so in practice this refusal never fires.

import { useCallback, useEffect, useMemo, useState } from "react";
import { X, Printer, Loader2, AlertCircle, CheckSquare, Square } from "lucide-react";
import { api, API_BASE, getToken } from "./firebase/apiClient";

const card = "bg-white border border-slate-200 rounded-xl";
const input = "w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm";
const lbl = "block text-[11px] uppercase tracking-wide text-slate-400 mb-1";
const btn = "text-xs rounded-lg px-3 py-2 flex items-center gap-1.5 whitespace-nowrap";

const fmtDate = (s) => {
  if (!s) return "—";
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(s);
};

/**
 * Turns any decodable date string into a YYYY-MM-DD. Returns "" for anything unparseable rather
 * than substituting today - section 3 is explicit that upload date is not a DOS.
 */
function toIsoDate(v) {
  if (!v) return "";
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

async function downloadBytes(patientId, recordId) {
  // The existing download endpoint. Same permission and same audit trail; nothing new happens on
  // the server side for a print, which is deliberate - a print is HANDLED BY THE BROWSER after the
  // bytes have already been retrieved through the audited path.
  const res = await fetch(`${API_BASE}/api/patients/${encodeURIComponent(patientId)}` +
    `/records/${encodeURIComponent(recordId)}/download`, {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error(`could not fetch record ${recordId} (HTTP ${res.status})`);
  const type = res.headers.get("content-type") || "application/octet-stream";
  const blob = await res.blob();
  return { type, blob, url: URL.createObjectURL(blob) };
}

export default function PrintByDos({ patient, perms, onClose }) {
  const mayPrint = (perms || []).includes("MEDICAL_RECORD_DOWNLOAD");

  // Two callers, two shapes. The doctor workspace passes the /doctor/patients/.../header response,
  // which uses `patientId` and `mrn`; the Medical Record tab passes a Firestore-shaped row with
  // `id`. Both hold the patient identifier - a KeyError here was why the DOS picker read "No
  // records" for a patient whose records are visible in the list beside the dialog.
  const patientId = patient?.id || patient?.patientId || "";
  const mrn = patient?.mrn || patient?.id || patient?.patientId || "";
  const patientName = patient?.name || "";
  const patientDob = patient?.dob || "";

  const [dates, setDates] = useState([]);          // available DOS values with counts
  const [dos, setDos] = useState("");
  // Same key/result pattern the other screens use, so "still loading" is derived rather than a
  // flag set synchronously inside the effect. The eslint rule this satisfies (set-state-in-effect)
  // rejects the flag pattern outright.
  const [dosResult, setDosResult] = useState(null);   // { key, records }
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [error, setError] = useState("");

  // Selection is per DOS so switching dates does not lose it.
  const [selectionByDos, setSelectionByDos] = useState({});
  const selection = useMemo(() => selectionByDos[dos] || {}, [selectionByDos, dos]);
  const selectedIds = useMemo(
    () => Object.entries(selection).filter(([, on]) => on).map(([id]) => id),
    [selection]);

  const [printing, setPrinting] = useState(false);

  // Load every record once to build the DOS picker with counts. The endpoint caps at 200; a chart
  // with more than that will still show the most recent 200 dates.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api(`/api/patients/${encodeURIComponent(patientId)}/records`);
        if (!alive) return;
        const all = r.records || [];
        // Group by real DOS. A record whose date does not parse is dropped rather than filed under
        // an invented one - the print would carry a wrong date.
        const byDate = new Map();
        for (const rec of all) {
          const iso = toIsoDate(rec.recordDate);
          if (!iso) continue;
          const list = byDate.get(iso) || [];
          list.push(rec);
          byDate.set(iso, list);
        }
        const sorted = [...byDate.entries()]
          .sort((a, b) => b[0].localeCompare(a[0]))
          .map(([date, list]) => ({ date, count: list.length }));
        setDates(sorted);
        if (sorted.length > 0 && !dos) setDos(sorted[0].date);
      } catch (e) {
        if (alive) setError(e.message || "The records could not be loaded.");
      } finally {
        if (alive) setInitialLoaded(true);
      }
    })();
    return () => { alive = false; };
    // Empty deps on purpose: this loads once per open. `dos` above is only read to decide whether
    // to seed the picker - a state change from it would not add new records.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  // Load the records for the selected DOS.
  useEffect(() => {
    if (!dos) return;
    let alive = true;
    (async () => {
      try {
        const r = await api(`/api/patients/${encodeURIComponent(patientId)}/records?from=${dos}&to=${dos}`);
        if (alive) setDosResult({ key: dos, records: r.records || [] });
      } catch (e) {
        if (alive) setError(e.message || "Records for that date could not be loaded.");
      }
    })();
    return () => { alive = false; };
  }, [patientId, dos]);

  const records = useMemo(
    () => (dosResult?.key === dos ? dosResult.records : []),
    [dosResult, dos]);
  const dosLoading = !!dos && (!dosResult || dosResult.key !== dos);
  const loading = !initialLoaded;

  const toggleOne = useCallback((id) => {
    setSelectionByDos((s) => ({ ...s, [dos]: { ...(s[dos] || {}), [id]: !(s[dos] || {})[id] } }));
  }, [dos]);
  const selectAll = useCallback(() => {
    setSelectionByDos((s) => ({ ...s, [dos]: Object.fromEntries(records.map((r) => [r.id, true])) }));
  }, [dos, records]);
  const clearAll = useCallback(() => {
    setSelectionByDos((s) => ({ ...s, [dos]: {} }));
  }, [dos]);

  const doPrint = useCallback(async () => {
    if (selectedIds.length === 0 || printing) return;
    setPrinting(true);
    setError("");

    let win = null;
    const cleanupUrls = [];
    try {
      // Fetch every selected file in parallel, then build ONE print window and open it. Building it
      // first means the window is either fully populated or not opened at all.
      const chosen = records.filter((r) => selection[r.id]);
      const files = await Promise.all(chosen.map((r) =>
        downloadBytes(patientId, r.id).then((f) => ({ record: r, ...f }))));
      files.forEach((f) => cleanupUrls.push(f.url));

      const rejected = files.filter((f) => !/^(application[/]pdf|image[/](png|jpe?g))$/i.test(f.type));
      if (rejected.length === files.length) {
        throw new Error("None of the selected files are a printable format (PDF or image).");
      }
      const printable = files.filter((f) => !rejected.includes(f));

      // Popup blockers can refuse to open windows outside a user gesture. This IS a click, so it
      // normally works; when it does not, we say so rather than fail silently.
      win = window.open("", "_blank", "width=900,height=1100");
      if (!win) throw new Error(
        "The print window was blocked. Allow pop-ups for this site and try again.");

      const esc = (s) => String(s || "").replace(/[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

      const header = `
<div class="header">
  <div class="practice">${esc(patient?.practice || "Medical Record")}</div>
  <table class="who">
    <tr>
      <td><span class="lbl">Patient</span>${esc(patientName || "—")}</td>
      <td><span class="lbl">MRN</span>${esc(mrn)}</td>
      <td><span class="lbl">DOB</span>${esc(patientDob ? fmtDate(patientDob) : "—")}</td>
      <td><span class="lbl">Date of service</span>${esc(fmtDate(dos))}</td>
    </tr>
  </table>
  <div class="stamp">Printed ${esc(new Date().toLocaleString())}${rejected.length ? ` · ${rejected.length} file(s) skipped (not printable)` : ""}</div>
</div>`;

      const recordBlock = (f, index) => {
        const meta = `
<div class="record-header">
  <div class="rn">RECORD ${index + 1}${printable.length > 1 ? ` OF ${printable.length}` : ""} — ${esc(f.record.recordName)}</div>
  <div class="rm">
    ${f.record.recordType ? `${esc(f.record.recordType)} · ` : ""}
    ${f.record.provider ? `${esc(f.record.provider)} · ` : ""}
    ${f.record.facility ? `${esc(f.record.facility)} · ` : ""}
    Uploaded ${esc(new Date(f.record.uploadedAt).toLocaleDateString())} by ${esc(f.record.uploadedByName || "—")}
  </div>
</div>`;
        if (f.type === "application/pdf") {
          // <object> asks the browser's own PDF viewer to render the file. When the outer window
          // prints, most browsers include the embedded document; those that don't offer their own
          // print control in the viewer UI.
          return meta +
            `<object class="pdf" data="${f.url}#toolbar=0&navpanes=0" type="application/pdf"></object>`;
        }
        return meta + `<img class="img" src="${f.url}" alt="${esc(f.record.recordName)}" />`;
      };

      // The print stylesheet is on the print window, not the application, so it cannot leak into
      // the app's own layout.
      const html = `<!doctype html>
<html><head><meta charset="utf-8" />
<title>Medical Record — ${esc(patient.name || patient.id)}</title>
<style>
  @page { size: 8.5in 11in; margin: 0.5in; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000;
               font-family: "Helvetica Neue", Arial, sans-serif; font-size: 11pt; }
  .header { border-bottom: 1pt solid #000; padding-bottom: 8pt; margin-bottom: 12pt; }
  .practice { font-size: 14pt; font-weight: 700; margin-bottom: 4pt; text-align: center; }
  .who { width: 100%; border-collapse: collapse; margin-top: 4pt; }
  .who td { padding: 2pt 6pt; font-size: 10pt; }
  .who .lbl { display: block; font-size: 8pt; color: #666; text-transform: uppercase; }
  .stamp { font-size: 8pt; color: #666; margin-top: 4pt; text-align: right; }
  .record-header { margin-top: 14pt; margin-bottom: 6pt; page-break-inside: avoid;
                   border-top: 0.5pt solid #999; padding-top: 6pt; }
  .rn { font-size: 10pt; font-weight: 700; letter-spacing: 0.5pt; }
  .rm { font-size: 9pt; color: #444; margin-top: 2pt; }
  .pdf { width: 100%; height: 9in; border: 0; page-break-inside: avoid; }
  .img { max-width: 100%; max-height: 9in; page-break-inside: avoid; display: block; margin: 0 auto; }
  .footer { position: fixed; bottom: 0.25in; left: 0.5in; right: 0.5in;
            font-size: 8pt; color: #666; text-align: center; }
  @media print { .no-print { display: none; } }
</style></head>
<body>
  ${header}
  ${printable.map(recordBlock).join("\n")}
  <div class="footer">${esc(patientName || "")} · MRN ${esc(mrn)} · DOS ${esc(fmtDate(dos))}</div>
  <script>
    // Give embedded PDFs a moment to render before the print dialog opens - firing it too early
    // sometimes prints a blank page in place of the PDF.
    window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 350); });
  ${"<" + "/script>"}
</body></html>`;

      win.document.open();
      win.document.write(html);
      win.document.close();

      // Once the window has printed (or the user cancels), free the blob URLs.
      win.addEventListener("afterprint", () => {
        cleanupUrls.forEach((u) => URL.revokeObjectURL(u));
      }, { once: true });
      // Fallback: some browsers do not fire afterprint. Free everything after two minutes anyway.
      setTimeout(() => cleanupUrls.forEach((u) => URL.revokeObjectURL(u)), 120_000);

      if (rejected.length > 0) {
        setError(`${rejected.length} file(s) were not printable and were skipped: ` +
          rejected.map((f) => f.record.recordName).join(", "));
      }
    } catch (e) {
      cleanupUrls.forEach((u) => URL.revokeObjectURL(u));
      if (win) { try { win.close(); } catch { /* window already closed */ } }
      setError(e.message || "The print could not be prepared.");
    } finally {
      setPrinting(false);
    }
  }, [dos, patient, records, selection, selectedIds.length, printing]);

  const allChecked = records.length > 0 && records.every((r) => selection[r.id]);

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className={`${card} w-full max-w-2xl my-8`}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <div>
            <h3 className="font-semibold text-slate-800">Print medical record</h3>
            <p className="text-[11px] text-slate-500">Pick a date of service, tick the records to include, then print.</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        {!mayPrint && (
          <div className="m-5 bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-xs text-amber-900">
            You do not have permission to download medical record files. Ask an administrator for
            the Medical Record Download permission.
          </div>
        )}

        <div className="p-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            <label className="block">
              <span className={lbl}>Date of service</span>
              <select className={input} value={dos} onChange={(e) => setDos(e.target.value)} disabled={loading}>
                {dates.length === 0 && <option value="">No records</option>}
                {dates.map((d) => (
                  <option key={d.date} value={d.date}>
                    {fmtDate(d.date)} — {d.count} record{d.count === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              {records.length > 0 && (
                <p className="text-xs text-slate-500">
                  {records.length} record{records.length === 1 ? "" : "s"} found. {selectedIds.length} selected.
                </p>
              )}
            </div>
          </div>

          {error && (
            <div className="mb-3 bg-rose-50 border border-rose-200 rounded-lg p-2.5 flex items-start gap-2">
              <AlertCircle size={14} className="text-rose-600 mt-0.5 shrink-0" />
              <p className="text-xs text-rose-800">{error}</p>
            </div>
          )}

          {(loading || dosLoading) ? (
            <p className="text-sm text-slate-400 py-8 text-center">
              <Loader2 size={16} className="animate-spin inline mr-2" /> Loading…
            </p>
          ) : records.length === 0 ? (
            <p className="text-sm text-slate-400 py-8 text-center">
              No records on this date of service.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-2">
                <button onClick={allChecked ? clearAll : selectAll}
                  className={`${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`}>
                  {allChecked ? <><Square size={13} /> Clear selection</> : <><CheckSquare size={13} /> Select all</>}
                </button>
              </div>
              <div className="space-y-1">
                {records.map((r) => (
                  <label key={r.id} className="flex items-start gap-2 border border-slate-200 rounded-lg px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer">
                    <input type="checkbox" checked={!!selection[r.id]} onChange={() => toggleOne(r.id)} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="text-slate-800 font-medium truncate">{r.recordName}</div>
                      <div className="text-[11px] text-slate-500">
                        {[r.recordType, r.provider, r.facility].filter(Boolean).join(" · ")}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        DOS {fmtDate(r.recordDate)} · Uploaded {new Date(r.uploadedAt).toLocaleDateString()} by {r.uploadedByName || "—"}
                      </div>
                    </div>
                    <span className="text-[11px] text-slate-400 whitespace-nowrap">{r.fileType?.split("/")[1]?.toUpperCase() || ""}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-end gap-2">
          <p className="text-[11px] text-slate-400 mr-auto max-w-sm">
            The date shown is the REAL date of service, not the upload date. Files that are not PDF
            or image are skipped from the print with a message.
          </p>
          <button onClick={onClose} className={`${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`}>Cancel</button>
          <button onClick={doPrint} disabled={!mayPrint || selectedIds.length === 0 || printing}
            className={`${btn} bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-40`}>
            {printing ? <Loader2 size={13} className="animate-spin" /> : <Printer size={13} />}
            Print selected
          </button>
        </div>
      </div>
    </div>
  );
}
