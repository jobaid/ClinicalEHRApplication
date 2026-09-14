"use strict";

const path = require("path");
const fs = require("fs");

const pm = require("./process-manager");
const { waitUntil } = require("./health");
const {
  buildServices,
  missingRequirements,
  validateAppDir,
  START_ORDER,
  STOP_ORDER,
} = require("./services");

// Start, stop and restart the Clinical EHR stack.
//
// Two rules shape everything in this file.
//
// Ordering is not cosmetic. Each service waits for the one it depends on to be
// genuinely answering before the next is launched. Starting the API against a
// database that is still recovering produces a confusing failure that looks
// like a bug in the API, so the manager simply does not do it.
//
// Adoption over duplication. If a port is already serving, that service is
// recorded as "external" and left alone rather than started a second time. The
// common case is the developer who already has `npm run dev` going; starting a
// rival Vite on a strictPort would fail, and starting a second PostgreSQL on
// the same data directory is a genuinely bad idea.

const STATES = {
  STOPPED: "stopped",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  ERROR: "error",
};

class Orchestrator {
  constructor({ settings, logs, onChange }) {
    this.settings = settings;
    this.logs = logs;
    this.onChange = onChange || (() => {});

    this.busy = null;            // "starting" | "stopping" | "restarting" | null
    this.children = new Map();   // id -> ChildProcess (only ones we spawned)

    // Which services this manager started, by id.
    //
    // Ownership cannot be inferred from `children`: PostgreSQL is launched
    // through pg_ctl, which starts a detached server and exits, so the database
    // never appears as a child process however plainly the manager started it.
    // Using "is it a child?" as the ownership test made the manager disown its
    // own database the moment it looked again, and then politely refuse to stop
    // it - exactly the behaviour that must not happen when the user presses Stop.
    this.owned = new Set();
    this.state = new Map();      // id -> per-service status record
    this.restartCounts = new Map();
    this.lastStartedAt = null;
    this.lastError = null;

    for (const id of START_ORDER) {
      this.state.set(id, { id, state: STATES.STOPPED, detail: "Not running", external: false, pid: null });
    }
  }

  // ---------- shared accessors ----------

  get appDir() { return this.settings.get("appDir"); }

  services() { return buildServices(this.appDir || ""); }

  setState(id, patch) {
    const prev = this.state.get(id) || { id };
    this.state.set(id, { ...prev, ...patch });
    this.onChange();
  }

  snapshot() {
    const defs = this.services();
    const services = START_ORDER.map((id) => {
      const def = defs[id];
      const st = this.state.get(id) || {};
      return {
        id,
        name: def.name,
        role: def.role,
        icon: def.icon,
        port: def.port,
        healthLabel: def.healthLabel,
        state: st.state || STATES.STOPPED,
        detail: st.detail || "",
        external: Boolean(st.external),
        pid: st.pid || null,
      };
    });

    const running = services.filter((s) => s.state === STATES.RUNNING).length;
    let overall = "stopped";
    if (this.busy) overall = this.busy;
    else if (services.some((s) => s.state === STATES.ERROR)) overall = "error";
    else if (running === services.length) overall = "running";
    else if (running > 0) overall = "partial";

    return {
      overall,
      busy: this.busy,
      services,
      appDir: this.appDir,
      lastStartedAt: this.lastStartedAt,
      lastError: this.lastError,
      openUrl: defs.web ? defs.web.openUrl : null,
    };
  }

  // ---------- detection ----------

  /**
   * Probes every service without starting anything. Run at launch so a stack
   * that is already up is shown as it is, and so the tray never offers to start
   * something that is already running.
   */
  async detect() {
    if (!this.appDir) return this.snapshot();
    const defs = this.services();

    for (const id of START_ORDER) {
      const def = defs[id];
      const alive = await def.probe();
      const mine = this.owned.has(id);
      const child = this.children.get(id);

      if (alive) {
        this.setState(id, {
          state: STATES.RUNNING,
          detail: mine ? def.healthLabel : "Running (started outside the manager)",
          external: !mine,
          pid: child ? child.pid : null,
        });
      } else {
        this.owned.delete(id);
        this.setState(id, { state: STATES.STOPPED, detail: "Not running", external: false, pid: null });
      }
    }
    return this.snapshot();
  }

  // ---------- start ----------

  async startAll() {
    if (this.busy) return { ok: false, error: `Already ${this.busy}.` };

    const valid = validateAppDir(this.appDir);
    if (!valid.ok) {
      this.lastError = valid.reason;
      this.logs.error("manager", valid.reason);
      return { ok: false, error: valid.reason };
    }

    this.busy = "starting";
    this.lastError = null;
    this.onChange();
    this.logs.info("manager", "Starting Clinical EHR.");

    try {
      for (const id of START_ORDER) {
        const result = await this.startOne(id);
        if (!result.ok) {
          this.busy = null;
          this.lastError = result.error;
          this.setState(id, { state: STATES.ERROR, detail: result.error });
          this.logs.error("manager", `Startup stopped: ${result.error}`);
          this.onChange();
          return result;
        }
      }

      this.busy = null;
      this.lastStartedAt = new Date().toISOString();
      this.logs.success("manager", "Clinical EHR is ready.");
      this.onChange();
      return { ok: true };
    } catch (err) {
      this.busy = null;
      this.lastError = String(err && err.message);
      this.logs.error("manager", `Unexpected startup failure: ${this.lastError}`);
      this.onChange();
      return { ok: false, error: this.lastError };
    }
  }

  async startOne(id) {
    const defs = this.services();
    const def = defs[id];

    // Already serving? Adopt it and move on.
    if (await def.probe()) {
      const mine = this.owned.has(id);
      const child = this.children.get(id);
      this.setState(id, {
        state: STATES.RUNNING,
        detail: mine ? def.healthLabel : "Already running (not started by the manager)",
        external: !mine,
        pid: child ? child.pid : null,
      });
      this.logs.info("manager", `${def.name} is already running - reusing it.`);
      return { ok: true, adopted: true };
    }

    const missing = missingRequirements(def);
    if (missing.length) {
      const rels = missing.map((p) => path.relative(this.appDir, p) || p);
      return {
        ok: false,
        error: `${def.name} cannot start - missing ${rels.join(", ")}.`,
        hint: id === "api"
          ? "Build the API first: npm run api:build"
          : "Check the application directory in Settings.",
      };
    }

    // The port must be free, or free-but-for-us. Anything else belongs to
    // somebody and this manager does not evict it.
    const owner = await pm.findPortOwner(def.port);
    if (owner) {
      return {
        ok: false,
        error: `Port ${def.port} is already in use by ${owner.image} (PID ${owner.pid}), which the manager did not start.`,
        hint: "Close that program, or change the port it is using. The manager will not stop a process it does not own.",
        conflict: { port: def.port, ...owner },
      };
    }

    this.setState(id, { state: STATES.STARTING, detail: "Starting…", external: false });
    this.logs.info("manager", `Starting ${def.name}…`);

    const launched = await this.launch(def);
    if (!launched.ok) {
      return { ok: false, error: `${def.name} failed to start: ${launched.error}` };
    }

    const ready = await waitUntil(() => def.probe(), {
      timeoutMs: id === "postgres" ? 60000 : 45000,
      intervalMs: 500,
      onProgress: (ms) => {
        if (ms % 5000 < 600) {
          this.setState(id, { state: STATES.STARTING, detail: `Starting… ${Math.round(ms / 1000)}s` });
        }
      },
    });

    if (!ready) {
      await this.stopOne(id).catch(() => {});
      return {
        ok: false,
        error: `${def.name} started but never became reachable on port ${def.port}.`,
        hint: "Open Logs and read that service's output for the underlying reason.",
      };
    }

    this.owned.add(id);
    this.setState(id, {
      state: STATES.RUNNING,
      detail: def.healthLabel,
      external: false,
      pid: this.children.has(id) ? this.children.get(id).pid : null,
    });
    this.logs.success("manager", `${def.name} is ready.`);
    this.restartCounts.set(id, 0);
    return { ok: true };
  }

  /** Spawns the service, hidden. Detached services return once their launcher exits. */
  async launch(def) {
    const cwd = def.start.cwdFromAppDir ? this.appDir : path.dirname(def.start.command || this.appDir);

    if (def.kind === "detached") {
      const res = await pm.run({
        command: def.start.command,
        args: def.start.args,
        cwd: this.appDir,
        timeoutMs: 60000,
      });
      // pg_ctl reports "another server might be running" on a stale lock file;
      // the readiness probe that follows is the real verdict either way.
      if (res.stdout) this.logs.fromService(def.id, res.stdout, "out");
      if (res.stderr) this.logs.fromService(def.id, res.stderr, "err");
      if (res.spawnError) return { ok: false, error: res.stderr || "could not be launched" };
      return { ok: true };
    }

    const node = def.start.useNode ? nodeBinary() : null;
    const command = node ? node.path : def.start.command;
    const args = def.start.useNode ? [def.start.script, ...(def.start.args || [])] : (def.start.args || []);

    let child;
    try {
      child = pm.spawnHidden({
        command,
        args,
        cwd,
        // ELECTRON_RUN_AS_NODE is only needed when Electron's own binary is
        // standing in for Node; a real node.exe must not receive it.
        env: node && node.isElectron ? { ELECTRON_RUN_AS_NODE: "1" } : undefined,
        onOutput: (line, stream) => this.logs.fromService(def.id, line, stream),
        onExit: (code) => this.handleExit(def.id, code),
      });
    } catch (err) {
      return { ok: false, error: String(err && err.message) };
    }

    this.children.set(def.id, child);
    this.setState(def.id, { pid: child.pid });
    return { ok: true };
  }

  /**
   * A service we started has gone away.
   *
   * During a deliberate stop this is expected and silent. Outside of one it is
   * a crash, and automatic recovery applies if the user has switched it on.
   */
  handleExit(id, code) {
    const def = this.services()[id];
    this.children.delete(id);

    if (this.busy === "stopping" || this.busy === "restarting") return;

    const wasRunning = (this.state.get(id) || {}).state === STATES.RUNNING;
    this.setState(id, { state: STATES.STOPPED, detail: `Exited (code ${code})`, pid: null });

    if (!wasRunning) return;
    this.logs.error("manager", `${def.name} stopped unexpectedly (exit code ${code}).`);

    if (!this.settings.get("autoRestart")) return;

    const attempts = (this.restartCounts.get(id) || 0) + 1;
    const max = this.settings.get("maxRestartAttempts");
    if (attempts > max) {
      this.setState(id, { state: STATES.ERROR, detail: `Stopped after ${max} restart attempts` });
      this.logs.error("manager", `${def.name} has failed ${max} times - automatic restart given up.`);
      return;
    }

    this.restartCounts.set(id, attempts);
    this.logs.warn("manager", `Restarting ${def.name} automatically (attempt ${attempts} of ${max}).`);
    setTimeout(() => {
      if (!this.busy) this.startOne(id).catch(() => {});
    }, 1500);
  }

  // ---------- stop ----------

  async stopAll() {
    if (this.busy === "stopping") return { ok: false, error: "Already stopping." };
    this.busy = "stopping";
    this.onChange();
    this.logs.info("manager", "Stopping Clinical EHR. The database is shut down cleanly; no data is removed.");

    for (const id of STOP_ORDER) {
      await this.stopOne(id);
    }

    this.busy = null;
    this.logs.success("manager", "Clinical EHR stopped.");
    this.onChange();
    return { ok: true };
  }

  async stopOne(id) {
    const def = this.services()[id];
    const st = this.state.get(id) || {};

    // Something this manager did not start is not this manager's to stop.
    if (st.external) {
      this.logs.warn("manager", `${def.name} was started outside the manager - leaving it running.`);
      return { ok: true, skipped: true };
    }

    if (st.state === STATES.STOPPED && !this.children.has(id)) return { ok: true };

    this.setState(id, { state: STATES.STOPPING, detail: "Stopping…" });

    if (def.kind === "detached") {
      // pg_ctl stop, default "fast" mode: clean shutdown, nothing deleted.
      const res = await pm.run({
        command: def.stop.command,
        args: def.stop.args,
        cwd: this.appDir,
        timeoutMs: 45000,
      });
      if (res.stdout) this.logs.fromService(id, res.stdout, "out");
      if (res.stderr) this.logs.fromService(id, res.stderr, "err");
    } else {
      const child = this.children.get(id);
      if (child && child.pid) {
        const result = await pm.stopTree(child.pid);
        if (result.forced) {
          // Expected, not alarming: taskkill's polite form posts a window
          // message, and a console service has no window to receive it.
          this.logs.info("manager", `${def.name} was terminated directly (no graceful signal on Windows).`);
        }
      }
      this.children.delete(id);
    }

    const gone = await waitUntil(async () => !(await def.probe()), { timeoutMs: 15000, intervalMs: 400 });
    if (gone) this.owned.delete(id);
    this.setState(id, {
      state: gone ? STATES.STOPPED : STATES.ERROR,
      detail: gone ? "Not running" : `Still answering on port ${def.port}`,
      pid: null,
    });

    if (gone) this.logs.success("manager", `${def.name} stopped.`);
    else this.logs.error("manager", `${def.name} is still answering on port ${def.port}.`);

    return { ok: gone };
  }

  // ---------- restart ----------

  async restartAll() {
    if (this.busy) return { ok: false, error: `Already ${this.busy}.` };
    this.busy = "restarting";
    this.onChange();
    this.logs.info("manager", "Restarting Clinical EHR.");

    for (const id of STOP_ORDER) await this.stopOne(id);

    // Wait for every port to be genuinely free before starting again, so the
    // restart cannot race a socket that is still closing and produce a second
    // copy or a false port conflict.
    const defs = this.services();
    for (const id of STOP_ORDER) {
      await waitUntil(async () => !(await defs[id].probe()), { timeoutMs: 15000, intervalMs: 400 });
    }

    this.busy = null;
    return this.startAll();
  }

  /** Every child this manager owns, for a clean application exit. */
  async shutdownOwned() {
    this.busy = "stopping";
    for (const id of STOP_ORDER) {
      const st = this.state.get(id) || {};
      if (!st.external) await this.stopOne(id).catch(() => {});
    }
    this.busy = null;
  }
}

/**
 * Finds an interpreter to run Vite with.
 *
 * The system's own node.exe is preferred when there is one. Electron bundles a
 * Node runtime and will happily stand in for it (that is what
 * ELECTRON_RUN_AS_NODE does), but the bundled version trails the current
 * release - Electron 33 carries Node 20.18, and Vite 8 asks for 20.19 or newer
 * and says so on every start. Using the installed Node keeps the dev server on
 * a version it actually supports.
 *
 * The Electron fallback still matters: it means a packaged manager works on a
 * clinic machine that has never had Node installed.
 */
function nodeBinary() {
  const found = findSystemNode();
  if (found) return { path: found, isElectron: false };
  return { path: process.execPath, isElectron: true };
}

let cachedNodePath;

function findSystemNode() {
  if (cachedNodePath !== undefined) return cachedNodePath;
  cachedNodePath = null;

  const dirs = String(process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, "node.exe");
    try {
      if (fs.existsSync(candidate)) { cachedNodePath = candidate; break; }
    } catch { /* an unreadable PATH entry is not fatal */ }
  }
  return cachedNodePath;
}

module.exports = { Orchestrator, STATES };
