// CMS-1500 (HCFA) preview and printing.
//
// Added alongside the existing claim screens - nothing existing is changed. Every value comes
// from records the application already holds; nothing is stored for this feature and no claim
// is duplicated to support it. The field map, data mapping and validation live in
// cms1500Form.js.

import { useCallback, useEffect, useMemo, useState } from "react";
import { X, Printer, Crosshair, Save, RotateCcw } from "lucide-react";
import {
  CMS1500_FIELDS, LINE_COLS, LINE_TOP, LINE_STEP, MAX_SERVICE_LINES, PAGE,
  buildCms1500, validateCms1500, loadAlignment, saveAlignment,
} from "./cms1500Form";

// ---------- rendering ----------

// One absolutely positioned value. Inches throughout, because the target is a physical sheet -
// pixels would depend on the browser's zoom and the printer's DPI.
function Box({ x, y, w, value, align, bold }) {
  if (!String(value ?? "").trim()) return null;
  return (
    <div style={{
      position: "absolute", left: `${x}in`, top: `${y}in`, width: `${w}in`,
      fontFamily: '"Courier New", Courier, monospace', fontSize: "9pt", lineHeight: 1,
      whiteSpace: "nowrap", overflow: "hidden", textAlign: align || "left",
      fontWeight: bold ? 700 : 400, color: "#000",
    }}>{value}</div>
  );
}

/**
 * The sheet. `withForm` draws a light guide grid and box outlines; preprinted mode draws only
 * the data, because the boxes are already on the paper.
 */
export function Cms1500Sheet({ data, alignment, withForm, showGuides }) {
  const a = alignment || { x: 0, y: 0 };
  const off = (v, axis) => v + (axis === "x" ? a.x : a.y);

  return (
    <div
      className="cms1500-sheet"
      style={{
        position: "relative", width: `${PAGE.width}in`, height: `${PAGE.height}in`,
        background: "#fff", overflow: "hidden",
      }}
    >
      {withForm && (
        // A representation of the form, not a reproduction of it: the official CMS-1500 is
        // printed in OCR-readable red drop-out ink and a black facsimile is not a substitute for
        // the real stock where a payer requires scannable originals.
        <>
          {CMS1500_FIELDS.map((f) => (
            <div key={"o" + f.box} style={{
              position: "absolute", left: `${off(f.x, "x") - 0.04}in`, top: `${off(f.y, "y") - 0.13}in`,
              width: `${f.w + 0.08}in`, height: "0.22in",
              border: "0.5pt solid #bbb", borderRadius: "1pt",
            }} />
          ))}
          {Array.from({ length: MAX_SERVICE_LINES }).map((_, i) =>
            LINE_COLS.map((c) => (
              <div key={`o${i}${c.key}`} style={{
                position: "absolute", left: `${off(c.x, "x") - 0.03}in`,
                top: `${off(LINE_TOP + i * LINE_STEP, "y") - 0.12}in`,
                width: `${c.w + 0.06}in`, height: "0.2in",
                border: "0.5pt solid #ccc",
              }} />
            ))
          )}
        </>
      )}

      {showGuides && CMS1500_FIELDS.map((f) => (
        <div key={"g" + f.box} style={{
          position: "absolute", left: `${off(f.x, "x")}in`, top: `${off(f.y, "y") - 0.15}in`,
          fontSize: "5pt", color: "#3b82f6", fontFamily: "sans-serif",
        }}>{f.box}</div>
      ))}

      {CMS1500_FIELDS.map((f) => (
        <Box key={f.box} x={off(f.x, "x")} y={off(f.y, "y")} w={f.w}
          value={data.boxes[f.box]} align={f.align} />
      ))}

      {data.serviceLines.map((line, i) =>
        LINE_COLS.map((c) => (
          <Box key={`${i}-${c.key}`} x={off(c.x, "x")} y={off(LINE_TOP + i * LINE_STEP, "y")}
            w={c.w} value={line[c.key]} align={c.align} />
        ))
      )}
    </div>
  );
}

// The print stylesheet. Fixed page size, no margins, nothing from the application chrome -
// section 12 requires the renderer to own the layout rather than inherit the responsive screen.
const PRINT_CSS = `
@page { size: ${PAGE.width}in ${PAGE.height}in; margin: 0; }
@media print {
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body * { visibility: hidden !important; }
  .cms1500-sheet, .cms1500-sheet * { visibility: visible !important; }
  .cms1500-sheet { position: absolute !important; left: 0 !important; top: 0 !important;
                   page-break-after: always; }
}`;

// ---------- the modal ----------

export default function Cms1500Modal({ charges, patient, policy, practice, onClose, onAudit }) {
  const [mode, setMode] = useState("preprinted");   // preprinted | withform
  const [align, setAlign] = useState(loadAlignment);
  const [showGuides, setShowGuides] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [saved, setSaved] = useState(false);

  const data = useMemo(
    () => buildCms1500({ charges, patient, policy, practice }),
    [charges, patient, policy, practice]);

  const problems = useMemo(() => validateCms1500(data), [data]);

  // A calibration sheet: every field prints its own box number, so a misaligned run shows
  // immediately which way to nudge. Section 14 - no real claim is needed to test alignment.
  const testData = useMemo(() => ({
    boxes: Object.fromEntries(CMS1500_FIELDS.map((f) => [f.box, f.box])),
    serviceLines: Array.from({ length: MAX_SERVICE_LINES }).map((_, i) =>
      Object.fromEntries(LINE_COLS.map((c) => [c.key, `${i + 1}${c.key.slice(0, 2)}`]))),
    total: 0,
  }), []);

  const nudge = useCallback((axis, delta) => {
    setAlign((a) => ({ ...a, [axis]: Math.round((a[axis] + delta) * 100) / 100 }));
    setSaved(false);
  }, []);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = PRINT_CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  function doPrint(kind) {
    onAudit?.(kind);
    window.print();
  }

  const shown = testMode ? testData : data;

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4 print:p-0 print:bg-white">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-[1100px] h-[92vh] flex flex-col print:h-auto print:max-w-none print:shadow-none print:rounded-none">

        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 print:hidden">
          <h3 className="font-semibold text-slate-800">CMS-1500 (HCFA)</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        <div className="px-5 py-2.5 border-b border-slate-200 flex items-center gap-2 flex-wrap print:hidden">
          <div className="flex rounded-lg border border-slate-200 overflow-hidden">
            <button onClick={() => setMode("preprinted")}
              className={`text-xs px-3 py-1.5 ${mode === "preprinted" ? "bg-slate-900 text-white" : "hover:bg-slate-50"}`}>
              Preprinted paper
            </button>
            <button onClick={() => setMode("withform")}
              className={`text-xs px-3 py-1.5 ${mode === "withform" ? "bg-slate-900 text-white" : "hover:bg-slate-50"}`}>
              With form
            </button>
          </div>

          <label className="text-xs text-slate-600 flex items-center gap-1.5 ml-1">
            <input type="checkbox" checked={showGuides} onChange={(e) => setShowGuides(e.target.checked)} />
            Box numbers
          </label>
          <label className="text-xs text-slate-600 flex items-center gap-1.5">
            <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} />
            Alignment test page
          </label>

          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-[11px] text-slate-500">Offset in</span>
            <button onClick={() => nudge("x", -0.05)} className="text-xs border border-slate-200 rounded px-1.5 py-1">←</button>
            <span className="text-xs w-12 text-center tabular-nums">{align.x.toFixed(2)}</span>
            <button onClick={() => nudge("x", 0.05)} className="text-xs border border-slate-200 rounded px-1.5 py-1">→</button>
            <button onClick={() => nudge("y", -0.05)} className="text-xs border border-slate-200 rounded px-1.5 py-1">↑</button>
            <span className="text-xs w-12 text-center tabular-nums">{align.y.toFixed(2)}</span>
            <button onClick={() => nudge("y", 0.05)} className="text-xs border border-slate-200 rounded px-1.5 py-1">↓</button>
            <button onClick={() => { saveAlignment(align); setSaved(true); }}
              className="text-xs border border-slate-200 rounded-lg px-2 py-1 hover:bg-slate-50 flex items-center gap-1">
              <Save size={12} /> {saved ? "Saved" : "Save"}
            </button>
            <button onClick={() => { setAlign({ x: 0, y: 0 }); setSaved(false); }}
              title="Reset offsets" className="text-xs border border-slate-200 rounded-lg px-2 py-1 hover:bg-slate-50">
              <RotateCcw size={12} />
            </button>
          </div>
        </div>

        {problems.length > 0 && !testMode && (
          <div className="px-5 py-2 bg-amber-50 border-b border-amber-200 print:hidden">
            <p className="text-xs font-medium text-amber-900 mb-1">
              {problems.length} field{problems.length === 1 ? "" : "s"} incomplete — the form can still be printed
            </p>
            <ul className="text-[11px] text-amber-800 list-disc pl-4 max-h-16 overflow-y-auto">
              {problems.map((p, i) => <li key={i}>{p.message}</li>)}
            </ul>
          </div>
        )}

        <div className="flex-1 overflow-auto bg-slate-200 p-4 print:p-0 print:bg-white print:overflow-visible">
          <div className="mx-auto shadow-lg print:shadow-none" style={{ width: `${PAGE.width}in` }}>
            <Cms1500Sheet data={shown} alignment={align}
              withForm={mode === "withform"} showGuides={showGuides} />
          </div>
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex items-center gap-2 print:hidden">
          <p className="text-[11px] text-slate-500 mr-auto max-w-lg">
            {mode === "preprinted"
              ? "Only the data prints. Load preprinted CMS-1500 stock and calibrate with the alignment test page before running real claims."
              : "Prints a representation of the form with the data. Not a substitute for official scannable red-ink stock where a payer requires it."}
          </p>
          <button onClick={() => { setTestMode(true); setTimeout(() => doPrint("HCFA alignment test printed"), 50); }}
            className="text-xs border border-slate-200 rounded-lg px-3 py-2 hover:bg-slate-50 flex items-center gap-1.5">
            <Crosshair size={13} /> Test print
          </button>
          <button onClick={() => doPrint(mode === "preprinted" ? "HCFA printed (preprinted paper)" : "HCFA printed (with form)")}
            className="text-xs bg-slate-900 text-white rounded-lg px-4 py-2 hover:bg-slate-800 flex items-center gap-1.5">
            <Printer size={13} /> Print
          </button>
        </div>
      </div>
    </div>
  );
}
