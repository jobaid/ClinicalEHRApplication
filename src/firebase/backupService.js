// Backup & Restore, and the permissions that govern it.
//
// Same shape as authService.js: this module owns the paths and the response unwrapping, and
// src/app.jsx imports named functions without knowing the transport.
//
// Nothing here decides what the signed-in user may do. myBackupPermissions() reports what the
// server says they hold so the interface can render the right controls, but every one of these
// calls is authorised again server-side - a browser that skips the check simply collects 403s.

import { api, apiBlob, apiUpload } from "./apiClient";

export const BACKUP_PERMISSIONS = [
  { key: "BACKUP_VIEW", label: "View Backup History", help: "Open Backup & Restore and see the history and status." },
  { key: "BACKUP_CREATE", label: "Create Backup", help: "Run Create Backup Now. Does not allow restoring." },
  { key: "BACKUP_DOWNLOAD", label: "Download Backup", help: "Download backup files to their own machine." },
  { key: "BACKUP_UPLOAD", label: "Upload Backup", help: "Upload a backup file for validation or restore." },
  { key: "BACKUP_RESTORE", label: "Restore Backup", help: "Replace live data with a backup. High risk." },
  { key: "BACKUP_DELETE", label: "Delete Backup", help: "Permanently remove a backup file." },
  { key: "BACKUP_SETTINGS", label: "Backup Settings", help: "Change the automatic backup schedule and retention." },
  { key: "BACKUP_ACCESS_MANAGEMENT", label: "Manage Backup Access", help: "Grant and revoke backup access. Super Admin only." },
];

// Mirrors highRiskUserPermissions in server/userpermissions.go. Kept in step with it because
// the confirmation this drives is the one section 53 asks for.
export const HIGH_RISK_PERMISSIONS = new Set([
  "BACKUP_RESTORE",
  "BACKUP_DELETE",
  "BACKUP_SETTINGS",
  "BACKUP_ACCESS_MANAGEMENT",
]);

export function permissionLabel(key) {
  return BACKUP_PERMISSIONS.find((p) => p.key === key)?.label || key;
}

// ---------- what may I do ----------

export async function myBackupPermissions() {
  const res = await api("/api/admin/backup-permissions/me");
  return { permissions: res.permissions || [], superAdmin: !!res.superAdmin };
}

// ---------- backups ----------

export async function listBackups() {
  const res = await api("/api/admin/backups");
  return res.backups || [];
}

export async function createBackup(note = "") {
  return api("/api/admin/backups", { method: "POST", body: { note } });
}

export async function downloadBackup(id) {
  return apiBlob(`/api/admin/backups/${encodeURIComponent(id)}/download`, { method: "GET" });
}

export async function uploadBackup(file) {
  return apiUpload("/api/admin/backups/upload", file);
}

// The confirm string is checked by the server too. Sending it from here is not the safeguard -
// the safeguard is that the server refuses without it - but it keeps a stray click on a
// mis-wired button from reaching a restore.
export async function restoreBackup(id) {
  return api(`/api/admin/backups/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    body: { confirm: "RESTORE" },
  });
}

export async function deleteBackup(id) {
  return api(`/api/admin/backups/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---------- schedule ----------

export async function getBackupSettings() {
  return api("/api/admin/backup-settings");
}

export async function saveBackupSettings(settings) {
  return api("/api/admin/backup-settings", { method: "PUT", body: settings });
}

// ---------- access management ----------

export async function listBackupAccess() {
  const res = await api("/api/admin/backup-access");
  return { users: res.users || [], permissions: res.permissions || [], highRisk: res.highRisk || [] };
}

export async function saveBackupAccess(userId, permissions) {
  return api(`/api/admin/backup-access/${encodeURIComponent(userId)}`, {
    method: "PUT",
    body: { permissions },
  });
}

export async function backupAccessHistory() {
  const res = await api("/api/admin/backup-access/history");
  return res.history || [];
}

// ---------- presentation helpers ----------

export function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// Saves a blob the browser already holds. Revoking the object URL matters: without it the blob
// stays in memory for the life of the tab, and a database dump is not a small thing to leak.
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
