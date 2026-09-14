"use strict";

const { app } = require("electron");

// "Start with Windows".
//
// Electron's setLoginItemSettings writes the per-user Run key
// (HKCU\Software\Microsoft\Windows\CurrentVersion\Run). Per-user, so it needs
// no elevation and cannot affect anyone else who signs in to the machine.
//
// It is only ever called from an explicit toggle in Settings. Nothing in this
// application registers itself for startup on first run, on install, or as a
// side effect of anything else - deciding what launches with the computer is
// the user's, and a program that quietly adds itself has taken that decision
// away from them.

/**
 * @param {boolean} enabled
 * @param {boolean} openMinimised  pass --minimised so the launched manager goes
 *                                 straight to the tray instead of opening a window
 */
function setStartWithWindows(enabled, openMinimised) {
  // Only Windows has this Run key; elsewhere the toggle is simply inert rather
  // than an error, so the same Settings screen works if this is ever ported.
  if (process.platform !== "win32") return { ok: true, applied: false };

  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      // Without this, a packaged app registers the Electron stub rather than
      // the installed executable and the entry silently does nothing.
      path: process.execPath,
      args: openMinimised ? ["--minimised"] : [],
    });
    return { ok: true, applied: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
}

/** What Windows currently believes, rather than what the settings file says. */
function isStartWithWindowsEnabled() {
  if (process.platform !== "win32") return false;
  try {
    return Boolean(app.getLoginItemSettings({ path: process.execPath }).openAtLogin);
  } catch {
    return false;
  }
}

module.exports = { setStartWithWindows, isStartWithWindowsEnabled };
