"use strict";

const fs = require("fs");
const path = require("path");

// Settings persistence.
//
// A small JSON file in Electron's per-user data directory. No dependency for
// this: the whole store is six keys, and a corrupt or missing file falls back
// to defaults rather than refusing to start.
//
// Nothing secret belongs here. The database password and the session signing
// key are read by the Go service from its own environment, and this manager
// never reads, stores or forwards them - it starts a process and lets that
// process resolve its own configuration.

const DEFAULTS = {
  appDir: null,               // resolved on first run, see resolveDefaultAppDir
  startWithWindows: false,
  autoStartApp: false,        // deliberately separate from startWithWindows
  startMinimized: true,
  autoRestart: false,
  maxRestartAttempts: 3,
};

class Settings {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, "settings.json");
    this.values = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      // Only known keys are adopted, so an edited file cannot introduce
      // surprises, and a key added in a later version gets its default.
      for (const key of Object.keys(DEFAULTS)) {
        if (parsed[key] !== undefined) this.values[key] = parsed[key];
      }
    } catch {
      // No file yet, or unreadable - defaults stand.
    }
    this.clamp();
  }

  save() {
    this.clamp();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2), "utf8");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message) };
    }
  }

  get(key) { return this.values[key]; }

  update(patch) {
    for (const key of Object.keys(DEFAULTS)) {
      if (patch[key] !== undefined) this.values[key] = patch[key];
    }
    return this.save();
  }

  all() { return { ...this.values }; }

  // An unbounded restart count would let a service that fails instantly spin
  // forever; 1..10 keeps automatic recovery a convenience rather than a loop.
  clamp() {
    const n = Number(this.values.maxRestartAttempts);
    this.values.maxRestartAttempts = Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : 3;
    for (const key of ["startWithWindows", "autoStartApp", "startMinimized", "autoRestart"]) {
      this.values[key] = Boolean(this.values[key]);
    }
  }
}

/**
 * Guesses the project directory on first run.
 *
 * When the manager lives inside the project (manager/ beside src/ and server/),
 * its own location identifies the project and the user never has to browse for
 * it. A packaged copy installed elsewhere finds nothing and the Settings screen
 * asks - which is the honest outcome, rather than guessing at a path that
 * happens to exist on the developer's machine.
 */
function resolveDefaultAppDir(managerDir) {
  let dir = managerDir;
  for (let depth = 0; depth < 4; depth++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const looksRight =
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "server", "main.go"));
    if (looksRight) return dir;
  }
  return null;
}

module.exports = { Settings, DEFAULTS, resolveDefaultAppDir };
