"use strict";

const fs = require("fs");
const path = require("path");

// Log capture.
//
// The services run with no console, so their stdout and stderr have nowhere to
// go unless something collects them. This does, into two places at once: a
// bounded in-memory buffer the dashboard renders, and a rolling file on disk
// for the case that matters most - a failure that happened before anyone had
// the window open.
//
// Nothing here writes patient data. It records what the services print about
// themselves, and this manager never asks them for record contents.

const MAX_ENTRIES = 3000;   // roughly a full day of ordinary start/stop activity
const MAX_FILE_BYTES = 2 * 1024 * 1024;

class LogStore {
  constructor(logDir) {
    this.logDir = logDir;
    this.file = path.join(logDir, "clinical-ehr-manager.log");
    this.entries = [];
    this.listeners = new Set();
    this.seq = 0;

    try {
      fs.mkdirSync(logDir, { recursive: true });
      this.rotateIfLarge();
    } catch {
      // A read-only or missing log directory must not stop the manager from
      // running; the in-memory viewer still works.
      this.file = null;
    }
  }

  /**
   * @param {string} source  "manager" | "postgres" | "api" | "web"
   * @param {string} level   "info" | "success" | "warn" | "error"
   */
  add(source, level, message) {
    const entry = {
      id: ++this.seq,
      at: new Date().toISOString(),
      source,
      level,
      message: String(message).replace(/\s+$/, ""),
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }

    this.appendToFile(entry);
    for (const fn of this.listeners) {
      try { fn(entry); } catch { /* a broken listener must not stop logging */ }
    }
    return entry;
  }

  info(source, message)    { return this.add(source, "info", message); }
  success(source, message) { return this.add(source, "success", message); }
  warn(source, message)    { return this.add(source, "warn", message); }
  error(source, message)   { return this.add(source, "error", message); }

  /**
   * Classifies a line a service printed on its own.
   *
   * Deliberately conservative. Vite writes its startup banner to stderr, and Go's
   * standard logger writes everything there too, so treating "came from stderr"
   * as "is an error" would paint a healthy startup red. The text decides.
   */
  fromService(source, line, stream) {
    const text = line.trim();
    if (!text) return null;

    let level = "info";
    if (/\b(error|fatal|panic|refused|failed|cannot)\b/i.test(text)) level = "error";
    else if (/\bwarn(ing)?\b/i.test(text)) level = "warn";
    else if (/\b(ready|listening|started|success)\b/i.test(text)) level = "success";
    else if (stream === "err" && /^\s*$/.test(text)) return null;

    return this.add(source, level, text);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  all() { return this.entries.slice(); }

  clear() {
    this.entries = [];
    this.add("manager", "info", "Log cleared.");
  }

  asText(sources) {
    const wanted = sources && sources.length ? new Set(sources) : null;
    return this.entries
      .filter((e) => !wanted || wanted.has(e.source))
      .map((e) => `${e.at}  ${e.source.padEnd(9)} ${e.level.padEnd(7)} ${e.message}`)
      .join("\n");
  }

  appendToFile(entry) {
    if (!this.file) return;
    try {
      fs.appendFileSync(
        this.file,
        `${entry.at}\t${entry.source}\t${entry.level}\t${entry.message}\n`,
        "utf8"
      );
    } catch {
      this.file = null; // stop trying; the viewer still has everything
    }
  }

  // One generation of history is kept, so the log that captured last week's
  // failure is not lost the moment the current one fills up.
  rotateIfLarge() {
    if (!this.file || !fs.existsSync(this.file)) return;
    if (fs.statSync(this.file).size < MAX_FILE_BYTES) return;
    try {
      fs.renameSync(this.file, this.file.replace(/\.log$/, ".previous.log"));
    } catch { /* keep appending to the current file */ }
  }
}

module.exports = { LogStore };
