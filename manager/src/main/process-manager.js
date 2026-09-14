"use strict";

const { spawn } = require("child_process");

// Process control for the Clinical EHR Manager.
//
// ============================================================================
//  THE NO-CONSOLE RULE - read this before changing anything in this file
// ============================================================================
//
// Two things make a console window appear on Windows, and this module exists to
// avoid both of them.
//
// 1. HOW a process is spawned. Node's `windowsHide: true` sets the Win32
//    CREATE_NO_WINDOW creation flag, so the child is given no console at all.
//    It is not a hidden window or a minimised one - there is no window to show.
//    Every spawn in this application goes through run() or spawnHidden() below,
//    and both set it. Nothing else may call child_process directly.
//
// 2. WHAT is spawned. `npm.cmd`, `npx.cmd` and any `.bat`/`.cmd` file are batch
//    scripts: Windows runs them by starting cmd.exe, and cmd.exe brings its own
//    console before our flag can apply to it. The same is true of
//    `powershell -File script.ps1`. So this manager never shells out to the
//    project's npm scripts or to scripts/db.ps1, even though those exist and
//    work - it calls the underlying .exe and .js entry points directly. That is
//    the single most important design decision here.
//
// Stopping is the mirror image of the same problem: `taskkill /IM node.exe`
// would kill every Node process on the machine, including the user's own work.
// Everything below is addressed by PID, and only PIDs this manager started.

const CREATE_NO_WINDOW_OPTS = {
  windowsHide: true,
  // Pipes rather than 'inherit': inheriting would attach the child to whatever
  // console the manager has (none, when packaged) and would throw away output
  // that belongs in the log viewer.
  stdio: ["ignore", "pipe", "pipe"],
};

/**
 * Spawns a long-running service with no console window.
 *
 * @param {object}   opts
 * @param {string}   opts.command   absolute path to an .exe or the node binary
 * @param {string[]} opts.args
 * @param {string}   opts.cwd
 * @param {object}   [opts.env]
 * @param {(line: string, stream: "out"|"err") => void} opts.onOutput
 * @param {(code: number|null, signal: string|null) => void} opts.onExit
 * @returns {import("child_process").ChildProcess}
 */
function spawnHidden({ command, args, cwd, env, onOutput, onExit }) {
  const child = spawn(command, args, {
    cwd,
    env: childEnv(env),
    ...CREATE_NO_WINDOW_OPTS,
  });

  attachOutput(child, onOutput);

  child.on("exit", (code, signal) => {
    if (onExit) onExit(code, signal);
  });

  return child;
}

// Splits the child's byte stream into whole lines before handing them to the
// log. Without this, a chunk boundary can arrive mid-line and the viewer shows
// half a message on one row and half on the next.
function attachOutput(child, onOutput) {
  if (!onOutput) return;

  for (const [stream, name] of [[child.stdout, "out"], [child.stderr, "err"]]) {
    if (!stream) continue;
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) onOutput(line, name);
      }
    });
    stream.on("end", () => {
      if (buffer.trim()) onOutput(buffer, name);
    });
  }
}

/**
 * Runs a short-lived command to completion with no console window, and
 * collects its output. Used for pg_ctl, taskkill and netstat.
 *
 * Never rejects on a non-zero exit - the caller decides what a failure means,
 * because for several of these (taskkill on an already-dead PID, pg_ctl stop on
 * a stopped server) a non-zero exit is the expected, harmless outcome.
 */
function run({ command, args, cwd, env, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: childEnv(env),
        ...CREATE_NO_WINDOW_OPTS,
      });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: String(err && err.message), spawnError: true });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    if (child.stdout) child.stdout.on("data", (d) => { stdout += d; });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += d; });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already gone */ }
      resolve({ code: -1, stdout, stderr, timedOut: true });
    }, timeoutMs);

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    child.on("error", (err) => {
      stderr += String(err && err.message);
      finish(-1);
    });
    child.on("close", finish);
  });
}

/**
 * Stops a process and everything it started, addressed strictly by PID.
 *
 * `taskkill /PID n /T` walks the process tree rooted at that one PID. That
 * matters for the dev server: Vite spawns esbuild workers, and killing only the
 * parent would leave them holding the port. The /T form reaches them; an /IM
 * form would reach every Node process on the machine, which is exactly the
 * behaviour this application must never have.
 *
 * The polite signal goes first. /F is only sent if the process is still there
 * after graceMs, because a forced kill gives a service no chance to release
 * what it is holding.
 */
async function stopTree(pid, { graceMs = 1500 } = {}) {
  if (!pid) return { stopped: true, forced: false };

  await run({ command: "taskkill", args: ["/PID", String(pid), "/T"] });

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!(await isRunning(pid))) return { stopped: true, forced: false };
    await delay(200);
  }

  await run({ command: "taskkill", args: ["/PID", String(pid), "/T", "/F"] });
  await delay(400);

  return { stopped: !(await isRunning(pid)), forced: true };
}

/** True when a PID still exists. Signal 0 tests for existence without signalling. */
async function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else - still running.
    return err && err.code === "EPERM";
  }
}

/**
 * Finds which PID is listening on a TCP port, so a conflict can be reported
 * precisely ("port 8080 is held by PID 14412") instead of vaguely.
 *
 * This only ever reads. Nothing in this manager kills a process it did not
 * start, however tempting it is when a port is occupied - that process may be
 * the user's own work.
 */
async function findPortOwner(port) {
  const { code, stdout } = await run({
    command: "netstat",
    args: ["-ano", "-p", "TCP"],
    timeoutMs: 8000,
  });
  if (code !== 0 && !stdout) return null;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const local = parts[1];
    const pid = Number(parts[parts.length - 1]);
    // Match the port at the end of the address, so :5433 does not match :15433.
    const match = /:(\d+)$/.exec(local);
    if (match && Number(match[1]) === port && Number.isFinite(pid)) {
      return { pid, address: local, image: await imageNameFor(pid) };
    }
  }
  return null;
}

/** Best-effort executable name for a PID, for the conflict dialog. */
async function imageNameFor(pid) {
  const { stdout } = await run({
    command: "tasklist",
    args: ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
    timeoutMs: 8000,
  });
  const match = /^"([^"]+)"/m.exec(stdout.trim());
  return match ? match[1] : "unknown";
}

/**
 * Builds the environment a child is given.
 *
 * ELECTRON_RUN_AS_NODE is stripped unless the caller asked for it. The variable
 * turns any Electron binary into a plain Node interpreter, and it is inherited
 * by every descendant - so a value present in the manager's own environment
 * would silently follow every service down the tree. It is set deliberately for
 * exactly one child (Vite, which needs a Node interpreter) and removed for all
 * the rest, so that whether the manager was launched from an ordinary shortcut
 * or from a terminal that happens to export it, the services are given the same
 * environment either way.
 */
function childEnv(overrides) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return overrides ? { ...env, ...overrides } : env;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  spawnHidden,
  run,
  stopTree,
  isRunning,
  findPortOwner,
  imageNameFor,
  delay,
};
