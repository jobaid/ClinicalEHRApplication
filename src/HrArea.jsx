// The HR tab: Workforce (read) and Manage (write), as two views of the same module.
//
// They are separated because they answer different questions. Workforce answers "who is here
// today"; Manage answers "record what happened and what is planned". Mixing editing controls into
// the reporting screen would make the thing an HR user looks at twenty times a day busier for the
// sake of the thing they do occasionally.
//
// The Manage view appears only for somebody holding at least one write grant, so a user who may
// only look never sees a tab that would refuse them.

import { useMemo, useState } from "react";
import { Users, PencilLine } from "lucide-react";
import Workforce from "./Workforce";
import HrManage from "./HrManage";

const WRITE_GRANTS = [
  "HR_EMPLOYEE_MANAGE",
  "HR_SCHEDULE_MANAGE",
  "HR_ATTENDANCE_MANAGE",
  "HR_LEAVE_MANAGE",
  "HR_CONFIG_MANAGE",
];

export default function HrArea({ permissions, initialDate, initialQuick }) {
  const canManage = useMemo(
    () => WRITE_GRANTS.some((g) => (permissions || []).includes(g)),
    [permissions]);

  const [view, setView] = useState("workforce");

  // Nothing to switch between without a write grant, so the toggle is not rendered at all rather
  // than rendered disabled.
  if (!canManage) {
    return <Workforce permissions={permissions} initialDate={initialDate} initialQuick={initialQuick} />;
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-4">
        {[
          { key: "workforce", label: "Workforce", icon: Users },
          { key: "manage", label: "Manage", icon: PencilLine },
        ].map((t) => (
          <button key={t.key} onClick={() => setView(t.key)}
            className={`text-xs rounded-lg px-3 py-2 flex items-center gap-1.5 border ${
              view === t.key
                ? "bg-slate-900 text-white border-slate-900"
                : "border-slate-200 bg-white hover:bg-slate-50"}`}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>

      {/* Both stay mounted so switching back to Workforce does not refetch and lose the filters
          an HR user had set up. */}
      <div className={view === "workforce" ? "" : "hidden"}>
        <Workforce permissions={permissions} initialDate={initialDate} initialQuick={initialQuick} />
      </div>
      <div className={view === "manage" ? "" : "hidden"}>
        <HrManage permissions={permissions} />
      </div>
    </div>
  );
}
