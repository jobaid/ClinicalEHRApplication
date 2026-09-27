// HR data entry: the employee form, the rota, the day sheet and leave approvals.
//
// Added alongside the Workforce screen, which is unchanged - these are the screens that WRITE the
// data Workforce reads.
//
// Each one is behind its own grant and simply does not render without it, so a user who may publish
// a rota but not decide leave sees a rota editor and no approvals queue.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  X, Save, Loader2, AlertCircle, CheckCircle2, CalendarDays, ClipboardList,
  UserPlus, Settings2, Check, Ban,
} from "lucide-react";
import {
  getOptions, getWorkforce, createEmployee, updateEmployee, getEmployee,
  saveSchedule, saveAttendance, listLeave, decideLeave, createLeave, saveHrConfig,
  today, prettyDate, statusMeta, TONE_CLASS,
} from "./hrService";
import { EmployeeDocuments } from "./ProfileSettings";

const card = "bg-white border border-slate-200 rounded-xl";
const input = "w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm";
const lbl = "block text-[11px] uppercase tracking-wide text-slate-400 mb-1";
const btn = "text-xs rounded-lg px-3 py-2 flex items-center gap-1.5 whitespace-nowrap";
const primary = `${btn} bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-40`;
const plain = `${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`;

// A real <label> wrapping its control, not a <div> with a <span> above it.
//
// Implicit label association is what gives the input an accessible name. Written as a div, every
// field in this form is announced to a screen reader as an unlabelled text box - which is the same
// defect already recorded against the sign-in password field, and there is no reason to add more.
function Field({ label, children, hint }) {
  return (
    <label className="block">
      <span className={lbl}>{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-400 mt-0.5">{hint}</span>}
    </label>
  );
}

function Problems({ list }) {
  if (!list?.length) return null;
  return (
    <div className="bg-rose-50 border border-rose-200 rounded-lg p-2.5 mb-3">
      <ul className="text-xs text-rose-800 list-disc pl-4 space-y-0.5">
        {list.map((p, i) => <li key={i}>{p}</li>)}
      </ul>
    </div>
  );
}

function Banner({ tone = "emerald", children }) {
  const cls = tone === "emerald"
    ? "bg-emerald-50 border-emerald-200 text-emerald-800"
    : "bg-amber-50 border-amber-200 text-amber-900";
  return <div className={`border rounded-lg p-2.5 mb-3 text-xs ${cls}`}>{children}</div>;
}

// ---------- 1. the employee form ----------

const BLANK = {
  name: "", email: "", role: "RECEPTIONIST", employeeNo: "",
  departmentId: "", jobTitleId: "", locationId: "", managerUserId: "",
  employmentType: "", employmentStatus: "ACTIVE", workArrangement: "",
  defaultShiftId: "", hireDate: "", terminationDate: "", workPhone: "",
};

export function EmployeeForm({ userId, options, staff, onClose, onSaved }) {
  const editing = !!userId;
  const [form, setForm] = useState(BLANK);
  const [loaded, setLoaded] = useState(!editing);
  const [problems, setProblems] = useState([]);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) return;
    let alive = true;
    (async () => {
      try {
        const e = await getEmployee(userId);
        if (!alive) return;
        // Ids, not labels: the form edits references, and the profile returns both.
        const byLabel = (list, label) => (list || []).find((o) => o.label === label)?.id || "";
        setForm({
          ...BLANK,
          name: e.name || "",
          employeeNo: e.employeeNo || "",
          departmentId: byLabel(options.departments, e.department),
          jobTitleId: byLabel(options.jobTitles, e.jobTitle),
          locationId: byLabel(options.locations, e.location),
          managerUserId: (staff || []).find((s) => s.name === e.manager)?.userId || "",
          employmentType: e.employmentType || "",
          employmentStatus: e.employmentStatus || "ACTIVE",
          workArrangement: e.workArrangement || "",
          hireDate: e.hireDate || "",
          terminationDate: e.terminationDate || "",
          workPhone: e.workPhone || "",
        });
        setLoaded(true);
      } catch (err) {
        if (alive) { setError(err.message || "This employee could not be loaded."); setLoaded(true); }
      }
    })();
    return () => { alive = false; };
  }, [editing, userId, options, staff]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    setBusy(true); setProblems([]); setError(""); setNote("");
    try {
      const res = editing ? await updateEmployee(userId, form) : await createEmployee(form);
      if (res.note) setNote(res.note);
      onSaved?.(res);
      if (!res.note) onClose();
    } catch (e) {
      // The server returns a list of what is wrong; show all of it rather than the first.
      if (e.body?.problems) setProblems(e.body.problems);
      else setError(e.message || "The employee could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const opt = (list) => (list || []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>);

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl my-8">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h3 className="font-semibold text-slate-800">
            {editing ? "Edit employee" : "Add employee"}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        <div className="p-5">
          {!loaded ? (
            <p className="text-sm text-slate-400 py-8 text-center">
              <Loader2 size={16} className="animate-spin inline mr-2" /> Loading…
            </p>
          ) : (
            <>
              <Problems list={problems} />
              {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2.5 mb-3 text-xs text-rose-800">{error}</div>}
              {note && <Banner tone="amber">{note}</Banner>}

              {!editing && (
                <Banner tone="amber">
                  An employee is an account in this application, so adding one creates a user. It is
                  created <strong>disabled and without a password</strong> — give this person access
                  from User accounts in Settings only if they need to sign in.
                </Banner>
              )}

              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <Field label="Full name">
                  <input className={input} value={form.name} onChange={set("name")} />
                </Field>
                <Field label="Email" hint={editing ? "Changed from User accounts" : "Identifies the account"}>
                  <input className={input} type="email" value={form.email} onChange={set("email")}
                    disabled={editing} placeholder={editing ? "—" : "name@practice.com"} />
                </Field>
                <Field label="Employee ID">
                  <input className={input} value={form.employeeNo} onChange={set("employeeNo")} />
                </Field>

                <Field label="Department">
                  <select className={input} value={form.departmentId} onChange={set("departmentId")}>
                    <option value="">—</option>{opt(options.departments)}
                  </select>
                </Field>
                <Field label="Job title">
                  <select className={input} value={form.jobTitleId} onChange={set("jobTitleId")}>
                    <option value="">—</option>{opt(options.jobTitles)}
                  </select>
                </Field>
                <Field label="Work location">
                  <select className={input} value={form.locationId} onChange={set("locationId")}>
                    <option value="">—</option>{opt(options.locations)}
                  </select>
                </Field>

                <Field label="Manager">
                  <select className={input} value={form.managerUserId} onChange={set("managerUserId")}>
                    <option value="">—</option>
                    {(staff || []).filter((s) => s.userId !== userId)
                      .map((s) => <option key={s.userId} value={s.userId}>{s.name}</option>)}
                  </select>
                </Field>
                <Field label="Employment type">
                  <select className={input} value={form.employmentType} onChange={set("employmentType")}>
                    <option value="">—</option>{opt(options.employmentTypes)}
                  </select>
                </Field>
                <Field label="Employment status">
                  <select className={input} value={form.employmentStatus} onChange={set("employmentStatus")}>
                    {opt(options.employmentStatuses)}
                  </select>
                </Field>

                <Field label="Work arrangement">
                  <select className={input} value={form.workArrangement} onChange={set("workArrangement")}>
                    <option value="">—</option>{opt(options.workArrangements)}
                  </select>
                </Field>
                <Field label="Usual shift" hint="Used when a rota day names no shift">
                  <select className={input} value={form.defaultShiftId} onChange={set("defaultShiftId")}>
                    <option value="">—</option>{opt(options.shifts)}
                  </select>
                </Field>
                <Field label="Work phone">
                  <input className={input} value={form.workPhone} onChange={set("workPhone")} />
                </Field>

                <Field label="Hire date">
                  <input className={input} type="date" value={form.hireDate} onChange={set("hireDate")} />
                </Field>
                <Field label="Termination date" hint="Leave blank for current staff">
                  <input className={input} type="date" value={form.terminationDate}
                    onChange={set("terminationDate")} />
                </Field>
                {!editing && (
                  <Field label="Application role" hint="Only applies if they are later given access">
                    <select className={input} value={form.role} onChange={set("role")}>
                      {["RECEPTIONIST", "NURSE", "BILLER", "DOCTOR", "HIM", "HUMAN_RESOURCE", "MANAGER"].map((r) =>
                        <option key={r} value={r}>{r}</option>)}
                    </select>
                  </Field>
                )}
              </div>

              <p className="text-[11px] text-slate-400 mt-4">
                Employees are never deleted. Somebody who leaves gets a termination date and a
                status of Resigned, Terminated or Retired, which keeps their attendance and leave
                history intact.
              </p>

              {editing && (
                <div className="mt-5 pt-4 border-t border-slate-200">
                  <EmployeeDocuments userId={userId} canManage />
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button onClick={onClose} className={plain}>{note ? "Close" : "Cancel"}</button>
          <button onClick={submit} disabled={busy || !loaded} className={primary}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {editing ? "Save changes" : "Add employee"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 2. the rota ----------

function RotaEditor({ options, staff, onDone }) {
  const [form, setForm] = useState({
    userId: "", from: today(), to: today(), shiftId: "", isDayOff: false, skipWeekend: true, note: "",
  });
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  async function submit() {
    setBusy(true); setError(""); setResult("");
    try {
      const r = await saveSchedule(form);
      setResult(`Saved ${r.days} day${r.days === 1 ? "" : "s"}.`);
      onDone?.();
    } catch (e) {
      setError(e.message || "The rota could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${card} p-4 max-w-3xl`}>
      <h3 className="text-sm font-semibold text-slate-800 mb-1">Publish a rota</h3>
      <p className="text-[11px] text-slate-400 mb-4">
        Sets one person&apos;s rota across a range of dates. Re-running over the same dates replaces
        them, so a correction is just a second publish.
      </p>

      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2.5 mb-3 text-xs text-rose-800">{error}</div>}
      {result && <Banner>{result}</Banner>}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Field label="Employee">
          <select className={input} value={form.userId} onChange={set("userId")}>
            <option value="">Select…</option>
            {(staff || []).map((s) => <option key={s.userId} value={s.userId}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="From"><input type="date" className={input} value={form.from} onChange={set("from")} /></Field>
        <Field label="To"><input type="date" className={input} value={form.to} onChange={set("to")} /></Field>

        <Field label="Shift">
          <select className={input} value={form.shiftId} onChange={set("shiftId")} disabled={form.isDayOff}>
            <option value="">Use their usual shift</option>
            {(options.shifts || []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Note"><input className={input} value={form.note} onChange={set("note")} /></Field>
        <div className="flex flex-col justify-end gap-1.5 pb-1">
          <label className="text-xs text-slate-600 flex items-center gap-1.5">
            <input type="checkbox" checked={form.skipWeekend} onChange={set("skipWeekend")} />
            Skip Saturdays and Sundays
          </label>
          <label className="text-xs text-slate-600 flex items-center gap-1.5">
            <input type="checkbox" checked={form.isDayOff} onChange={set("isDayOff")} />
            Mark these days as off
          </label>
        </div>
      </div>

      <button onClick={submit} disabled={busy || !form.userId} className={`${primary} mt-4`}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <CalendarDays size={13} />} Publish
      </button>
    </div>
  );
}

// ---------- 3. the day sheet ----------

function DaySheet({ options, onDone }) {
  const [date, setDate] = useState(today());
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  // The result carries the key that produced it, so "still loading" is derived rather than tracked
  // in a flag that would have to be set synchronously inside the effect.
  const [result, setResult] = useState(null);   // { key, rows }
  const key = `${date}#${reload}`;
  const loading = !result || result.key !== key;
  const rows = result?.rows || [];

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await getWorkforce({ date, limit: 200, today: "scheduled" });
        if (alive) { setResult({ key, rows: r.employees || [] }); setError(""); }
      } catch (e) {
        if (alive) setError(e.message || "The day sheet could not be loaded.");
      }
    })();
    return () => { alive = false; };
  }, [date, reload, key]);

  const record = useCallback(async (userId, status) => {
    setSaving(userId); setError("");
    try {
      // The clock-in is stamped only for the statuses where arriving is what happened. Recording a
      // clock-in for somebody marked Absent would be a contradiction in the data.
      const arriving = ["PRESENT", "LATE", "REMOTE"].includes(status);
      await saveAttendance({
        userId, date, status,
        clockIn: arriving ? new Date().toISOString() : "",
      });
      setReload((n) => n + 1);
      onDone?.();
    } catch (e) {
      setError(e.message || "That could not be recorded.");
    } finally {
      setSaving("");
    }
  }, [date, onDone]);

  const statuses = (options.attendanceStatuses || []).map((s) => s.id);

  return (
    <div className={`${card} p-4`}>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-slate-800">Day sheet</h3>
        <input type="date" className={`${input} w-40`} value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <p className="text-[11px] text-slate-400 mb-4">
        Everyone rostered on {prettyDate(date)}. Recording attendance stamps a clock-in for Present,
        Late and Remote only.
      </p>

      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2.5 mb-3 text-xs text-rose-800">{error}</div>}

      {loading ? (
        <p className="text-sm text-slate-400 py-8 text-center">
          <Loader2 size={16} className="animate-spin inline mr-2" /> Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-slate-400 py-8 text-center">
          Nobody is rostered on this date. Publish a rota first.
        </p>
      ) : (
        <div className="space-y-1">
          {rows.map((e) => (
            <div key={e.userId} className="flex items-center gap-2 py-1.5 border-b border-slate-100 last:border-0">
              <span className="text-sm text-slate-800 w-40 truncate">{e.name}</span>
              <span className="text-xs text-slate-400 w-28 truncate">{e.department}</span>
              <span className="text-xs text-slate-500 w-24">
                {e.scheduleStart ? `${e.scheduleStart}–${e.scheduleEnd}` : "—"}
              </span>
              <span className={`text-[11px] px-2 py-0.5 rounded-full border w-32 text-center ${
                TONE_CLASS[statusMeta(e.todayStatus).tone]}`}>
                {statusMeta(e.todayStatus).label}
              </span>
              <div className="flex gap-1 ml-auto">
                {saving === e.userId
                  ? <Loader2 size={13} className="animate-spin text-slate-400" />
                  : statuses.map((st) => (
                    <button key={st} onClick={() => record(e.userId, st)}
                      className="text-[11px] border border-slate-200 rounded px-1.5 py-1 hover:bg-slate-50">
                      {statusMeta(st).label}
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- 4. leave approvals ----------

function LeaveQueue({ options, staff, mayDecide, onDone }) {
  const [requests, setRequests] = useState([]);
  const [filter, setFilter] = useState("PENDING");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [reload, setReload] = useState(0);
  const [showNew, setShowNew] = useState(false);
  const [draft, setDraft] = useState({ userId: "", leaveType: "PTO", start: today(), end: today(), hours: "" });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await listLeave(filter);
        if (alive) { setRequests(r.requests || []); setError(""); }
      } catch (e) {
        if (alive) setError(e.message || "The leave requests could not be loaded.");
      }
    })();
    return () => { alive = false; };
  }, [filter, reload]);

  async function decide(id, decision) {
    setBusy(id); setError("");
    try {
      await decideLeave(id, decision);
      setReload((n) => n + 1);
      onDone?.();
    } catch (e) {
      setError(e.message || "The decision could not be recorded.");
    } finally {
      setBusy("");
    }
  }

  async function raise() {
    setError("");
    try {
      await createLeave({ ...draft, hours: draft.hours ? Number(draft.hours) : null });
      setShowNew(false);
      setDraft({ userId: "", leaveType: "PTO", start: today(), end: today(), hours: "" });
      setReload((n) => n + 1);
      onDone?.();
    } catch (e) {
      setError(e.message || "The request could not be raised.");
    }
  }

  const tone = (s) => (s === "APPROVED" ? "emerald" : s === "PENDING" ? "amber"
    : s === "DENIED" ? "rose" : "slate");

  return (
    <div className={`${card} p-4`}>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-slate-800">Leave</h3>
        <div className="flex items-center gap-1.5">
          <select className={`${input} w-32`} value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="DENIED">Denied</option>
            <option value="">All</option>
          </select>
          {mayDecide && (
            <button onClick={() => setShowNew((v) => !v)} className={plain}>Raise a request</button>
          )}
        </div>
      </div>
      <p className="text-[11px] text-slate-400 mb-4">
        A decision is recorded once, with who made it and when. A refused or cancelled request is
        superseded by a new one rather than edited.
      </p>

      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2.5 mb-3 text-xs text-rose-800">{error}</div>}

      {showNew && (
        <div className="border border-slate-200 rounded-lg p-3 mb-3 grid grid-cols-2 md:grid-cols-5 gap-2">
          <Field label="Employee">
            <select className={input} value={draft.userId}
              onChange={(e) => setDraft({ ...draft, userId: e.target.value })}>
              <option value="">Select…</option>
              {(staff || []).map((s) => <option key={s.userId} value={s.userId}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select className={input} value={draft.leaveType}
              onChange={(e) => setDraft({ ...draft, leaveType: e.target.value })}>
              {(options.leaveTypes || []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="From">
            <input type="date" className={input} value={draft.start}
              onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
          </Field>
          <Field label="To">
            <input type="date" className={input} value={draft.end}
              onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
          </Field>
          <div className="flex items-end">
            <button onClick={raise} disabled={!draft.userId} className={primary}>Raise</button>
          </div>
        </div>
      )}

      {requests.length === 0 ? (
        <p className="text-xs text-slate-400 py-8 text-center">Nothing here.</p>
      ) : (
        <div className="space-y-1">
          {requests.map((rq) => (
            <div key={rq.id} className="flex items-center gap-2 py-1.5 border-b border-slate-100 last:border-0">
              <span className="text-sm text-slate-800 w-40 truncate">{rq.name}</span>
              <span className="text-xs text-slate-400 w-24 truncate">{rq.department}</span>
              <span className="text-xs text-slate-600 w-20">{rq.leaveType}</span>
              <span className="text-xs text-slate-500 flex-1">
                {rq.start} → {rq.end} · {rq.days} day{rq.days === 1 ? "" : "s"}
              </span>
              <span className={`text-[11px] px-2 py-0.5 rounded-full border ${TONE_CLASS[tone(rq.status)]}`}>
                {rq.status}
              </span>
              {rq.decidedBy && (
                <span className="text-[11px] text-slate-400 w-32 truncate">by {rq.decidedBy}</span>
              )}
              {mayDecide && rq.status === "PENDING" && (
                <div className="flex gap-1">
                  {busy === rq.id ? <Loader2 size={13} className="animate-spin text-slate-400" /> : (
                    <>
                      <button onClick={() => decide(rq.id, "APPROVED")}
                        className="text-[11px] border border-emerald-200 bg-emerald-50 text-emerald-700 rounded px-2 py-1 flex items-center gap-1">
                        <Check size={11} /> Approve
                      </button>
                      <button onClick={() => decide(rq.id, "DENIED")}
                        className="text-[11px] border border-rose-200 bg-rose-50 text-rose-700 rounded px-2 py-1 flex items-center gap-1">
                        <Ban size={11} /> Refuse
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- 5. org configuration ----------

const CONFIG_KINDS = [
  { kind: "departments", label: "Departments", optionKey: "departments" },
  { kind: "job-titles", label: "Job titles", optionKey: "jobTitles" },
  { kind: "locations", label: "Work locations", optionKey: "locations" },
];

function OrgSetup({ options, onDone }) {
  const [name, setName] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  async function add(kind) {
    const value = (name[kind] || "").trim();
    if (!value) return;
    setBusy(kind); setError("");
    try {
      await saveHrConfig(kind, { name: value });
      setName((n) => ({ ...n, [kind]: "" }));
      onDone?.();
    } catch (e) {
      setError(e.message || "That could not be saved.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className={`${card} p-4 max-w-3xl`}>
      <h3 className="text-sm font-semibold text-slate-800 mb-1">Organisation setup</h3>
      <p className="text-[11px] text-slate-400 mb-4">
        These fill the filter dropdowns on Workforce. Nothing here can be deleted — a department
        with history behind it would orphan the employees and reports referencing it. Deactivating
        one hides it from the filters and keeps the history.
      </p>

      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2.5 mb-3 text-xs text-rose-800">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {CONFIG_KINDS.map(({ kind, label, optionKey }) => (
          <div key={kind}>
            <span className={lbl}>{label}</span>
            <div className="flex gap-1 mb-2">
              <input className={input} value={name[kind] || ""}
                onChange={(e) => setName((n) => ({ ...n, [kind]: e.target.value }))}
                placeholder="Add new…"
                onKeyDown={(e) => { if (e.key === "Enter") add(kind); }} />
              <button onClick={() => add(kind)} disabled={busy === kind} className={plain}>
                {busy === kind ? <Loader2 size={12} className="animate-spin" /> : "Add"}
              </button>
            </div>
            <ul className="text-xs text-slate-600 space-y-0.5 max-h-48 overflow-y-auto">
              {(options[optionKey] || []).map((o) => (
                <li key={o.id} className="px-2 py-1 bg-slate-50 rounded">{o.label}</li>
              ))}
              {(options[optionKey] || []).length === 0 && (
                <li className="text-slate-300 px-2">none yet</li>
              )}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-4 pt-4 border-t border-slate-100">
        <span className={lbl}>Shifts</span>
        <ul className="text-xs text-slate-600 flex flex-wrap gap-1.5 mt-1">
          {(options.shifts || []).map((o) => (
            <li key={o.id} className="px-2 py-1 bg-slate-50 rounded">{o.label}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------- the manage screen ----------

export default function HrManage({ permissions }) {
  const perms = useMemo(() => new Set(permissions || []), [permissions]);
  const may = useCallback((p) => perms.has(p), [perms]);

  const [options, setOptions] = useState({});
  const [staff, setStaff] = useState([]);
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState(null);   // userId | "new" | null

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [o, w] = await Promise.all([getOptions(), getWorkforce({ limit: 200 })]);
        if (!alive) return;
        setOptions(o || {});
        setStaff((w.employees || []).map((e) => ({ userId: e.userId, name: e.name })));
      } catch { /* the sub-screens show their own errors */ }
    })();
    return () => { alive = false; };
  }, [refresh]);

  const bump = useCallback(() => setRefresh((n) => n + 1), []);

  const sections = [
    { key: "people", label: "People", icon: UserPlus, need: "HR_EMPLOYEE_MANAGE" },
    { key: "rota", label: "Rota", icon: CalendarDays, need: "HR_SCHEDULE_MANAGE" },
    { key: "attendance", label: "Day sheet", icon: ClipboardList, need: "HR_ATTENDANCE_MANAGE" },
    { key: "leave", label: "Leave", icon: CheckCircle2, need: "HR_WORKFORCE_VIEW" },
    { key: "setup", label: "Setup", icon: Settings2, need: "HR_CONFIG_MANAGE" },
  ].filter((s) => may(s.need));

  const [section, setSection] = useState(sections[0]?.key || "");
  const current = sections.find((s) => s.key === section) ? section : sections[0]?.key;

  if (sections.length === 0) {
    return (
      <div className={`${card} p-6 flex items-start gap-2`}>
        <AlertCircle size={16} className="text-slate-400 mt-0.5" />
        <div>
          <p className="text-sm text-slate-700">You do not have any HR management permissions.</p>
          <p className="text-xs text-slate-400 mt-1">
            A Super Admin grants these from Access Management.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-4">
        {sections.map((s) => (
          <button key={s.key} onClick={() => setSection(s.key)}
            className={`text-xs rounded-lg px-3 py-2 flex items-center gap-1.5 border ${
              current === s.key
                ? "bg-slate-900 text-white border-slate-900"
                : "border-slate-200 bg-white hover:bg-slate-50"}`}>
            <s.icon size={13} /> {s.label}
          </button>
        ))}
      </div>

      {current === "people" && (
        <div className={`${card} p-4`}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">People</h3>
              <p className="text-[11px] text-slate-400">{staff.length} employee records</p>
            </div>
            <button onClick={() => setEditing("new")} className={primary}>
              <UserPlus size={13} /> Add employee
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5">
            {staff.map((s) => (
              <button key={s.userId} onClick={() => setEditing(s.userId)}
                className="text-left text-xs border border-slate-200 rounded-lg px-2.5 py-2 hover:bg-slate-50">
                {s.name}
              </button>
            ))}
          </div>
          {staff.length === 0 && (
            <p className="text-xs text-slate-400 py-8 text-center">
              No employees yet. Add the first one to begin.
            </p>
          )}
        </div>
      )}

      {current === "rota" && <RotaEditor options={options} staff={staff} onDone={bump} />}
      {current === "attendance" && <DaySheet options={options} onDone={bump} />}
      {current === "leave" && (
        <LeaveQueue options={options} staff={staff} mayDecide={may("HR_LEAVE_MANAGE")} onDone={bump} />
      )}
      {current === "setup" && <OrgSetup options={options} onDone={bump} />}

      {editing && (
        <EmployeeForm
          userId={editing === "new" ? null : editing}
          options={options}
          staff={staff}
          onClose={() => setEditing(null)}
          onSaved={bump}
        />
      )}
    </div>
  );
}
