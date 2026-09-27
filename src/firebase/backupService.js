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

// Labels for every non-backup grant, so the Access Management editor can show them properly. The
// server is the source of truth for which permissions exist and which are high risk - the
// listBackupAccess response carries the whole set. This table only supplies a human label and a
// short description.
export const PERMISSION_META = {
  // Backup & Restore (duplicated here so lookup is one path)
  BACKUP_VIEW:               { label: "View Backup History", help: "Open Backup & Restore and see the history and status." },
  BACKUP_CREATE:             { label: "Create Backup", help: "Run Create Backup Now." },
  BACKUP_DOWNLOAD:           { label: "Download Backup", help: "Download backup files." },
  BACKUP_UPLOAD:             { label: "Upload Backup", help: "Upload a backup file." },
  BACKUP_RESTORE:            { label: "Restore Backup", help: "Replace live data with a backup." },
  BACKUP_DELETE:             { label: "Delete Backup", help: "Permanently remove a backup file." },
  BACKUP_SETTINGS:           { label: "Backup Settings", help: "Change the automatic backup schedule." },
  BACKUP_ACCESS_MANAGEMENT:  { label: "Manage Backup Access", help: "Grant and revoke backup access. Super Admin only." },

  // Antimicrobial Review
  ANTIMICROBIAL_VIEW:        { label: "View", help: "Open the Antimicrobial Review tab." },
  ANTIMICROBIAL_REVIEW:      { label: "Create / Record review", help: "Add a review entry or record a review outcome." },
  ANTIMICROBIAL_ASSIGN:      { label: "Assign reviewer", help: "Assign an antimicrobial review to a reviewer." },
  ANTIMICROBIAL_COMPLETE:    { label: "Complete review", help: "Close a review as completed." },
  ANTIMICROBIAL_REPORT:      { label: "Reports", help: "See antimicrobial stewardship reports." },

  // HIM Coding
  HIM_WORKLIST_VIEW:         { label: "View worklist", help: "Open the HIM coding worklist." },
  HIM_CODING_EDIT:           { label: "Create / Edit encounters", help: "Create HIM encounters and edit codes." },
  HIM_ASSIGN:                { label: "Assign coder", help: "Assign an encounter to a coder." },
  HIM_QUERY_CREATE:          { label: "Create query", help: "Raise a coding query to the provider." },
  HIM_QUERY_MANAGE:          { label: "Manage query", help: "Respond to or close a coding query." },
  HIM_COMPLETE:              { label: "Complete encounter", help: "Close a coded encounter as complete." },
  HIM_REPORT:                { label: "Reports", help: "See HIM coding reports." },

  // Doctor Clinical Workspace
  DOCTOR_PATIENT_VIEW:         { label: "Patient view", help: "See the clinical patient header." },
  DOCTOR_MEDICAL_RECORD_VIEW:  { label: "Medical record tab", help: "Access the Medical Record tab." },
  DOCTOR_CLINICAL_NOTE_CREATE: { label: "Create note", help: "Draft a clinical note." },
  DOCTOR_CLINICAL_NOTE_EDIT:   { label: "Edit note", help: "Edit an unsigned note." },
  DOCTOR_CLINICAL_NOTE_SIGN:   { label: "Sign note", help: "Sign a note - clinical attestation." },
  DOCTOR_LAB_VIEW:             { label: "Labs", help: "See lab results." },
  DOCTOR_DOCUMENT_VIEW:        { label: "Documents", help: "See uploaded clinical documents." },
  DOCTOR_DIAGNOSIS_MANAGE:     { label: "Manage diagnoses", help: "Add or remove diagnoses on a chart." },
  DOCTOR_MEDICATION_VIEW:      { label: "View medications", help: "See a patient's medications." },
  DOCTOR_MEDICATION_MANAGE:    { label: "Change medication", help: "Change dose / duration on a submitted medication." },
  DOCTOR_ANTIMICROBIAL_VIEW:   { label: "Antimicrobial context", help: "See antimicrobial-relevant chart data." },

  // Medical Records (uploaded files)
  MEDICAL_RECORD_DOCUMENT_VIEW: { label: "View records", help: "Open uploaded medical records." },
  MEDICAL_RECORD_UPLOAD:        { label: "Upload records", help: "Attach a new medical record." },
  MEDICAL_RECORD_DOWNLOAD:      { label: "Download / Print", help: "Download or print a medical record." },
  MEDICAL_RECORD_EMAIL:         { label: "Email record", help: "Email a medical record to a recipient." },
  MEDICAL_RECORD_DELETE:        { label: "Delete record", help: "Remove a filed record." },

  // Prescriptions
  RX_VIEW:          { label: "View prescriptions", help: "See a patient's prescription history." },
  RX_CREATE:        { label: "Create / Draft", help: "Draft a new prescription." },
  RX_SIGN:          { label: "Sign", help: "Sign a prescription - legal attestation." },
  RX_SEND:          { label: "Send", help: "Transmit a signed prescription to a pharmacy." },
  RX_CANCEL:        { label: "Cancel", help: "Cancel a prescription." },
  RX_HISTORY_VIEW:  { label: "History", help: "See prescription history." },

  // Claims / CMS-1500
  CLAIM_HCFA_VIEW:        { label: "View HCFA / CMS-1500", help: "See an assembled claim." },
  CLAIM_HCFA_PRINT:       { label: "Print", help: "Record a CMS-1500 print." },
  CLAIM_ELECTRONIC_SUBMIT:{ label: "Electronic submit", help: "Transmit a claim to the payer." },
  CLAIM_PRINT_SETTINGS:   { label: "Print settings", help: "Change CMS-1500 alignment / template." },

  // HR / Workforce
  HR_WORKFORCE_VIEW:    { label: "Workforce", help: "Access the HR tab and see the workforce." },
  HR_EMPLOYEE_VIEW:     { label: "Employee detail", help: "See identifying and employment fields." },
  HR_CREDENTIAL_VIEW:   { label: "Credentials", help: "See credentials and training compliance." },
  HR_REPORT_EXPORT:     { label: "Export reports", help: "Export workforce data." },
  HR_EMPLOYEE_MANAGE:   { label: "Manage employees", help: "Add / edit employees; upload documents." },
  HR_SCHEDULE_MANAGE:   { label: "Manage schedule", help: "Publish and edit rotas." },
  HR_ATTENDANCE_MANAGE: { label: "Manage attendance", help: "Record and adjust attendance." },
  HR_LEAVE_MANAGE:      { label: "Manage leave", help: "Approve or refuse leave." },
  HR_CONFIG_MANAGE:     { label: "Manage HR setup", help: "Departments, job titles, locations, shifts." },
};

// Mirrors highRiskUserPermissions in server/userpermissions.go. Kept in step with it because
// the confirmation this drives is the one section 53 asks for.
export const HIGH_RISK_PERMISSIONS = new Set([
  "BACKUP_RESTORE", "BACKUP_DELETE", "BACKUP_SETTINGS", "BACKUP_ACCESS_MANAGEMENT",
  "ANTIMICROBIAL_COMPLETE", "HIM_CODING_EDIT", "HIM_COMPLETE",
  "DOCTOR_CLINICAL_NOTE_SIGN", "DOCTOR_MEDICATION_MANAGE", "DOCTOR_DIAGNOSIS_MANAGE",
  "MEDICAL_RECORD_DELETE", "MEDICAL_RECORD_EMAIL",
  "RX_SIGN", "RX_SEND",
  "CLAIM_ELECTRONIC_SUBMIT",
  "HR_REPORT_EXPORT", "HR_EMPLOYEE_MANAGE", "HR_LEAVE_MANAGE",
]);

export function permissionLabel(key) {
  return PERMISSION_META[key]?.label || key;
}

export function permissionHelp(key) {
  return PERMISSION_META[key]?.help || "";
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
  return {
    users: res.users || [],
    permissions: res.permissions || [],
    groups: res.groups || [],
    highRisk: res.highRisk || [],
  };
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
