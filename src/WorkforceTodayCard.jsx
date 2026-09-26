// The Today's Workforce tile on the dashboard (section 17).
//
// Shown only to an account that holds HR_WORKFORCE_VIEW, and every number comes from the same
// counts endpoint the Workforce screen uses - so the tile and the page can never disagree about how
// many people are present. Clicking a number opens Workforce with today's date and that filter
// already applied, which is the whole point of the tile.

import { useEffect, useState } from "react";
import { Users, ArrowRight } from "lucide-react";
import { getWorkforceCounts, today } from "./hrService";

const TILES = [
  { key: "scheduled", label: "Scheduled", tone: "text-slate-700 bg-slate-50" },
  { key: "present", label: "Present", tone: "text-emerald-700 bg-emerald-50" },
  { key: "pto", label: "PTO", tone: "text-violet-700 bg-violet-50" },
  { key: "absent", label: "Absent", tone: "text-rose-700 bg-rose-50" },
  { key: "late", label: "Late", tone: "text-amber-700 bg-amber-50" },
];

export default function WorkforceTodayCard({ onOpen }) {
  const [counts, setCounts] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    getWorkforceCounts({ date: today() })
      .then((r) => { if (alive) setCounts(r.counts || {}); })
      // A dashboard tile must never be the reason the dashboard fails to render, so a failure here
      // hides the tile rather than surfacing an error over the rest of the screen.
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  if (failed) return null;

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-slate-700 flex items-center gap-1.5">
          <Users size={15} /> Today&apos;s workforce
        </h3>
        <button onClick={() => onOpen(null)}
          className="text-xs text-teal-700 hover:underline flex items-center gap-1">
          Filter workforce <ArrowRight size={12} />
        </button>
      </div>

      <div className="grid grid-cols-5 gap-2">
        {TILES.map((t) => (
          <button key={t.key} onClick={() => onOpen(t.key)}
            className={`rounded-lg px-3 py-2.5 text-left hover:ring-1 hover:ring-slate-300 ${t.tone}`}>
            <div className="text-lg font-semibold tabular-nums">
              {counts ? (counts[t.key] ?? 0) : "—"}
            </div>
            <div className="text-[11px]">{t.label}</div>
          </button>
        ))}
      </div>

      {counts && counts.all === 0 && (
        <p className="text-[11px] text-slate-400 mt-2">
          No employee records yet. Workforce counts appear once staff are recorded in HR.
        </p>
      )}
      {counts && counts.pending_requests > 0 && (
        <button onClick={() => onOpen("pending")}
          className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mt-2">
          {counts.pending_requests} pending leave request{counts.pending_requests === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}
