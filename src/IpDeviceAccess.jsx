// Settings → Access Management → IP & Device Access.
//
// Two views: IP rules (add / revoke) and Access events (audit history). Both endpoints are
// server-gated on IP_ACCESS_MANAGE; a Super Admin holds it by default. Nothing here enforces
// authorisation - the server refuses forbidden calls regardless of what this file renders.

import { useEffect, useState } from "react";
import { Shield, Loader2, Plus, X, Save, Trash2, RefreshCw, AlertTriangle, Search } from "lucide-react";
import { api } from "./firebase/apiClient";

const input = "w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm";
const lbl = "block text-[11px] uppercase tracking-wide text-slate-400 mb-1";
const btn = "text-xs rounded-lg px-3 py-2 flex items-center gap-1.5";
const primary = `${btn} bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-40`;
const plain = `${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`;
const danger = `${btn} border border-rose-200 text-rose-600 hover:bg-rose-50`;

const TABS = [
  { key: "users", label: "Users" },
  { key: "rules", label: "IP rules" },
  { key: "events", label: "Access events" },
];

export default function IpDeviceAccess() {
  const [tab, setTab] = useState("users");
  return (
    <div>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
          <Shield size={14} /> IP &amp; Device Access
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Block or allow IP addresses, grant time-limited access, and review the access history.
          Rules apply to authenticated requests only, and a Super Admin session is never blocked.
        </p>
      </div>
      <div className="flex gap-1.5 mb-3">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`text-xs rounded-lg px-3 py-1.5 border ${
              tab === t.key ? "bg-slate-900 text-white border-slate-900" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "users" && <UsersTab />}
      {tab === "rules" && <IpRulesTab />}
      {tab === "events" && <AccessEventsTab />}
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let alive = true;
    setBusy(true);
    api("/api/admin/ip-access/users")
      .then((r) => { if (alive) { setUsers(r.users || []); setError(""); setBusy(false); } })
      .catch((e) => { if (alive) { setError(e.message); setUsers([]); setBusy(false); } });
    return () => { alive = false; };
  }, [reloadKey]);

  const filtered = (users || []).filter((u) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (u.email || "").toLowerCase().includes(q)
      || (u.name || "").toLowerCase().includes(q)
      || (u.role || "").toLowerCase().includes(q)
      || (u.lastIP || "").toLowerCase().includes(q);
  });

  return (
    <div>
      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}
      <p className="text-[11px] text-slate-500 mb-2">
        Most recent sign-in per user. A user with no login row has not signed in since IP tracking
        was deployed - their history begins on their next login.
      </p>
      <div className="flex items-center gap-2 mb-2">
        <input className={`${input} max-w-xs`} placeholder="Filter by name, email, role or IP"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <button onClick={() => setReloadKey((n) => n + 1)} disabled={busy} className={plain}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
        </button>
      </div>
      {!users && <p className="text-xs text-slate-400"><Loader2 size={12} className="inline animate-spin mr-1" />Loading…</p>}
      {users && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2 font-medium">User</th>
                <th className="text-left px-3 py-2 font-medium">Role</th>
                <th className="text-left px-3 py-2 font-medium">Last IP</th>
                <th className="text-left px-3 py-2 font-medium">VPN</th>
                <th className="text-left px-3 py-2 font-medium">Last login</th>
                <th className="text-left px-3 py-2 font-medium">Browser</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={6} className="text-center text-slate-400 py-6">No users match.</td></tr>
              )}
              {filtered.map((u) => (
                <tr key={u.userId} className="border-t border-slate-100">
                  <td className="px-3 py-1.5">
                    <div className="text-slate-800">{u.name || u.email}</div>
                    <div className="text-[11px] text-slate-400">{u.email}{u.disabled ? " · disabled" : ""}</div>
                  </td>
                  <td className="px-3 py-1.5 text-slate-500">{u.role}</td>
                  <td className="px-3 py-1.5 font-mono text-[11px] text-slate-800">
                    {u.lastIP || <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    {u.vpnStatus && u.vpnStatus !== "unchecked" ? (
                      <span className={`text-[10px] uppercase border rounded px-1.5 py-0.5 ${
                        ["vpn", "proxy", "tor", "datacenter"].includes(u.vpnStatus)
                          ? "bg-amber-50 text-amber-800 border-amber-200"
                          : "bg-emerald-50 text-emerald-700 border-emerald-200"}`}>
                        {u.vpnStatus}
                      </span>
                    ) : (
                      <span className="text-slate-300 text-[11px]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-slate-500">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : <span className="text-slate-300">never</span>}
                  </td>
                  <td className="px-3 py-1.5 text-[11px] text-slate-500 max-w-[24rem] truncate" title={u.userAgent}>
                    {u.userAgent || <span className="text-slate-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function IpRulesTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [check, setCheck] = useState({ ip: "", result: null, busy: false });

  useEffect(() => {
    let alive = true;
    setBusy(true);
    api("/api/admin/ip-access/rules")
      .then((r) => { if (alive) { setData(r); setError(""); setBusy(false); } })
      .catch((e) => { if (alive) { setError(e.message || "Could not load rules."); setData({ rules: [] }); setBusy(false); } });
    return () => { alive = false; };
  }, [reloadKey]);

  async function revoke(id) {
    const reason = window.prompt("Reason for revoking this rule (optional)") || "";
    try {
      await api(`/api/admin/ip-access/rules/${encodeURIComponent(id)}?reason=${encodeURIComponent(reason)}`,
        { method: "DELETE" });
      setReloadKey((n) => n + 1);
    } catch (e) {
      alert(e.message || "Could not revoke the rule.");
    }
  }

  async function runCheck() {
    if (!check.ip.trim()) return;
    setCheck((c) => ({ ...c, busy: true, result: null }));
    try {
      const r = await api("/api/admin/ip-access/check", { method: "POST", body: { ip: check.ip.trim() } });
      setCheck((c) => ({ ...c, busy: false, result: r }));
    } catch (e) {
      setCheck((c) => ({ ...c, busy: false, result: { error: e.message } }));
    }
  }

  if (!data) return <p className="text-xs text-slate-400"><Loader2 size={12} className="inline animate-spin mr-1" />Loading…</p>;

  const enforcing = !!data.enforcing;

  return (
    <div>
      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}

      <div className={`rounded-lg p-3 mb-3 border ${enforcing ? "bg-amber-50 border-amber-200" : "bg-slate-50 border-slate-200"}`}>
        <div className="flex items-start gap-2">
          <AlertTriangle size={14} className={enforcing ? "text-amber-700 mt-0.5" : "text-slate-500 mt-0.5"} />
          <div className="text-xs">
            <div className="font-medium text-slate-800">
              Enforcement is {enforcing ? <span className="text-amber-700">ON</span> : <span className="text-slate-600">OFF</span>}.
              VPN policy: <span className="font-mono">{data.vpnPolicy || "monitor"}</span>.
              VPN provider: <span className="font-mono">{data.vpnProvider || "not configured"}</span>.
            </div>
            <p className="text-slate-500 mt-1">
              Enforcement is controlled by the <code>IP_ACCESS_ENFORCE</code> environment variable
              on the server. When OFF, rules are stored and viewable but never deny a request -
              deploy the feature first, verify the rules, then flip enforcement on.
              Super Admin sessions are never blocked, no matter what.
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-slate-500">
          {data.rules.length} rule{data.rules.length === 1 ? "" : "s"} on record ·
          <span className="ml-1">{data.rules.filter((r) => r.active).length} active</span>
        </p>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setReloadKey((n) => n + 1)} disabled={busy} className={plain}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
          </button>
          <button onClick={() => setShowAdd(true)} className={primary}><Plus size={13} /> Add rule</button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-4">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2 font-medium">CIDR / IP</th>
              <th className="text-left px-3 py-2 font-medium">Mode</th>
              <th className="text-left px-3 py-2 font-medium">Reason</th>
              <th className="text-left px-3 py-2 font-medium">Created</th>
              <th className="text-left px-3 py-2 font-medium">Expires</th>
              <th className="text-left px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {data.rules.length === 0 && (
              <tr><td colSpan={7} className="text-center text-slate-400 py-6">No rules yet.</td></tr>
            )}
            {data.rules.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-mono text-[11px] text-slate-800">{r.cidr}</td>
                <td className="px-3 py-2">
                  <span className={`text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 ${
                    r.mode === "block" ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"}`}>
                    {r.mode}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-600">{r.reason || "—"}</td>
                <td className="px-3 py-2 text-slate-500">
                  {r.createdBy}<br /><span className="text-[10px]">{new Date(r.createdAt).toLocaleString()}</span>
                </td>
                <td className="px-3 py-2 text-slate-500">
                  {r.expiresAt ? new Date(r.expiresAt).toLocaleString() : <span className="text-slate-300">permanent</span>}
                </td>
                <td className="px-3 py-2">
                  {r.active ? (
                    <span className="text-emerald-700 text-[11px]">active</span>
                  ) : r.revokedAt ? (
                    <span className="text-slate-400 text-[11px]" title={r.revokedReason}>revoked</span>
                  ) : (
                    <span className="text-slate-400 text-[11px]">expired</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {r.active && (
                    <button onClick={() => revoke(r.id)} className={danger}><Trash2 size={11} /> Revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-3">
        <h4 className="text-xs font-semibold text-slate-700 mb-2">VPN / proxy lookup</h4>
        <p className="text-[11px] text-slate-500 mb-2">
          Ask the configured provider what it knows about an IP. Result is cached for 24 hours.
        </p>
        <div className="flex items-center gap-2">
          <input className={`${input} max-w-xs`} placeholder="e.g. 203.0.113.42"
            value={check.ip} onChange={(e) => setCheck({ ...check, ip: e.target.value })} />
          <button onClick={runCheck} disabled={check.busy || !check.ip.trim()} className={primary}>
            {check.busy ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
            Check
          </button>
        </div>
        {check.result && (
          <div className="text-xs mt-2 font-mono bg-slate-50 border border-slate-200 rounded p-2">
            {check.result.error
              ? <span className="text-rose-700">{check.result.error}</span>
              : <>ip: {check.result.ip} · status: <span className="font-semibold">{check.result.status}</span>{check.result.source ? ` · source: ${check.result.source}` : ""}</>}
          </div>
        )}
      </div>

      {showAdd && (
        <AddRuleDialog onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); setReloadKey((n) => n + 1); }} />
      )}
    </div>
  );
}

function AddRuleDialog({ onClose, onDone }) {
  const [form, setForm] = useState({ cidr: "", mode: "block", reason: "", expiresLocal: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    setBusy(true); setError("");
    try {
      let expiresAt = "";
      if (form.expiresLocal.trim()) {
        expiresAt = new Date(form.expiresLocal).toISOString();
      }
      await api("/api/admin/ip-access/rules", {
        method: "POST",
        body: { cidr: form.cidr.trim(), mode: form.mode, reason: form.reason.trim(), expiresAt },
      });
      onDone();
    } catch (e) {
      setError(e.message || "The rule could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg my-8">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h3 className="font-semibold text-slate-800">Add IP rule</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="p-5">
          {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}
          <label className="block mb-3"><span className={lbl}>Mode</span>
            <select className={input} value={form.mode} onChange={set("mode")}>
              <option value="block">Block</option>
              <option value="allow">Allow (overrides a matching block rule)</option>
            </select>
          </label>
          <label className="block mb-3"><span className={lbl}>IP address or CIDR block</span>
            <input className={input} value={form.cidr} onChange={set("cidr")} placeholder="203.0.113.42 or 203.0.113.0/24 or 2001:db8::/32" />
          </label>
          <label className="block mb-3"><span className={lbl}>Reason</span>
            <input className={input} value={form.reason} onChange={set("reason")} placeholder="Recorded in the audit log" />
          </label>
          <label className="block mb-3"><span className={lbl}>Expires at (optional)</span>
            <input type="datetime-local" className={input} value={form.expiresLocal} onChange={set("expiresLocal")} />
            <span className="text-[11px] text-slate-400 mt-0.5 block">Leave blank for a permanent rule.</span>
          </label>
        </div>
        <div className="px-5 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button onClick={onClose} className={plain}>Cancel</button>
          <button onClick={submit} disabled={busy || !form.cidr.trim()} className={primary}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {busy ? "Saving…" : "Save rule"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AccessEventsTab() {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [filter, setFilter] = useState({ user: "", ip: "", action: "" });
  const [applied, setApplied] = useState({ user: "", ip: "", action: "" });

  useEffect(() => {
    let alive = true;
    setBusy(true);
    const q = new URLSearchParams();
    Object.entries(applied).forEach(([k, v]) => { if (v) q.set(k, v); });
    api(`/api/admin/ip-access/events?${q.toString()}`)
      .then((r) => { if (alive) { setEvents(r.events || []); setError(""); setBusy(false); } })
      .catch((e) => { if (alive) { setError(e.message); setEvents([]); setBusy(false); } });
    return () => { alive = false; };
  }, [reloadKey, applied]);

  async function clearAll() {
    if (!window.confirm("Delete every access event? This cannot be undone. The Super Admin who cleared the log is recorded as the first event afterwards.")) return;
    setClearing(true);
    try {
      await api("/api/admin/ip-access/events", { method: "DELETE" });
      setReloadKey((n) => n + 1);
    } catch (e) {
      alert(e.message || "Could not clear the events.");
    } finally {
      setClearing(false);
    }
  }

  return (
    <div>
      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 mb-3 text-xs text-rose-800">{error}</div>}
      <div className="flex flex-wrap gap-2 mb-2 items-end">
        <label className="block">
          <span className={lbl}>User</span>
          <input className={input} value={filter.user} onChange={(e) => setFilter({ ...filter, user: e.target.value })} placeholder="email or uid" />
        </label>
        <label className="block">
          <span className={lbl}>IP</span>
          <input className={input} value={filter.ip} onChange={(e) => setFilter({ ...filter, ip: e.target.value })} />
        </label>
        <label className="block">
          <span className={lbl}>Action</span>
          <select className={input} value={filter.action} onChange={(e) => setFilter({ ...filter, action: e.target.value })}>
            <option value="">Any</option>
            <option value="login">login</option>
            <option value="blocked_ip">blocked_ip</option>
            <option value="rule_create">rule_create</option>
            <option value="rule_revoke">rule_revoke</option>
            <option value="events_cleared">events_cleared</option>
          </select>
        </label>
        <button onClick={() => { setApplied({ ...filter }); setReloadKey((n) => n + 1); }} className={primary}>
          <Search size={12} /> Apply
        </button>
        <button onClick={() => setReloadKey((n) => n + 1)} disabled={busy} className={plain}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
        </button>
        <button onClick={clearAll} disabled={clearing || (events && events.length === 0)} className={danger}>
          {clearing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Clear all
        </button>
      </div>

      {!events && <p className="text-xs text-slate-400"><Loader2 size={12} className="inline animate-spin mr-1" />Loading…</p>}
      {events && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2 font-medium">When</th>
                <th className="text-left px-3 py-2 font-medium">User</th>
                <th className="text-left px-3 py-2 font-medium">Role</th>
                <th className="text-left px-3 py-2 font-medium">IP</th>
                <th className="text-left px-3 py-2 font-medium">Action</th>
                <th className="text-left px-3 py-2 font-medium">Decision</th>
                <th className="text-left px-3 py-2 font-medium">VPN</th>
                <th className="text-left px-3 py-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr><td colSpan={8} className="text-center text-slate-400 py-6">No events match.</td></tr>
              )}
              {events.map((e) => (
                <tr key={e.id} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 text-slate-500">{new Date(e.at).toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-slate-700">{e.userEmail || e.userId || "—"}</td>
                  <td className="px-3 py-1.5 text-slate-500">{e.role}</td>
                  <td className="px-3 py-1.5 font-mono text-[11px] text-slate-800">{e.ip || "—"}</td>
                  <td className="px-3 py-1.5 text-slate-600">{e.action}</td>
                  <td className="px-3 py-1.5">
                    <span className={`text-[10px] uppercase border rounded px-1.5 py-0.5 ${
                      e.decision === "block" ? "bg-rose-50 text-rose-700 border-rose-200"
                      : e.decision === "allow" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : "bg-slate-50 text-slate-600 border-slate-200"}`}>
                      {e.decision || "—"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-slate-500">
                    {e.vpnStatus === "unchecked" ? <span className="text-slate-300">—</span> : e.vpnStatus}
                    {e.vpnSource && <span className="text-[10px] text-slate-400 ml-1">({e.vpnSource})</span>}
                  </td>
                  <td className="px-3 py-1.5 text-slate-600">{e.reason || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
