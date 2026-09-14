"use strict";

const net = require("net");
const http = require("http");

// Health probing.
//
// Two kinds of question, deliberately kept apart:
//
//   reachable  - is something listening on the port?
//   healthy    - is it the right something, and is it working?
//
// A port that answers is not the same as a service that works. The Go API is
// only counted healthy when /api/health returns 200, which it does only after
// it has actually connected to PostgreSQL - so the API's health check doubles
// as proof the database behind it is answering queries, not merely accepting
// sockets.
//
// Nothing here spawns a process. An earlier draft shelled out to psql.exe to
// test the database, which meant a new process every two seconds for as long as
// the dashboard was open; a TCP probe answers the same question for free.

/** Resolves true when something is listening on host:port. */
function tcpProbe(port, host = "127.0.0.1", timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));

    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/**
 * Resolves true when an HTTP endpoint answers with an acceptable status.
 *
 * A 401 counts as healthy for authenticated endpoints: the service answered,
 * which is the question being asked. Only the health endpoint is probed here
 * and it is unauthenticated, but the allowance keeps this reusable.
 */
function httpProbe(url, { timeoutMs = 1500, accept = [200, 204, 401] } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      // Drain, or the socket is held open and the agent pool fills up.
      res.resume();
      finish(accept.includes(res.statusCode));
    });

    req.on("timeout", () => { req.destroy(); finish(false); });
    req.on("error", () => finish(false));
  });
}

/**
 * Polls `check` until it returns true, or the timeout expires.
 *
 * onProgress receives elapsed milliseconds so the UI can show a service taking
 * its time rather than appearing frozen - PostgreSQL's first start after a
 * machine reboot is routinely several seconds.
 */
async function waitUntil(check, { timeoutMs = 45000, intervalMs = 500, onProgress } = {}) {
  const started = Date.now();
  for (;;) {
    if (await check()) return true;

    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) return false;
    if (onProgress) onProgress(elapsed);

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = { tcpProbe, httpProbe, waitUntil };
