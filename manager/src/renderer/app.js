"use strict";

// Clinical EHR Manager — interface logic.
//
// This file renders state and sends named requests. It holds no knowledge of
// commands, paths or ports: everything it shows arrives from the main process,
// and every action it triggers is a verb the main process interprets for
// itself. Disabling a button here is a courtesy to the user, never a control -
// the main process re-checks whether an action is possible before doing it.

const api = window.manager;

const el = (id) => document.getElementById(id);

let currentState = null;
let logEntries = [];
let logFilter = "all";
let settingsDraft = {};

/** Service order and labels the progress list walks through. */
const STEP_ORDER = ["postgres", "api", "web"];

// --------------------------------------------------------------- helpers ---

/** Status presentation. Never colour alone: each state carries a glyph and a word. */
function statePresentation(state, external) {
  switch (state) {
    case "running":  return { cls: "running",  dot: "dot-green", glyph: external ? "◆" : "✓", label: external ? "Running" : "Healthy" };
    case "starting": return { cls: "starting", dot: "dot-blue",  glyph: "◌", label: "Starting…" };
    case "stopping": return { cls: "stopping", dot: "dot-amber", glyph: "◌", label: "Stopping…" };
    case "error":    return { cls: "error",    dot: "dot-red",   glyph: "✕", label: "Error" };
    default:         return { cls: "",         dot: "dot-grey",  glyph: "●", label: "Stopped" };
  }
}

const ICONS = {
  database: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  server:   '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
  layout:   '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>',
};

function timeOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "--:--:--" : d.toTimeString().slice(0, 8);
}

// ------------------------------------------------------------ navigation ---

function showScreen(name) {
  for (const s of document.querySelectorAll(".screen")) {
    s.classList.toggle("is-active", s.id === `screen-${name}`);
  }
  for (const b of document.querySelectorAll(".nav-item")) {
    b.classList.toggle("is-active", b.dataset.screen === name);
  }
  if (name === "logs") scrollLogsToEnd();
}

for (const btn of document.querySelectorAll("[data-screen]")) {
  btn.addEventListener("click", () => showScreen(btn.dataset.screen));
}

api.onNavigate((screen) => showScreen(screen));

// ------------------------------------------------------------- dashboard ---

function render(state) {
  currentState = state;

  const services = state.services;
  const running = services.filter((s) => s.state === "running").length;
  const total = services.length;
  const busy = Boolean(state.busy);

  renderBanner(state, running, total);
  renderCards(services);
  renderProgress(state, services);
  renderError(state);

  // Buttons reflect what is possible right now. Requirement 31: no double-start.
  el("btnStart").disabled = busy || running === total;
  el("btnRestart").disabled = busy || running === 0;
  el("btnStop").disabled = busy || running === 0;
  el("btnOpen").disabled = busy || running !== total;

  el("btnStart").firstChild.nodeValue = "";
  el("btnStart").lastChild.nodeValue = busy && state.busy === "starting" ? " Starting…" : " Start Application";
  el("btnRestart").lastChild.nodeValue = state.busy === "restarting" ? " Restarting…" : " Restart";
  el("btnStop").lastChild.nodeValue = state.busy === "stopping" ? " Stopping…" : " Stop";

  const pill = statePresentation(
    state.overall === "running" ? "running" : busy ? "starting" : state.overall === "error" ? "error" : "stopped"
  );
  el("healthPill").querySelector(".dot").className = `dot ${pill.dot}`;
  el("healthPillText").textContent = overallText(state, running, total);
  el("sidebarStatus").querySelector(".dot").className = `dot ${pill.dot}`;
  el("sidebarStatusText").textContent = overallText(state, running, total);

  el("lastStarted").textContent = state.lastStartedAt
    ? `Last started: ${new Date(state.lastStartedAt).toLocaleString()}`
    : "Last started: not yet this session";
  el("appDirLabel").textContent = state.appDir || "No application directory set";
}

function overallText(state, running, total) {
  if (state.busy === "starting") return "Starting…";
  if (state.busy === "stopping") return "Stopping…";
  if (state.busy === "restarting") return "Restarting…";
  if (state.overall === "error") return "Attention needed";
  if (running === total) return "System healthy";
  if (running === 0) return "Stopped";
  return `${running} of ${total} running`;
}

function renderBanner(state, running, total) {
  const banner = el("banner");
  let cls = "", icon = "●", title = "Clinical EHR is stopped", text = "No services are running.";

  if (state.busy) {
    cls = "busy"; icon = "◌";
    title = { starting: "Starting Clinical EHR…", stopping: "Stopping Clinical EHR…", restarting: "Restarting Clinical EHR…" }[state.busy];
    text = "This takes a few seconds. No command windows will appear.";
  } else if (state.overall === "error") {
    cls = "bad"; icon = "⚠";
    title = "A service needs attention";
    text = state.lastError || "One or more services reported a problem.";
  } else if (running === total) {
    cls = "ok"; icon = "✓";
    title = "All systems operational";
    text = "Clinical EHR is ready to use.";
  } else if (running > 0) {
    cls = "warn"; icon = "⚠";
    title = "Partially running";
    text = `${running} of ${total} services are up.`;
  }

  banner.className = `banner ${cls}`;
  el("bannerIcon").textContent = icon;
  el("bannerTitle").textContent = title;
  el("bannerText").textContent = text;
}

function renderCards(services) {
  el("serviceCards").innerHTML = services.map((s) => {
    const p = statePresentation(s.state, s.external);
    return `
      <article class="card">
        <div class="card-top">
          <span class="card-icon" aria-hidden="true">${ICONS[s.icon] || ""}</span>
          <span>
            <span class="card-name">${escapeHtml(s.name)}</span><br>
            <span class="card-role">${escapeHtml(s.role)}</span>
          </span>
        </div>
        <span class="card-state ${p.cls}">
          <span aria-hidden="true">${p.glyph}</span> ${p.label}
        </span>
        <div class="card-meta">
          <span>Port <code>${s.port}</code></span>
          <span>${escapeHtml(s.detail || "")}</span>
          ${s.pid ? `<span>PID <code>${s.pid}</code></span>` : ""}
        </div>
        ${s.external ? '<span class="badge-external">Started outside the manager</span>' : ""}
      </article>`;
  }).join("");
}

function renderProgress(state, services) {
  const card = el("progressCard");
  if (!state.busy) { card.hidden = true; return; }

  card.hidden = false;
  el("progressTitle").textContent = {
    starting: "Starting Clinical EHR",
    stopping: "Stopping Clinical EHR",
    restarting: "Restarting Clinical EHR",
  }[state.busy];

  const byId = Object.fromEntries(services.map((s) => [s.id, s]));
  const done = STEP_ORDER.filter((id) => byId[id] && byId[id].state === "running").length;
  const pct = Math.round((done / STEP_ORDER.length) * 100);

  el("progressFill").style.width = `${pct}%`;
  el("progressPct").textContent = `${pct}%`;

  el("progressSteps").innerHTML = STEP_ORDER.map((id) => {
    const s = byId[id];
    if (!s) return "";
    let cls = "pending", mark = "○";
    if (s.state === "running") { cls = "done"; mark = "✓"; }
    else if (s.state === "starting" || s.state === "stopping") { cls = "active"; mark = "◌"; }
    else if (s.state === "error") { cls = "failed"; mark = "✕"; }
    return `<li class="${cls}"><span class="mark" aria-hidden="true">${mark}</span>
              <span>${escapeHtml(s.name)}</span>
              <span class="card-role">${escapeHtml(s.detail || "")}</span></li>`;
  }).join("");
}

function renderError(state) {
  const card = el("errorCard");
  if (!state.lastError || state.busy) { card.hidden = true; return; }
  card.hidden = false;
  el("errorTitle").textContent = "Clinical EHR startup error";
  el("errorText").textContent = state.lastError;
  el("errorHint").textContent = state.lastErrorHint || "Open Logs for the service output behind this.";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- actions ---

el("btnStart").addEventListener("click", async () => {
  const result = await api.start();
  if (!result.ok && result.hint) showHint(result);
});

el("btnRestart").addEventListener("click", () => api.restart());
el("btnOpen").addEventListener("click", () => api.openApp());
el("errorRetry").addEventListener("click", () => api.start());

// Stop asks first, and says plainly that data survives. Requirement 30.
el("btnStop").addEventListener("click", () => {
  el("stopModalList").innerHTML = (currentState ? currentState.services : [])
    .slice().reverse()
    .map((s) => `<li><span class="tick" aria-hidden="true">✓</span>${escapeHtml(s.name)}</li>`)
    .join("");
  el("stopModal").hidden = false;
  el("stopConfirm").focus();
});

el("stopCancel").addEventListener("click", () => { el("stopModal").hidden = true; });
el("stopModal").addEventListener("click", (e) => {
  if (e.target === el("stopModal")) el("stopModal").hidden = true;
});
el("stopConfirm").addEventListener("click", async () => {
  el("stopModal").hidden = true;
  await api.stop();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("stopModal").hidden) el("stopModal").hidden = true;
});

function showHint(result) {
  el("errorCard").hidden = false;
  el("errorText").textContent = result.error;
  el("errorHint").textContent = result.hint || "";
}

// ------------------------------------------------------------------- logs ---

function addLogEntry(entry) {
  logEntries.push(entry);
  if (logEntries.length > 3000) logEntries.splice(0, logEntries.length - 3000);
  if (logFilter === "all" || logFilter === entry.source) appendLogLine(entry);
}

function appendLogLine(entry) {
  const view = el("logView");
  const empty = view.querySelector(".log-empty");
  if (empty) empty.remove();

  const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 60;

  const row = document.createElement("div");
  row.className = `log-line ${entry.level}`;
  row.innerHTML =
    `<span class="log-time">${timeOf(entry.at)}</span>` +
    `<span class="log-src">${escapeHtml(entry.source)}</span>` +
    `<span class="log-msg">${escapeHtml(entry.message)}</span>`;
  view.appendChild(row);

  // Only auto-scroll when the reader is already at the end, so scrolling back
  // through a failure is not yanked away by the next line.
  if (atBottom) view.scrollTop = view.scrollHeight;
}

function renderLogs() {
  const view = el("logView");
  const shown = logEntries.filter((e) => logFilter === "all" || e.source === logFilter);
  if (!shown.length) {
    view.innerHTML = '<div class="log-empty">No log entries for this filter yet.</div>';
    return;
  }
  view.innerHTML = shown.map((e) =>
    `<div class="log-line ${e.level}">` +
    `<span class="log-time">${timeOf(e.at)}</span>` +
    `<span class="log-src">${escapeHtml(e.source)}</span>` +
    `<span class="log-msg">${escapeHtml(e.message)}</span></div>`
  ).join("");
  scrollLogsToEnd();
}

function scrollLogsToEnd() {
  const view = el("logView");
  view.scrollTop = view.scrollHeight;
}

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    for (const c of document.querySelectorAll(".chip")) c.classList.remove("is-active");
    chip.classList.add("is-active");
    logFilter = chip.dataset.source;
    renderLogs();
  });
}

el("btnClearLogs").addEventListener("click", async () => {
  await api.clearLogs();
  logEntries = [];
  renderLogs();
});

el("btnCopyLogs").addEventListener("click", async () => {
  await api.copyLogs(logFilter === "all" ? null : [logFilter]);
  flash(el("btnCopyLogs"), "Copied");
});

el("btnExportLogs").addEventListener("click", async () => {
  const result = await api.exportLogs(logFilter === "all" ? null : [logFilter]);
  if (result.ok) flash(el("btnExportLogs"), "Exported");
});

function flash(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = original; }, 1400);
}

// --------------------------------------------------------------- settings ---

const SWITCHES = {
  swStartWithWindows: "startWithWindows",
  swAutoStartApp: "autoStartApp",
  swStartMinimized: "startMinimized",
  swAutoRestart: "autoRestart",
};

for (const [id, key] of Object.entries(SWITCHES)) {
  el(id).addEventListener("click", () => {
    const next = el(id).getAttribute("aria-checked") !== "true";
    el(id).setAttribute("aria-checked", String(next));
    settingsDraft[key] = next;
  });
  // A switch is a button, so Space and Enter already activate it; this only
  // stops Space from scrolling the panel behind it.
  el(id).addEventListener("keydown", (e) => { if (e.key === " ") e.preventDefault(); });
}

el("maxRestarts").addEventListener("change", () => {
  settingsDraft.maxRestartAttempts = Number(el("maxRestarts").value);
});

el("btnBrowse").addEventListener("click", async () => {
  const result = await api.browseAppDir();
  if (result.canceled) return;
  if (!result.ok) {
    el("appDirHint").textContent = result.error;
    el("appDirHint").style.color = "var(--red)";
    return;
  }
  el("appDir").value = result.path;
  settingsDraft.appDir = result.path;
  el("appDirHint").textContent = "Looks like a valid Clinical EHR project. Save to apply.";
  el("appDirHint").style.color = "var(--green)";
});

el("btnSaveSettings").addEventListener("click", async () => {
  settingsDraft.maxRestartAttempts = Number(el("maxRestarts").value);
  const result = await api.saveSettings(settingsDraft);
  if (!result.ok) {
    el("appDirHint").textContent = result.error;
    el("appDirHint").style.color = "var(--red)";
    return;
  }
  settingsDraft = {};
  el("savedFlag").hidden = false;
  setTimeout(() => { el("savedFlag").hidden = true; }, 1800);
  loadSettings();
});

async function loadSettings() {
  const s = await api.getSettings();
  el("appDir").value = s.appDir || "";
  el("maxRestarts").value = s.maxRestartAttempts;
  for (const [id, key] of Object.entries(SWITCHES)) {
    el(id).setAttribute("aria-checked", String(Boolean(s[key])));
  }
  el("appDirHint").textContent = "The folder containing package.json, server/ and src/.";
  el("appDirHint").style.color = "";
}

// ------------------------------------------------------------------ start ---

(async function init() {
  render(await api.getState());
  api.onState(render);

  logEntries = await api.getLogs();
  renderLogs();
  api.onLog(addLogEntry);

  await loadSettings();
})();
