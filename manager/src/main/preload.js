"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// The only bridge between the interface and the machine.
//
// The renderer runs with contextIsolation on and nodeIntegration off, so the
// dashboard has no access to child_process, fs, or the network beyond what is
// listed here. Every entry is a named request the main process validates for
// itself - the interface can ask to stop the application, but it cannot say
// which command to run to do it.

contextBridge.exposeInMainWorld("manager", {
  // --- state ---
  getState: () => ipcRenderer.invoke("state:get"),
  onState: (fn) => {
    const handler = (_event, snapshot) => fn(snapshot);
    ipcRenderer.on("state:changed", handler);
    return () => ipcRenderer.removeListener("state:changed", handler);
  },

  // --- lifecycle ---
  start: () => ipcRenderer.invoke("app:start"),
  stop: () => ipcRenderer.invoke("app:stop"),
  restart: () => ipcRenderer.invoke("app:restart"),
  openApp: () => ipcRenderer.invoke("app:open"),

  // --- logs ---
  getLogs: () => ipcRenderer.invoke("logs:get"),
  onLog: (fn) => {
    const handler = (_event, entry) => fn(entry);
    ipcRenderer.on("logs:entry", handler);
    return () => ipcRenderer.removeListener("logs:entry", handler);
  },
  clearLogs: () => ipcRenderer.invoke("logs:clear"),
  exportLogs: (sources) => ipcRenderer.invoke("logs:export", sources),
  copyLogs: (sources) => ipcRenderer.invoke("logs:copy", sources),

  // --- settings ---
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  browseAppDir: () => ipcRenderer.invoke("settings:browse"),

  // --- window ---
  minimiseToTray: () => ipcRenderer.invoke("window:hide"),

  // Lets the main process pull the renderer to a given screen, so "View Logs"
  // in the tray menu lands on the log viewer rather than the dashboard.
  onNavigate: (fn) => {
    const handler = (_event, screen) => fn(screen);
    ipcRenderer.on("ui:navigate", handler);
    return () => ipcRenderer.removeListener("ui:navigate", handler);
  },
});
