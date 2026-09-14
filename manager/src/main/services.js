"use strict";

const path = require("path");
const fs = require("fs");
const { tcpProbe, httpProbe } = require("./health");

// The service catalogue.
//
// Three services, because three is what this application has. Node.js appears
// nowhere as a service: in this project Node is the build toolchain that runs
// Vite plus three one-shot CLI scripts (seedFirestore, exportFirestore,
// makeDemoGif), none of which listen on a port or stay running. A card reading
// "Node.js - Running" would be reporting on something that does not exist.
//
// Every path and port below was read out of the project, not assumed:
//   - PostgreSQL 5433 comes from tools/pgdata/postgresql.conf, which is why
//     db:psql in package.json passes -p 5433. It is NOT the default 5432.
//   - 8080 is the ADDR default in server/main.go.
//   - 5173 is Vite's default, and vite.config.js sets strictPort: true, so the
//     dev server fails loudly on a taken port instead of silently moving to
//     5174 and leaving the browser pointed at nothing.

const START_ORDER = ["postgres", "api", "web"];
// Shutdown is the reverse: let the things that depend on the database let go of
// it before the database goes away.
const STOP_ORDER = [...START_ORDER].reverse();

/**
 * Builds the service definitions for a project directory.
 * Kept a function rather than a constant so the directory stays configurable -
 * nothing here hard-codes a machine-specific path.
 */
function buildServices(appDir) {
  const pgData = path.join(appDir, "tools", "pgdata");
  const pgCtl = path.join(appDir, "tools", "pgsql", "bin", "pg_ctl.exe");
  const pgLog = path.join(appDir, "tools", "pgdata", "manager-postgres.log");
  const apiExe = path.join(appDir, "server", "medbill-server.exe");
  const viteJs = path.join(appDir, "node_modules", "vite", "bin", "vite.js");

  return {
    postgres: {
      id: "postgres",
      name: "PostgreSQL",
      role: "Database",
      icon: "database",
      port: 5433,

      // PostgreSQL is not a child process this manager babysits. pg_ctl starts
      // a detached server and returns; the server outlives the launcher by
      // design, which is also why it survives the manager being closed.
      kind: "detached",

      requires: [pgCtl, pgData],

      start: {
        command: pgCtl,
        // -w waits for the server to accept connections before returning, so a
        // successful exit already means "ready" rather than "launched".
        args: ["-D", pgData, "-l", pgLog, "-w", "start"],
      },

      // DATABASE SAFETY - the only stop this manager will ever issue.
      //
      // pg_ctl's default shutdown mode is "fast": running transactions are
      // rolled back, the server flushes and exits cleanly. There is deliberately
      // no "-m immediate" here, and there is no code path anywhere in this
      // application that runs dropdb, truncate, a migration, or a Docker volume
      // removal. Stopping the application must never cost a patient record.
      stop: {
        command: pgCtl,
        args: ["-D", pgData, "-w", "stop"],
      },

      probe: () => tcpProbe(5433),
      healthLabel: "accepting connections",
    },

    api: {
      id: "api",
      name: "Go Backend",
      role: "API Server",
      icon: "server",
      port: 8080,
      kind: "child",

      requires: [apiExe],
      dependsOn: ["postgres"],

      start: {
        command: apiExe,
        args: [],
        // Run from the project root: the server resolves
        // server/firebase-hash-config.json relative to the working directory.
        cwdFromAppDir: true,
      },

      // /api/health pings the database before answering 200, so a healthy API
      // is also proof the connection behind it works.
      probe: () => httpProbe("http://127.0.0.1:8080/api/health"),
      healthLabel: "/api/health responding",
    },

    web: {
      id: "web",
      name: "React Frontend",
      role: "Web Interface",
      icon: "layout",
      port: 5173,
      kind: "child",

      requires: [viteJs],
      dependsOn: ["api"],

      // Started as `node vite.js`, never as `npm run dev`. npm.cmd is a batch
      // file, and Windows runs batch files by starting cmd.exe - which arrives
      // with its own console window before CREATE_NO_WINDOW can apply to it.
      // Calling Vite's JavaScript entry point directly avoids the shell layer
      // entirely, which is what keeps the screen free of a terminal flash.
      start: {
        useNode: true,
        script: viteJs,
        args: ["--port", "5173", "--strictPort"],
        cwdFromAppDir: true,
      },

      probe: () => tcpProbe(5173),
      healthLabel: "serving on 5173",
      openUrl: "http://localhost:5173/",
    },
  };
}

/**
 * Reports which required files are missing, so a wrong or half-built project
 * directory produces a precise message instead of a spawn failure.
 */
function missingRequirements(service) {
  return (service.requires || []).filter((p) => !fs.existsSync(p));
}

/**
 * Recognises a directory as this project.
 *
 * Checked against files that are committed and structural, not against build
 * output - server/main.go is in the repository, while medbill-server.exe is
 * produced by `npm run api:build` and is legitimately absent on a fresh clone.
 * A directory can be valid while still needing a build, and the two problems
 * deserve different messages.
 */
function validateAppDir(dir) {
  if (!dir) return { ok: false, reason: "No application directory is set." };
  if (!fs.existsSync(dir)) return { ok: false, reason: "That folder does not exist." };

  const markers = [
    path.join(dir, "package.json"),
    path.join(dir, "server", "main.go"),
    path.join(dir, "src", "app.jsx"),
  ];
  const missing = markers.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    return {
      ok: false,
      reason: "That folder does not look like the Clinical EHR project (package.json, server/main.go and src/app.jsx were expected).",
    };
  }
  return { ok: true };
}

module.exports = { buildServices, missingRequirements, validateAppDir, START_ORDER, STOP_ORDER };
