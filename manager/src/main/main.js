"use strict";

const path = require("path");
const fs = require("fs");
const {
  app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, clipboard, nativeImage,
} = require("electron");

const { Settings, resolveDefaultAppDir } = require("./settings");
const { LogStore } = require("./logs");
const { Orchestrator } = require("./orchestrator");
const { validateAppDir } = require("./services");
const { setStartWithWindows, isStartWithWindowsEnabled } = require("./startup");

// Clinical EHR Manager - application entry point.
//
// Owns the window, the tray, and the IPC surface. All process control lives in
// orchestrator.js; this file decides when to ask for it.
//
// Closing the window hides it. Only "Exit Manager" ends the process, and it
// asks first if services are still up, because quitting a control panel should
// not be a way to accidentally take a clinic's software offline.

let win = null;
let tray = null;
let settings = null;
let logs = null;
let orchestrator = null;
let quitting = false;

const startedMinimised = process.argv.includes("--minimised");

// A second copy would show a second tray icon and fight the first over ports.
// Windows launches the Run-key entry on every sign-in, so this matters.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(bootstrap);
}

async function bootstrap() {
  app.setAppUserModelId("com.clinicalehr.manager");

  settings = new Settings(app.getPath("userData"));
  logs = new LogStore(path.join(app.getPath("userData"), "logs"));

  if (!settings.get("appDir")) {
    const guess = resolveDefaultAppDir(__dirname);
    if (guess) {
      settings.update({ appDir: guess });
      logs.info("manager", `Application directory detected: ${guess}`);
    } else {
      logs.warn("manager", "No application directory is set yet - choose one in Settings.");
    }
  }

  orchestrator = new Orchestrator({
    settings,
    logs,
    onChange: () => {
      pushState();
      refreshTray();
    },
  });

  logs.subscribe((entry) => {
    if (win && !win.isDestroyed()) win.webContents.send("logs:entry", entry);
  });

  registerIpc();
  createTray();
  createWindow();

  // Adopt anything already running before offering any action.
  await orchestrator.detect();
  refreshTray();

  if (settings.get("autoStartApp")) {
    logs.info("manager", "Starting the application automatically (Settings → Startup).");
    orchestrator.startAll().catch(() => {});
  }
}

// ---------------------------------------------------------------- window ----

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: "#f3f6f8",
    title: "Clinical EHR Manager",
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  win.once("ready-to-show", () => {
    const hide = startedMinimised && settings.get("startMinimized");
    if (!hide) win.show();
    else logs.info("manager", "Started minimised to the system tray.");
  });

  // The X hides; it does not stop anything. Requirement 14.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Anything that wants a new window goes to the real browser instead.
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

function showWindow(screen) {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (screen) win.webContents.send("ui:navigate", screen);
}

function pushState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send("state:changed", orchestrator.snapshot());
  }
}

// ------------------------------------------------------------------ tray ----

function appIcon() {
  const icon = path.join(__dirname, "..", "..", "build", "icon.png");
  return fs.existsSync(icon) ? icon : undefined;
}

function trayImage() {
  const file = path.join(__dirname, "..", "..", "build", "tray.png");
  if (fs.existsSync(file)) {
    const img = nativeImage.createFromPath(file);
    return img.isEmpty() ? nativeImage.createEmpty() : img;
  }
  return nativeImage.createEmpty();
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip("Clinical EHR Manager");
  tray.on("double-click", () => showWindow());
  refreshTray();
}

function refreshTray() {
  if (!tray) return;

  const snap = orchestrator.snapshot();
  const running = snap.services.filter((s) => s.state === "running").length;
  const total = snap.services.length;

  const statusLabel = {
    running: "All systems running",
    partial: `${running} of ${total} services running`,
    starting: "Starting…",
    stopping: "Stopping…",
    restarting: "Restarting…",
    error: "Attention needed",
    stopped: "Stopped",
  }[snap.overall] || "Unknown";

  const busy = Boolean(snap.busy);
  const anyRunning = running > 0;

  tray.setToolTip(`Clinical EHR — ${statusLabel}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Clinical EHR", enabled: false },
    { label: statusLabel, enabled: false },
    { type: "separator" },
    { label: "Open Manager", click: () => showWindow("dashboard") },
    { label: "Open Clinical EHR", enabled: snap.overall === "running", click: () => openClinicalEhr() },
    { type: "separator" },
    { label: "Start Application", enabled: !busy && running < total, click: () => orchestrator.startAll() },
    { label: "Restart Application", enabled: !busy && anyRunning, click: () => orchestrator.restartAll() },
    { label: "Stop Application", enabled: !busy && anyRunning, click: () => confirmStopFromTray() },
    { type: "separator" },
    { label: "View Logs", click: () => showWindow("logs") },
    { label: "Settings", click: () => showWindow("settings") },
    { type: "separator" },
    { label: "Exit Manager", click: () => requestQuit() },
  ]));
}

// ------------------------------------------------------------- behaviour ----

async function openClinicalEhr() {
  const snap = orchestrator.snapshot();
  const web = snap.services.find((s) => s.id === "web");

  if (!web || web.state !== "running") {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Clinical EHR is not running",
      message: "Clinical EHR is not running.",
      detail: "The web interface has to be started before it can be opened.",
      buttons: ["Start Application", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      const result = await orchestrator.startAll();
      if (result.ok) shell.openExternal(snap.openUrl);
    }
    return;
  }

  shell.openExternal(snap.openUrl);
}

async function confirmStopFromTray() {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "Stop Clinical EHR?",
    message: "Stop Clinical EHR?",
    detail:
      "This stops the React frontend, the Go backend and PostgreSQL.\n\n" +
      "Database data will NOT be deleted. The database is shut down cleanly and every record is preserved.",
    buttons: ["Cancel", "Stop Application"],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) orchestrator.stopAll();
}

/**
 * Exit Manager. Requirement 15: never silently take the services down with it.
 */
async function requestQuit() {
  const snap = orchestrator.snapshot();
  const ownRunning = snap.services.filter((s) => s.state === "running" && !s.external).length;

  if (ownRunning === 0) {
    quitting = true;
    app.quit();
    return;
  }

  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "Clinical EHR is still running",
    message: "Clinical EHR is still running.",
    detail: "What would you like to do?",
    buttons: [
      "Exit Manager & Keep Application Running",
      "Stop Application & Exit",
      "Cancel",
    ],
    defaultId: 0,
    cancelId: 2,
  });

  if (response === 2) return;

  if (response === 1) {
    logs.info("manager", "Stopping the application before exit.");
    await orchestrator.shutdownOwned();
  } else {
    logs.info("manager", "Exiting the manager; the application keeps running.");
  }

  quitting = true;
  app.quit();
}

// ------------------------------------------------------------------- ipc ----

function registerIpc() {
  ipcMain.handle("state:get", () => orchestrator.snapshot());

  ipcMain.handle("app:start", () => orchestrator.startAll());
  ipcMain.handle("app:restart", () => orchestrator.restartAll());
  ipcMain.handle("app:stop", () => orchestrator.stopAll());
  ipcMain.handle("app:open", async () => { await openClinicalEhr(); return { ok: true }; });

  ipcMain.handle("logs:get", () => logs.all());
  ipcMain.handle("logs:clear", () => { logs.clear(); return { ok: true }; });

  ipcMain.handle("logs:copy", (_e, sources) => {
    clipboard.writeText(logs.asText(sources));
    return { ok: true };
  });

  ipcMain.handle("logs:export", async (_e, sources) => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "Export logs",
      defaultPath: `clinical-ehr-manager-${stamp}.log`,
      filters: [{ name: "Log file", extensions: ["log", "txt"] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(filePath, logs.asText(sources), "utf8");
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: String(err && err.message) };
    }
  });

  ipcMain.handle("settings:get", () => ({
    ...settings.all(),
    startWithWindows: isStartWithWindowsEnabled(),
  }));

  ipcMain.handle("settings:save", (_e, patch) => {
    if (patch.appDir !== undefined && patch.appDir !== settings.get("appDir")) {
      const valid = validateAppDir(patch.appDir);
      if (!valid.ok) return { ok: false, error: valid.reason };
    }

    const result = settings.update(patch);
    if (!result.ok) return result;

    // Windows is told only when this toggle actually changed.
    if (patch.startWithWindows !== undefined) {
      const applied = setStartWithWindows(patch.startWithWindows, settings.get("startMinimized"));
      if (!applied.ok) return { ok: false, error: `Saved, but Windows startup could not be changed: ${applied.error}` };
      logs.info("manager", `Start with Windows: ${patch.startWithWindows ? "on" : "off"}.`);
    }

    orchestrator.detect().catch(() => {});
    return { ok: true, settings: settings.all() };
  });

  ipcMain.handle("settings:browse", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: "Select the Clinical EHR application folder",
      properties: ["openDirectory"],
      defaultPath: settings.get("appDir") || app.getPath("home"),
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };

    const chosen = filePaths[0];
    const valid = validateAppDir(chosen);
    if (!valid.ok) return { ok: false, error: valid.reason, path: chosen };
    return { ok: true, path: chosen };
  });

  ipcMain.handle("window:hide", () => { if (win) win.hide(); return { ok: true }; });
}

// ---------------------------------------------------------------- exit ------

// The tray keeps the manager alive with no window open; that is the point.
app.on("window-all-closed", (event) => { event.preventDefault(); });

app.on("before-quit", () => { quitting = true; });
