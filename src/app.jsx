import React, { useState, useMemo, useEffect, useRef, useCallback, useContext, createContext } from "react";
import Papa from "papaparse";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { signIn, signOutUser, fetchUserProfile, createUserAccount, changeOwnPassword, adminResetPassword,
  verifyMfa, startMfaEnrollment, confirmMfaEnrollment, securityStatus, listTrustedDevices,
  revokeTrustedDevice, revokeAllTrustedDevices } from "./firebase/authService";
import { useFirestoreCollection, setDocument, updateDocument, addDocument, deleteDocument, newBatch, docRef } from "./firebase/firestoreService";
import { api, apiBlob, onTokenChange } from "./firebase/apiClient";
import {
  LayoutDashboard, CalendarDays, Users, Receipt, FileStack, BarChart3,
  Plus, X, Search, ChevronRight, ChevronLeft, AlertCircle, CheckCircle2, Clock,
  Send, DollarSign, Stethoscope, Settings, Trash2, Pencil, MessageSquarePlus,
  ScissorsLineDashed, CreditCard, Upload, FileCheck2, Landmark, Wand2,
  Download, Printer, TrendingDown, TrendingUp,
  Shield, History, IdCard, Ban, Eye, FileText,
  Activity, Pill, ClipboardList, FileSignature, AlertTriangle, HeartPulse, UserCog, Bell, Wrench, Paperclip,
  KeyRound, ShieldCheck
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, Legend
} from "recharts";

// ---------- Seed data ----------

// Patient demography, CPT catalog, insurance, charges/claims, clinical data, ID documents, and
// user accounts all live in Firestore now (see src/firebase/ and scripts/seedFirestore.mjs) —
// nothing here is hardcoded app data any more. What's left below are small reference constants
// (role/permission tables, dropdown option lists, providers) that aren't "data" so much as UI
// vocabulary, plus pure helper functions.

// CMS-1500-style claim fields — practice defaults, prefilled but editable per charge.
const PRACTICE_INFO = { name: "Jobaid Clinic", address: "400 Harbor Way, Bellerose, NY 11426", taxId: "13-5551234" };
const emptyDxCodes = () => Array(10).fill("");

// ---------- Auth / RBAC ----------
// Real authentication now goes through Firebase Auth (src/firebase/authService.js) — role and
// display name are read from the users/{uid} Firestore doc after sign-in, not from a local list.
// This gates the UI so each role sees the right nav; the actual write-permission enforcement
// lives in firestore.rules / storage.rules, not just in this client-side tab filter.

// Display-only convenience for the login screen's "quick fill" panel — these are the accounts
// scripts/seedFirestore.mjs creates. Never used to authenticate; real sign-in always goes
// through signIn() in src/firebase/authService.js.
//
// This list is working credentials printed on the sign-in page, so it must never reach a
// deployed build. SHOW_DEMO_LOGINS gates the panel: on during `npm run dev`, off in any
// production build unless VITE_SHOW_DEMO_LOGINS=true is set deliberately for a public demo.
// Vite inlines import.meta.env at build time, so with the flag off the block below is
// unreachable and the bundler drops it — the passwords are absent from the shipped JavaScript,
// not merely hidden by CSS.
const SHOW_DEMO_LOGINS = import.meta.env.DEV || import.meta.env.VITE_SHOW_DEMO_LOGINS === "true";

const DEMO_LOGIN_HINTS = [
  { email: "admin@medbill.local", password: "Admin@12345", role: "SUPER_ADMIN" },
  { email: "manager@medbill.local", password: "Manager@12345", role: "MANAGER" },
  { email: "nurse@medbill.local", password: "Nurse@12345", role: "NURSE" },
  { email: "reception@medbill.local", password: "Reception@12345", role: "RECEPTIONIST" },
  { email: "biller@medbill.local", password: "Biller@12345", role: "BILLER" },
];
const ROLE_LABELS = {
  SUPER_ADMIN: "Super Admin", MANAGER: "Manager", NURSE: "Nurse", RECEPTIONIST: "Receptionist", BILLER: "Biller",
};

// Fallback tab grants, used only until the rolePermissions collection loads (and if a role has
// no row there). The live grants are stored in the database and edited from
// Settings > Manage roles; these values mirror migrations/002_role_permissions.sql.
//
// SUPER_ADMIN is deliberately absent from the editable path everywhere: it always holds every
// tab, so an admin cannot revoke their own access to the screen that grants access back.
const DEFAULT_ROLE_TABS = {
  SUPER_ADMIN: ["dashboard", "schedule", "patients", "clinical", "billing", "claims", "reports", "users"],
  MANAGER: ["dashboard", "schedule", "patients", "clinical", "billing", "claims", "reports"],
  NURSE: ["dashboard", "schedule", "patients", "clinical"],
  RECEPTIONIST: ["dashboard", "schedule", "patients"],
  BILLER: ["dashboard", "patients", "billing", "claims", "reports"],
};

// CPT catalog now lives in Firestore's cptCatalog collection (loaded once in ClinicApp) and is
// handed down through this context rather than prop-drilled through every intermediate form —
// it's read from several unrelated leaf components (AddChargeForm, EditClaimForm, AddApptForm...).
const CptCatalogContext = createContext([]);

// The physician roster travels the same way, and for the same reason — the provider dropdown is
// rendered by four unrelated leaf forms (AddChargeForm, EditClaimForm, AddApptForm, the report
// doctor filter). It used to be two hardcoded constants; it is now the `physicians` collection,
// edited from Settings > Practice catalog. See migrations/003_physicians.sql.
const PhysiciansContext = createContext([]);

// Every provider dropdown shows active physicians only, so retiring someone keeps them off new
// charges without rewriting the history that already names them. `current` is the value already
// saved on the record being edited: an inactive provider stays selectable on their own old
// charge, otherwise opening that charge would silently reassign it to whoever sorts first.
function useProviderOptions(current) {
  const physicians = useContext(PhysiciansContext);
  return useMemo(() => {
    const names = physicians.filter(p => p.active !== false).map(p => p.name);
    return current && !names.includes(current) ? [current, ...names] : names;
  }, [physicians, current]);
}

// Same rule for the CPT dropdowns: a retired code stays readable on the charges that already use
// it, but stops being offered for new work. Note this filters the *pickers* only — code lookups
// (cptCatalog.find, to resolve a description or amount) always search the full catalog, or an
// old charge would lose its description the moment its code was retired.
function useCptOptions(current) {
  const cptCatalog = useContext(CptCatalogContext);
  return useMemo(() => {
    const active = cptCatalog.filter(c => c.active !== false);
    if (!current || active.some(c => c.code === current)) return active;
    const retired = cptCatalog.find(c => c.code === current);
    return retired ? [retired, ...active] : active;
  }, [cptCatalog, current]);
}

// Name -> NPI. Built from the same rows, so a physician can never be in the dropdown while
// missing an NPI the way the two old constants allowed.
function useNpiByProvider() {
  const physicians = useContext(PhysiciansContext);
  return useMemo(
    () => Object.fromEntries(physicians.map(p => [p.name, p.npi || ""])),
    [physicians],
  );
}

// ---------- Insurance (versioned — never overwritten, see addInsurance/editInsurance) ----------

const insuranceTypes = ["Commercial", "Medicare", "Medicaid", "Tricare", "Workers' Comp", "Other"];
const priorities = ["Primary", "Secondary", "Tertiary"];
const idTypes = ["Driver's License", "State ID", "Passport", "Other Government ID"];

const followUpTypes = ["Call", "Note", "Letter", "Portal message", "Other"];
const followUpStatuses = ["Open", "Resolved"];

// Debiting (reversing) a posted payment — reasons shown in the debit dialog. "System Debit" is
// deliberately not in this list: it's a separate action in DebitPostingForm that takes no reason.
const debitReasons = ["Overpayment", "Insurance Recall", "Posting Error", "Duplicate Payment", "Refund Request", "Patient Dispute", "Incorrect Posting", "Other"];

// A posting is "insurance-sourced" if it's an Insurance Credit, or a Check/other posting
// that names an insurer; everything else (Patient Credit, Card, unattributed Check) is patient-sourced.
function postingPayerKind(posting) {
  if (posting.type === "Insurance Credit") return "insurance";
  if (posting.type === "Check" && posting.insuranceName) return "insurance";
  return "patient";
}

// ---------- Clinical charting (EHR-lite: vitals, allergies, medications, problems, notes) ----------

const allergySeverities = ["Mild", "Moderate", "Severe", "Unknown"];
const medicationStatuses = ["Active", "Discontinued", "Completed", "Historical"];
const problemStatuses = ["Active", "Resolved", "Historical"];
const noteTypes = ["SOAP Note", "Progress Note", "Consultation", "Procedure Note", "Discharge Note", "Telephone Note"];

const revenueByMonth = [
  { month: "Mar", revenue: 8200 }, { month: "Apr", revenue: 9100 }, { month: "May", revenue: 8700 },
  { month: "Jun", revenue: 10250 }, { month: "Jul", revenue: 11020 }, { month: "Aug", revenue: 6480 },
];

const COLORS = ["#0d9488", "#f59e0b", "#e11d48", "#0ea5e9", "#84cc16"];

// ---------- Helpers ----------

function localDateString(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const TODAY = localDateString(new Date());

// ---------- Display date formatting ----------
// Dates and timestamps are STORED as ISO ("2026-08-24", "2026-08-24T09:15:00") because sorting,
// date-range filters and <input type="date"> all depend on that shape. These two helpers exist so
// every place that shows a date to a human renders it as MM/DD/YYYY instead (spec: US date format).
// Parsing is done with a regex rather than `new Date()` on purpose: `new Date("2026-08-24")` is
// parsed as UTC midnight and can display as the previous day west of Greenwich.

// "2026-08-24" or "2026-08-24T09:15:00" -> "08/24/2026". Anything else ("", null, "—", an already
// formatted value) is passed straight through so callers can keep their own `|| "—"` fallbacks.
function fmtDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : (value || "");
}

// The dashboard header and the schedule's day groupings used to spell the date out in full
// ("Monday, August 24, 2026"). The date itself is now MM/DD/YYYY, but the weekday is kept as a
// prefix because the schedule relies on it to tell one day's group of appointments from the next.
function weekdayOf(isoDate) {
  return new Date(isoDate + "T00:00").toLocaleDateString("en-US", { weekday: "long" });
}

// "2026-08-24T09:15:00" -> "08/24/2026 09:15". Falls back to fmtDate for date-only input.
function fmtDateTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value ?? ""));
  return m ? `${m[2]}/${m[3]}/${m[1]} ${m[4]}:${m[5]}` : fmtDate(value);
}

function daysBetween(dateStr, todayStr) {
  const d1 = new Date(dateStr + "T00:00");
  const d2 = new Date(todayStr + "T00:00");
  return Math.max(0, Math.round((d2 - d1) / 86400000));
}

// ---------- Service identity ----------
//
// A *service* is one patient + one date of service + one CPT. Memos, postings, payments and
// debits are *activity* recorded against that service — they are never services themselves, so
// they must never produce a row of their own in a report. These two helpers build the key that
// keeps that distinction.

// Compared as plain calendar strings, never through Date(): new Date("2026-08-24") is parsed as
// UTC midnight and slips to the 23rd in any western timezone, which would split one service into
// two. Accepts the ISO form the database stores and the MM/DD/YYYY form the UI shows.
function isoDay(value) {
  const s = String(value ?? "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return s;
}

// CPT is free text here (numeric CPT, alphanumeric HCPCS such as J1100) and is typed by hand in
// places, so it is trimmed and case-folded before it is compared.
function normCpt(value) { return String(value ?? "").trim().toUpperCase(); }

// "2026-08-24T09:15:00" -> "09:15 AM". Empty for date-only input, so a record with no recorded
// time shows its date alone rather than an invented midnight.
function fmtTime(value) {
  const m = /^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/.exec(String(value ?? ""));
  if (!m) return "";
  const h = Number(m[1]);
  return `${String(h % 12 || 12).padStart(2, "0")}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

function agingBucket(days) {
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

// ---------- Export helpers (CSV / print-to-PDF) ----------

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportCSV(filename, rows) {
  if (!rows.length) return;
  const csv = Papa.unparse(rows);
  downloadBlob(filename, new Blob([csv], { type: "text/csv;charset=utf-8;" }));
}

// Used only by the Daily Transaction modal's Print button, which is a browser print of its own
// printable block and always has been. The Aging Report does not use this: it generates a real
// PDF document (below) and never opens a print dialog.
function printReport() {
  window.print();
}

// ---------- Aging Report: Accounts Receivable Statement (PDF) ----------
//
// A dedicated document, not a rendering of the screen. The dashboard is built for filtering and
// drill-down; this is built to be printed, filed and handed to a manager or an accountant, so it
// is laid out as a statement: letterhead, the criteria it was run under, the money summarised,
// the aging distribution, then the detail.
//
// Every figure comes from the rows the table and the CSV already use. Nothing is recalculated on
// the way out, which is what makes it impossible for the PDF to disagree with the screen.

const PDF_PAGE = { format: "letter", marginX: 14, marginTop: 14, marginBottom: 18 };

/** Strips characters that break downloads, and collapses runs of separators. */
function safeFilename(...parts) {
  const base = parts.filter(Boolean).join("_")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return (base || "Aging_Report").slice(0, 120);
}

/** Currency for the PDF: right-alignable, no locale surprises. */
const pdfMoney = (n) => money(Number(n) || 0);

/**
 * Folds typographic punctuation to ASCII before it reaches the PDF.
 *
 * jsPDF's built-in fonts are WinAnsi-encoded and silently DROP characters they cannot represent
 * rather than substituting anything visible. An em dash therefore disappears without trace, so
 * "System debited — Check $73.00" prints as "System debited  Check $73.00" and a memo written
 * with smart quotes loses them. Accented Latin-1 letters (José, Müller) are in WinAnsi and are
 * deliberately left alone.
 */
// Built from code points at load time rather than written as literal characters, so this source
// stays pure ASCII - a literal non-breaking space here is invisible and easy to break later.
const PDF_TEXT_FOLDS = [
  { codes: [0x2014, 0x2013, 0x2212, 0x2010, 0x2011], to: "-" },   // em/en dash, minus, hyphens
  { codes: [0x2018, 0x2019, 0x201b], to: "'" },                    // single curly quotes
  { codes: [0x201c, 0x201d, 0x201f], to: '"' },                    // double curly quotes
  { codes: [0x2026], to: "..." },                                  // ellipsis
  { codes: [0x00b7, 0x2022], to: "-" },                            // middle dot, bullet
  { codes: [0x00a0], to: " " },                                    // non-breaking space
].map(f => ({
  re: new RegExp("[" + f.codes.map(c => String.fromCharCode(c)).join("") + "]", "g"),
  to: f.to,
}));

function pdfText(value) {
  let out = String(value ?? "");
  for (const f of PDF_TEXT_FOLDS) out = out.replace(f.re, f.to);
  return out;
}

/**
 * Builds and opens the Accounts Receivable Statement.
 *
 * @param {object}   o
 * @param {object[]} o.rows        grouped service rows (one per patient + DOS + CPT)
 * @param {object}   o.criteria    label -> value, printed as the report criteria block
 * @param {object}   o.groupTotals subtotal per Group value
 * @param {string}   o.groupLabel  what Group means for this run ("Physician" / "Insurance")
 * @param {string}   o.filename
 * @returns {{ok: boolean, error?: string, popupBlocked?: boolean}}
 */
function openAgingStatementPDF({ rows, criteria, groupTotals, groupLabel, filename }) {
  if (!rows || !rows.length) {
    return { ok: false, error: "There are no outstanding services in this report to put in a PDF." };
  }

  // Opened synchronously inside the click. Popup blockers permit a window opened during a user
  // gesture but block one opened later from an async continuation, and laying out several hundred
  // services takes long enough to lose that association.
  const tab = window.open("", "_blank");

  try {
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: PDF_PAGE.format });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const L = PDF_PAGE.marginX;
    const R = W - PDF_PAGE.marginX;

    // ---- totals, summed from the same rows the table shows ----
    const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    const totals = {
      charge: sum("Charge"),
      paid: sum("Paid"),
      adjustment: sum("Adjustment"),
      credit: sum("Credit"),
      balance: sum("Balance"),
    };
    const insuranceAR = rows.filter(r => r._responsibility === "insurance").reduce((s, r) => s + r.Balance, 0);
    const patientAR = totals.balance - insuranceAR;

    const buckets = new Map();
    for (const r of rows) {
      const b = buckets.get(r.Bucket) || { amount: 0, count: 0 };
      b.amount += r.Balance;
      b.count += 1;
      buckets.set(r.Bucket, b);
    }
    // Printed in aging order rather than whatever order the data happened to arrive in.
    const bucketOrder = ["0-30", "31-60", "61-90", "90+"];
    const bucketRows = [...buckets.entries()]
      .sort((a, b) => bucketOrder.indexOf(a[0]) - bucketOrder.indexOf(b[0]));

    // ---------- section helpers ----------
    let y = PDF_PAGE.marginTop;

    const heading = (text) => {
      if (y > H - 40) { doc.addPage(); y = PDF_PAGE.marginTop; }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(15, 23, 42);
      doc.text(pdfText(text).toUpperCase(), L, y);
      y += 1.6;
      doc.setDrawColor(203, 213, 225);
      doc.setLineWidth(0.3);
      doc.line(L, y, R, y);
      y += 5;
    };

    /** label left, value right-aligned — the shape every money block here uses. */
    const lineItem = (label, value, opts = {}) => {
      doc.setFont("helvetica", opts.bold ? "bold" : "normal");
      doc.setFontSize(opts.bold ? 9.5 : 8.5);
      doc.setTextColor(opts.bold ? 15 : 71, opts.bold ? 23 : 85, opts.bold ? 42 : 105);
      doc.text(pdfText(label), L + (opts.indent || 0), y);
      doc.text(pdfText(value), R, y, { align: "right" });
      y += opts.bold ? 6 : 4.8;
    };

    // ---------- letterhead ----------
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(15, 23, 42);
    doc.text(pdfText(PRACTICE_INFO.name), L, y + 4);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(pdfText(PRACTICE_INFO.address), L, y + 9);
    doc.text(pdfText(`Tax ID ${PRACTICE_INFO.taxId}`), L, y + 13);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(15, 23, 42);
    doc.text("AGING REPORT", R, y + 4, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text("Accounts Receivable Statement", R, y + 9, { align: "right" });
    doc.setFontSize(8);
    doc.text(`Generated ${fmtDate(TODAY)}`, R, y + 13, { align: "right" });

    y += 18;
    doc.setDrawColor(15, 23, 42);
    doc.setLineWidth(0.6);
    doc.line(L, y, R, y);
    y += 8;

    // ---------- report criteria ----------
    heading("Report criteria");
    const entries = Object.entries(criteria).filter(([, v]) => v !== "" && v != null);
    doc.setFontSize(8.5);
    // Two columns, so the criteria block stays compact however many filters are set.
    const half = Math.ceil(entries.length / 2);
    const colX = [L, L + (R - L) / 2];
    let maxRow = 0;
    entries.forEach(([label, value], i) => {
      const col = i < half ? 0 : 1;
      const row = i < half ? i : i - half;
      maxRow = Math.max(maxRow, row);
      const yy = y + row * 4.6;
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100, 116, 139);
      doc.text(pdfText(`${label}:`), colX[col], yy);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(30, 41, 59);
      doc.text(pdfText(value), colX[col] + 34, yy);
    });
    y += (maxRow + 1) * 4.6 + 5;

    // ---------- A/R summary ----------
    heading("Accounts receivable summary");
    lineItem("Total charges", pdfMoney(totals.charge));
    lineItem("Total payments", pdfMoney(totals.paid));
    // This application records one write-off/adjustment figure per charge; it is not split into
    // separate "adjustment" and "write-off" columns, so it is reported once under both names
    // rather than invented twice.
    lineItem("Total adjustments / write-offs", pdfMoney(totals.adjustment));
    lineItem("Total credits", pdfMoney(totals.credit));
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.3);
    doc.line(R - 60, y - 2, R, y - 2);
    y += 2;
    lineItem("OUTSTANDING A/R", pdfMoney(totals.balance), { bold: true });
    y += 2;

    const pct = (n) => (totals.balance ? ((n / totals.balance) * 100).toFixed(1) : "0.0") + "%";
    lineItem(`Insurance A/R  (${pct(insuranceAR)})`, pdfMoney(insuranceAR));
    lineItem(`Patient A/R  (${pct(patientAR)})`, pdfMoney(patientAR));
    y += 4;

    // ---------- aging summary ----------
    heading("Aging summary");
    autoTable(doc, {
      head: [["Age bucket", "Services", "Amount", "% of A/R"]],
      body: bucketRows.map(([name, b]) => [pdfText(name), String(b.count), pdfMoney(b.amount), pct(b.amount)]),
      foot: [["TOTAL", String(rows.length), pdfMoney(totals.balance), "100.0%"]],
      startY: y,
      margin: { left: L, right: PDF_PAGE.marginX },
      theme: "grid",
      styles: { fontSize: 8, cellPadding: 1.8 },
      headStyles: { fillColor: [241, 245, 249], textColor: [30, 41, 59], fontStyle: "bold", lineColor: [203, 213, 225] },
      footStyles: { fillColor: [255, 255, 255], textColor: [15, 23, 42], fontStyle: "bold", lineColor: [203, 213, 225] },
      bodyStyles: { lineColor: [226, 232, 240] },
      columnStyles: { 1: { halign: "right", cellWidth: 22 }, 2: { halign: "right", cellWidth: 32 }, 3: { halign: "right", cellWidth: 24 } },
    });
    y = doc.lastAutoTable.finalY + 8;

    // ---------- group summary (insurance or provider, whichever the run is grouped by) ----------
    const groupNames = Object.keys(groupTotals || {});
    if (groupNames.length > 1) {
      heading(`${groupLabel} summary`);
      autoTable(doc, {
        head: [[groupLabel, "Services", "Outstanding", "% of A/R"]],
        body: groupNames
          .map(g => [pdfText(g), String(rows.filter(r => r.Group === g).length), pdfMoney(groupTotals[g]), pct(groupTotals[g])])
          .sort((a, b) => Number(String(b[2]).replace(/[^0-9.]/g, "")) - Number(String(a[2]).replace(/[^0-9.]/g, ""))),
        startY: y,
        margin: { left: L, right: PDF_PAGE.marginX },
        theme: "grid",
        styles: { fontSize: 8, cellPadding: 1.8 },
        headStyles: { fillColor: [241, 245, 249], textColor: [30, 41, 59], fontStyle: "bold", lineColor: [203, 213, 225] },
        bodyStyles: { lineColor: [226, 232, 240] },
        columnStyles: { 1: { halign: "right", cellWidth: 22 }, 2: { halign: "right", cellWidth: 32 }, 3: { halign: "right", cellWidth: 24 } },
      });
      y = doc.lastAutoTable.finalY + 8;
    }

    // ---------- account detail ----------
    heading("Account detail");

    const detailHead = ["Account", "Patient", "DOS", "CPT", "Insurance", "Age", "Charge", "Paid", "Balance"];
    const body = [];
    let lastGroup = null;

    for (const r of rows) {
      if (r.Group !== lastGroup) {
        lastGroup = r.Group;
        body.push([{
          content: pdfText(`${groupLabel}: ${r.Group}`),
          colSpan: detailHead.length - 1,
          styles: { fillColor: [226, 232, 240], textColor: [15, 23, 42], fontStyle: "bold" },
        }, {
          content: pdfMoney(groupTotals[r.Group] || 0),
          styles: { fillColor: [226, 232, 240], textColor: [15, 23, 42], fontStyle: "bold", halign: "right" },
        }]);
      }

      body.push([
        pdfText(r.Account), pdfText(r.Patient), r.DOS, pdfText(r.CPT), pdfText(r["Insurance name"]), pdfText(r.Bucket),
        pdfMoney(r.Charge), pdfMoney(r.Paid), pdfMoney(r.Balance),
      ]);

      // ONE memo box per service, on its own full-width row directly beneath it. Activity never
      // creates another service row - a service with twenty memos is still one line above one box.
      if (r._activity && r._activity.length) {
        const memo = r._activity
          .map(a => pdfText(`${a.date}${a.time ? "  " + a.time : ""}   ${a.type}${a.user ? "   Posted by: " + a.user : ""}\n${a.text}`))
          .join("\n\n");
        body.push([{
          content: `MEMO / ACTIVITY  (${r._activity.length})\n${memo}`,
          colSpan: detailHead.length,
          styles: {
            fillColor: [248, 250, 252], textColor: [51, 65, 85], fontSize: 6.8,
            cellPadding: { top: 2, right: 3, bottom: 2.5, left: 6 },
          },
        }]);
      }
    }

    autoTable(doc, {
      head: [detailHead],
      body,
      startY: y,
      margin: { left: L, right: PDF_PAGE.marginX, top: PDF_PAGE.marginTop + 12, bottom: PDF_PAGE.marginBottom },
      theme: "grid",
      styles: { fontSize: 7.4, cellPadding: 1.7, overflow: "linebreak", valign: "top", lineColor: [226, 232, 240] },
      headStyles: { fillColor: [15, 23, 42], textColor: 255, fontSize: 7.4, fontStyle: "bold" },
      // The header repeats on every page, and a service row is never separated from the memo box
      // that belongs to it.
      showHead: "everyPage",
      rowPageBreak: "avoid",
      columnStyles: {
        0: { cellWidth: 18 },
        1: { cellWidth: 32 },
        2: { cellWidth: 19 },
        3: { cellWidth: 15 },
        4: { cellWidth: 30 },
        5: { cellWidth: 13 },
        6: { cellWidth: 19, halign: "right" },
        7: { cellWidth: 18, halign: "right" },
        8: { cellWidth: 21, halign: "right", fontStyle: "bold" },
      },
      // Compact running header on every page after the first, so a page found on its own is still
      // identifiable.
      didDrawPage: (data) => {
        if (data.pageNumber > 1) {
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8.5);
          doc.setTextColor(15, 23, 42);
          doc.text(pdfText(PRACTICE_INFO.name), L, PDF_PAGE.marginTop);
          doc.setFont("helvetica", "normal");
          doc.setFontSize(7.5);
          doc.setTextColor(100, 116, 139);
          doc.text(pdfText("Aging Report — Accounts Receivable Statement"), L, PDF_PAGE.marginTop + 4);
          doc.text(`As of ${fmtDate(TODAY)}`, R, PDF_PAGE.marginTop, { align: "right" });
          doc.setDrawColor(203, 213, 225);
          doc.setLineWidth(0.3);
          doc.line(L, PDF_PAGE.marginTop + 6, R, PDF_PAGE.marginTop + 6);
        }
      },
    });

    // ---------- closing total ----------
    let endY = doc.lastAutoTable.finalY + 7;
    if (endY > H - 24) { doc.addPage(); endY = PDF_PAGE.marginTop + 10; }
    doc.setDrawColor(15, 23, 42);
    doc.setLineWidth(0.5);
    doc.line(R - 76, endY - 4, R, endY - 4);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(15, 23, 42);
    doc.text("TOTAL OUTSTANDING A/R", R - 76, endY + 1);
    doc.text(pdfMoney(totals.balance), R, endY + 1, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(`${rows.length} outstanding service${rows.length === 1 ? "" : "s"}`, L, endY + 1);

    // ---------- footers ----------
    // Written after every page exists, so "Page 1 of 9" is right on page 1 too - a per-page
    // footer drawn during layout can only ever know the count so far.
    const pages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7);
      doc.setTextColor(120, 130, 145);
      doc.text(pdfText(`${PRACTICE_INFO.name} — Aging Report — generated ${fmtDate(TODAY)}`), L, H - 9);
      doc.text(`Page ${i} of ${pages}`, R, H - 9, { align: "right" });
    }

    // A real application/pdf document handed to the browser's own viewer. Never window.print():
    // printing is the reader's decision, taken from the viewer's toolbar.
    const blob = doc.output("blob");
    const url = URL.createObjectURL(blob);
    if (tab) {
      tab.location = url;
      return { ok: true };
    }
    downloadBlob(filename, blob);
    return { ok: true, popupBlocked: true };
  } catch (err) {
    if (tab) tab.close();
    return { ok: false, error: `The PDF could not be generated: ${err?.message || err}` };
  }
}

// ---------- Report PDF ----------
//
// Built from `exportRows` - the same array the CSV button hands to Papa.unparse.
// That is the whole point of doing it this way: the PDF cannot disagree with the
// CSV or with the table on screen, because no figure is recomputed on the way
// out. Columns are read off the row objects too, so a column added to a report
// appears in all three places at once.
//
// The output is a real application/pdf document opened in the browser's own
// viewer. It deliberately does NOT call window.print(): printing is the reader's
// decision, taken from the viewer's own toolbar.

const REPORT_MONEY_COLUMNS = new Set(["Amount", "Balance"]);

// Columns that need room to breathe. Everything else is sized by autoTable.
const REPORT_COLUMN_WIDTHS = {
  Memo: 46,
  Description: 46,
  Patient: 32,
  Physician: 28,
  "Insurance name": 30,
};

/**
 * Renders a report to a PDF and opens it in a new tab.
 *
 * @param {object}   opts
 * @param {string}   opts.title       e.g. "Debit report - charges posted"
 * @param {string[]} opts.meta        filter lines to print under the title
 * @param {object[]} opts.rows        the report rows, exactly as CSV receives them
 * @param {string}   opts.totalLabel
 * @param {number}   opts.totalValue
 * @param {string}   opts.filename
 * @param {object}   [opts.groupTotals] aging only: subtotal per Group value
 * @returns {{ok: boolean, error?: string}}
 */
function openReportPDF({ title, meta, rows, totalLabel, totalValue, filename, groupTotals }) {
  if (!rows || !rows.length) {
    return { ok: false, error: "There are no rows in this report to put in a PDF." };
  }

  // The tab is opened synchronously, inside the click, BEFORE the document is
  // built. Popup blockers allow a window opened during a user gesture but block
  // one opened later from an async callback, and rendering a few hundred rows is
  // easily long enough to lose that association.
  const tab = window.open("", "_blank");

  try {
    const columns = Object.keys(rows[0]);
    const isWide = columns.length > 7;

    const doc = new jsPDF({ orientation: isWide ? "landscape" : "portrait", unit: "mm", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();

    // ---- letterhead ----
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.text(PRACTICE_INFO.name, 14, 16);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(110);
    doc.text(PRACTICE_INFO.address, 14, 21);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(20);
    doc.text(title, 14, 30);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(110);
    let metaY = 35;
    for (const line of meta.filter(Boolean)) {
      doc.text(line, 14, metaY);
      metaY += 4.2;
    }
    doc.setTextColor(20);

    // ---- body ----
    const body = [];
    let lastGroup = null;

    for (const row of rows) {
      // Aging groups its rows on screen with a subtotal band; the PDF carries the
      // same bands so the two read identically.
      if (groupTotals && row.Group !== lastGroup) {
        lastGroup = row.Group;
        body.push([{
          content: `${row.Group}          ${money(groupTotals[row.Group] || 0)}`,
          colSpan: columns.length,
          styles: { fillColor: [238, 243, 246], textColor: [30, 41, 59], fontStyle: "bold" },
        }]);
      }
      body.push(columns.map((key) =>
        REPORT_MONEY_COLUMNS.has(key) ? money(row[key]) : String(row[key] ?? "")
      ));
    }

    const columnStyles = {};
    columns.forEach((key, i) => {
      if (REPORT_MONEY_COLUMNS.has(key)) columnStyles[i] = { halign: "right", cellWidth: 22 };
      else if (REPORT_COLUMN_WIDTHS[key]) columnStyles[i] = { cellWidth: REPORT_COLUMN_WIDTHS[key] };
    });

    autoTable(doc, {
      head: [columns],
      body,
      startY: metaY + 2,
      margin: { left: 14, right: 14, top: 14, bottom: 16 },
      styles: { fontSize: 7.5, cellPadding: 1.8, overflow: "linebreak", valign: "top" },
      headStyles: { fillColor: [15, 23, 42], textColor: 255, fontSize: 7.5, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles,
      // Repeats the column header on every page, and gives long memos and
      // descriptions a wrapped cell rather than a clipped one.
      showHead: "everyPage",
      didDrawPage: () => {
        const page = doc.internal.getCurrentPageInfo().pageNumber;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.5);
        doc.setTextColor(120);
        doc.text(
          `${PRACTICE_INFO.name} — generated ${fmtDate(TODAY)}`,
          14,
          doc.internal.pageSize.getHeight() - 8
        );
        doc.text(
          `Page ${page} of ${doc.internal.getNumberOfPages()}`,
          pageWidth - 14,
          doc.internal.pageSize.getHeight() - 8,
          { align: "right" }
        );
        doc.setTextColor(20);
      },
    });

    // ---- total ----
    const afterTable = doc.lastAutoTable.finalY + 8;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(`${totalLabel}: ${money(totalValue)}`, pageWidth - 14, afterTable, { align: "right" });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(110);
    doc.text(`${rows.length} row${rows.length === 1 ? "" : "s"}`, 14, afterTable);

    // The page-count footer is written per page as pages are created, so the
    // "of N" on early pages is stale until every page exists. Rewriting the
    // footer now that the total is known fixes page 1 of a ten-page report.
    const total = doc.internal.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      doc.setPage(i);
      doc.setFillColor(255, 255, 255);
      doc.rect(pageWidth - 45, doc.internal.pageSize.getHeight() - 12, 32, 6, "F");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(120);
      doc.text(`Page ${i} of ${total}`, pageWidth - 14, doc.internal.pageSize.getHeight() - 8, { align: "right" });
    }

    const blob = doc.output("blob");
    const url = URL.createObjectURL(blob);

    if (tab) {
      tab.location.href = url;
      tab.document.title = filename;
    } else {
      // The popup was blocked. Rather than fail, hand the reader the file - the
      // browser opens it in the same native viewer from the downloads bar.
      downloadBlob(filename, blob);
    }

    // Released once the tab has had time to take its own reference to the blob.
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    return { ok: true, popupBlocked: !tab };
  } catch (err) {
    if (tab) tab.close();
    console.error("[medbill] report PDF generation failed:", err);
    return { ok: false, error: "Unable to generate PDF report. Please try again." };
  }
}

const money = (n) => Number(n || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const maskSSN = (ssn) => ssn ? `***-**-${ssn.slice(-4)}` : "—";
const uid = (prefix) => `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;
const adjustedOf = (c) => c.paid + c.writeoff + (c.credits || 0);
// Charges = paid + write-off + credits + remaining balance — this is never clamped, so a payment
// larger than what was owed legitimately drives the balance negative (an overpayment), not $0.00.
const balanceOf = (c) => c.charge - c.paid - c.writeoff - (c.credits || 0);
const BALANCE_EPSILON = 0.005; // absorbs floating-point cents, not real balance
const chargeStatus = (c) => {
  const bal = balanceOf(c);
  if (bal < -BALANCE_EPSILON) return "Overpayment";
  if (bal <= BALANCE_EPSILON && c.writeoff > 0 && c.paid === 0 && (c.credits || 0) === 0) return "Written off";
  if (bal <= BALANCE_EPSILON) return "Paid";
  if (c.paid > 0 || c.writeoff > 0 || (c.credits || 0) > 0) return "Partial";
  return "Open";
};
const payerLabel = (c, policies) => {
  if (c.payerOverride === "self") return "Self / Patient";
  const pol = c.chargeInsuranceId ? policies.find(p => p.id === c.chargeInsuranceId) : null;
  return pol ? pol.insuranceCompany : "Unassigned";
};

function nowIso() { return TODAY + "T" + new Date().toTimeString().slice(0, 8); }

// Splits an insurance-allowed amount into patient responsibility (copay, then deductible,
// then coinsurance on what's left) using a policy's flat rates, leaving the remainder as
// what the insurer actually pays. Used to auto-fill the manual posting form from an EOB.
function splitAllowedAmount(allowed, policy) {
  let remaining = Math.max(0, Number(allowed) || 0);
  const round2 = (n) => Math.round(n * 100) / 100;
  const copay = policy ? Math.min(remaining, Number(policy.copay) || 0) : 0;
  remaining = round2(remaining - copay);
  const deductible = policy ? Math.min(remaining, Number(policy.deductible) || 0) : 0;
  remaining = round2(remaining - deductible);
  const coinsRate = policy ? (parseFloat(policy.coinsurance) || 0) / 100 : 0;
  const coinsurance = round2(remaining * coinsRate);
  remaining = round2(remaining - coinsurance);
  return { copay: round2(copay), deductible: round2(deductible), coinsurance, insurancePaid: Math.max(0, remaining) };
}

// The single source of truth for "what insurance is this patient on right now" —
// everywhere the app used to read a flat patient.insurer field, it reads this instead.
function currentPrimaryPolicy(patientId, policies) {
  const active = policies.filter(p => p.patientId === patientId && p.status === "Active");
  return active.find(p => p.priority === "Primary") || active[0] || null;
}

function findDuplicatePatients(form, patients) {
  return patients.filter(p => {
    const nameDobMatch = p.name.trim().toLowerCase() === form.name.trim().toLowerCase() && p.dob === form.dob;
    const phoneDobMatch = form.phone && p.phone === form.phone && p.dob === form.dob;
    const emailDobMatch = form.email && p.email.toLowerCase() === form.email.toLowerCase() && p.dob === form.dob;
    const ssnMatch = form.ssn && p.ssn === form.ssn;
    return nameDobMatch || phoneDobMatch || emailDobMatch || ssnMatch;
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------- Daily Transaction report engine ----------
//
// Everything below is pure: the modal preview, the CSV export and the print view all call
// generateDailyTransactionReport() and dailyTxnColumns() with the same filters, so the three
// can never disagree about which rows or which columns a report contains.
//
// The app has no `receipts` collection. Money-received records live on charge.postings[], while
// the flat `transactions` ledger is the only thing carrying batchId. So the first step is to
// normalise those two sources into one row list, joining batches back on via posting id.
//
// The three date fields the report can pivot on are genuinely different columns:
//   Service Date     charge.dos        — when care was delivered
//   Deposit Date     posting.depositDate — when money reached the bank (payments only)
//   Transaction Date posting.postedAt / charge.postedAt — when a human keyed it in
// A charge has no deposit date at all, which is why DEPOSIT_DATE reports are receipts-only.

const DAILY_TXN_PAGE_SIZE = 25;

// Charges created before this feature shipped carry no postedBy/batchId (addCharge only started
// stamping them later), so those columns render as "—" rather than guessing an operator.
const UNATTRIBUTED = "—";

// ---------- Daily Transaction: accounting classification ----------
//
// The report has always carried `charge`, `adjustment` and `receipt`. Those three are left exactly
// as they were - the CSV columns, the on-screen table and the existing totals all read them, and
// changing them would silently restate historical reports.
//
// The fields below are ADDED alongside, and they exist because "receipt" lumps together three
// things a manager must not see summed:
//
//   payment         real money received today
//   creditTransfer  an existing credit moved onto another charge - NOT new money
//   refund          money paid back out - NOT a collection
//
// Net collection is therefore payments minus refunds, with credit transfers and write-offs
// deliberately excluded. A transfer that counted as a collection would overstate the day's
// takings by exactly the amount that was already collected on some earlier day.

// Applying a credit balance posts an ordinary Patient/Insurance Credit whose notes record where it
// came from (see applyCreditBalance). That note is the only marker distinguishing moved money from
// money received, so it is what this reads.
function isAppliedCreditTransfer(posting) {
  return typeof posting?.notes === "string" && posting.notes.startsWith("Applied from ");
}

// The five buckets §5 asks for, derived from the posting rather than invented.
function dailyTxnMethodOf(posting) {
  switch (posting.type) {
    case "Check": return "Check";
    case "Credit Card": return "Credit Card";
    case "Insurance Credit": return "Insurance";
    case "Patient Credit": {
      const m = String(posting.method || "").toLowerCase();
      if (m.includes("check")) return "Check";
      if (m.includes("card")) return "Credit Card";
      if (m.includes("cash")) return "Cash / Self";
      return "Cash / Self";
    }
    default: return "Other";
  }
}

// One of: Charge, Payment, Refund, Credit Transfer, Adjustment.
function dailyTxnTypeOf(posting) {
  if (posting.type === "Debit") {
    // A debit is money leaving only when it is an actual refund; the "Credit Balance" variants
    // keep the money in the practice as a credit pool, so they are a transfer, not a refund.
    return String(posting.debitType || "").includes("Refund") ? "Refund" : "Credit Transfer";
  }
  return isAppliedCreditTransfer(posting) ? "Credit Transfer" : "Payment";
}

// posting.type is an internal posting kind, not a payment method. Map it onto the payment types
// billing staff expect to see on a receipt report.
function receiptPaymentType(posting) {
  switch (posting.type) {
    case "Check": return "Check";
    case "Credit Card": return "Credit Card";
    case "Insurance Credit": return "Insurance";
    // A Patient Credit records how the patient actually paid in posting.method.
    case "Patient Credit": return posting.method || "Patient Credit";
    case "Debit": return `Debit — ${posting.debitType || "Reversal"}`;
    default: return posting.type || "Other";
  }
}

// Flattens charges + their postings into one uniform row shape. Both row kinds carry every field
// the report can filter or group on, so downstream filtering never has to branch on kind.
function buildDailyTransactionRows({ charges, patientById, transactions, policies }) {
  // posting id -> batchId. Only payment-side transactions carry postingId (see addCharge and the
  // posting handlers in ClinicApp), which is the only link from a posting back to its batch.
  const batchByPostingId = new Map();
  (transactions || []).forEach(t => { if (t.postingId && t.batchId) batchByPostingId.set(t.postingId, t.batchId); });

  const rows = [];
  (charges || []).forEach(c => {
    const p = patientById[c.patientId] || {};
    const patientName = p.name || "";
    const patientAccount = c.patientId || "";

    // The payer this charge is billed to, using the application's own rule rather than a second
    // one invented here, so the report can never disagree with the Claim/Ledger screen.
    const insurance = payerLabel(c, policies || []);

    rows.push({
      kind: "charge",
      key: `chg-${c.id}`,
      chargeId: c.id,
      patientId: c.patientId, patientName, patientAccount,
      serviceDate: c.dos || "",
      receiptDate: "",
      depositDate: "",
      transactionDate: (c.postedAt || "").slice(0, 10) || c.dos || "",
      cpt: c.cpt || "", desc: c.desc || "",
      doctor: c.provider || "",
      paymentType: "", receiptNumber: "",
      charge: Number(c.charge) || 0,
      adjustment: (Number(c.writeoff) || 0) + (Number(c.credits) || 0),
      receipt: 0,
      balance: balanceOf(c),
      user: c.postedBy || "",
      batchId: c.batchId || "",

      // ---- added, never summed into the three above ----
      insurance,
      txnType: "Charge",
      method: "",
      payment: 0,
      refund: 0,
      creditTransfer: 0,
      // Write-off and DOS credit are separate lines in the summary even though the existing
      // `adjustment` column keeps showing their sum.
      writeOff: Number(c.writeoff) || 0,
      credit: Number(c.credits) || 0,
      reason: "", notes: "",
    });

    // field === "paid" is money actually received. Write-off and DOS-credit postings are
    // adjustments and are already reflected in the parent charge's `adjustment`, so counting
    // them here as well would double-count them.
    (c.postings || []).forEach(pt => {
      if (pt.field !== "paid") return;
      const isDebit = pt.type === "Debit";
      const txnType = dailyTxnTypeOf(pt);
      const amount = Math.abs(Number(pt.amount) || 0);
      rows.push({
        kind: "receipt",
        key: `rct-${c.id}-${pt.id}`,
        chargeId: c.id, postingId: pt.id,
        patientId: c.patientId, patientName, patientAccount,
        serviceDate: c.dos || "",
        receiptDate: pt.date || "",
        depositDate: pt.depositDate || "",
        transactionDate: (pt.postedAt || "").slice(0, 10) || pt.date || "",
        cpt: c.cpt || "", desc: c.desc || "",
        doctor: c.provider || "",
        paymentType: receiptPaymentType(pt),
        receiptNumber: pt.checkNumber || pt.reference || "",
        charge: 0, adjustment: 0,
        // A debit reverses a payment, so it lands on a receipt report as a negative amount.
        receipt: (Number(pt.amount) || 0) * (isDebit ? -1 : 1),
        balance: 0,
        user: pt.postedBy || "",
        batchId: batchByPostingId.get(pt.id) || "",

        // ---- added ----
        // An insurance posting names its own payer; anything else is billed to the charge's payer.
        insurance: pt.insuranceName || insurance,
        txnType,
        method: dailyTxnMethodOf(pt),
        // Exactly one of these three carries the amount, so no summary can count it twice.
        payment: txnType === "Payment" ? amount : 0,
        refund: txnType === "Refund" ? amount : 0,
        creditTransfer: txnType === "Credit Transfer" ? amount : 0,
        writeOff: 0,
        credit: 0,
        reason: pt.reason || "",
        notes: pt.notes || "",
        checkNumber: pt.checkNumber || "",
        reference: pt.reference || "",
      });
    });
  });
  return rows;
}

// Which date column a row is filtered on. Returns "" when the row has no such date — the caller
// treats that as "cannot match this date filter".
function dailyTxnDateOf(row, basedOn) {
  if (basedOn === "deposit") return row.depositDate;
  if (basedOn === "transaction") return row.transactionDate;
  return row.serviceDate;
}

const DAILY_TXN_DEFAULTS = {
  patientDisplay: "name",     // "name" | "total"
  printWithName: "both",      // "both" | "charge" | "receipt"
  procedureMode: "all",       // "all" | "specific"
  procedureCodes: [],
  reportFrom: "dateSpan",     // "dateSpan" | "closing"
  closingBatchIds: [],
  basedOn: "service",         // "service" | "deposit" | "transaction"
  startDate: "",
  endDate: "",
  doctorMode: "all",
  doctors: [],
  userMode: "all",
  users: [],
  batchMode: "all",
  batchIds: [],
  includeCharges: true,
  includeReceipts: true,

  // Added filters. "all" keeps every existing report behaving exactly as before.
  insuranceMode: "all",       // "all" | "specific"
  insurances: [],
  txnTypeMode: "all",         // "all" | "specific"
  txnTypes: [],
  methodMode: "all",          // "all" | "specific"
  methods: [],
  patientQuery: "",           // free text: name or account
};

const DAILY_TXN_TYPES = ["Charge", "Payment", "Refund", "Credit Transfer"];
const DAILY_TXN_METHODS = ["Check", "Credit Card", "Cash / Self", "Insurance", "Other"];

function validateDailyTxnFilters(f) {
  const errors = {};
  if (f.reportFrom === "dateSpan") {
    if (!f.startDate) errors.startDate = "Start date is required.";
    if (!f.endDate) errors.endDate = "End date is required.";
    if (f.startDate && f.endDate && f.endDate < f.startDate) errors.endDate = "End date cannot be before start date.";
  } else if (!f.closingBatchIds.length) {
    errors.closingBatchIds = "Select at least one closed batch.";
  }
  if (!f.includeCharges && !f.includeReceipts) errors.include = "Include charges, receipts, or both.";
  if (f.procedureMode === "specific" && !f.procedureCodes.length) errors.procedureCodes = "Select at least one procedure code.";
  if (f.doctorMode === "specific" && !f.doctors.length) errors.doctors = "Select at least one doctor.";
  if (f.userMode === "specific" && !f.users.length) errors.users = "Select at least one user.";
  if (f.batchMode === "specific" && !f.batchIds.length) errors.batchIds = "Select at least one batch.";
  // Deposit date only exists on payments, so a charges-only deposit-date report can never match.
  if (f.basedOn === "deposit" && !f.includeReceipts) errors.basedOn = "Deposit date applies to receipts only — include receipts to use it.";
  return errors;
}

// The single filtering pipeline (spec §22). `rows` comes from buildDailyTransactionRows so the
// expensive flatten can be memoised once and re-filtered cheaply.
function generateDailyTransactionReport(filters, rows) {
  const f = { ...DAILY_TXN_DEFAULTS, ...filters };
  let out = rows;

  // 1. charge / receipt inclusion, and the Print-With-Name narrowing (which only applies when
  //    patient names are being shown — it is a print/export scope, not a separate filter).
  const nameScope = f.patientDisplay === "name" ? f.printWithName : "both";
  out = out.filter(r => {
    if (r.kind === "charge" && !f.includeCharges) return false;
    if (r.kind === "receipt" && !f.includeReceipts) return false;
    if (nameScope === "charge" && r.kind !== "charge") return false;
    if (nameScope === "receipt" && r.kind !== "receipt") return false;
    return true;
  });

  // 2. Report source. A closing report is scoped by batch membership instead of a date span.
  if (f.reportFrom === "closing") {
    const ids = new Set(f.closingBatchIds);
    out = out.filter(r => r.batchId && ids.has(r.batchId));
  } else {
    // 3. Date range on whichever date field was selected. Charges have no deposit date, so a
    //    deposit-date report is receipts-only by definition.
    if (f.basedOn === "deposit") out = out.filter(r => r.kind === "receipt");
    out = out.filter(r => {
      const d = dailyTxnDateOf(r, f.basedOn);
      if (!d) return false;
      return (!f.startDate || d >= f.startDate) && (!f.endDate || d <= f.endDate);
    });
  }

  // 4-7. Doctor / user / batch / procedure. Specific-value filters drop unattributed rows,
  //      since a row with no user or batch cannot be claimed to match a named one.
  if (f.doctorMode === "specific") { const s = new Set(f.doctors); out = out.filter(r => s.has(r.doctor)); }
  if (f.userMode === "specific") { const s = new Set(f.users); out = out.filter(r => r.user && s.has(r.user)); }
  if (f.batchMode === "specific") { const s = new Set(f.batchIds); out = out.filter(r => r.batchId && s.has(r.batchId)); }
  if (f.procedureMode === "specific") { const s = new Set(f.procedureCodes); out = out.filter(r => s.has(r.cpt)); }

  // Added filters, applied in the same pipeline so the detail table, every summary section, the
  // CSV and the PDF are all narrowed by exactly the same pass.
  if (f.insuranceMode === "specific") { const s = new Set(f.insurances); out = out.filter(r => s.has(r.insurance)); }
  if (f.txnTypeMode === "specific") { const s = new Set(f.txnTypes); out = out.filter(r => s.has(r.txnType)); }
  if (f.methodMode === "specific") { const s = new Set(f.methods); out = out.filter(r => r.method && s.has(r.method)); }
  if (String(f.patientQuery || "").trim()) {
    const q = f.patientQuery.trim().toLowerCase();
    out = out.filter(r => `${r.patientName} ${r.patientAccount}`.toLowerCase().includes(q));
  }

  out = [...out].sort((a, b) =>
    (dailyTxnDateOf(a, f.basedOn) || "").localeCompare(dailyTxnDateOf(b, f.basedOn) || "") ||
    a.patientName.localeCompare(b.patientName) ||
    a.kind.localeCompare(b.kind)
  );

  // 8. Totals, always from the filtered set — never hard-coded.
  const totals = {
    totalPatients: new Set(out.map(r => r.patientId)).size,
    totalTransactions: out.length,
    totalCharges: out.reduce((s, r) => s + r.charge, 0),
    totalAdjustments: out.reduce((s, r) => s + r.adjustment, 0),
    totalReceipts: out.reduce((s, r) => s + r.receipt, 0),
    remainingBalance: out.reduce((s, r) => s + r.balance, 0),
  };

  // One summary, computed once from the filtered rows and carried on the result, so the preview,
  // the CSV, the PDF and the print view cannot each arrive at a different number.
  return { rows: out, totals, summary: buildDailyTxnSummary(out), filters: f };
}

// ---------- Daily Transaction: summary engine ----------
//
// Every summary section in the report, the PDF and the print view is produced here, from the
// SAME filtered rows the detail table shows. That is what makes "web = CSV = PDF" structurally
// true rather than a promise: there is one dataset and one set of totals, and no section
// recomputes anything from the raw charges.
//
// The accounting rules it enforces, from the report's own definitions:
//   - a credit transfer is movement of money already collected, never a new collection;
//   - a refund is money returned, never a negative payment folded into the payment total;
//   - net collection = payments - refunds, with write-offs and transfers deliberately excluded.

/** Adds `row` into `bucket`, creating it on first sight. */
function dailyTxnAccumulate(map, key, row) {
  let b = map.get(key);
  if (!b) {
    b = { name: key, count: 0, charges: 0, payments: 0, writeOffs: 0, credits: 0, refunds: 0, creditTransfers: 0, balance: 0 };
    map.set(key, b);
  }
  b.count += 1;
  b.charges += row.charge;
  b.payments += row.payment;
  b.writeOffs += row.writeOff;
  b.credits += row.credit;
  b.refunds += row.refund;
  b.creditTransfers += row.creditTransfer;
  b.balance += row.balance;
  return b;
}

const dailyTxnSorted = (map) => [...map.values()].sort((a, b) => (b.charges + b.payments) - (a.charges + a.payments));

function buildDailyTxnSummary(rows) {
  const totals = {
    charges: 0, payments: 0, writeOffs: 0, credits: 0, refunds: 0, creditTransfers: 0, balance: 0,
  };
  const byMethod = new Map();
  const byInsurance = new Map();
  const byPhysician = new Map();
  const byUser = new Map();
  const byCpt = new Map();

  const checks = [];
  const cards = [];
  const selfPayments = [];
  const refundRows = [];
  const transferRows = [];
  const writeOffRows = [];

  const counts = {
    charges: 0, payments: 0, checks: 0, creditCards: 0, selfPayments: 0,
    insurancePayments: 0, creditTransfers: 0, refunds: 0, writeOffs: 0,
  };

  for (const r of rows) {
    totals.charges += r.charge;
    totals.payments += r.payment;
    totals.writeOffs += r.writeOff;
    totals.credits += r.credit;
    totals.refunds += r.refund;
    totals.creditTransfers += r.creditTransfer;
    totals.balance += r.balance;

    dailyTxnAccumulate(byInsurance, r.insurance || "Unassigned", r);
    dailyTxnAccumulate(byPhysician, r.doctor || UNATTRIBUTED, r);
    dailyTxnAccumulate(byUser, r.user || UNATTRIBUTED, r);
    if (r.cpt) dailyTxnAccumulate(byCpt, r.cpt, r);

    if (r.kind === "charge") {
      counts.charges += 1;
      if (r.writeOff > 0) { counts.writeOffs += 1; writeOffRows.push(r); }
      continue;
    }

    // Only real payments belong in the payment-method breakdown. A refund or a transfer carries a
    // method too, but putting either here would make the method totals stop agreeing with the
    // payment total.
    if (r.txnType === "Payment") {
      counts.payments += 1;
      dailyTxnAccumulate(byMethod, r.method || "Other", r);
      if (r.method === "Check") { counts.checks += 1; checks.push(r); }
      else if (r.method === "Credit Card") { counts.creditCards += 1; cards.push(r); }
      else if (r.method === "Insurance") counts.insurancePayments += 1;
      else { counts.selfPayments += 1; selfPayments.push(r); }
    } else if (r.txnType === "Refund") {
      counts.refunds += 1;
      refundRows.push(r);
    } else if (r.txnType === "Credit Transfer") {
      counts.creditTransfers += 1;
      transferRows.push(r);
    }
  }

  // The headline figure, and the only one people act on. Stated as a formula in the UI too, so
  // nobody has to guess whether write-offs were deducted.
  totals.netCollection = totals.payments - totals.refunds;

  return {
    totals,
    counts,
    byMethod: dailyTxnSorted(byMethod),
    byInsurance: dailyTxnSorted(byInsurance),
    byPhysician: dailyTxnSorted(byPhysician),
    byUser: dailyTxnSorted(byUser),
    byCpt: dailyTxnSorted(byCpt),
    checks, cards, selfPayments,
    refunds: refundRows,
    transfers: transferRows,
    writeOffs: writeOffRows,
  };
}

// Column visibility is derived once here and consumed by the preview table, the CSV and the
// print view (spec §25), so a hidden column can never leak into an export.
function dailyTxnColumns(filters) {
  const f = { ...DAILY_TXN_DEFAULTS, ...filters };
  const showNames = f.patientDisplay === "name";
  const scope = showNames ? f.printWithName : "both";
  const wantCharge = scope !== "receipt" && f.includeCharges;
  const wantReceipt = scope !== "charge" && f.includeReceipts;

  const cols = [];
  if (showNames) {
    cols.push({ key: "patientName", label: "Patient Name", get: r => r.patientName || UNATTRIBUTED });
    cols.push({ key: "patientAccount", label: "Patient ID", get: r => r.patientAccount });
  }
  cols.push({ key: "kind", label: "Transaction", get: r => (r.kind === "charge" ? "Charge" : "Receipt") });
  cols.push({ key: "serviceDate", label: "Service Date", get: r => fmtDate(r.serviceDate) || UNATTRIBUTED });
  cols.push({ key: "transactionDate", label: "Transaction Date", get: r => fmtDate(r.transactionDate) || UNATTRIBUTED });
  if (wantReceipt) cols.push({ key: "depositDate", label: "Deposit Date", get: r => fmtDate(r.depositDate) || UNATTRIBUTED });
  cols.push({ key: "cpt", label: "Procedure Code", get: r => r.cpt || UNATTRIBUTED });
  cols.push({ key: "doctor", label: "Doctor", get: r => r.doctor || UNATTRIBUTED });
  if (wantReceipt) {
    cols.push({ key: "paymentType", label: "Payment Type", get: r => r.paymentType || UNATTRIBUTED });
    cols.push({ key: "receiptNumber", label: "Receipt Number", get: r => r.receiptNumber || UNATTRIBUTED });
  }
  if (wantCharge) {
    cols.push({ key: "charge", label: "Charge", get: r => r.charge, money: true, align: "right" });
    cols.push({ key: "adjustment", label: "Adjustment", get: r => r.adjustment, money: true, align: "right" });
  }
  if (wantReceipt) cols.push({ key: "receipt", label: "Receipt", get: r => r.receipt, money: true, align: "right" });
  if (wantCharge) cols.push({ key: "balance", label: "Remaining Balance", get: r => r.balance, money: true, align: "right" });
  cols.push({ key: "user", label: "User", get: r => r.user || UNATTRIBUTED });
  cols.push({ key: "batch", label: "Batch", get: r => r.batchId || UNATTRIBUTED });
  return cols;
}

// CSV rows are built from the same column list as the on-screen table, so "do not export records
// or columns excluded by the filters" holds automatically.
function dailyTxnCsvRows(rows, columns) {
  return rows.map(r => Object.fromEntries(columns.map(c => {
    const v = c.get(r);
    return [c.label, c.money ? (Number(v) || 0).toFixed(2) : v];
  })));
}

function dailyTxnFilename(filters, batchLabelById = {}) {
  const f = { ...DAILY_TXN_DEFAULTS, ...filters };
  const safe = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  let scope = "";
  if (f.doctorMode === "specific" && f.doctors.length === 1) scope = `_${safe(f.doctors[0])}`;
  else if (f.batchMode === "specific" && f.batchIds.length === 1) scope = `_Batch_${safe(batchLabelById[f.batchIds[0]] || f.batchIds[0])}`;
  const span = f.reportFrom === "closing" ? "Closing" : `${f.startDate || "all"}_to_${f.endDate || "all"}`;
  return `Daily_Transaction_Report${scope}_${span}.csv`;
}

// Same naming rules as the CSV, plus the insurance scope, and sanitised so a payer name with a
// slash or an ampersand cannot produce a file the browser refuses to save.
function dailyTxnPdfFilename(filters, batchLabelById = {}) {
  const f = { ...DAILY_TXN_DEFAULTS, ...filters };
  const parts = ["Daily_Transaction_Report"];
  if (f.insuranceMode === "specific" && f.insurances.length === 1) parts.push(f.insurances[0]);
  if (f.doctorMode === "specific" && f.doctors.length === 1) parts.push(f.doctors[0]);
  if (f.userMode === "specific" && f.users.length === 1) parts.push(f.users[0]);
  if (f.batchMode === "specific" && f.batchIds.length === 1) parts.push("Batch_" + (batchLabelById[f.batchIds[0]] || f.batchIds[0]));
  parts.push(f.reportFrom === "closing" ? "Closing" : `${f.startDate || "all"}_to_${f.endDate || "all"}`);
  return safeFilename(...parts) + ".pdf";
}

// Opens an uploaded ID document in a separate, small popup window — never a same-tab navigation
// and never a full-page modal — with its own zoom controls for images, or the browser's native
// PDF viewer for PDFs. The popup is opened blank (about:blank) and the document is attached via
// direct DOM assignment rather than through window.open's URL argument, so the data URL never
// lands in an address bar, browser history, or console log.
function openIdDocumentViewerWindow(doc) {
  const dataUrl = doc?.file;
  if (!dataUrl) return;
  const isPdf = doc.fileType === "application/pdf" || dataUrl.startsWith("data:application/pdf");
  const win = window.open("", `iddoc-viewer-${doc.id}`, "width=800,height=600,resizable=yes,scrollbars=yes");
  if (!win) {
    alert("Your browser blocked the document viewer pop-up. Please allow pop-ups for this site and try again.");
    return;
  }
  const d = win.document;
  d.title = "ID Document Viewer";

  const style = d.createElement("style");
  style.textContent = `
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: #0f172a; font-family: -apple-system, "Segoe UI", sans-serif; }
    .idv-bar { position:absolute; top:0; left:0; right:0; height:42px; display:flex; align-items:center; justify-content:space-between;
      padding: 0 14px; background:#1e293b; color:#e2e8f0; font-size:13px; font-weight:600; border-bottom:1px solid #334155; }
    .idv-bar button { background:none; border:none; color:#94a3b8; font-size:17px; cursor:pointer; line-height:1; padding:4px 8px; border-radius:4px; }
    .idv-bar button:hover { background:#334155; color:#fff; }
    .idv-body { position:absolute; top:42px; bottom:${isPdf ? "0" : "46px"}; left:0; right:0; overflow:auto; background:#1e293b; }
    .idv-body-inner { min-height:100%; display:flex; align-items:center; justify-content:center; padding:16px; }
    .idv-body-inner img { display:block; max-width:100%; height:auto; }
    .idv-body embed { width:100%; height:100%; border:0; }
    .idv-zoombar { position:absolute; bottom:0; left:0; right:0; height:46px; display:flex; align-items:center; justify-content:center; gap:14px;
      background:#1e293b; border-top:1px solid #334155; color:#e2e8f0; font-size:13px; }
    .idv-zoombar button { width:26px; height:26px; border-radius:6px; border:1px solid #475569; background:#0f172a; color:#e2e8f0; cursor:pointer; font-size:15px; line-height:1; }
    .idv-zoombar button:hover { background:#334155; }
    .idv-zoombar .idv-pct { min-width:44px; text-align:center; }
    .idv-zoombar .idv-reset { width:auto; padding:0 10px; }
  `;
  d.head.appendChild(style);

  const bar = d.createElement("div");
  bar.className = "idv-bar";
  const title = d.createElement("span");
  title.textContent = "ID Document Viewer";
  const closeBtn = d.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.title = "Close";
  closeBtn.onclick = () => win.close();
  bar.appendChild(title);
  bar.appendChild(closeBtn);
  d.body.appendChild(bar);

  const body = d.createElement("div");
  body.className = "idv-body";
  d.body.appendChild(body);

  if (isPdf) {
    const embed = d.createElement("embed");
    embed.type = "application/pdf";
    embed.src = dataUrl;
    body.appendChild(embed);
    return;
  }

  const inner = d.createElement("div");
  inner.className = "idv-body-inner";
  const img = d.createElement("img");
  img.alt = "ID document";
  inner.appendChild(img);
  body.appendChild(inner);

  const zoombar = d.createElement("div");
  zoombar.className = "idv-zoombar";
  const outBtn = d.createElement("button"); outBtn.textContent = "−"; outBtn.title = "Zoom out";
  const pct = d.createElement("span"); pct.className = "idv-pct"; pct.textContent = "100%";
  const inBtn = d.createElement("button"); inBtn.textContent = "+"; inBtn.title = "Zoom in";
  const resetBtn = d.createElement("button"); resetBtn.className = "idv-reset"; resetBtn.textContent = "Reset";
  zoombar.appendChild(outBtn); zoombar.appendChild(pct); zoombar.appendChild(inBtn); zoombar.appendChild(resetBtn);
  d.body.appendChild(zoombar);

  let scale = 1;
  function applyZoom(fit) {
    if (fit) { img.style.maxWidth = "100%"; img.style.width = ""; img.style.height = "auto"; }
    else if (img.naturalWidth) { img.style.maxWidth = "none"; img.style.width = Math.round(img.naturalWidth * scale) + "px"; img.style.height = "auto"; }
    pct.textContent = Math.round(scale * 100) + "%";
  }
  img.onload = () => applyZoom(scale === 1);
  outBtn.onclick = () => { scale = Math.max(0.25, +(scale - 0.25).toFixed(2)); applyZoom(false); };
  inBtn.onclick = () => { scale = Math.min(3, +(scale + 0.25).toFixed(2)); applyZoom(false); };
  resetBtn.onclick = () => { scale = 1; applyZoom(true); };
  img.src = dataUrl; // set last so onload fires after listeners are attached
}

// ---------- X12 835 (electronic remittance) helpers ----------
// Parses the common segments of a real 835 file: BPR (payment), TRN (trace/check #),
// N1*PR (payer), CLP (claim payment), NM1*QC (patient), SVC (service line), CAS (adjustments).

function parse835(raw) {
  const segments = raw
    .replace(/\r/g, "")
    .split("~")
    .map(s => s.trim())
    .filter(Boolean);

  let payerName = "", totalPaymentAmount = 0, checkEft = "", paymentMethod = "";
  const claims = [];
  let current = null;

  const claimStatusMap = { "1": "Paid", "2": "Paid", "3": "Paid", "4": "Denied", "19": "Reversal", "22": "Reversal" };

  segments.forEach(seg => {
    const el = seg.split("*");
    const tag = el[0];
    if (tag === "BPR") {
      totalPaymentAmount = parseFloat(el[2] || 0);
      paymentMethod = el[4] || "";
    } else if (tag === "TRN") {
      checkEft = el[2] || "";
    } else if (tag === "N1" && el[1] === "PR") {
      payerName = el[2] || "";
    } else if (tag === "CLP") {
      if (current) claims.push(current);
      current = {
        claimId: el[1] || "",
        statusCode: el[2] || "",
        statusLabel: claimStatusMap[el[2]] || "Other",
        totalCharge: parseFloat(el[3] || 0),
        totalPaid: parseFloat(el[4] || 0),
        patientResp: parseFloat(el[5] || 0),
        payerClaimNumber: el[7] || "",
        patientName: "",
        services: [],
        adjustments: [],
      };
    } else if (tag === "NM1" && el[1] === "QC" && current) {
      current.patientName = [el[4], el[3]].filter(Boolean).join(" ") || el[3] || "";
    } else if (tag === "SVC" && current) {
      const proc = (el[1] || "").split(":")[1] || el[1] || "";
      current.services.push({ cpt: proc, charge: parseFloat(el[2] || 0), paid: parseFloat(el[3] || 0) });
    } else if (tag === "CAS" && current) {
      const group = el[1];
      for (let i = 2; i + 1 < el.length; i += 3) {
        if (!el[i]) continue;
        current.adjustments.push({ group, reason: el[i], amount: parseFloat(el[i + 1] || 0) });
      }
    }
  });
  if (current) claims.push(current);

  return { payerName, totalPaymentAmount, checkEft, paymentMethod, claims };
}

// Builds a synthetic but structurally valid 835 from the app's current submitted
// claims, so the electronic-posting flow can be tested without a real payer file.
function generateSampleERA(claims, patientById, chargeById) {
  const eligible = claims.filter(c => c.status === "Submitted");
  if (eligible.length === 0) return "";
  const lines = [
    "ISA*00*          *00*          *ZZ*PAYERSENDER    *ZZ*CLINICRECEIVER *260824*1200*^*00501*000000001*0*P*:~",
    "GS*HP*PAYERSENDER*CLINICRECEIVER*20260824*1200*1*X*005010X221A1~",
    "ST*835*0001~",
    `BPR*I*${eligible.reduce((s, c) => s + Math.round(c.amount * 0.8 * 100) / 100, 0).toFixed(2)}*C*ACH*CTX*01*999999999*DA*123456789*1512345678**01*999999998*DA*987654321*20260824~`,
    "TRN*1*EFT00293841*1512345678~",
    "N1*PR*Aetna~",
    "N1*PE*Obaid Clinic*XX*1912345678~",
  ];
  eligible.forEach(c => {
    const charge = chargeById[c.chargeId];
    const paid = Math.round(c.amount * 0.8 * 100) / 100;
    const adj = Math.round((c.amount - paid) * 100) / 100;
    const patient = patientById[c.patientId];
    lines.push(`CLP*${c.id}*1*${c.amount.toFixed(2)}*${paid.toFixed(2)}*0*12*${c.id}-PAYER~`);
    lines.push(`NM1*QC*1*${patient?.name?.split(" ").slice(-1)[0] || "Doe"}*${patient?.name?.split(" ")[0] || "Jane"}~`);
    lines.push(`SVC*HC:${c.cpt}*${c.amount.toFixed(2)}*${paid.toFixed(2)}~`);
    lines.push(`CAS*CO*45*${adj.toFixed(2)}~`);
  });
  lines.push("SE*99*0001~", "GE*1*1~", "IEA*1*000000001~");
  return lines.join("\n");
}

function StatusPill({ status }) {
  const map = {
    "Scheduled": "bg-sky-50 text-sky-700 border-sky-200",
    "In progress": "bg-amber-50 text-amber-700 border-amber-200",
    "Checked out": "bg-emerald-50 text-emerald-700 border-emerald-200",
    "Open": "bg-sky-50 text-sky-700 border-sky-200",
    "Partial": "bg-amber-50 text-amber-700 border-amber-200",
    "Paid": "bg-emerald-50 text-emerald-700 border-emerald-200",
    "Overpayment": "bg-violet-50 text-violet-700 border-violet-200",
    "Written off": "bg-slate-100 text-slate-500 border-slate-200",
    "Draft": "bg-slate-100 text-slate-600 border-slate-200",
    "Submitted": "bg-sky-50 text-sky-700 border-sky-200",
    "Denied": "bg-rose-50 text-rose-700 border-rose-200",
    "Active": "bg-emerald-50 text-emerald-700 border-emerald-200",
    "Terminated": "bg-slate-100 text-slate-500 border-slate-200",
    "Resolved": "bg-slate-100 text-slate-500 border-slate-200",
    "Historical": "bg-slate-100 text-slate-500 border-slate-200",
    "Discontinued": "bg-rose-50 text-rose-700 border-rose-200",
    "Completed": "bg-emerald-50 text-emerald-700 border-emerald-200",
    "Signed": "bg-emerald-50 text-emerald-700 border-emerald-200",
    "Amended": "bg-amber-50 text-amber-700 border-amber-200",
    "Mild": "bg-emerald-50 text-emerald-700 border-emerald-200",
    "Moderate": "bg-amber-50 text-amber-700 border-amber-200",
    "Severe": "bg-rose-50 text-rose-700 border-rose-200",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${map[status] || "bg-slate-100 text-slate-600 border-slate-200"}`}>
      {status}
    </span>
  );
}

function Card({ children, className = "" }) {
  return <div className={`bg-white border border-slate-200 rounded-xl ${className}`}>{children}</div>;
}

// `size` is an optional Tailwind max-width escape hatch for reports that need more room than
// `wide` gives; omitting it keeps the original md/2xl behaviour every existing caller relies on.
function Modal({ title, onClose, children, wide, size }) {
  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-4 print:hidden">
      <div className={`bg-white rounded-xl shadow-xl w-full ${size || (wide ? "max-w-2xl" : "max-w-md")} max-h-[85vh] overflow-y-auto`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 sticky top-0 bg-white">
          <h3 className="font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <label className="block mb-3">
      <span className="block text-xs font-medium text-slate-500 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-400 mt-1">{hint}</span>}
    </label>
  );
}

const inputCls = "w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500";

function PriorityBadge({ priority }) {
  const map = { Primary: "bg-teal-600 text-white", Secondary: "bg-sky-500 text-white", Tertiary: "bg-slate-400 text-white" };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${map[priority] || "bg-slate-300 text-white"}`}>{priority}</span>;
}

function SectionTitle({ children }) {
  return <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mt-4 mb-2 first:mt-0">{children}</h4>;
}

function FileDrop({ label, value, onChange }) {
  const isPdf = typeof value === "string" && value.startsWith("data:application/pdf");
  async function handle(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Second argument (the raw File) is optional — existing callers that only take the data URL are unaffected.
    onChange(await fileToDataUrl(file), file);
  }
  return (
    <div className="mb-3">
      <span className="block text-xs font-medium text-slate-500 mb-1">{label}</span>
      {value ? (
        <div className="flex items-center gap-3 border border-slate-200 rounded-lg p-2">
          {isPdf ? (
            <div className="w-16 h-16 rounded-md bg-slate-100 flex items-center justify-center border border-slate-200"><FileText size={22} className="text-slate-400" /></div>
          ) : (
            <img src={value} alt={label} className="w-16 h-16 object-cover rounded-md border border-slate-200" />
          )}
          <label className="text-xs text-teal-700 border border-teal-200 bg-teal-50 rounded-lg px-2 py-1 cursor-pointer hover:bg-teal-100">
            Replace
            <input type="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={handle} />
          </label>
        </div>
      ) : (
        <label className="flex items-center gap-2 border border-dashed border-slate-300 rounded-lg px-3 py-4 text-xs text-slate-500 cursor-pointer hover:bg-slate-50 justify-center">
          <Upload size={14} /> Upload or scan
          <input type="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={handle} />
        </label>
      )}
    </div>
  );
}

// ---------- Main App ----------

// ---------- Multi-factor authentication ----------
//
// Sits between the existing password step and the application. The password screen below is
// untouched: when the API answers "a second factor is outstanding" it hands control here, and
// this component hands back a completed credential exactly as signIn() would have.

/** Six separate boxes that behave like one field: paste, arrow keys and backspace all work. */
function CodeInput({ value, onChange, onComplete, disabled }) {
  const refs = useRef([]);
  const digits = String(value || "").padEnd(6, " ").slice(0, 6).split("");

  function setAt(i, ch) {
    const next = digits.map((d, j) => (j === i ? ch : d)).join("").replace(/\s/g, "");
    onChange(next);
    if (ch && i < 5) refs.current[i + 1]?.focus();
    if (next.length === 6 && onComplete) onComplete(next);
  }

  return (
    <div className="flex gap-2 justify-center" role="group" aria-label="Six digit verification code">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={1}
          disabled={disabled}
          aria-label={`Digit ${i + 1}`}
          value={d.trim()}
          onChange={(e) => setAt(i, e.target.value.replace(/\D/g, "").slice(-1))}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !d.trim() && i > 0) refs.current[i - 1]?.focus();
            if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
            if (e.key === "ArrowRight" && i < 5) refs.current[i + 1]?.focus();
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
            if (!pasted) return;
            e.preventDefault();
            onChange(pasted);
            if (pasted.length === 6 && onComplete) onComplete(pasted);
            refs.current[Math.min(pasted.length, 5)]?.focus();
          }}
          className="w-11 h-13 py-3 text-center text-lg font-semibold border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 disabled:bg-slate-100"
        />
      ))}
    </div>
  );
}

/** The "trust this device" choice, with the warning that belongs next to it. */
function TrustDeviceCheckbox({ checked, onChange, disabled }) {
  return (
    <div className="mt-5 border border-slate-200 rounded-lg p-3 bg-slate-50">
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 w-4 h-4 accent-teal-600"
        />
        <span>
          <span className="text-sm font-medium text-slate-700 block">Trust this device for 30 days</span>
          <span className="text-xs text-slate-500 block mt-0.5">
            You won&apos;t be asked for your authenticator code again on this device for 30 days.
          </span>
        </span>
      </label>
      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 mt-2.5 flex items-start gap-1.5">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        <span>Only select this on a private, trusted computer — never on a shared, public or library machine.</span>
      </p>
    </div>
  );
}

/** Step 2 of signing in: enter the 6-digit code. */
function MfaVerifyScreen({ challenge, onVerified, onCancel }) {
  const [code, setCode] = useState("");
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [useBackup, setUseBackup] = useState(false);
  const [backup, setBackup] = useState("");

  async function submit(value) {
    const entered = (useBackup ? backup : value ?? code).trim();
    if (!entered) return;
    setBusy(true);
    setError("");
    try {
      const credential = await verifyMfa(challenge, entered, trust);
      onVerified(credential);
    } catch (err) {
      // Stays on this screen, as required - a rejected code is not a reason to send someone back
      // to re-type their password.
      setError(err?.message || "That code is not valid. Check your authenticator app and try again.");
      setCode("");
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Authenticator verification" subtitle="Enter the 6-digit code from your authenticator app.">
      {!useBackup ? (
        <>
          <label className="text-xs text-slate-500 block mb-2 text-center">Verification code</label>
          <CodeInput value={code} onChange={setCode} onComplete={(v) => submit(v)} disabled={busy} />
        </>
      ) : (
        <>
          <label className="text-xs text-slate-500 block mb-2">Backup code</label>
          <input
            className={inputCls}
            placeholder="XXXXX-XXXXX"
            value={backup}
            onChange={(e) => setBackup(e.target.value.toUpperCase())}
            disabled={busy}
          />
          <p className="text-xs text-slate-400 mt-1">Each backup code works once.</p>
        </>
      )}

      <TrustDeviceCheckbox checked={trust} onChange={setTrust} disabled={busy} />

      {error && <p className="text-rose-600 text-xs mt-3 text-center">{error}</p>}

      <button
        onClick={() => submit()}
        disabled={busy || (useBackup ? !backup.trim() : code.length !== 6)}
        className="w-full mt-4 bg-teal-600 text-white text-sm font-medium py-2.5 rounded-lg hover:bg-teal-700 disabled:opacity-50"
      >
        {busy ? "Verifying…" : "Verify & continue"}
      </button>

      <div className="flex items-center justify-between mt-4 text-xs">
        <button onClick={() => { setUseBackup(!useBackup); setError(""); }} className="text-teal-700 hover:underline">
          {useBackup ? "Use authenticator code" : "Use a backup code"}
        </button>
        <button onClick={onCancel} className="text-slate-500 hover:underline">Back to sign in</button>
      </div>
    </AuthShell>
  );
}

/** First-time enrolment: scan the QR, confirm a code, save the backup codes. */
function MfaEnrollScreen({ challenge, email, onEnrolled, onCancel }) {
  const [setup, setSetup] = useState(null);
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(null);

  useEffect(() => {
    let cancelled = false;
    startMfaEnrollment(challenge)
      .then(async (s) => {
        if (cancelled) return;
        setSetup(s);
        // Rendered locally: the secret never leaves the browser to become a QR somewhere else.
        const QRCode = (await import("qrcode")).default;
        const url = await QRCode.toDataURL(s.otpauth, { width: 220, margin: 1 });
        if (!cancelled) setQr(url);
      })
      .catch((e) => !cancelled && setError(e?.message || "Could not start setup."));
    return () => { cancelled = true; };
  }, [challenge]);

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const res = await confirmMfaEnrollment(challenge, code.trim(), trust);
      setCodes(res.backupCodes || []);
      setPending(res.token ? { uid: res.user?.uid, email: res.user?.email } : null);
      setBusy(false);
    } catch (err) {
      setError(err?.message || "That code is not valid.");
      setCode("");
      setBusy(false);
    }
  }

  // Backup codes are shown once and never again, so finishing is gated on acknowledging them.
  if (codes) {
    return (
      <AuthShell title="Save your backup codes" subtitle="These are shown once. Store them somewhere safe.">
        <div className="grid grid-cols-2 gap-1.5 bg-slate-50 border border-slate-200 rounded-lg p-3 font-mono text-sm text-slate-700">
          {codes.map((c) => <div key={c} className="text-center py-0.5">{c}</div>)}
        </div>
        <p className="text-xs text-slate-500 mt-3">
          Each code signs you in once if you lose your phone. Print them or put them in a password manager.
        </p>
        <button
          onClick={() => { navigator.clipboard?.writeText(codes.join("\n")); setSaved(true); }}
          className="w-full mt-3 border border-slate-300 text-slate-700 text-sm py-2 rounded-lg hover:bg-slate-50"
        >
          {saved ? "Copied" : "Copy codes"}
        </button>
        <button
          onClick={() => onEnrolled(pending)}
          className="w-full mt-2 bg-teal-600 text-white text-sm font-medium py-2.5 rounded-lg hover:bg-teal-700"
        >
          I&apos;ve saved them — continue
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Set up authenticator" subtitle="Two-step verification is required for this account.">
      <ol className="text-xs text-slate-500 space-y-1 mb-3 list-decimal list-inside">
        <li>Install Google Authenticator, Authy, 1Password or Microsoft Authenticator.</li>
        <li>Scan this code with it.</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>

      <div className="flex justify-center mb-3">
        {qr
          ? <img src={qr} alt="Authenticator setup QR code" className="border border-slate-200 rounded-lg" />
          : <div className="w-[220px] h-[220px] bg-slate-100 rounded-lg animate-pulse" />}
      </div>

      {setup && (
        <details className="mb-3">
          <summary className="text-xs text-teal-700 cursor-pointer">Can&apos;t scan? Enter the key manually</summary>
          <div className="mt-2 text-xs">
            <div className="text-slate-400">Account</div>
            <div className="text-slate-700 mb-1.5">{email || setup.account}</div>
            <div className="text-slate-400">Key</div>
            <code className="block bg-slate-50 border border-slate-200 rounded px-2 py-1.5 break-all text-slate-700">{setup.secret}</code>
          </div>
        </details>
      )}

      <label className="text-xs text-slate-500 block mb-2 text-center">Enter the 6-digit code</label>
      <CodeInput value={code} onChange={setCode} onComplete={() => {}} disabled={busy || !setup} />

      <TrustDeviceCheckbox checked={trust} onChange={setTrust} disabled={busy} />

      {error && <p className="text-rose-600 text-xs mt-3 text-center">{error}</p>}

      <button
        onClick={confirm}
        disabled={busy || code.length !== 6 || !setup}
        className="w-full mt-4 bg-teal-600 text-white text-sm font-medium py-2.5 rounded-lg hover:bg-teal-700 disabled:opacity-50"
      >
        {busy ? "Verifying…" : "Turn on two-step verification"}
      </button>
      <button onClick={onCancel} className="w-full mt-2 text-slate-500 text-xs hover:underline">Back to sign in</button>
    </AuthShell>
  );
}

/** Shared frame for the auth screens, matching the existing login card. */
function AuthShell({ title, subtitle, children }) {
  return (
    <div className="min-h-[700px] bg-slate-50 flex items-center justify-center p-6 font-sans">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 justify-center mb-6">
          <div className="w-9 h-9 rounded-lg bg-teal-500 flex items-center justify-center text-white">
            <Stethoscope size={18} />
          </div>
          <div className="text-slate-800 font-semibold text-lg">{PRACTICE_INFO.name}</div>
        </div>
        <Card className="p-6">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck size={16} className="text-teal-600" />
            <h1 className="text-base font-semibold text-slate-800">{title}</h1>
          </div>
          <p className="text-xs text-slate-500 mb-5">{subtitle}</p>
          {children}
        </Card>
      </div>
    </div>
  );
}

function LoginPage({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Set when the API says a second factor is outstanding. The password form below is unchanged;
  // this simply swaps which screen is rendered until verification completes.
  const [mfa, setMfa] = useState(null);

  // Shared tail of a successful sign-in, reached either straight from the password step (when no
  // second factor is outstanding) or after verification. One place, so the profile and disabled
  // checks cannot drift apart between the two routes.
  async function finishLogin(credential) {
    const profile = await fetchUserProfile(credential.user.uid);
    if (!profile) {
      await signOutUser();
      setMfa(null);
      setError("No profile found for this account. Ask an admin to provision your access.");
      setLoading(false);
      return;
    }
    if (profile.disabled) {
      await signOutUser();
      setMfa(null);
      setError("This account has been deactivated. Contact an administrator.");
      setLoading(false);
      return;
    }
    setLoading(false);
    onLogin({ uid: credential.user.uid, email: credential.user.email, name: profile.name, role: profile.role });
  }

  if (mfa) {
    const back = () => { setMfa(null); setPassword(""); setError(""); };
    return mfa.enroll
      ? <MfaEnrollScreen challenge={mfa.challenge} email={mfa.email} onCancel={back}
          onEnrolled={(user) => user ? finishLogin({ user }) : back()} />
      : <MfaVerifyScreen challenge={mfa.challenge} onCancel={back} onVerified={finishLogin} />;
  }

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const credential = await signIn(email.trim(), password);
      // No session token was stored: a code (or first-time setup) is still outstanding.
      if (credential.mfa) {
        setMfa(credential.mfa);
        setLoading(false);
        return;
      }
      const profile = await fetchUserProfile(credential.user.uid);
      if (!profile) {
        await signOutUser();
        setError("No profile found for this account. Ask an admin to provision your access.");
        setLoading(false);
        return;
      }
      if (profile.disabled) {
        await signOutUser();
        setError("This account has been deactivated. Contact an administrator.");
        setLoading(false);
        return;
      }
      setLoading(false);
      onLogin({ uid: credential.user.uid, email: credential.user.email, name: profile.name, role: profile.role });
    } catch {
      setError("Invalid email or password.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[700px] bg-slate-50 flex items-center justify-center p-6 font-sans">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 justify-center mb-6">
          <div className="w-9 h-9 rounded-lg bg-teal-500 flex items-center justify-center text-white">
            <Stethoscope size={18} />
          </div>
          <div className="text-slate-800 font-semibold text-lg">Jobaid Clinic</div>
        </div>

        <Card className="p-6">
          <h1 className="text-lg font-semibold text-slate-800 mb-1">Sign in</h1>
          <p className="text-xs text-slate-500 mb-5">Practice management &amp; billing</p>

          <form onSubmit={submit}>
            <Field label="Email">
              <input type="email" required className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@medbill.local" autoFocus />
            </Field>
            <Field label="Password">
              <div className="relative">
                <input type={showPassword ? "text" : "password"} required className={`${inputCls} pr-16`} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
                <button type="button" onClick={() => setShowPassword(s => !s)} className="absolute right-2 top-1.5 text-xs text-slate-400 hover:text-slate-600 px-2 py-1">
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </Field>
            <div className="flex items-center justify-between mb-4">
              <label className="flex items-center gap-2 text-xs text-slate-500">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember me
              </label>
              <button type="button" className="text-xs text-teal-700 hover:underline">Forgot password?</button>
            </div>
            {error && <p className="text-rose-600 text-xs mb-3">{error}</p>}
            <button type="submit" disabled={loading} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700 disabled:opacity-60">
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </Card>

        {SHOW_DEMO_LOGINS && (
        <Card className="p-4 mt-4 bg-amber-50 border-amber-200">
          <p className="text-xs font-medium text-amber-800 mb-2 flex items-center gap-1.5"><AlertTriangle size={13} /> Development-only credentials</p>
          <div className="space-y-1 text-xs text-amber-700">
            {DEMO_LOGIN_HINTS.map(u => (
              <div key={u.email} className="flex justify-between">
                <span>{ROLE_LABELS[u.role]}</span>
                <button onClick={() => { setEmail(u.email); setPassword(u.password); }} className="underline hover:no-underline">{u.email}</button>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-amber-600 mt-2">Seeded by scripts/seedFirestore.mjs and shown only in development builds. Sign-in still goes through the API, not this list.</p>
        </Card>
        )}
      </div>
    </div>
  );
}

// A patient id that no longer resolves. This is reachable whenever the saved navigation position
// outlives the record it points at - the patient was deleted, or the collections came back empty -
// and it exists because the alternative was a crash: the chart and billing screens read
// patient.name immediately, so an undefined patient unmounted the entire application and left a
// blank page with no way back.
function MissingPatient({ patientId, onBack }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-14 h-14 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400 mb-4">
        <Users size={24} />
      </div>
      <h2 className="text-lg font-semibold text-slate-800 mb-1">Patient record unavailable</h2>
      <p className="text-sm text-slate-500 mb-5 max-w-sm">
        No record could be loaded for <span className="font-medium text-slate-700">{patientId}</span>.
        It may have been removed, or your session may have expired while this page was open.
      </p>
      <button onClick={onBack} className="bg-teal-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-teal-700">Back to search</button>
    </div>
  );
}

function Forbidden({ onBack }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-14 h-14 rounded-full bg-rose-50 border border-rose-200 flex items-center justify-center text-rose-500 mb-4">
        <Ban size={24} />
      </div>
      <h2 className="text-lg font-semibold text-slate-800 mb-1">Access denied</h2>
      <p className="text-sm text-slate-500 mb-5 max-w-sm">You do not have permission to access this section. If you believe this is a mistake, contact your practice administrator.</p>
      <button onClick={onBack} className="bg-teal-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-teal-700">Return to Dashboard</button>
    </div>
  );
}

// ---------- Storage adapter ----------
// window.storage only exists inside the claude.ai artifact preview. A real deployment
// (e.g. this file dropped into your own Vite project) has no such API — there, we fall
// back to plain localStorage, which works fine in an actual browser.
const storageAdapter = {
  async get(key) {
    if (typeof window !== "undefined" && window.storage && typeof window.storage.get === "function") {
      try {
        const r = await window.storage.get(key, false);
        return r ? r.value : null;
      } catch (e) { return null; }
    }
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  },
  async set(key, value) {
    if (typeof window !== "undefined" && window.storage && typeof window.storage.set === "function") {
      try { await window.storage.set(key, value, false); return; } catch (e) { /* fall through */ }
    }
    try { window.localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ }
  },
  async remove(key) {
    if (typeof window !== "undefined" && window.storage && typeof window.storage.delete === "function") {
      try { await window.storage.delete(key, false); return; } catch (e) { /* fall through */ }
    }
    try { window.localStorage.removeItem(key); } catch (e) { /* storage unavailable */ }
  },
};

const SESSION_KEY = "clinic_session";
const NAV_KEY = "clinic_nav";
const IDLE_LIMIT_MS = 2 * 60 * 30 * 1000; // 2 hours
const SESSION_WRITE_THROTTLE_MS = 60 * 1000; // don't hammer storage on every click/keystroke

export default function ClinicBilling() {
  const [session, setSession] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true); // avoids a login-page flash on refresh
  const lastActivityRef = useRef(Date.now());
  const lastWriteRef = useRef(0);

  // Top-level navigation state lives here (not inside ClinicApp) so it can be persisted
  // and restored on refresh — "keep me where I was," not just "keep me logged in."
  const [tab, setTab] = useState("dashboard");
  const [billingPatientId, setBillingPatientId] = useState(null);
  const [billingMode, setBillingMode] = useState("search");
  const [clinicalPatientId, setClinicalPatientId] = useState(null);
  const navRestored = useRef(false);

  // On mount: restore a still-valid session AND the last navigation position from storage.
  useEffect(() => {
    (async () => {
      try {
        const raw = await storageAdapter.get(SESSION_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved?.lastActivity && Date.now() - saved.lastActivity < IDLE_LIMIT_MS) {
            setSession(saved);
            lastActivityRef.current = Date.now();
          } else {
            await storageAdapter.remove(SESSION_KEY);
          }
        }
      } catch (e) { /* no valid session — show login */ }

      try {
        const rawNav = await storageAdapter.get(NAV_KEY);
        if (rawNav) {
          const nav = JSON.parse(rawNav);
          if (nav.tab) setTab(nav.tab);
          if (nav.billingPatientId !== undefined) setBillingPatientId(nav.billingPatientId);
          if (nav.billingMode) setBillingMode(nav.billingMode);
          if (nav.clinicalPatientId !== undefined) setClinicalPatientId(nav.clinicalPatientId);
        }
      } catch (e) { /* no saved position — default to Dashboard */ }
      navRestored.current = true;

      setCheckingSession(false);
    })();
  }, []);

  // The API drops the stored token the moment a request comes back 401 (see expireSession in
  // apiClient). That can happen while the app is open - the token expires, the account is
  // disabled, or the API restarts with a new signing secret - so the session state here follows
  // it down. The saved navigation position is deliberately left alone: signing back in should
  // return the user to the screen they were on.
  useEffect(() => onTokenChange((next) => {
    if (!next) {
      setSession(null);
      storageAdapter.remove(SESSION_KEY);
    }
  }), []);

  // Persist navigation position whenever it changes (skip the very first render so we
  // don't immediately overwrite a just-restored position with the pre-restore defaults).
  useEffect(() => {
    if (!navRestored.current) return;
    storageAdapter.set(NAV_KEY, JSON.stringify({ tab, billingPatientId, billingMode, clinicalPatientId }));
  }, [tab, billingPatientId, billingMode, clinicalPatientId]);

  async function persistSession(sess) {
    await storageAdapter.set(SESSION_KEY, JSON.stringify(sess));
  }

  function handleLogin(user) {
    const sess = { uid: user.uid, email: user.email, name: user.name, role: user.role, loginAt: Date.now(), lastActivity: Date.now() };
    setSession(sess);
    lastActivityRef.current = Date.now();
    lastWriteRef.current = Date.now();
    persistSession(sess);
    addDocument("loginAudit", { action: "Login", user: user.name, role: user.role, timestamp: nowIso() });
  }

  async function handleLogout(reason) {
    addDocument("loginAudit", { action: reason === "timeout" ? "Session expired (2h inactivity)" : "Logout", user: session?.name, role: session?.role, timestamp: nowIso() });
    setSession(null);
    await signOutUser();
    await storageAdapter.remove(SESSION_KEY);
    // Deliberately keep NAV_KEY on manual logout/timeout so the next login for this browser
    // returns to the same place — only a fresh "start over" would need to clear it.
  }

  // Track activity (click/keydown/mousemove/scroll) and check idle time every 30s.
  useEffect(() => {
    if (!session) return;
    function markActivity() {
      lastActivityRef.current = Date.now();
      if (Date.now() - lastWriteRef.current > SESSION_WRITE_THROTTLE_MS) {
        lastWriteRef.current = Date.now();
        persistSession({ ...session, lastActivity: lastActivityRef.current });
      }
    }
    const events = ["click", "keydown", "mousemove", "scroll"];
    events.forEach(ev => window.addEventListener(ev, markActivity, { passive: true }));

    const idleCheck = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= IDLE_LIMIT_MS) {
        handleLogout("timeout");
      }
    }, 30 * 1000);

    return () => {
      events.forEach(ev => window.removeEventListener(ev, markActivity));
      clearInterval(idleCheck);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  if (checkingSession) {
    return <div className="min-h-[700px] flex items-center justify-center bg-slate-50 text-slate-400 text-sm font-sans">Loading…</div>;
  }
  if (!session) return <LoginPage onLogin={handleLogin} />;
  return (
    <ClinicApp
      session={session} onLogout={() => handleLogout("manual")}
      tab={tab} setTab={setTab}
      billingPatientId={billingPatientId} setBillingPatientId={setBillingPatientId}
      billingMode={billingMode} setBillingMode={setBillingMode}
      clinicalPatientId={clinicalPatientId} setClinicalPatientId={setClinicalPatientId}
    />
  );
}

function ClinicApp({
  session, onLogout,
  tab, setTab, billingPatientId, setBillingPatientId, billingMode, setBillingMode, clinicalPatientId, setClinicalPatientId,
}) {
  // Every collection below is a real-time Firestore read (src/firebase/firestoreService.js) —
  // writes go out via the handler functions further down and this array updates automatically
  // once Firestore confirms them, the same way the old setPatients(prev => ...) calls used to
  // update local state immediately.
  const [patients, lPatients] = useFirestoreCollection("patients");
  const [appointments, lAppointments] = useFirestoreCollection("appointments");
  const [charges, lCharges] = useFirestoreCollection("charges");
  const [claims, lClaims] = useFirestoreCollection("claims");
  const [transactions, lTransactions] = useFirestoreCollection("transactions");
  const [policies, lPolicies] = useFirestoreCollection("insurancePolicies");
  const [auditLogs, lAuditLogs] = useFirestoreCollection("auditLogs");
  const [idDocuments, lIdDocuments] = useFirestoreCollection("idDocuments");
  const [patientMemos, lPatientMemos] = useFirestoreCollection("patientMemos");
  const [cptCatalog, lCptCatalog] = useFirestoreCollection("cptCatalog");
  const [physicians, lPhysicians] = useFirestoreCollection("physicians");
  const [insurances, lInsurances] = useFirestoreCollection("insurance");
  const [rolePermissions, lRolePermissions] = useFirestoreCollection("rolePermissions");
  // Credit balance pools created by "Credit Balance"-type debits — usable against any patient's charges.
  const [patientCreditBalances, lPatientCreditBalances] = useFirestoreCollection("patientCreditBalances");
  const [insuranceCreditBalances, lInsuranceCreditBalances] = useFirestoreCollection("insuranceCreditBalances");
  const [vitals, lVitals] = useFirestoreCollection("vitals");
  const [allergies, lAllergies] = useFirestoreCollection("allergies");
  const [medications, lMedications] = useFirestoreCollection("medications");
  const [problems, lProblems] = useFirestoreCollection("problems");
  const [clinicalNotes, lClinicalNotes] = useFirestoreCollection("clinicalNotes");
  // Every signed-in user can read the users collection now (see firestore.rules) — needed for
  // the Tickler "Assign To" picker, not just the SUPER_ADMIN-only User Management screen.
  const [userAccounts, lUserAccounts] = useFirestoreCollection("users");
  const [batches, lBatches] = useFirestoreCollection("batches");
  const [ticklers, lTicklers] = useFirestoreCollection("ticklers");
  const [supportTickets, lSupportTickets] = useFirestoreCollection("supportTickets");

  // First Firestore snapshot for every collection hasn't landed yet — hold off rendering the
  // real UI so nothing briefly flashes "no data" (or a cptCatalog[0] lookup crashes) before the
  // seeded data actually arrives.
  const dataLoading = lPatients || lAppointments || lCharges || lClaims || lTransactions || lPolicies ||
    lAuditLogs || lIdDocuments || lPatientMemos || lCptCatalog || lPhysicians || lInsurances || lRolePermissions || lPatientCreditBalances ||
    lInsuranceCreditBalances || lVitals || lAllergies || lMedications || lProblems || lClinicalNotes ||
    lUserAccounts || lBatches || lTicklers || lSupportTickets;

  const [showAddPatient, setShowAddPatient] = useState(false);
  const [showAddAppt, setShowAddAppt] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState(null);
  const [showBatchManagement, setShowBatchManagement] = useState(false);
  const [showUserAdmin, setShowUserAdmin] = useState(false);
  const [showManageRoles, setShowManageRoles] = useState(false);
  const [showPracticeCatalog, setShowPracticeCatalog] = useState(false);
  const [showInsuranceAdmin, setShowInsuranceAdmin] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showSecurity, setShowSecurity] = useState(false);
  const [showSupportPanel, setShowSupportPanel] = useState(false);
  const [showTicklerPanel, setShowTicklerPanel] = useState(false);
  const [ticklerPrefill, setTicklerPrefill] = useState(null); // set to open the Tickler panel pre-filled from a charge

  const patientById = useMemo(() => Object.fromEntries(patients.map(p => [p.id, p])), [patients]);
  const chargeById = useMemo(() => Object.fromEntries(charges.map(c => [c.id, c])), [charges]);
  const primaryPolicyByPatient = useMemo(() => {
    const map = {};
    patients.forEach(p => { map[p.id] = currentPrimaryPolicy(p.id, policies); });
    return map;
  }, [patients, policies]);
  const allergiesByPatient = useMemo(() => {
    const map = {};
    allergies.filter(a => a.status === "Active").forEach(a => { (map[a.patientId] = map[a.patientId] || []).push(a); });
    return map;
  }, [allergies]);

  const patientBalance = (patientId) =>
    charges.filter(c => c.patientId === patientId).reduce((s, c) => s + Math.max(0, balanceOf(c)), 0);

  const outstanding = useMemo(() => charges.reduce((s, c) => s + Math.max(0, balanceOf(c)), 0), [charges]);
  const monthRevenue = useMemo(() => charges.reduce((s, c) => s + c.paid, 0), [charges]);
  const todaysAppts = appointments.filter(a => a.date === "2026-08-24");
  const pendingClaims = claims.filter(c => c.status === "Submitted" || c.status === "Draft").length;
  const deniedClaims = claims.filter(c => c.status === "Denied").length;

  const claimStatusData = useMemo(() => {
    const counts = {};
    claims.forEach(c => { counts[c.status] = (counts[c.status] || 0) + 1; });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [claims]);

  const allNav = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "schedule", label: "Schedule", icon: CalendarDays },
    { id: "patients", label: "Patients", icon: Users },
    { id: "clinical", label: "Clinical", icon: HeartPulse },
    { id: "billing", label: "Billing", icon: Receipt },
    { id: "claims", label: "Claims", icon: FileStack },
    { id: "reports", label: "Reports", icon: BarChart3 },
  ];
  // Live grants win; DEFAULT_ROLE_TABS covers the first render and any role without a row.
  // Super Admin is never read from the table - see DEFAULT_ROLE_TABS.
  const allowedTabs = useMemo(() => {
    if (session.role === "SUPER_ADMIN") return DEFAULT_ROLE_TABS.SUPER_ADMIN;
    const row = rolePermissions.find(r => r.id === session.role);
    if (row && Array.isArray(row.tabs)) return row.tabs;
    return DEFAULT_ROLE_TABS[session.role] || ["dashboard"];
  }, [rolePermissions, session.role]);
  const isAccountAdmin = session.role === "SUPER_ADMIN";
  const nav = allNav.filter(item => allowedTabs.includes(item.id));
  const tabAllowed = allowedTabs.includes(tab);

  // "users" was a nav tab until User accounts moved into the Settings menu, and the last
  // position is restored from storage on refresh - so an admin who was on that screen would come
  // back to a tab that no longer renders anything. The same guard covers a role whose access to
  // the saved tab was revoked in Manage roles while they were away.
  useEffect(() => {
    if (!nav.some(item => item.id === tab)) setTab("dashboard");
  }, [nav, tab, setTab]);

  // The batch this user currently has open, if any — a user can only ever have one (batches are
  // keyed by userId+date, see openBatch), so there's at most one OPEN doc for this uid at a time.
  const myOpenBatch = batches.find(b => b.userId === session.uid && b.status === "OPEN") || null;

  // ----- Posting sessions with money still to allocate -----
  //
  // A cheque or remittance is entered with a total, and the biller allocates it across claims one
  // at a time. That leftover lives only in the posting screen's own state - it is not a database
  // figure - so closing the batch is the last moment anything can notice it. Each posting screen
  // reports its progress here, and closeBatch() refuses while any of it is unallocated.
  const [postingSessions, setPostingSessions] = useState({});
  const [blockedClose, setBlockedClose] = useState(null);

  // Stable identity, and a no-op when nothing actually changed: the posting screens call this from
  // an effect, so returning a new object every time would loop.
  const reportPostingSession = useCallback((key, sessionInfo) => {
    setPostingSessions(prev => {
      if (!sessionInfo) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      const cur = prev[key];
      if (cur && cur.total === sessionInfo.total && cur.allocated === sessionInfo.allocated && cur.reference === sessionInfo.reference) {
        return prev;
      }
      return { ...prev, [key]: sessionInfo };
    });
  }, []);

  const unallocatedSessions = useMemo(
    () => Object.entries(postingSessions)
      .map(([key, v]) => ({ key, ...v, remaining: (Number(v.total) || 0) - (Number(v.allocated) || 0) }))
      .filter(v => v.remaining > BALANCE_EPSILON),
    [postingSessions]
  );
  const isBillingOversightRole = session.role === "SUPER_ADMIN" || session.role === "MANAGER";
  const insurancePerms = useInsurancePermissions(session, rolePermissions);
  // Badge on the floating Tickler button: open items assigned to me that are due today or overdue.
  const ticklerBadgeCount = ticklers.filter(t => t.assignedToUid === session.uid && t.status === "Open" && t.reminderDate <= TODAY).length;

  // ---------- Handlers ----------

  function addAudit(patientId, action, entityType, entityId, oldValues, newValues) {
    addDocument("auditLogs", { patientId, user: session.name, action, entityType, entityId, oldValues, newValues, timestamp: nowIso() }, uid("AUD"));
  }

  function addPatient(form) {
    const dupes = findDuplicatePatients(form, patients);
    if (dupes.length > 0 && !form._forceCreate) {
      setDuplicateWarning({ form, dupes });
      return;
    }
    const id = uid("");
    const patient = { ...form, id };
    delete patient._forceCreate;
    setDocument("patients", id, patient);
    addAudit(id, "Patient created", "patient", id, null, `${patient.name} registered`);
    setShowAddPatient(false);
    setDuplicateWarning(null);
  }

  function updatePatient(patientId, updates) {
    const before = patientById[patientId];
    updateDocument("patients", patientId, updates);
    const changed = Object.keys(updates).filter(k => JSON.stringify(before[k]) !== JSON.stringify(updates[k]));
    if (changed.length) addAudit(patientId, "Patient updated", "patient", patientId, changed.map(k => `${k}: ${before[k]}`).join("; "), changed.map(k => `${k}: ${updates[k]}`).join("; "));
  }

  // ----- Insurance: the never-overwrite rule -----
  function addInsurance(patientId, form) {
    const conflict = policies.find(pol => pol.patientId === patientId && pol.priority === form.priority && pol.status === "Active");
    if (conflict) {
      const endDate = form.effectiveDate ? new Date(new Date(form.effectiveDate + "T00:00") - 86400000).toISOString().slice(0, 10) : TODAY;
      updateDocument("insurancePolicies", conflict.id, { status: "Terminated", terminationDate: endDate, updatedAt: nowIso() });
      addAudit(patientId, "Insurance terminated", "insurance", conflict.id, "Active", `Terminated ${endDate} (superseded by ${form.insuranceCompany})`);
    }
    const id = uid("POL");
    setDocument("insurancePolicies", id, { id, patientId, status: "Active", fieldHistory: [], createdBy: session.name, createdAt: nowIso(), updatedAt: nowIso(), ...form });
    addAudit(patientId, "Insurance added", "insurance", id, null, `${form.insuranceCompany} ${form.planName}, Member ${form.memberId}, ${form.priority}, effective ${fmtDate(form.effectiveDate)}`);
  }

  function editInsurance(policyId, updates, createNew) {
    const policy = policies.find(p => p.id === policyId);
    if (!policy) return;
    if (createNew) { addInsurance(policy.patientId, { ...policy, ...updates, id: undefined }); return; }
    const changedFields = Object.keys(updates).filter(k => policy[k] !== updates[k]);
    const historyEntries = changedFields.map(k => ({ field: k, oldValue: policy[k], newValue: updates[k], changedAt: nowIso(), changedBy: session.name }));
    updateDocument("insurancePolicies", policyId, { ...updates, fieldHistory: [...(policy.fieldHistory || []), ...historyEntries], updatedAt: nowIso() });
    if (changedFields.length) addAudit(policy.patientId, "Insurance updated", "insurance", policyId, changedFields.map(k => `${k}: ${policy[k]}`).join("; "), changedFields.map(k => `${k}: ${updates[k]}`).join("; "));
  }

  function setPolicyPriority(policyId, newPriority) {
    const policy = policies.find(p => p.id === policyId);
    if (!policy) return;
    const holder = policies.find(p => p.patientId === policy.patientId && p.priority === newPriority && p.status === "Active" && p.id !== policyId);
    const batch = newBatch();
    batch.update(docRef("insurancePolicies", policyId), { priority: newPriority, updatedAt: nowIso() });
    if (holder) batch.update(docRef("insurancePolicies", holder.id), { priority: policy.priority, updatedAt: nowIso() });
    batch.commit();
    addAudit(policy.patientId, "Insurance priority changed", "insurance", policyId, policy.priority, newPriority);
  }

  function endCoverage(policyId, endDate) {
    const policy = policies.find(p => p.id === policyId);
    if (!policy) return;
    updateDocument("insurancePolicies", policyId, { status: "Terminated", terminationDate: endDate, updatedAt: nowIso() });
    addAudit(policy.patientId, "Insurance ended", "insurance", policyId, "Active", `Terminated ${endDate}`);
  }

  function uploadInsuranceCard(policyId, side, dataUrl) {
    const policy = policies.find(p => p.id === policyId);
    updateDocument("insurancePolicies", policyId, { [side]: dataUrl, updatedAt: nowIso() });
    addAudit(policy.patientId, "Insurance card uploaded", "insurance", policyId, null, side === "cardFront" ? "Front card image" : "Back card image");
  }

  // Stores the file inline on the Firestore document as a base64 data URL — no Cloud Storage
  // bucket involved. (Firebase Storage — and Realtime Database — both require the project to be
  // on the Blaze billing plan to provision a new bucket/instance at all, even for free-tier
  // usage; this keeps the app fully working on the free Spark plan instead.) Firestore documents
  // cap out at 1 MiB, so IdDocForm rejects files over ~700KB before they ever get here — plenty
  // for a photographed/scanned ID, not for a high-res multi-page PDF.
  // A new upload of the same ID type replaces the old one outright — the previous row and its
  // inline file are removed, not archived, so the tab only ever lists documents that are really
  // on file. The audit log below still records every upload and removal, so the paper trail of
  // what happened and when survives even though the file itself does not.
  async function uploadIdDocument(patientId, doc) {
    const id = uid("DOC");
    const superseded = idDocuments.filter(d => d.patientId === patientId && d.idType === doc.idType);
    const batch = newBatch();
    superseded.forEach(d => batch.delete(docRef("idDocuments", d.id)));
    batch.set(docRef("idDocuments", id), {
      id, patientId, status: "Active", uploadedBy: session.name, uploadedAt: nowIso(),
      idType: doc.idType, idNumber: doc.idNumber, issuingState: doc.issuingState, issueDate: doc.issueDate, expirationDate: doc.expirationDate,
      file: doc.file, fileName: doc.fileName, fileType: doc.fileType, fileSize: doc.fileSize,
    });
    await batch.commit();
    addAudit(patientId, "ID uploaded", "document", id, superseded.length ? `Replaced ${superseded.length} earlier ${doc.idType}` : null, `${doc.idType} ${doc.idNumber || ""}`.trim());
  }

  // Hard delete, unlike the soft-delete/append-only pattern the rest of this app uses. ID
  // documents carry a scanned government ID as an inline base64 file, so "delete" has to mean
  // the image is gone from the database — keeping an archived copy of exactly the record someone
  // asked to remove is the opposite of what deleting an ID is for. The audit entry (which holds
  // no image data) is what remains, so the removal itself is still traceable.
  function deleteIdDocument(patientId, docId) {
    const doc = idDocuments.find(d => d.id === docId && d.patientId === patientId);
    if (!doc) return;
    deleteDocument("idDocuments", docId);
    addAudit(patientId, "ID document deleted", "document", docId, `${doc.idType} ${doc.idNumber || ""}`.trim(), "Permanently removed");
  }

  // ----- Patient-level memos (billing/admin notes, separate from per-charge follow-ups) -----
  function addPatientMemo(patientId, text) {
    const id = uid("PMEMO");
    setDocument("patientMemos", id, { id, patientId, text, user: session.name, date: TODAY });
    addAudit(patientId, "Memo added", "memo", id, null, text);
  }

  // ----- Claim / Ledger: posting a transaction onto a specific DOS charge -----
  // Shared apply step: bump paid/writeoff/credits, push a detailed posting record, log a global
  // transaction (for Reports) and an audit entry. Never overwrites prior postings — append-only.
  // Multiple entries (e.g. a payment plus its contractual write-off) are applied against one
  // running balance. Write-offs/credits can never exceed the charge's remaining room, but a cash
  // payment (field "paid") is posted in full even past that room — the charge is then legitimately
  // overpaid and balanceOf() goes negative rather than silently truncating the payment.
  function postToChargeMulti(chargeId, entries) {
    if (!myOpenBatch) { alert("Open your batch before posting payments — see the batch status in the header."); return; }
    const target = charges.find(c => c.id === chargeId);
    if (!target) return;
    let room = Math.max(0, target.charge - target.paid - target.writeoff - (target.credits || 0));
    const applied = [];
    entries.forEach(entry => {
      const requested = Math.max(0, Number(entry.amount) || 0);
      if (requested <= 0) return;
      const amt = entry.field === "paid" ? requested : Math.min(room, requested);
      if (amt <= 0) return;
      room -= amt;
      // Generated once and shared by the posting record and its transaction, so a later
      // System Debit can look up and remove both by the same id.
      applied.push({ ...entry, amount: amt, postingId: uid("PST") });
    });
    if (applied.length === 0) return;

    const fieldDeltas = {};
    applied.forEach(e => { fieldDeltas[e.field] = (fieldDeltas[e.field] || 0) + e.amount; });
    const updatedFields = {};
    Object.entries(fieldDeltas).forEach(([field, delta]) => { updatedFields[field] = (target[field] || 0) + delta; });
    updatedFields.postings = [...(target.postings || []), ...applied.map(e => ({ id: e.postingId, field: e.field, amount: e.amount, debited: 0, postedBy: session.name, postedAt: nowIso(), ...e.posting }))];

    const batch = newBatch();
    batch.update(docRef("charges", chargeId), updatedFields);
    applied.forEach(e => {
      batch.set(docRef("transactions", uid("TXN")), { postingId: e.postingId, batchId: myOpenBatch.id, chargeId, patientId: target.patientId, type: e.txnType, amount: e.amount, date: e.posting.date || TODAY, source: e.posting.insuranceName || e.posting.payer || e.posting.method || "Manual", reference: e.posting.reference || e.posting.checkNumber || "" });
    });
    batch.commit();
    applied.forEach(e => addAudit(target.patientId, e.auditLabel, "charge", chargeId, null, `${money(e.amount)} — ${e.posting.notes || e.posting.type || ""}`.trim()));
  }
  function postToCharge(chargeId, entry) {
    postToChargeMulti(chargeId, [entry]);
  }

  // Guided manual posting (Post payments > Manual post): a single payment plus an optional,
  // reason-required contractual write-off, applied atomically to one charge.
  function postManualLinePayment(chargeId, form) {
    const entries = [];
    const amt = Number(form.amount) || 0;
    if (amt > 0) {
      entries.push({
        field: "paid", amount: amt, txnType: "payment", auditLabel: form.insuranceName ? "Insurance payment posted" : "Patient payment posted",
        posting: {
          type: form.insuranceName ? "Insurance Credit" : "Patient Credit", insuranceName: form.insuranceName || undefined,
          payer: form.insuranceName || "Patient", checkNumber: form.checkNumber, reference: form.checkNumber, date: form.paymentDate, notes: form.notes,
          copay: form.copay, coinsurance: form.coinsurance, deductible: form.deductible, allowedAmount: form.allowedAmount,
        },
      });
    }
    const writeoffAmt = Number(form.writeoff) || 0;
    if (writeoffAmt > 0) {
      entries.push({
        field: "writeoff", amount: writeoffAmt, txnType: "writeoff", auditLabel: "Write-off posted",
        posting: { type: "Write-off", reason: form.writeoffReason, checkNumber: form.checkNumber, date: form.paymentDate, notes: `Allowed ${money(Number(form.allowedAmount) || 0)} of billed ${money(Number(form.billedAmount) || 0)}` },
      });
    }
    if (entries.length === 0) return;
    postToChargeMulti(chargeId, entries);
  }

  function postCheckPayment(chargeId, form) {
    postToCharge(chargeId, {
      field: "paid", amount: Number(form.amount) || 0, txnType: "payment", auditLabel: "Check payment posted",
      posting: { type: "Check", payer: form.payer, insuranceName: form.insurance, checkNumber: form.checkNumber, checkDate: form.checkDate, depositDate: form.depositDate, date: form.paymentDate, notes: form.notes },
    });
  }
  function postCreditCardPayment(chargeId, form) {
    postToCharge(chargeId, {
      field: "paid", amount: Number(form.amount) || 0, txnType: "payment", auditLabel: "Card payment posted",
      posting: { type: "Credit Card", payer: form.payer, reference: form.reference, date: form.paymentDate, notes: form.notes },
    });
  }
  function postInsuranceCredit(chargeId, form) {
    postToCharge(chargeId, {
      field: "paid", amount: Number(form.amount) || 0, txnType: "payment", auditLabel: "Insurance payment posted",
      posting: { type: "Insurance Credit", insuranceName: form.insuranceName, reference: form.reference, depositDate: form.depositDate, date: form.paymentDate, notes: form.notes, copay: form.copay, coinsurance: form.coinsurance, deductible: form.deductible, allowedAmount: form.allowedAmount },
    });
  }
  function postPatientCredit(chargeId, form) {
    postToCharge(chargeId, {
      field: "paid", amount: Number(form.amount) || 0, txnType: "payment", auditLabel: "Patient payment posted",
      posting: { type: "Patient Credit", method: form.method, reference: form.reference, date: form.date, notes: form.notes },
    });
  }
  function writeOffDOS(chargeId, form) {
    postToCharge(chargeId, {
      field: "writeoff", amount: Number(form.amount) || 0, txnType: "writeoff", auditLabel: "Write-off posted",
      posting: { type: "Write-off", reason: form.reason, date: form.date, notes: form.notes },
    });
  }
  function creditDOS(chargeId, form) {
    postToCharge(chargeId, {
      field: "credits", amount: Number(form.amount) || 0, txnType: "writeoff", auditLabel: "DOS credit posted",
      posting: { type: "Credit", reason: form.reason, date: form.date, notes: form.notes },
    });
  }

  function selectInsuranceForCharge(chargeId, policyId) {
    const target = charges.find(c => c.id === chargeId);
    if (!target) return;
    updateDocument("charges", chargeId, { chargeInsuranceId: policyId, payerOverride: null });
    const pol = policies.find(p => p.id === policyId);
    addAudit(target.patientId, "Claim payer changed", "charge", chargeId, payerLabel(target, policies), pol ? pol.insuranceCompany : "Unassigned");
  }
  function setSelfPayForCharge(chargeId) {
    const target = charges.find(c => c.id === chargeId);
    if (!target) return;
    // Insurance association is preserved, not cleared — only the payer display/override changes.
    updateDocument("charges", chargeId, { payerOverride: "self" });
    addAudit(target.patientId, "Claim payer changed", "charge", chargeId, payerLabel(target, policies), "Self / Patient");
  }
  function editClaimFields(chargeId, updates) {
    const target = charges.find(c => c.id === chargeId);
    if (!target) return;
    const changed = Object.keys(updates).filter(k => target[k] !== updates[k]);
    updateDocument("charges", chargeId, updates);
    if (changed.length) addAudit(target.patientId, "Claim updated", "charge", chargeId, changed.map(k => `${k}: ${target[k]}`).join("; "), changed.map(k => `${k}: ${updates[k]}`).join("; "));
  }
  function addFollowUp(chargeId, entry) {
    const target = charges.find(c => c.id === chargeId);
    if (!target) return;
    updateDocument("charges", chargeId, { memos: [...(target.memos || []), { ...entry, user: session.name }] });
    addAudit(target.patientId, "Follow-up added", "charge", chargeId, null, `${entry.type}: ${entry.text}`);
  }

  // Debits (reverses) part or all of a previously posted payment. Never edits the original
  // posting — appends a linked "Debit" posting and reduces paid/balance accordingly.
  // System Debit is the exception: it's a correction for a posting that shouldn't have existed
  // (mis-click, wrong patient, duplicate), not a business reversal — so it takes no reason and
  // instead removes the original posting and its transaction outright, rather than leaving a
  // credit/debit pair in the ledger history.
  function debitPosting(chargeId, postingId, form) {
    const target = charges.find(c => c.id === chargeId);
    const posting = target?.postings.find(p => p.id === postingId);
    if (!target || !posting) return;
    const debitable = Math.max(0, posting.amount - (posting.debited || 0));

    if (form.systemDebit) {
      if (debitable <= 0) return;
      const field = posting.field || "paid";
      const batch = newBatch();
      batch.update(docRef("charges", chargeId), {
        [field]: Math.max(0, (target[field] || 0) - debitable),
        postings: target.postings.filter(p => p.id !== postingId),
        // Surfaced in Follow-up history too — that panel is what billing staff actually look at
        // per DOS, and a removal like this shouldn't be visible only in the separate Audit History tab.
        memos: [...(target.memos || []), { type: "System Debit", text: `System debited — ${posting.type} ${money(debitable)} removed from the ledger (no reason recorded).`, date: TODAY, user: session.name }],
      });
      transactions.filter(t => t.postingId === postingId).forEach(t => batch.delete(docRef("transactions", t.id)));
      batch.commit();
      addAudit(target.patientId, "System debit — posting removed", "charge", chargeId, `${posting.type} ${money(posting.amount)}`, "Removed entirely by system debit (no reason recorded)");
      return;
    }

    if (!myOpenBatch) { alert("Open your batch before posting a debit — see the batch status in the header."); return; }
    const applied = Math.min(debitable, Number(form.amount) || 0);
    if (applied <= 0) return;

    const debitId = uid("PST");
    const batch = newBatch();
    batch.update(docRef("charges", chargeId), {
      paid: Math.max(0, target.paid - applied),
      postings: [
        ...target.postings.map(p => p.id === postingId ? { ...p, debited: (p.debited || 0) + applied } : p),
        { id: debitId, type: "Debit", debitType: form.debitType, reason: form.reason, amount: applied, date: form.date, notes: form.notes, reversalOf: postingId, postedBy: session.name, postedAt: nowIso() },
      ],
    });
    batch.set(docRef("transactions", uid("TXN")), { batchId: myOpenBatch.id, chargeId, patientId: target.patientId, type: "debit", amount: applied, date: form.date || TODAY, source: form.debitType, reference: form.reason });

    // "Credit Balance" debits keep the money in the practice as an applicable credit pool;
    // "Refund" debits pay it back out and create no pool entry.
    if (form.debitType === "Patient Credit Balance") {
      batch.set(docRef("patientCreditBalances", uid("PCB")), { patientId: target.patientId, amount: applied, remaining: applied, reason: form.reason, date: form.date, sourceChargeId: chargeId, sourcePostingId: debitId, createdBy: session.name, createdAt: nowIso() });
    }
    if (form.debitType === "Insurance Credit Balance") {
      const insuranceName = posting.insuranceName || "Unspecified insurer";
      batch.set(docRef("insuranceCreditBalances", uid("ICB")), { insuranceName, patientId: target.patientId, amount: applied, remaining: applied, reason: form.reason, date: form.date, sourceChargeId: chargeId, sourcePostingId: debitId, createdBy: session.name, createdAt: nowIso() });
    }
    batch.commit();
    addAudit(target.patientId, "Payment debited", "charge", chargeId, `${posting.type} ${money(posting.amount)}`, `${money(applied)} debited — ${form.reason} (${form.debitType})`);
  }

  // Applies an existing credit-balance pool entry (patient- or insurance-sourced) as a payment
  // toward any patient's open charge — including a different patient than the one who generated it.
  function applyCreditBalance(poolType, creditId, targetChargeId, amount) {
    if (!myOpenBatch) { alert("Open your batch before applying a credit balance — see the batch status in the header."); return; }
    const poolName = poolType === "patient" ? "patientCreditBalances" : "insuranceCreditBalances";
    const pool = poolType === "patient" ? patientCreditBalances : insuranceCreditBalances;
    const credit = pool.find(c => c.id === creditId);
    const targetCharge = charges.find(c => c.id === targetChargeId);
    if (!credit || !targetCharge) return;
    const room = Math.max(0, targetCharge.charge - targetCharge.paid - targetCharge.writeoff - (targetCharge.credits || 0));
    const applied = Math.min(credit.remaining, room, Number(amount) || 0);
    if (applied <= 0) return;

    const postingId = uid("PST");
    const batch = newBatch();
    batch.update(docRef(poolName, creditId), { remaining: credit.remaining - applied });
    batch.update(docRef("charges", targetChargeId), {
      paid: targetCharge.paid + applied,
      postings: [...(targetCharge.postings || []), {
        id: postingId, type: poolType === "patient" ? "Patient Credit" : "Insurance Credit", amount: applied, debited: 0,
        notes: `Applied from ${poolType === "patient" ? "patient" : credit.insuranceName} credit balance (${credit.reason}, originally on charge ${credit.sourceChargeId})`,
        insuranceName: poolType === "insurance" ? credit.insuranceName : undefined,
        date: TODAY, postedBy: session.name, postedAt: nowIso(),
      }],
    });
    batch.set(docRef("transactions", uid("TXN")), { batchId: myOpenBatch.id, chargeId: targetChargeId, patientId: targetCharge.patientId, type: "payment", amount: applied, date: TODAY, source: poolType === "patient" ? "Patient credit balance" : `${credit.insuranceName} credit balance`, reference: credit.id });
    batch.commit();
    addAudit(targetCharge.patientId, "Credit balance applied", "charge", targetChargeId, null, `${money(applied)} applied from ${poolType} credit balance (source: ${patientById[credit.patientId]?.name || credit.patientId})`);
    if (credit.patientId !== targetCharge.patientId) {
      addAudit(credit.patientId, "Credit balance used elsewhere", "credit", creditId, null, `${money(applied)} of this patient's credit balance applied to ${patientById[targetCharge.patientId]?.name || targetCharge.patientId}'s account`);
    }
  }

  // ----- Clinical charting -----
  function addVital(patientId, entry) {
    const id = uid("VIT");
    setDocument("vitals", id, { id, patientId, recordedBy: "Dr. S. Reyes", ...entry });
    addAudit(patientId, "Vitals recorded", "vital", id, null, `BP ${entry.bp}, HR ${entry.pulse}, Wt ${entry.weight}`);
  }

  function addAllergy(patientId, entry) {
    const id = uid("ALG");
    setDocument("allergies", id, { id, patientId, status: "Active", recordedBy: "Dr. S. Reyes", ...entry });
    addAudit(patientId, "Allergy recorded", "allergy", id, null, `${entry.substance} (${entry.severity})`);
  }

  function updateAllergyStatus(id, patientId, status) {
    updateDocument("allergies", id, { status });
    addAudit(patientId, "Allergy updated", "allergy", id, "Active", status);
  }

  function addMedication(patientId, entry) {
    const id = uid("MED");
    setDocument("medications", id, { id, patientId, status: "Active", ...entry });
    addAudit(patientId, "Medication added", "medication", id, null, `${entry.name} ${entry.dose}, ${entry.frequency}`);
  }

  function updateMedicationStatus(id, patientId, status) {
    const med = medications.find(m => m.id === id);
    updateDocument("medications", id, { status, endDate: status === "Active" ? med?.endDate : (med?.endDate || TODAY) });
    addAudit(patientId, "Medication updated", "medication", id, med?.status, status);
  }

  function addProblem(patientId, entry) {
    const id = uid("PRB");
    setDocument("problems", id, { id, patientId, status: "Active", ...entry });
    addAudit(patientId, "Problem added", "problem", id, null, `${entry.diagnosis} (${entry.icd10})`);
  }

  function updateProblemStatus(id, patientId, status) {
    updateDocument("problems", id, { status });
    addAudit(patientId, "Problem updated", "problem", id, "Active", status);
  }

  function addClinicalNote(patientId, entry) {
    const id = uid("NOTE");
    setDocument("clinicalNotes", id, { id, patientId, status: "Draft", amendments: [], ...entry });
    addAudit(patientId, "Note created", "note", id, null, `${entry.type}, draft`);
  }

  function signNote(id, patientId, provider) {
    updateDocument("clinicalNotes", id, { status: "Signed", signedBy: provider, signedAt: nowIso() });
    addAudit(patientId, "Note signed", "note", id, "Draft", `Signed by ${provider}`);
  }

  // Signed notes are never edited in place — an amendment is appended and the original stays intact.
  function amendNote(id, patientId, text, provider) {
    const note = clinicalNotes.find(n => n.id === id);
    updateDocument("clinicalNotes", id, { status: "Amended", amendments: [...(note?.amendments || []), { text, by: provider, at: nowIso() }] });
    addAudit(patientId, "Note amended", "note", id, null, text);
  }

  function addAppointment(a) {
    setDocument("appointments", uid("A"), { ...a, status: "Scheduled" });
    setShowAddAppt(false);
  }

  function addCharge(patientId, entry) {
    const id = uid("C");
    const batch = newBatch();
    // postedBy/postedAt/batchId are what let the Daily Transaction report attribute a charge to a
    // user and a batch. Unlike posting a payment, adding a charge does not require an open batch,
    // so batchId is legitimately null when the user has none open. Charges written before this
    // was added simply lack the fields and report as unattributed.
    const stamp = { postedBy: session.name, postedAt: nowIso(), batchId: myOpenBatch?.id || null };
    batch.set(docRef("charges", id), {
      id, patientId, paid: 0, writeoff: 0, credits: 0, memos: [], postings: [],
      chargeInsuranceId: primaryPolicyByPatient[patientId]?.id || null, payerOverride: null, referralPhysician: "",
      facilityName: PRACTICE_INFO.name, facilityAddress: PRACTICE_INFO.address, taxId: PRACTICE_INFO.taxId,
      npi: "", diagnosisCodes: emptyDxCodes(), ndc: "", units: 1, time: "",
      ...stamp,
      ...entry,
    });
    batch.set(docRef("transactions", uid("TXN")), { chargeId: id, patientId, type: "charge", amount: entry.charge, date: entry.dos, source: "", reference: "", ...stamp });
    batch.commit();
  }

  function generateClaimFromCharge(charge) {
    if (claims.some(c => c.chargeId === charge.id)) return;
    const primary = primaryPolicyByPatient[charge.patientId];
    const primaryDx = (charge.diagnosisCodes || []).find(d => d) || "";
    const id = uid("CLM-7");
    setDocument("claims", id, {
      id, patientId: charge.patientId, chargeId: charge.id,
      payer: primary ? primary.insuranceCompany : "Self-pay", cpt: charge.cpt, dx: primaryDx, amount: charge.charge, submitted: "", status: "Draft",
      npi: charge.npi || "", facilityName: charge.facilityName || PRACTICE_INFO.name, taxId: charge.taxId || PRACTICE_INFO.taxId,
      units: charge.units || 1, diagnosisCodes: charge.diagnosisCodes || emptyDxCodes(),
    });
    setTab("claims");
  }

  function submitClaim(id) {
    updateDocument("claims", id, { status: "Submitted", submitted: "2026-08-24" });
  }

  function openBillingFor(patientId) {
    setBillingPatientId(patientId);
    setTab("billing");
  }

  // Electronic remittance (835) posting: apply parsed, matched claim rows in one batch.
  function postERABatch(matchedRows, meta = {}) {
    if (!myOpenBatch) { alert("Open your batch before posting a remittance — see the batch status in the header."); return; }
    const batch = newBatch();
    matchedRows.forEach(row => {
      const target = charges.find(c => c.id === row.chargeId);
      if (!target) return;
      const room = Math.max(0, target.charge - target.paid - target.writeoff);
      const paidApplied = Math.min(room, row.paid || 0);
      const writeoffApplied = Math.min(room - paidApplied, row.writeoff || 0);
      batch.update(docRef("charges", row.chargeId), { paid: target.paid + paidApplied, writeoff: target.writeoff + writeoffApplied });
      if (paidApplied > 0) batch.set(docRef("transactions", uid("TXN")), { batchId: myOpenBatch.id, chargeId: row.chargeId, patientId: target.patientId, type: "payment", amount: paidApplied, date: TODAY, source: meta.source || "Payer ERA", reference: meta.reference || "" });
      if (writeoffApplied > 0) batch.set(docRef("transactions", uid("TXN")), { batchId: myOpenBatch.id, chargeId: row.chargeId, patientId: target.patientId, type: "writeoff", amount: writeoffApplied, date: TODAY, source: "Contractual adjustment", reference: meta.reference || "" });
    });
    claims.forEach(cl => {
      const row = matchedRows.find(r => r.claimId === cl.id);
      if (!row) return;
      batch.update(docRef("claims", cl.id), { status: row.statusLabel === "Denied" ? "Denied" : "Paid" });
    });
    batch.commit();
  }

  // ----- User account administration (SUPER_ADMIN only — also enforced by firestore.rules,
  // so this isn't the only thing standing between another role and these actions) -----
  // Real Firebase Auth accounts can't be hard-deleted from client code (that needs the Admin
  // SDK in a trusted backend), so "delete" here deactivates the account instead — same
  // never-truly-delete pattern used everywhere else in this app (ID documents, insurance
  // policies, ...). A deactivated account is blocked at login (see LoginPage's submit).
  async function addUserAccount(form) {
    const uid = await createUserAccount(form.email.trim(), form.password);
    await setDocument("users", uid, {
      email: form.email.trim(), name: form.name, role: form.role, disabled: false,
      createdBy: session.name, createdAt: nowIso(),
    });
    addAudit(null, "User account created", "user", uid, null, `${form.name} <${form.email}> as ${ROLE_LABELS[form.role] || form.role}`);
  }

  function setUserDisabled(uid, disabled) {
    const target = userAccounts.find(u => u.id === uid);
    updateDocument("users", uid, { disabled });
    addAudit(null, disabled ? "User account deactivated" : "User account reactivated", "user", uid, null, target ? `${target.name} <${target.email}>` : uid);
  }

  function changeUserRole(uid, role) {
    const target = userAccounts.find(u => u.id === uid);
    updateDocument("users", uid, { role });
    addAudit(null, "User role changed", "user", uid, target?.role || null, role);
  }

  // Setting a password never goes through the collections API - credentials live in columns the
  // document store deliberately does not expose (see the field registry in server/schema.go), so
  // both of these call dedicated endpoints. Neither the old nor the new password is ever written
  // to the audit log; only the fact that a change happened.
  async function changeMyPassword(currentPassword, newPassword) {
    await changeOwnPassword(currentPassword, newPassword);
    addAudit(null, "Password changed", "user", session.uid, null, `${session.name} changed their own password`);
  }

  async function resetUserPassword(uid, newPassword) {
    const target = userAccounts.find(u => u.id === uid);
    await adminResetPassword(uid, newPassword);
    addAudit(null, "Password reset by admin", "user", uid, null, target ? `${target.name} <${target.email}>` : uid);
  }

  // Role grants are stored one document per role. SUPER_ADMIN is not writable (the server
  // rejects it too, in writeAllowed) so the admin role cannot be edited into a corner.
  function saveRolePermissions(role, tabs, permissions = []) {
    if (role === "SUPER_ADMIN") return;
    const before = rolePermissions.find(r => r.id === role);
    setDocument("rolePermissions", role, {
      id: role, tabs, permissions, updatedBy: session.name, updatedAt: nowIso(),
    });
    // Tabs and action grants are audited as one line because they are saved as one decision;
    // splitting them would make a single click read as two unrelated changes.
    const describe = (t, p) => `tabs: ${(t || []).join(", ") || "none"} | actions: ${(p || []).join(", ") || "none"}`;
    addAudit(null, "Role permissions changed", "user", role,
      describe(before?.tabs, before?.permissions), describe(tabs, permissions));
  }

  // ----- Practice catalog: physicians + CPT codes (SUPER_ADMIN only) -----
  // Both collections are reference data every other screen reads, so a change here is felt
  // app-wide the moment it lands. The server pins physicians to SUPER_ADMIN in writeAllowed();
  // this is the matching client-side gate, not the enforcement.
  //
  // An id is minted on first save and never reused, so renaming a physician (a married name, a
  // corrected spelling) updates the row the dropdown reads without stranding the charges that
  // recorded the old name.
  function savePhysician(entry) {
    const id = entry.id || uid("PHY");
    const before = physicians.find(p => p.id === id);
    setDocument("physicians", id, { ...entry, id, active: before ? before.active !== false : true });
    addAudit(null, before ? "Physician updated" : "Physician added", "physician", id,
      before ? `${before.name} · NPI ${before.npi}` : null,
      `${entry.name} · NPI ${entry.npi}`);
  }

  // The doc id is the CPT code itself for codes seeded that way, so an edit that changes the code
  // would otherwise orphan the old row. Keep the existing id and let `code` be the editable field.
  function saveCptCode(entry) {
    const id = entry.id || entry.code;
    const before = cptCatalog.find(c => c.id === id);
    setDocument("cptCatalog", id, { ...entry, id, active: before ? before.active !== false : true });
    addAudit(null, before ? "CPT code updated" : "CPT code added", "cptCode", id,
      before ? `${before.code} · ${before.desc} · ${money(before.charge)}` : null,
      `${entry.code} · ${entry.desc} · ${money(entry.charge)}`);
  }

  // ----- Master insurance list (Settings > Insurance Management) -----
  // Writes are gated server-side on the insurance.* permissions (see server/permissions.go); the
  // buttons that call these are hidden for roles without the grant, but that is only the courtesy
  // half - the API rejects an unauthorized call regardless of what the interface showed.
  function saveInsurance(entry) {
    const id = entry.id || uid("INS");
    const before = insurances.find(i => i.id === id);
    setDocument("insurance", id, {
      ...entry, id,
      createdBy: before?.createdBy || session.name,
      createdAt: before?.createdAt || nowIso(),
      updatedBy: session.name,
      updatedAt: nowIso(),
    });
    addAudit(null, before ? "Insurance updated" : "Insurance created", "insurance", id,
      before ? `${before.name} · Payer ${before.payerId}` : null,
      `${entry.name} · Payer ${entry.payerId}`);
  }

  function setInsuranceStatus(entry, status) {
    updateDocument("insurance", entry.id, { status, updatedBy: session.name, updatedAt: nowIso() });
    addAudit(null, status === "Active" ? "Insurance reactivated" : "Insurance deactivated",
      "insurance", entry.id, entry.status || "Active", status);
  }

  // Only reachable for a row no policy references - the server re-checks that and answers 409 if
  // it is wrong, so a stale screen cannot delete an insurer that has since been used.
  async function deleteInsurance(entry) {
    try {
      await deleteDocument("insurance", entry.id);
      addAudit(null, "Insurance deleted", "insurance", entry.id, `${entry.name} · Payer ${entry.payerId}`, null);
    } catch (e) {
      alert(e?.message || "That insurance could not be deleted.");
    }
  }

  // Deactivation is the app's stand-in for deletion here — see the note in PracticeCatalog.
  function setCatalogEntryActive(collection, entry, active) {
    const isPhysician = collection === "physicians";
    updateDocument(collection, entry.id, { active });
    addAudit(null, active ? "Catalog entry reactivated" : "Catalog entry deactivated",
      isPhysician ? "physician" : "cptCode", entry.id,
      isPhysician ? entry.name : `${entry.code} ${entry.desc}`,
      active ? "Active" : "Inactive");
  }

  // ----- Batch management: one open/closed daily work-batch per user -----
  // Doc id is the user+date composite key — this IS the "one batch per user per day"
  // uniqueness rule: opening a batch for a date that already has one just reopens that same
  // document (status flips back to OPEN), it never creates a duplicate.
  function openBatch(date) {
    const batchDate = date || TODAY;
    if (myOpenBatch && myOpenBatch.batchDate !== batchDate) {
      alert(`You already have batch #${myOpenBatch.batchNumber} open for ${fmtDate(myOpenBatch.batchDate)}. Close it first before opening a different date.`);
      return;
    }
    const id = `${session.uid}_${batchDate}`;
    const existing = batches.find(b => b.id === id);
    if (existing) {
      updateDocument("batches", id, { status: "OPEN", openedAt: nowIso(), closedAt: null });
    } else {
      setDocument("batches", id, {
        id, batchNumber: uid("BATCH"), userId: session.uid, userName: session.name,
        batchDate, status: "OPEN", openedAt: nowIso(), closedAt: null,
      });
    }
    addAudit(null, "Batch opened", "batch", id, null, `${session.name} — ${batchDate}`);
  }

  function closeBatch() {
    if (!myOpenBatch) return;
    // Money entered but not yet posted would be stranded by a closed batch: the payment screens
    // reset, and nothing in the database records that a cheque was short-allocated. Refuse, and
    // say exactly how much is outstanding on which payment.
    if (unallocatedSessions.length > 0) {
      setBlockedClose(unallocatedSessions);
      return;
    }
    updateDocument("batches", myOpenBatch.id, { status: "CLOSED", closedAt: nowIso() });
    addAudit(null, "Batch closed", "batch", myOpenBatch.id, "OPEN", "CLOSED");
  }

  // ----- Ticklers (reminders) -----
  function addTickler(form) {
    const id = uid("TICK");
    setDocument("ticklers", id, {
      id, patientId: form.patientId || null, patientName: form.patientName || "",
      claimId: form.claimId || null, dos: form.dos || "", cpt: form.cpt || "",
      title: form.title, description: form.description || "",
      createdByUid: session.uid, createdByName: session.name,
      assignedToUid: form.assignedToUid || session.uid, assignedToName: form.assignedToName || session.name,
      reminderDate: form.reminderDate, reminderTime: form.reminderTime || "",
      priority: form.priority || "Normal", status: "Open",
      createdAt: nowIso(), completedAt: null,
    });
    addAudit(form.patientId || null, "Tickler created", "tickler", id, null, `${form.title} (assigned to ${form.assignedToName || session.name})`);
  }

  function updateTicklerStatus(id, status) {
    updateDocument("ticklers", id, { status, completedAt: status === "Completed" ? nowIso() : null });
  }

  function snoozeTickler(id, newDate) {
    updateDocument("ticklers", id, { status: "Snoozed", reminderDate: newDate });
  }

  // ----- Technical support tickets -----
  function addSupportTicket(form) {
    const id = uid("TCKT");
    setDocument("supportTickets", id, {
      id, subject: form.subject, description: form.description, priority: form.priority || "Normal",
      status: "Open", attachment: form.attachment || null, attachmentName: form.attachmentName || null,
      createdByUid: session.uid, createdByName: session.name, createdAt: nowIso(), notes: [],
    });
    addAudit(null, "Support ticket filed", "supportTicket", id, null, `${form.subject} (${form.priority})`);
  }

  function updateSupportTicketStatus(id, status) {
    updateDocument("supportTickets", id, { status });
    addAudit(null, "Support ticket status changed", "supportTicket", id, null, status);
  }

  if (dataLoading) {
    return <div className="min-h-[700px] flex items-center justify-center bg-slate-50 text-slate-400 text-sm font-sans">Loading…</div>;
  }

  return (
    <CptCatalogContext.Provider value={cptCatalog}>
    <PhysiciansContext.Provider value={physicians}>
    <div className="flex flex-col h-full min-h-[700px] bg-slate-50 text-slate-800 font-sans text-sm">
      <header className="bg-slate-900 text-slate-300 shrink-0">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-teal-500 flex items-center justify-center text-white">
              <Stethoscope size={18} />
            </div>
            <div>
              <div className="text-white font-semibold text-sm leading-tight">Obaid Clinic</div>
              <div className="text-xs text-slate-500">Practice manager</div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <BatchStatusWidget myOpenBatch={myOpenBatch} onOpenBatch={openBatch} onCloseBatch={closeBatch} />
            <SettingsMenu
              isAccountAdmin={isAccountAdmin}
              onOpenBatchManagement={() => setShowBatchManagement(true)}
              onOpenChangePassword={() => setShowChangePassword(true)}
              onOpenSecurity={() => setShowSecurity(true)}
              onOpenUserAdmin={() => setShowUserAdmin(true)}
              onOpenManageRoles={() => setShowManageRoles(true)}
              onOpenPracticeCatalog={() => setShowPracticeCatalog(true)}
              onOpenInsuranceAdmin={() => setShowInsuranceAdmin(true)}
              canManageInsurance={insurancePerms.any}
            />
            <div className="flex items-center gap-2 border-l border-slate-800 pl-4">
              <div className="w-7 h-7 rounded-full bg-slate-700 flex items-center justify-center text-white text-xs font-medium">
                {session.name.split(" ").map(n => n[0]).join("")}
              </div>
              <div className="text-xs">
                <div className="text-white leading-tight">{session.name}</div>
                <div className="text-slate-500 leading-tight">{ROLE_LABELS[session.role]}</div>
              </div>
              <button onClick={onLogout} className="text-xs text-slate-400 hover:text-white ml-2">Log out</button>
            </div>
          </div>
        </div>
        <nav className="flex items-center gap-1 px-3 overflow-x-auto">
          {nav.map(item => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => { setTab(item.id); if (item.id !== "billing") setBillingPatientId(null); if (item.id !== "clinical") setClinicalPatientId(null); }}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm whitespace-nowrap transition-colors border-b-2 ${
                  active ? "text-teal-400 border-teal-400" : "text-slate-300 border-transparent hover:bg-slate-800 hover:text-white"
                }`}
              >
                <Icon size={16} />
                {item.label}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        {!tabAllowed && <Forbidden onBack={() => setTab("dashboard")} />}

        {tabAllowed && tab === "dashboard" && (
          <Dashboard
            outstanding={outstanding} monthRevenue={monthRevenue} todaysAppts={todaysAppts}
            pendingClaims={pendingClaims} deniedClaims={deniedClaims} patientById={patientById}
            revenueByMonth={revenueByMonth} setTab={setTab}
          />
        )}

        {tabAllowed && tab === "schedule" && (
          <Schedule
            appointments={appointments} patientById={patientById} onAdd={() => setShowAddAppt(true)}
            onStatusChange={(id, status) => updateDocument("appointments", id, { status })}
          />
        )}

        {tabAllowed && tab === "patients" && (
          <Patients
            patients={patients} patientBalance={patientBalance} primaryPolicyByPatient={primaryPolicyByPatient}
            onAdd={() => setShowAddPatient(true)} onSelect={openBillingFor}
          />
        )}

        {tabAllowed && tab === "clinical" && !clinicalPatientId && (
          <ClinicalSearch patients={patients} allergiesByPatient={allergiesByPatient} onSelect={setClinicalPatientId} />
        )}

        {tabAllowed && tab === "clinical" && clinicalPatientId && !patientById[clinicalPatientId] && (
          <MissingPatient
            patientId={clinicalPatientId}
            onBack={() => setClinicalPatientId(null)}
          />
        )}

        {tabAllowed && tab === "clinical" && clinicalPatientId && patientById[clinicalPatientId] && (
          <ClinicalChart
            patient={patientById[clinicalPatientId]}
            vitals={vitals.filter(v => v.patientId === clinicalPatientId)}
            allergies={allergies.filter(a => a.patientId === clinicalPatientId)}
            medications={medications.filter(m => m.patientId === clinicalPatientId)}
            problems={problems.filter(p => p.patientId === clinicalPatientId)}
            notes={clinicalNotes.filter(n => n.patientId === clinicalPatientId)}
            onBack={() => setClinicalPatientId(null)}
            onAddVital={(entry) => addVital(clinicalPatientId, entry)}
            onAddAllergy={(entry) => addAllergy(clinicalPatientId, entry)}
            onUpdateAllergyStatus={(id, status) => updateAllergyStatus(id, clinicalPatientId, status)}
            onAddMedication={(entry) => addMedication(clinicalPatientId, entry)}
            onUpdateMedicationStatus={(id, status) => updateMedicationStatus(id, clinicalPatientId, status)}
            onAddProblem={(entry) => addProblem(clinicalPatientId, entry)}
            onUpdateProblemStatus={(id, status) => updateProblemStatus(id, clinicalPatientId, status)}
            onAddNote={(entry) => addClinicalNote(clinicalPatientId, entry)}
            onSignNote={(id, provider) => signNote(id, clinicalPatientId, provider)}
            onAmendNote={(id, text, provider) => amendNote(id, clinicalPatientId, text, provider)}
          />
        )}

        {tabAllowed && tab === "billing" && !billingPatientId && (
          <div>
            <div className="flex items-center gap-1 mb-5 border border-slate-200 bg-white rounded-lg p-1 w-fit">
              <button
                onClick={() => setBillingMode("search")}
                className={`px-3 py-1.5 text-sm rounded-md ${billingMode === "search" ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}
              >
                Account search
              </button>
              <button
                onClick={() => setBillingMode("post")}
                className={`px-3 py-1.5 text-sm rounded-md ${billingMode === "post" ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}
              >
                Post payments
              </button>
            </div>

            {billingMode === "search" && (
              <BillingSearch patients={patients} policies={policies} patientBalance={patientBalance} onSelect={setBillingPatientId} />
            )}
            {billingMode === "post" && (
              <PaymentPosting
                charges={charges}
                claims={claims}
                patients={patients}
                patientById={patientById}
                chargeById={chargeById}
                policies={policies}
                onPostManualLine={postManualLinePayment}
                onPostERA={postERABatch}
                onSelectChargeInsurance={selectInsuranceForCharge}
                onSetSelfPay={setSelfPayForCharge}
                onPostingSession={reportPostingSession}
                hasOpenBatch={!!myOpenBatch}
              />
            )}
          </div>
        )}

        {tabAllowed && tab === "billing" && billingPatientId && !patientById[billingPatientId] && (
          <MissingPatient
            patientId={billingPatientId}
            onBack={() => setBillingPatientId(null)}
          />
        )}

        {tabAllowed && tab === "billing" && billingPatientId && patientById[billingPatientId] && (
          <PatientBilling
            patient={patientById[billingPatientId]}
            charges={charges.filter(c => c.patientId === billingPatientId)}
            claims={claims.filter(c => c.patientId === billingPatientId)}
            policies={policies.filter(p => p.patientId === billingPatientId)}
            insurances={insurances}
            idDocuments={idDocuments.filter(d => d.patientId === billingPatientId)}
            auditLogs={auditLogs.filter(a => a.patientId === billingPatientId)}
            patientMemos={patientMemos.filter(m => m.patientId === billingPatientId)}
            appointments={appointments.filter(a => a.patientId === billingPatientId)}
            allPatients={patients}
            allCharges={charges}
            patientById={patientById}
            patientCreditBalances={patientCreditBalances}
            insuranceCreditBalances={insuranceCreditBalances}
            session={session}
            onBack={() => setBillingPatientId(null)}
            onUpdatePatient={(updates) => updatePatient(billingPatientId, updates)}
            onAddCharge={(entry) => addCharge(billingPatientId, entry)}
            onGenerateClaim={generateClaimFromCharge}
            onAddInsurance={(f) => addInsurance(billingPatientId, f)}
            onEditInsurance={editInsurance}
            onSetPriority={setPolicyPriority}
            onEndCoverage={endCoverage}
            onUploadCard={uploadInsuranceCard}
            onUploadIdDoc={(doc) => uploadIdDocument(billingPatientId, doc)}
            onDeleteIdDoc={(docId) => deleteIdDocument(billingPatientId, docId)}
            onAddPatientMemo={(text) => addPatientMemo(billingPatientId, text)}
            onAddAppointment={addAppointment}
            onPostCheck={postCheckPayment}
            onPostCard={postCreditCardPayment}
            onPostInsuranceCredit={postInsuranceCredit}
            onPostPatientCredit={postPatientCredit}
            onWriteOffDOS={writeOffDOS}
            onCreditDOS={creditDOS}
            onSelectChargeInsurance={selectInsuranceForCharge}
            onSetSelfPay={setSelfPayForCharge}
            onEditClaimFields={editClaimFields}
            onAddFollowUp={addFollowUp}
            onDebitPosting={debitPosting}
            onApplyCreditBalance={applyCreditBalance}
            hasOpenBatch={!!myOpenBatch}
            onCreateTickler={(prefill) => { setTicklerPrefill(prefill); setShowTicklerPanel(true); }}
          />
        )}

        {tabAllowed && tab === "claims" && (
          <Claims claims={claims} patientById={patientById} onSubmit={submitClaim} />
        )}

        {tabAllowed && tab === "reports" && (
          <Reports
            revenueByMonth={revenueByMonth} claimStatusData={claimStatusData} charges={charges} patientById={patientById}
            transactions={transactions} patients={patients} policies={policies}
            batches={batches} userAccounts={userAccounts} session={session} isOversight={isBillingOversightRole}
          />
        )}

      </main>

      {showAddPatient && (
        <Modal title="Register new patient" onClose={() => { setShowAddPatient(false); setDuplicateWarning(null); }} wide>
          {!duplicateWarning ? (
            <AddPatientForm onSubmit={addPatient} />
          ) : (
            <DuplicateWarning
              dupes={duplicateWarning.dupes}
              onUseExisting={(id) => { setShowAddPatient(false); setDuplicateWarning(null); openBillingFor(id); }}
              onCreateAnyway={() => addPatient({ ...duplicateWarning.form, _forceCreate: true })}
              onCancel={() => setDuplicateWarning(null)}
            />
          )}
        </Modal>
      )}
      {showAddAppt && (
        <Modal title="Schedule appointment" onClose={() => setShowAddAppt(false)}>
          <AddApptForm patients={patients} onSubmit={addAppointment} />
        </Modal>
      )}

      {showBatchManagement && (
        <Modal title="Batch Management" onClose={() => setShowBatchManagement(false)} wide>
          <BatchManagement batches={batches} session={session} isOversight={isBillingOversightRole} myOpenBatch={myOpenBatch} onOpenBatch={openBatch} onCloseBatch={closeBatch} />
        </Modal>
      )}

      {showSecurity && (
        <Modal title="Security & trusted devices" onClose={() => setShowSecurity(false)}>
          <SecuritySettings />
        </Modal>
      )}

      {blockedClose && (
        <Modal title="Batch still has money to post" onClose={() => setBlockedClose(null)}>
          <p className="text-sm text-slate-600 mb-3">
            This batch cannot be closed yet. The payment{blockedClose.length === 1 ? "" : "s"} below
            still {blockedClose.length === 1 ? "has" : "have"} an amount that has not been posted to a claim.
          </p>
          <div className="space-y-2 mb-4">
            {blockedClose.map(u => (
              <div key={u.key} className="border border-amber-200 bg-amber-50 rounded-lg px-3 py-2.5">
                <div className="text-sm font-medium text-slate-800">{u.label}</div>
                {u.reference && <div className="text-xs text-slate-500">Reference {u.reference}</div>}
                <div className="grid grid-cols-3 gap-2 mt-1.5 text-xs">
                  <div><span className="text-slate-400 block">Payment</span>{money(u.total)}</div>
                  <div><span className="text-slate-400 block">Posted</span>{money(u.allocated)}</div>
                  <div><span className="text-slate-400 block">Left to post</span>
                    <span className="font-semibold text-amber-700">{money(u.remaining)}</span></div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500 mb-4">
            Post the remaining amount against a claim, or clear the payment amount if it was entered in
            error. Closing the batch now would leave that money unrecorded.
          </p>
          <button onClick={() => setBlockedClose(null)} className="w-full bg-slate-800 text-white text-sm font-medium py-2 rounded-lg hover:bg-slate-900">
            Go back and finish posting
          </button>
        </Modal>
      )}

      {showChangePassword && (
        <Modal title="Change password" onClose={() => setShowChangePassword(false)}>
          <ChangePasswordForm onSubmit={changeMyPassword} onDone={() => setShowChangePassword(false)} />
        </Modal>
      )}

      {showUserAdmin && isAccountAdmin && (
        <Modal title="User accounts" onClose={() => setShowUserAdmin(false)} wide>
          <UserManagement
            users={userAccounts} auditLogs={auditLogs} session={session}
            onAddUser={addUserAccount} onSetDisabled={setUserDisabled} onChangeRole={changeUserRole}
            onResetPassword={resetUserPassword}
          />
        </Modal>
      )}

      {showManageRoles && isAccountAdmin && (
        <Modal title="Manage roles" onClose={() => setShowManageRoles(false)} wide>
          <ManageRoles
            rolePermissions={rolePermissions} users={userAccounts} navItems={allNav}
            onSave={saveRolePermissions}
          />
        </Modal>
      )}

      {showInsuranceAdmin && insurancePerms.any && (
        <Modal title="Insurance Management" onClose={() => setShowInsuranceAdmin(false)} size="max-w-5xl">
          <InsuranceManagement
            insurances={insurances} policies={policies} perms={insurancePerms}
            onSave={saveInsurance} onSetStatus={setInsuranceStatus} onDelete={deleteInsurance}
          />
        </Modal>
      )}

      {showPracticeCatalog && isAccountAdmin && (
        <Modal title="Practice catalog" onClose={() => setShowPracticeCatalog(false)} size="max-w-4xl">
          <PracticeCatalog
            physicians={physicians} cptCatalog={cptCatalog}
            charges={charges} appointments={appointments}
            onSavePhysician={savePhysician} onSaveCpt={saveCptCode} onSetActive={setCatalogEntryActive}
          />
        </Modal>
      )}

      {/* Floating Support / Tickler launchers — persist across every tab */}
      <div className="fixed bottom-5 right-5 flex flex-col items-end gap-3 z-40">
        <button onClick={() => setShowTicklerPanel(true)} title="Ticklers / reminders" className="w-12 h-12 rounded-full bg-amber-500 text-white shadow-lg flex items-center justify-center hover:bg-amber-600 relative">
          <Bell size={20} />
          {ticklerBadgeCount > 0 && <span className="absolute -top-1 -right-1 bg-rose-600 text-white text-[10px] font-semibold rounded-full w-5 h-5 flex items-center justify-center">{ticklerBadgeCount}</span>}
        </button>
        <button onClick={() => setShowSupportPanel(true)} title="Technical support" className="w-12 h-12 rounded-full bg-slate-700 text-white shadow-lg flex items-center justify-center hover:bg-slate-800">
          <Wrench size={19} />
        </button>
      </div>

      {showSupportPanel && (
        <Modal title="Technical Support" onClose={() => setShowSupportPanel(false)} wide>
          <SupportPanel
            tickets={supportTickets} session={session} isOversight={isBillingOversightRole}
            onAddTicket={addSupportTicket} onSetStatus={updateSupportTicketStatus}
          />
        </Modal>
      )}

      {showTicklerPanel && (
        <Modal title="Ticklers" onClose={() => { setShowTicklerPanel(false); setTicklerPrefill(null); }} wide>
          <TicklerPanel
            ticklers={ticklers} session={session} users={userAccounts} patients={patients} prefill={ticklerPrefill}
            onAddTickler={(form) => { addTickler(form); setTicklerPrefill(null); }}
            onSetStatus={updateTicklerStatus} onSnooze={snoozeTickler}
          />
        </Modal>
      )}
    </div>
    </PhysiciansContext.Provider>
    </CptCatalogContext.Provider>
  );
}

// ---------- Header: batch status widget + Settings menu ----------

function BatchStatusWidget({ myOpenBatch, onOpenBatch, onCloseBatch }) {
  const [show, setShow] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [pickedDate, setPickedDate] = useState(TODAY);

  return (
    <div className="relative">
      <button
        onClick={() => setShow(s => !s)}
        className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border ${myOpenBatch ? "border-emerald-700 bg-emerald-900/30 text-emerald-300" : "border-amber-700 bg-amber-900/30 text-amber-300"}`}
      >
        <Landmark size={13} />
        {myOpenBatch ? `Batch #${myOpenBatch.batchNumber} · ${fmtDate(myOpenBatch.batchDate)}` : "No batch open"}
      </button>
      {show && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-white border border-slate-200 rounded-xl shadow-xl p-3 z-50 text-slate-700">
          {myOpenBatch ? (
            <>
              <div className="text-xs text-slate-400 mb-1">Current batch</div>
              <div className="text-sm font-medium mb-1">#{myOpenBatch.batchNumber} — {fmtDate(myOpenBatch.batchDate)}</div>
              <div className="text-xs text-slate-500 mb-3">Opened {fmtDateTime(myOpenBatch.openedAt)}</div>
              <button onClick={() => { onCloseBatch(); setShow(false); }} className="w-full bg-rose-600 text-white text-xs font-medium py-1.5 rounded-lg hover:bg-rose-700">Close batch</button>
            </>
          ) : showDatePicker ? (
            <>
              <div className="text-xs text-slate-400 mb-2">Open a previous date's batch</div>
              <input type="date" className={inputCls} value={pickedDate} onChange={(e) => setPickedDate(e.target.value)} max={TODAY} />
              <div className="flex gap-2 mt-2">
                <button onClick={() => setShowDatePicker(false)} className="flex-1 border border-slate-200 text-xs py-1.5 rounded-lg hover:bg-slate-50">Cancel</button>
                <button onClick={() => { onOpenBatch(pickedDate); setShow(false); setShowDatePicker(false); }} className="flex-1 bg-teal-600 text-white text-xs font-medium py-1.5 rounded-lg hover:bg-teal-700">Open</button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-slate-500 mb-3">No batch is open. Payments and adjustments can't be posted until you open one.</p>
              <button onClick={() => { onOpenBatch(TODAY); setShow(false); }} className="w-full bg-teal-600 text-white text-xs font-medium py-1.5 rounded-lg hover:bg-teal-700 mb-2">Open today's batch</button>
              <button onClick={() => setShowDatePicker(true)} className="w-full border border-slate-200 text-slate-600 text-xs py-1.5 rounded-lg hover:bg-slate-50">Open a different date…</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// The gear menu is the app's admin surface: everyone gets batch management and their own
// password; a Super Admin additionally gets the two account screens, which is why User accounts
// no longer sits in the top nav.
function SettingsMenu({ isAccountAdmin, onOpenBatchManagement, onOpenChangePassword, onOpenSecurity, onOpenUserAdmin, onOpenManageRoles, onOpenPracticeCatalog, onOpenInsuranceAdmin, canManageInsurance }) {
  const [open, setOpen] = useState(false);
  const itemCls = "w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 flex items-center gap-2";
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)} title="Settings" className="hidden md:flex items-center gap-2 text-xs text-slate-500 hover:text-white p-1">
        <Settings size={14} />
      </button>
      {open && (
        <div onMouseLeave={() => setOpen(false)} className="absolute right-0 top-full mt-2 w-56 bg-white border border-slate-200 rounded-xl shadow-xl py-1.5 z-50 text-slate-700">
          <button onClick={() => { onOpenBatchManagement(); setOpen(false); }} className={itemCls}><Landmark size={13} /> Batch Management</button>
          <button onClick={() => { onOpenChangePassword(); setOpen(false); }} className={itemCls}><KeyRound size={13} /> Change password…</button>
          <button onClick={() => { onOpenSecurity(); setOpen(false); }} className={itemCls}><ShieldCheck size={13} /> Security &amp; trusted devices</button>
          {(isAccountAdmin || canManageInsurance) && (
            <div className="border-t border-slate-100 mt-1.5 pt-1.5 px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">Administration</div>
          )}
          {canManageInsurance && (
            <button onClick={() => { onOpenInsuranceAdmin(); setOpen(false); }} className={itemCls}><Shield size={13} /> Insurance Management</button>
          )}
          {isAccountAdmin && (
            <>
              <button onClick={() => { onOpenUserAdmin(); setOpen(false); }} className={itemCls}><UserCog size={13} /> User accounts</button>
              <button onClick={() => { onOpenManageRoles(); setOpen(false); }} className={itemCls}><ShieldCheck size={13} /> Manage roles</button>
              <button onClick={() => { onOpenPracticeCatalog(); setOpen(false); }} className={itemCls}><Stethoscope size={13} /> Practice catalog</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Settings: Security / Trusted Devices ----------
//
// Shows only what the browser can actually tell us: the User-Agent it sent, when the device was
// last used, and when its trust expires. No hardware model, no location, no "device fingerprint" -
// presenting a guess would invite people to make a security decision on a value we cannot stand
// behind.

function SecuritySettings() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [confirmAll, setConfirmAll] = useState(false);

  async function load() {
    try {
      const next = await securityStatus();
      setStatus(next);
      setError("");
    } catch (e) {
      setError(e?.message || "Could not load your security settings.");
    }
  }

  useEffect(() => {
    // Guarded so a close-then-reopen in flight cannot write into an unmounted component.
    let live = true;
    securityStatus()
      .then((next) => live && setStatus(next))
      .catch((e) => live && setError(e?.message || "Could not load your security settings."));
    return () => { live = false; };
  }, []);

  async function revokeOne(id) {
    setBusy(id);
    try {
      await revokeTrustedDevice(id);
      const devices = await listTrustedDevices();
      setStatus((s) => ({ ...s, trustedDevices: devices }));
    } catch (e) {
      setError(e?.message || "Could not revoke that device.");
    }
    setBusy("");
  }

  async function revokeEverything() {
    setBusy("all");
    try {
      await revokeAllTrustedDevices();
      await load();
      setConfirmAll(false);
    } catch (e) {
      setError(e?.message || "Could not revoke your trusted devices.");
    }
    setBusy("");
  }

  if (!status) {
    return <Card className="p-4"><p className="text-sm text-slate-400">{error || "Loading…"}</p></Card>;
  }

  const devices = status.trustedDevices || [];

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <SectionTitle>Two-step verification</SectionTitle>
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm">
              <ShieldCheck size={15} className={status.enabled ? "text-emerald-600" : "text-slate-400"} />
              <span className={status.enabled ? "text-emerald-700 font-medium" : "text-slate-500"}>
                {status.enabled ? "On — authenticator app" : "Not set up"}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {status.enforced
                ? "Required for every account in this practice."
                : "Optional for your account."}
            </p>
          </div>
          {status.enabled && (
            <div className="text-right">
              <div className="text-xs text-slate-400">Backup codes left</div>
              <div className={`text-lg font-semibold ${status.backupCodesLeft <= 2 ? "text-amber-600" : "text-slate-700"}`}>
                {status.backupCodesLeft}
              </div>
            </div>
          )}
        </div>
        {status.enabled && status.backupCodesLeft <= 2 && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 mt-2">
            You are running low on backup codes. If you lose your phone with none left, an administrator
            will have to reset your account.
          </p>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-1">
          <SectionTitle>Trusted devices</SectionTitle>
          {devices.length > 0 && (
            <button onClick={() => setConfirmAll(true)} className="text-xs text-rose-600 border border-rose-200 bg-rose-50 rounded-lg px-2.5 py-1.5 hover:bg-rose-100">
              Revoke all
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500 mb-3">
          Browsers that can sign in without an authenticator code, for up to {status.trustedDeviceDays} days.
        </p>

        {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}

        <div className="space-y-2">
          {devices.map((d) => (
            <div key={d.id} className="flex items-center justify-between border border-slate-200 rounded-lg px-3 py-2.5">
              <div>
                <div className="text-sm text-slate-700 flex items-center gap-2">
                  {d.label || "Unknown browser"}
                  {d.current && <span className="text-[10px] bg-teal-50 text-teal-700 border border-teal-200 rounded-full px-1.5 py-0.5">This device</span>}
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  Last used {d.lastUsedAt ? fmtDateTime(d.lastUsedAt.slice(0, 16).replace("T", " ")) : "never"}
                  {" · "}Trusted until {fmtDate(d.expiresAt.slice(0, 10))}
                </div>
              </div>
              <button
                onClick={() => revokeOne(d.id)}
                disabled={busy === d.id}
                className="text-xs text-slate-600 border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-50 disabled:opacity-50"
              >
                {busy === d.id ? "Revoking…" : "Revoke"}
              </button>
            </div>
          ))}
          {devices.length === 0 && (
            <p className="text-sm text-slate-400">
              No trusted devices. Every sign-in asks for an authenticator code.
            </p>
          )}
        </div>
      </Card>

      {confirmAll && (
        <Modal title="Revoke all trusted devices?" onClose={() => setConfirmAll(false)}>
          <p className="text-sm text-slate-600 mb-1">
            All devices will be required to complete verification again — including this one.
          </p>
          <p className="text-xs text-slate-400 mb-4">
            You will stay signed in now, but your next sign-in here will ask for a code.
          </p>
          <div className="flex gap-2">
            <button onClick={() => setConfirmAll(false)} className="flex-1 border border-slate-200 text-slate-600 text-sm py-2 rounded-lg hover:bg-slate-50">Cancel</button>
            <button onClick={revokeEverything} disabled={busy === "all"} className="flex-1 bg-rose-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-rose-700 disabled:opacity-50">
              {busy === "all" ? "Revoking…" : "Revoke all"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------- Settings: Batch Management ----------

function BatchManagement({ batches, session, isOversight, myOpenBatch, onOpenBatch, onCloseBatch }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("");

  const visible = isOversight ? batches : batches.filter(b => b.userId === session.uid);
  const filtered = visible.filter(b => {
    if (statusFilter && b.status !== statusFilter) return false;
    if (dateFilter && b.batchDate !== dateFilter) return false;
    if (search && !`${b.batchNumber} ${b.userName}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }).sort((a, b) => b.batchDate.localeCompare(a.batchDate) || (b.openedAt || "").localeCompare(a.openedAt || ""));

  return (
    <div>
      <SectionTitle>Your current batch</SectionTitle>
      {myOpenBatch ? (
        <div className="grid grid-cols-2 gap-y-2 text-sm bg-slate-50 border border-slate-200 rounded-lg p-3 mb-4">
          <div><span className="text-slate-400 text-xs block">Batch number</span>#{myOpenBatch.batchNumber}</div>
          <div><span className="text-slate-400 text-xs block">Date</span>{fmtDate(myOpenBatch.batchDate)}</div>
          <div><span className="text-slate-400 text-xs block">Status</span><StatusPill status="Active" /></div>
          <div><span className="text-slate-400 text-xs block">Opened by</span>{myOpenBatch.userName}</div>
          <div><span className="text-slate-400 text-xs block">Opened</span>{fmtDateTime(myOpenBatch.openedAt)}</div>
          <div className="flex items-end"><button onClick={onCloseBatch} className="text-xs text-rose-600 border border-rose-200 bg-rose-50 rounded-lg px-2.5 py-1 hover:bg-rose-100">Close batch</button></div>
        </div>
      ) : (
        <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 text-sm">
          <span className="text-amber-800">No batch currently open.</span>
          <button onClick={() => onOpenBatch(TODAY)} className="text-xs bg-teal-600 text-white px-2.5 py-1.5 rounded-lg hover:bg-teal-700">Open today's batch</button>
        </div>
      )}

      <SectionTitle>Batch history{!isOversight && " (yours)"}</SectionTitle>
      <div className="grid grid-cols-4 gap-2 mb-3">
        <input className={inputCls} placeholder="Search batch # or user" value={search} onChange={(e) => setSearch(e.target.value)} />
        <input type="date" className={inputCls} value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} />
        <select className={inputCls} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">Any status</option>
          <option value="OPEN">Open</option>
          <option value="CLOSED">Closed</option>
        </select>
        <button onClick={() => { setSearch(""); setDateFilter(""); setStatusFilter(""); }} className="text-xs text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50">Clear filters</button>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5 font-medium">Batch #</th>
              <th className="px-4 py-2.5 font-medium">Date</th>
              <th className="px-4 py-2.5 font-medium">User</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Opened</th>
              <th className="px-4 py-2.5 font-medium">Closed</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(b => (
              <tr key={b.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2.5 font-medium text-slate-800">#{b.batchNumber}</td>
                <td className="px-4 py-2.5 text-slate-600">{fmtDate(b.batchDate)}</td>
                <td className="px-4 py-2.5 text-slate-600">{b.userName}</td>
                <td className="px-4 py-2.5"><StatusPill status={b.status === "OPEN" ? "Active" : "Terminated"} /></td>
                <td className="px-4 py-2.5 text-slate-500 text-xs">{fmtDateTime(b.openedAt) || "—"}</td>
                <td className="px-4 py-2.5 text-slate-500 text-xs">{fmtDateTime(b.closedAt) || "—"}</td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">No batches match.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ---------- Floating: Technical Support ----------

const MAX_ATTACHMENT_BYTES = 2048 * 1024; // Firestore's 1 MiB document cap, same reasoning as ID documents
const ticketPriorities = ["Low", "Normal", "High", "Urgent"];
const ticketStatuses = ["Open", "In Progress", "Resolved", "Closed"];

function SupportPanel({ tickets, session, isOversight, onAddTicket, onSetStatus }) {
  const [mode, setMode] = useState("new");
  const mine = tickets.filter(t => t.createdByUid === session.uid).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const all = [...tickets].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  return (
    <div>
      <div className="flex items-center gap-1 mb-4 border border-slate-200 bg-white rounded-lg p-1 w-fit">
        <button onClick={() => setMode("new")} className={`px-3 py-1.5 text-sm rounded-md ${mode === "new" ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}>New ticket</button>
        <button onClick={() => setMode("mine")} className={`px-3 py-1.5 text-sm rounded-md ${mode === "mine" ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}>My tickets{mine.length > 0 ? ` (${mine.length})` : ""}</button>
        {isOversight && <button onClick={() => setMode("all")} className={`px-3 py-1.5 text-sm rounded-md ${mode === "all" ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}>All tickets ({all.length})</button>}
      </div>

      {mode === "new" && <NewTicketForm onSubmit={(form) => { onAddTicket(form); setMode("mine"); }} />}
      {mode === "mine" && <TicketList tickets={mine} canManage={false} onSetStatus={onSetStatus} />}
      {mode === "all" && isOversight && <TicketList tickets={all} canManage onSetStatus={onSetStatus} />}
    </div>
  );
}

function NewTicketForm({ onSubmit }) {
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("Normal");
  const [attachment, setAttachment] = useState(null);
  const [attachmentName, setAttachmentName] = useState("");
  const [attachmentSize, setAttachmentSize] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!subject.trim()) { setError("Subject is required."); return; }
    if (!description.trim()) { setError("Describe the problem."); return; }
    if (attachmentSize > MAX_ATTACHMENT_BYTES) { setError(`Attachment is too large — keep it under ${formatFileSize(MAX_ATTACHMENT_BYTES)}.`); return; }
    setError("");
    setSaving(true);
    await onSubmit({ subject, description, priority, attachment, attachmentName });
    setSaving(false);
  }

  return (
    <div>
      <Field label="Subject"><input className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Short summary of the problem" /></Field>
      <Field label="Describe the problem"><textarea className={`${inputCls} h-28 resize-none`} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label="Priority">
        <select className={inputCls} value={priority} onChange={(e) => setPriority(e.target.value)}>{ticketPriorities.map(p => <option key={p}>{p}</option>)}</select>
      </Field>
      <FileDrop
        label="Attach a screenshot (optional)"
        value={attachment}
        onChange={(dataUrl, file) => { setAttachment(dataUrl); setAttachmentName(file?.name || ""); setAttachmentSize(file ? file.size : null); }}
      />
      <p className="text-xs text-slate-400 mb-3">Keep attachments under {formatFileSize(MAX_ATTACHMENT_BYTES)}.</p>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} disabled={saving} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700 disabled:opacity-60">{saving ? "Submitting…" : "Submit ticket"}</button>
    </div>
  );
}

function TicketList({ tickets, canManage, onSetStatus }) {
  return (
    <div className="space-y-2 max-h-[26rem] overflow-y-auto">
      {tickets.map(t => (
        <Card key={t.id} className="p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="font-medium text-slate-800 truncate">{t.subject}</span>
                <StatusPill status={t.priority === "Urgent" || t.priority === "High" ? "Severe" : t.priority === "Low" ? "Mild" : "Moderate"} />
              </div>
              <p className="text-xs text-slate-500 mb-1">{t.description}</p>
              <div className="text-xs text-slate-400">{t.createdByName} · {fmtDateTime(t.createdAt)}</div>
              {t.attachment && (
                <button onClick={() => openIdDocumentViewerWindow({ id: t.id, file: t.attachment, fileType: t.attachmentName?.endsWith(".pdf") ? "application/pdf" : "image" })} className="mt-1.5 flex items-center gap-1 text-xs text-teal-700 hover:underline">
                  <Paperclip size={11} /> {t.attachmentName || "Attachment"}
                </button>
              )}
            </div>
            <div className="text-right shrink-0">
              {canManage ? (
                <select className="text-xs border border-slate-300 rounded-lg px-2 py-1" value={t.status} onChange={(e) => onSetStatus(t.id, e.target.value)}>
                  {ticketStatuses.map(s => <option key={s}>{s}</option>)}
                </select>
              ) : (
                <StatusPill status={t.status === "Resolved" || t.status === "Closed" ? "Completed" : t.status === "In Progress" ? "Amended" : "Open"} />
              )}
            </div>
          </div>
        </Card>
      ))}
      {tickets.length === 0 && <p className="text-center text-slate-400 text-sm py-6">No tickets here.</p>}
    </div>
  );
}

// ---------- Floating: Ticklers ----------

const ticklerPriorities = ["Low", "Normal", "High", "Urgent"];

function TicklerPanel({ ticklers, session, users, patients, prefill, onAddTickler, onSetStatus, onSnooze }) {
  // TicklerPanel is only ever mounted fresh (see the {showTicklerPanel && <Modal>...} guard at
  // the call site) — no effect needed to react to a later prefill change, there isn't one.
  const [tab, setTab] = useState(prefill ? "new" : "mine");

  const mine = ticklers.filter(t => t.createdByUid === session.uid || t.assignedToUid === session.uid);
  const assignedToMe = ticklers.filter(t => t.assignedToUid === session.uid);
  const createdByMe = ticklers.filter(t => t.createdByUid === session.uid);
  const relevant = mine;
  const dueToday = relevant.filter(t => t.status === "Open" && t.reminderDate === TODAY);
  const upcoming = relevant.filter(t => t.status === "Open" && t.reminderDate > TODAY);
  const overdue = relevant.filter(t => t.status === "Open" && t.reminderDate < TODAY);
  const completed = relevant.filter(t => t.status === "Completed");

  const tabs = [
    { id: "new", label: "New" },
    { id: "mine", label: `My Ticklers (${mine.length})` },
    { id: "assigned", label: `Assigned to Me (${assignedToMe.length})` },
    { id: "created", label: `Created by Me (${createdByMe.length})` },
    { id: "today", label: `Due Today (${dueToday.length})` },
    { id: "upcoming", label: `Upcoming (${upcoming.length})` },
    { id: "overdue", label: `Overdue (${overdue.length})` },
    { id: "completed", label: `Completed (${completed.length})` },
  ];
  const listByTab = { mine, assigned: assignedToMe, created: createdByMe, today: dueToday, upcoming, overdue, completed };

  return (
    <div>
      <div className="flex items-center gap-1 mb-4 border border-slate-200 bg-white rounded-lg p-1 w-fit flex-wrap">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-2.5 py-1.5 text-xs rounded-md whitespace-nowrap ${tab === t.id ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}>{t.label}</button>
        ))}
      </div>

      {tab === "new" ? (
        <NewTicklerForm users={users} patients={patients} session={session} prefill={prefill} onSubmit={(form) => { onAddTickler(form); setTab("mine"); }} />
      ) : (
        <TicklerList ticklers={listByTab[tab] || []} onSetStatus={onSetStatus} onSnooze={onSnooze} />
      )}
    </div>
  );
}

function NewTicklerForm({ users, patients, session, prefill, onSubmit }) {
  const [form, setForm] = useState({
    patientId: prefill?.patientId || "", patientName: prefill?.patientName || "",
    claimId: prefill?.claimId || "", dos: prefill?.dos || "", cpt: prefill?.cpt || "",
    title: prefill?.title || "", description: "", assignedToUid: session.uid, assignedToName: session.name,
    reminderDate: TODAY, reminderTime: "", priority: "Normal",
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const [error, setError] = useState("");

  function setPatient(patientId) {
    const p = patients.find(x => x.id === patientId);
    setForm({ ...form, patientId, patientName: p?.name || "" });
  }
  function setAssignee(uid) {
    const u = users.find(x => x.id === uid);
    setForm({ ...form, assignedToUid: uid, assignedToName: u?.name || session.name });
  }

  function submit() {
    if (!form.title.trim()) { setError("Title is required."); return; }
    if (!form.reminderDate) { setError("Reminder date is required."); return; }
    setError("");
    onSubmit(form);
  }

  return (
    <div>
      {prefill && (
        <p className="text-xs text-teal-700 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2 mb-3">
          Linked to {prefill.patientName} — {fmtDate(prefill.dos)} · {prefill.cpt}
        </p>
      )}
      <Field label="Title"><input className={inputCls} value={form.title} onChange={set("title")} placeholder="e.g. Follow up with insurance" /></Field>
      <Field label="Description"><textarea className={`${inputCls} h-20 resize-none`} value={form.description} onChange={set("description")} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Patient (optional)">
          <select className={inputCls} value={form.patientId} onChange={(e) => setPatient(e.target.value)}>
            <option value="">No patient</option>
            {patients.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="CPT code (optional)"><input className={inputCls} value={form.cpt} onChange={set("cpt")} placeholder="e.g. 99213" /></Field>
        <Field label="Date of service (optional)"><input type="date" className={inputCls} value={form.dos} onChange={set("dos")} /></Field>
        <Field label="Claim ID (optional)"><input className={inputCls} value={form.claimId} onChange={set("claimId")} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Assigned to">
          <select className={inputCls} value={form.assignedToUid} onChange={(e) => setAssignee(e.target.value)}>
            <option value={session.uid}>Myself ({session.name})</option>
            {users.filter(u => u.id !== session.uid).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select className={inputCls} value={form.priority} onChange={set("priority")}>{ticklerPriorities.map(p => <option key={p}>{p}</option>)}</select>
        </Field>
        <Field label="Reminder date"><input type="date" className={inputCls} value={form.reminderDate} onChange={set("reminderDate")} /></Field>
        <Field label="Reminder time (optional)"><input type="time" className={inputCls} value={form.reminderTime} onChange={set("reminderTime")} /></Field>
      </div>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Create tickler</button>
    </div>
  );
}

function TicklerList({ ticklers, onSetStatus, onSnooze }) {
  const [snoozing, setSnoozing] = useState(null);
  const [snoozeDate, setSnoozeDate] = useState(TODAY);
  const sorted = [...ticklers].sort((a, b) => (a.reminderDate || "").localeCompare(b.reminderDate || ""));

  return (
    <div className="space-y-2 max-h-[26rem] overflow-y-auto">
      {sorted.map(t => {
        const overdue = t.status === "Open" && t.reminderDate < TODAY;
        const urgent = t.priority === "Urgent" || t.priority === "High";
        return (
          <Card key={t.id} className={`p-3 ${overdue ? "border-rose-300 bg-rose-50/60" : urgent ? "border-amber-300 bg-amber-50/50" : ""}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                  <span className="font-medium text-slate-800">{t.title}</span>
                  <StatusPill status={urgent ? "Severe" : t.priority === "Low" ? "Mild" : "Moderate"} />
                  {overdue && <StatusPill status="Denied" />}
                </div>
                {t.patientName && <div className="text-xs text-slate-500">{t.patientName}{t.cpt ? ` · CPT ${t.cpt}` : ""}{t.dos ? ` · DOS ${fmtDate(t.dos)}` : ""}</div>}
                {t.description && <p className="text-xs text-slate-500 mt-0.5">{t.description}</p>}
                <div className="text-xs text-slate-400 mt-1">Due {fmtDate(t.reminderDate)}{t.reminderTime ? ` ${t.reminderTime}` : ""} · assigned to {t.assignedToName} · by {t.createdByName}</div>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <StatusPill status={t.status === "Completed" ? "Completed" : t.status === "Snoozed" ? "Amended" : t.status === "Cancelled" ? "Discontinued" : "Open"} />
                {t.status === "Open" && (
                  <div className="flex gap-1 mt-1">
                    <button onClick={() => onSetStatus(t.id, "Completed")} className="text-[11px] text-emerald-700 border border-emerald-200 bg-emerald-50 rounded-md px-1.5 py-0.5 hover:bg-emerald-100">Complete</button>
                    <button onClick={() => setSnoozing(snoozing === t.id ? null : t.id)} className="text-[11px] text-slate-500 border border-slate-200 rounded-md px-1.5 py-0.5 hover:bg-slate-50">Snooze</button>
                    <button onClick={() => onSetStatus(t.id, "Cancelled")} className="text-[11px] text-rose-500 border border-rose-200 rounded-md px-1.5 py-0.5 hover:bg-rose-50">Cancel</button>
                  </div>
                )}
              </div>
            </div>
            {snoozing === t.id && (
              <div className="flex items-center gap-2 mt-2 pt-2 border-t border-slate-100">
                <input type="date" className="text-xs border border-slate-300 rounded-lg px-2 py-1" value={snoozeDate} onChange={(e) => setSnoozeDate(e.target.value)} />
                <button onClick={() => { onSnooze(t.id, snoozeDate); setSnoozing(null); }} className="text-xs bg-slate-700 text-white px-2 py-1 rounded-lg hover:bg-slate-800">Snooze to this date</button>
              </div>
            )}
          </Card>
        );
      })}
      {sorted.length === 0 && <p className="text-center text-slate-400 text-sm py-6">Nothing here.</p>}
    </div>
  );
}

// ---------- Dashboard ----------

function Dashboard({ outstanding, monthRevenue, todaysAppts, pendingClaims, deniedClaims, patientById, revenueByMonth, setTab }) {
  const stats = [
    { label: "Collected this month", value: money(monthRevenue), icon: DollarSign, tone: "text-teal-600 bg-teal-50" },
    { label: "Outstanding balance", value: money(outstanding), icon: AlertCircle, tone: "text-rose-600 bg-rose-50" },
    { label: "Appointments today", value: todaysAppts.length, icon: CalendarDays, tone: "text-sky-600 bg-sky-50" },
    { label: "Claims pending", value: pendingClaims, icon: Clock, tone: "text-amber-600 bg-amber-50" },
  ];
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Dashboard</h1>
          <p className="text-slate-500 text-sm">{weekdayOf(TODAY) + ", " + fmtDate(TODAY)}</p>
        </div>
        {deniedClaims > 0 && (
          <button onClick={() => setTab("claims")} className="flex items-center gap-2 text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-1.5">
            <AlertCircle size={15} /> {deniedClaims} denied claim{deniedClaims > 1 ? "s" : ""} need review
          </button>
        )}
      </div>
      <div className="grid grid-cols-4 gap-4 mb-6">
        {stats.map((s, i) => {
          const Icon = s.icon;
          return (
            <Card key={i} className="p-4">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-3 ${s.tone}`}><Icon size={16} /></div>
              <div className="text-xl font-semibold text-slate-800">{s.value}</div>
              <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
            </Card>
          );
        })}
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Card className="p-4 col-span-2">
          <h3 className="font-medium text-slate-700 mb-3">Revenue, last 6 months</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={revenueByMonth}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 12 }} stroke="#94a3b8" />
              <YAxis tick={{ fontSize: 12 }} stroke="#94a3b8" />
              <Tooltip formatter={(v) => money(v)} />
              <Bar dataKey="revenue" fill="#0d9488" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card className="p-4">
          <h3 className="font-medium text-slate-700 mb-3">Today's schedule</h3>
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {todaysAppts.map(a => (
              <div key={a.id} className="flex items-center justify-between text-sm border-b border-slate-100 pb-2">
                <div>
                  <div className="font-medium text-slate-700">{patientById[a.patientId]?.name}</div>
                  <div className="text-xs text-slate-500">{a.time} · {a.provider}</div>
                </div>
                <StatusPill status={a.status} />
              </div>
            ))}
            {todaysAppts.length === 0 && <p className="text-slate-400 text-sm">No appointments today.</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---------- Schedule ----------

function Schedule({ appointments, patientById, onAdd, onStatusChange }) {
  const dates = [...new Set(appointments.map(a => a.date))].sort();
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-slate-800">Schedule</h1>
        <button onClick={onAdd} className="flex items-center gap-1.5 bg-teal-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-teal-700">
          <Plus size={15} /> New appointment
        </button>
      </div>
      {dates.map(date => (
        <div key={date} className="mb-6">
          <h3 className="text-sm font-medium text-slate-500 mb-2">{weekdayOf(date) + ", " + fmtDate(date)}</h3>
          <Card>
            {appointments.filter(a => a.date === date).sort((a, b) => a.time.localeCompare(b.time)).map((a, idx, arr) => (
              <div key={a.id} className={`flex items-center justify-between px-4 py-3 ${idx !== arr.length - 1 ? "border-b border-slate-100" : ""}`}>
                <div className="flex items-center gap-4">
                  <div className="text-sm font-medium text-slate-700 w-14">{a.time}</div>
                  <div>
                    <div className="text-sm font-medium text-slate-800">{patientById[a.patientId]?.name}</div>
                    <div className="text-xs text-slate-500">{a.type} · {a.provider} · CPT {a.cpt}</div>
                  </div>
                </div>
                <select value={a.status} onChange={(e) => onStatusChange(a.id, e.target.value)} className="text-xs border border-slate-200 rounded-lg px-2 py-1 bg-white">
                  <option>Scheduled</option><option>In progress</option><option>Checked out</option><option>No-show</option>
                </select>
              </div>
            ))}
          </Card>
        </div>
      ))}
    </div>
  );
}

// ---------- Patients ----------

// Shown in place of a result table until someone actually searches. These lists open onto the
// whole patient population, and putting every record on screen by default is both slow to read
// and a quiet invitation to browse charts nobody asked you to look at - so the list starts empty
// and the search box is the way in.
function SearchFirstPrompt({ icon: Icon, total, noun, hint }) {
  return (
    <Card className="py-12 text-center">
      <Icon size={28} className="mx-auto text-slate-300 mb-3" />
      <p className="text-sm text-slate-500">{hint}</p>
      <p className="text-xs text-slate-400 mt-1">{total.toLocaleString()} {total === 1 ? noun.one : noun.many} on file.</p>
    </Card>
  );
}

function Patients({ patients, patientBalance, primaryPolicyByPatient, onAdd, onSelect }) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const filtered = query
    ? patients.filter(p => p.name.toLowerCase().includes(query) || p.id.toLowerCase().includes(query))
    : [];
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-slate-800">Patients</h1>
        <button onClick={onAdd} className="flex items-center gap-1.5 bg-teal-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-teal-700">
          <Plus size={15} /> Add patient
        </button>
      </div>
      <div className="relative mb-4 max-w-sm">
        <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or ID" className={`${inputCls} pl-9`} />
      </div>
      {!query ? (
        <SearchFirstPrompt
          icon={Search}
          total={patients.length}
          noun={{ one: "patient", many: "patients" }}
          hint="Search by name or patient ID to find someone."
        />
      ) : (
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5 font-medium">Patient</th>
              <th className="px-4 py-2.5 font-medium">Current insurance</th>
              <th className="px-4 py-2.5 font-medium">Member ID</th>
              <th className="px-4 py-2.5 font-medium">Phone</th>
              <th className="px-4 py-2.5 font-medium text-right">Balance</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(p => {
              const bal = patientBalance(p.id);
              const primary = primaryPolicyByPatient[p.id];
              return (
                <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 cursor-pointer" onClick={() => onSelect(p.id)}>
                  <td className="px-4 py-2.5"><div className="font-medium text-slate-800">{p.name}</div><div className="text-xs text-slate-400">{p.id}</div></td>
                  <td className="px-4 py-2.5 text-slate-600">{primary ? primary.insuranceCompany : <span className="text-slate-400">Self-pay</span>}</td>
                  <td className="px-4 py-2.5 text-slate-600">{primary?.memberId || "—"}</td>
                  <td className="px-4 py-2.5 text-slate-600">{p.phone}</td>
                  <td className={`px-4 py-2.5 text-right font-medium ${bal > 0 ? "text-rose-600" : "text-slate-700"}`}>{money(bal)}</td>
                  <td className="px-4 py-2.5 text-slate-300"><ChevronRight size={16} /></td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">No patients match "{search.trim()}".</td></tr>}
          </tbody>
        </table>
      </Card>
      )}
    </div>
  );
}

// ---------- Billing: search / list ----------

function BillingSearch({ patients, policies, patientBalance, onSelect }) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter(p => {
      const patientPolicies = policies.filter(pol => pol.patientId === p.id);
      return p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.dob.includes(q) ||
        p.phone.replace(/\D/g, "").includes(q.replace(/\D/g, "")) ||
        patientPolicies.some(pol => pol.insuranceCompany.toLowerCase().includes(q) || pol.memberId.toLowerCase().includes(q));
    });
  }, [query, patients, policies]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-800 mb-1">Billing</h1>
      <p className="text-slate-500 text-sm mb-4">Search for a patient to view or edit their account.</p>

      <div className="relative mb-4 max-w-lg">
        <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, DOB, phone, account number, or insurance"
          className={`${inputCls} pl-9`}
          autoFocus
        />
      </div>

      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5 font-medium">Patient</th>
              <th className="px-4 py-2.5 font-medium">Account</th>
              <th className="px-4 py-2.5 font-medium">DOB</th>
              <th className="px-4 py-2.5 font-medium">Phone</th>
              <th className="px-4 py-2.5 font-medium">Insurance</th>
              <th className="px-4 py-2.5 font-medium text-right">Balance</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {results.map(p => {
              const bal = patientBalance(p.id);
              const primary = currentPrimaryPolicy(p.id, policies);
              return (
                <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 cursor-pointer" onClick={() => onSelect(p.id)}>
                  <td className="px-4 py-2.5 font-medium text-slate-800">{p.name}</td>
                  <td className="px-4 py-2.5 text-slate-600">{p.id}</td>
                  <td className="px-4 py-2.5 text-slate-600">{fmtDate(p.dob)}</td>
                  <td className="px-4 py-2.5 text-slate-600">{p.phone}</td>
                  <td className="px-4 py-2.5 text-slate-600">{primary ? primary.insuranceCompany : "Self-pay"}</td>
                  <td className={`px-4 py-2.5 text-right font-medium ${bal > 0 ? "text-rose-600" : "text-slate-700"}`}>{money(bal)}</td>
                  <td className="px-4 py-2.5 text-slate-300"><ChevronRight size={16} /></td>
                </tr>
              );
            })}
            {results.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-400">No patients match that search.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ---------- Billing: post payments (manual + electronic 835) ----------

function PaymentPosting({ charges, claims, patients, patientById, chargeById, policies, onPostManualLine, onPostERA, onSelectChargeInsurance, onSetSelfPay, onPostingSession, hasOpenBatch }) {
  const [mode, setMode] = useState("manual");
  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-800 mb-1">Post payments</h1>
      <p className="text-slate-500 text-sm mb-4">Post insurance and patient payments manually, or import an electronic remittance (835) file.</p>
      {!hasOpenBatch && (
        <p className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
          <AlertTriangle size={13} /> No batch is open — open your batch (top-right of the header) before posting.
        </p>
      )}

      <div className="flex items-center gap-1 mb-5 border border-slate-200 bg-white rounded-lg p-1 w-fit">
        <button onClick={() => setMode("manual")} className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${mode === "manual" ? "bg-teal-600 text-white" : "text-slate-500 hover:bg-slate-50"}`}>
          <Landmark size={14} /> Manual post
        </button>
        <button onClick={() => setMode("electronic")} className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${mode === "electronic" ? "bg-teal-600 text-white" : "text-slate-500 hover:bg-slate-50"}`}>
          <FileCheck2 size={14} /> Electronic remittance (835)
        </button>
      </div>

      {mode === "manual" && <ManualPosting charges={charges} claims={claims} patients={patients} patientById={patientById} policies={policies} onPostManualLine={onPostManualLine} onSelectChargeInsurance={onSelectChargeInsurance} onSetSelfPay={onSetSelfPay} onPostingSession={onPostingSession} hasOpenBatch={hasOpenBatch} />}
      {mode === "electronic" && <ElectronicRemittance charges={charges} claims={claims} patientById={patientById} chargeById={chargeById} onPostERA={onPostERA} onPostingSession={onPostingSession} hasOpenBatch={hasOpenBatch} />}
    </div>
  );
}

// ---------- Billing: Manual Posting ----------
//
// The workflow is payment-source first, then patient, then one claim at a time:
//
//   payment type + reference + amount  ->  find patient  ->  that patient's OPEN claims only
//   ->  pick one  ->  post  ->  the claim's balance is recalculated and it leaves the list at zero
//
// Two rules shape it. A claim is eligible only while balanceOf() is above zero, using the same
// balance function the Claim/Ledger screen bills from rather than a second status system. And the
// list is scoped to one selected patient, so a biller working a cheque cannot post against
// somebody else's account by clicking the wrong row.

const MANUAL_PAYMENT_TYPES = [
  { id: "check", label: "Check", refLabel: "Check number", refPlaceholder: "e.g. 4471029", requiresRef: true },
  { id: "card", label: "Credit Card", refLabel: "Transaction / reference", refPlaceholder: "e.g. CC-123456", requiresRef: true },
  { id: "eft", label: "Insurance EFT", refLabel: "EFT / trace number", refPlaceholder: "e.g. EFT-88213", requiresRef: true },
  { id: "cash", label: "Cash / Self", refLabel: "Receipt reference", refPlaceholder: "optional", requiresRef: false },
];

/**
 * Has this reference already been posted against any charge?
 *
 * Scans the postings the application already stores rather than a new index, so it sees every
 * payment however it was keyed. A match is a warning, never a block: the same cheque legitimately
 * covers several claims, which is the whole point of the allocation tracking below.
 */
function findExistingPaymentsByReference(charges, reference) {
  const ref = String(reference || "").trim().toLowerCase();
  if (!ref) return [];
  const hits = [];
  for (const c of charges || []) {
    for (const p of c.postings || []) {
      if (p.field !== "paid" || p.type === "Debit") continue;
      const candidates = [p.checkNumber, p.reference].filter(Boolean).map(x => String(x).trim().toLowerCase());
      if (candidates.includes(ref)) hits.push({ charge: c, posting: p });
    }
  }
  return hits;
}

function ManualPosting({ charges, claims, patients, patientById, policies, onPostManualLine, onSelectChargeInsurance, onSetSelfPay, onPostingSession, hasOpenBatch }) {
  // ----- payment source -----
  const [paymentType, setPaymentType] = useState("check");
  const [reference, setReference] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [postDate, setPostDate] = useState(TODAY);

  // ----- patient selection -----
  const [search, setSearch] = useState("");
  const [patientId, setPatientId] = useState(null);

  // ----- posting -----
  const [postingCharge, setPostingCharge] = useState(null);
  const [postedLines, setPostedLines] = useState([]);
  // Set after a payment that leaves a balance, so the biller can send the remainder to the next
  // payer without leaving this screen.
  const [routeAfterPost, setRouteAfterPost] = useState(null);
  const [sortKey, setSortKey] = useState("dos");
  const [sortDir, setSortDir] = useState("asc");

  const typeDef = MANUAL_PAYMENT_TYPES.find(t => t.id === paymentType) || MANUAL_PAYMENT_TYPES[0];

  // A claim is open while it still owes money. Same balanceOf() the rest of the application bills
  // from, so this list can never disagree with the Claim/Ledger screen about what is outstanding.
  const openCharges = useMemo(() => charges.filter(c => balanceOf(c) > BALANCE_EPSILON), [charges]);

  const query = search.trim().toLowerCase();
  const patientMatches = useMemo(() => {
    if (!query) return [];
    // Only patients who actually have something postable are offered, so selecting one can never
    // lead to an empty list for a reason the biller cannot see.
    const withOpen = new Set(openCharges.map(c => c.patientId));
    return (patients || [])
      .filter(p => withOpen.has(p.id))
      .filter(p =>
        (p.name || "").toLowerCase().includes(query) ||
        (p.id || "").toLowerCase().includes(query) ||
        (p.dob || "").includes(query) ||
        (p.phone || "").replace(/\D/g, "").includes(query.replace(/\D/g, "") || "no-match"))
      .slice(0, 25);
  }, [query, patients, openCharges]);

  const patient = patientId ? patientById[patientId] : null;

  const claimByChargeId = useMemo(() => {
    const m = {};
    (claims || []).forEach(cl => { if (cl.chargeId) m[cl.chargeId] = cl; });
    return m;
  }, [claims]);

  // The selected patient's open claims, and nobody else's.
  const patientClaims = useMemo(() => {
    if (!patientId) return [];
    const rows = openCharges
      .filter(c => c.patientId === patientId)
      .map(c => ({
        charge: c,
        claim: claimByChargeId[c.id] || null,
        insurance: payerLabel(c, policies || []),
        balance: balanceOf(c),
      }));
    const dir = sortDir === "asc" ? 1 : -1;
    const get = {
      dos: r => r.charge.dos || "",
      claim: r => r.claim?.id || "",
      cpt: r => r.charge.cpt || "",
      insurance: r => r.insurance || "",
      balance: r => r.balance,
    }[sortKey] || (r => r.charge.dos || "");
    return rows.sort((a, b) => {
      const x = get(a), y = get(b);
      const cmp = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
      // Oldest first by default: a biller works the oldest outstanding claim first. The charge id
      // is the final tie-break so two claims on the same date keep a stable, repeatable order -
      // rows that reshuffle between renders are how the wrong claim gets clicked.
      return cmp * dir || String(a.charge.id).localeCompare(String(b.charge.id));
    });
  }, [patientId, openCharges, claimByChargeId, policies, sortKey, sortDir]);

  // ----- allocation tracking -----
  const totalPayment = Number(paymentAmount) || 0;
  const allocated = postedLines.reduce((s, l) => s + l.amount, 0);
  const remainingToAllocate = totalPayment > 0 ? totalPayment - allocated : 0;
  const fullyAllocated = totalPayment > 0 && Math.abs(remainingToAllocate) < BALANCE_EPSILON;

  // Reported upward so closing the batch can refuse while a cheque is short-allocated. Cleared on
  // unmount, so navigating away from a finished payment does not leave a phantom block behind.
  useEffect(() => {
    if (!onPostingSession) return undefined;
    if (totalPayment > 0) {
      onPostingSession("manual", {
        label: `Manual posting - ${typeDef.label}`,
        reference: reference.trim(),
        total: totalPayment,
        allocated,
      });
    } else {
      onPostingSession("manual", null);
    }
    return () => onPostingSession("manual", null);
  }, [onPostingSession, totalPayment, allocated, reference, typeDef.label]);

  const duplicateHits = useMemo(
    () => (typeDef.requiresRef ? findExistingPaymentsByReference(charges, reference) : []),
    [charges, reference, typeDef.requiresRef]
  );
  // Postings made in this session are the expected duplicates, so they are not warned about.
  const priorDuplicates = duplicateHits.filter(h => !postedLines.some(l => l.postingIds?.includes(h.posting.id)));

  const sourceReady = Boolean(reference.trim()) || !typeDef.requiresRef;

  function sortBy(key) {
    if (sortKey === key) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  function handleSubmit(form) {
    const chargeId = postingCharge.id;
    // Concurrency: re-read the charge from the live collection at the moment of posting rather
    // than trusting the copy captured when the row was clicked. Two billers working the same
    // cheque would otherwise each post against a balance that no longer exists.
    const current = charges.find(c => c.id === chargeId);
    if (!current) {
      return { error: "That claim is no longer available. Refresh and try again." };
    }
    const liveBalance = balanceOf(current);
    if (liveBalance <= BALANCE_EPSILON) {
      return { error: "This claim has already been paid in full, most likely by another user. Nothing was posted." };
    }
    const amt = Number(form.amount) || 0;
    if (amt > liveBalance + BALANCE_EPSILON && !form.allowOverpayment) {
      return {
        error: `Payment exceeds the remaining claim balance of ${money(liveBalance)}. Review the amount, or tick "post as an overpayment" to create a patient credit.`,
        overpayment: true,
      };
    }

    onPostManualLine(chargeId, { ...form, checkNumber: reference || form.checkNumber, paymentDate: postDate });

    const name = patientById[current.patientId]?.name || current.patientId;
    const parts = [];
    if (amt > 0) parts.push(`${money(amt)} payment`);
    if (Number(form.writeoff) > 0) parts.push(`${money(Number(form.writeoff))} write-off`);
    setPostedLines(prev => [{
      id: uid("LOG"),
      amount: amt,
      chargeId,
      text: `${name} (${current.patientId}) — ${fmtDate(current.dos)} · ${current.cpt}: ${parts.join(" + ")}`,
    }, ...prev]);
    setPostingCharge(null);

    // Coordination of benefits: a primary payment that does not clear the claim leaves a balance
    // somebody else owes. Offering the routing here means the biller does it while looking at the
    // payment, rather than remembering to go to Claim/Ledger later - the usual way a balance ends
    // up sitting unbilled against the wrong payer.
    const remaining = liveBalance - amt - (Number(form.writeoff) || 0);
    if (remaining > BALANCE_EPSILON) {
      setRouteAfterPost({ chargeId, remaining, dos: current.dos, cpt: current.cpt, patientId: current.patientId });
    }
    return { ok: true };
  }

  /** Applies the chosen payer to the charge, using the application's own routing handlers. */
  function applyRouting(choice) {
    if (!routeAfterPost) return;
    if (choice === "self") onSetSelfPay?.(routeAfterPost.chargeId);
    else if (choice) onSelectChargeInsurance?.(routeAfterPost.chargeId, choice);
    setRouteAfterPost(null);
  }

  function resetPaymentSource() {
    setReference(""); setPaymentAmount(""); setPostedLines([]); setPatientId(null); setSearch("");
  }

  return (
    <div>
      {/* ---------- 1. payment source ---------- */}
      <Card className="p-4 mb-4">
        <SectionTitle>Payment source</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Field label="Payment type">
            <select className={inputCls} value={paymentType} onChange={(e) => { setPaymentType(e.target.value); setReference(""); }}>
              {MANUAL_PAYMENT_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </Field>
          <Field
            label={typeDef.refLabel}
            hint={paymentType === "card" ? "Reference only — no card number is stored." : undefined}
          >
            <input className={inputCls} value={reference} onChange={(e) => setReference(e.target.value)} placeholder={typeDef.refPlaceholder} />
          </Field>
          <Field label="Payment amount" hint="Optional. Set it to track how much is left to allocate.">
            <input type="number" min="0" step="0.01" className={inputCls} value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Post date"><input type="date" className={inputCls} value={postDate} onChange={(e) => setPostDate(e.target.value)} /></Field>
        </div>

        {typeDef.requiresRef && !reference.trim() && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
            Enter the {typeDef.refLabel.toLowerCase()} before posting, so every payment can be traced back to it.
          </p>
        )}

        {priorDuplicates.length > 0 && (
          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
            <strong>This reference has already been used</strong> on {priorDuplicates.length} existing payment
            {priorDuplicates.length === 1 ? "" : "s"}. Review before continuing — nothing has been changed.
            <ul className="mt-1 space-y-0.5">
              {priorDuplicates.slice(0, 4).map(h => (
                <li key={h.posting.id}>
                  {patientById[h.charge.patientId]?.name || h.charge.patientId} · {fmtDate(h.charge.dos)} · {h.charge.cpt} — {money(h.posting.amount)}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ---------- running allocation ---------- */}
        {totalPayment > 0 && (
          <div className="grid grid-cols-3 gap-3 mt-3 text-sm">
            <div className="border border-slate-200 rounded-lg px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-slate-400">Payment amount</div>
              <div className="font-semibold text-slate-800">{money(totalPayment)}</div>
            </div>
            <div className="border border-slate-200 rounded-lg px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-slate-400">Already posted</div>
              <div className="font-semibold text-slate-800">{money(allocated)}</div>
            </div>
            <div className={`border rounded-lg px-3 py-2 ${remainingToAllocate < -BALANCE_EPSILON ? "border-rose-200 bg-rose-50" : fullyAllocated ? "border-emerald-200 bg-emerald-50" : "border-slate-200"}`}>
              <div className="text-[10px] uppercase tracking-wide text-slate-400">Remaining to allocate</div>
              <div className={`font-semibold ${remainingToAllocate < -BALANCE_EPSILON ? "text-rose-600" : fullyAllocated ? "text-emerald-700" : "text-slate-800"}`}>
                {money(remainingToAllocate)}
              </div>
            </div>
          </div>
        )}
        {fullyAllocated && (
          <p className="text-xs text-emerald-700 mt-2 flex items-center gap-1.5">
            <CheckCircle2 size={13} /> Payment fully allocated.
          </p>
        )}
        {remainingToAllocate < -BALANCE_EPSILON && (
          <p className="text-xs text-rose-700 mt-2">
            {money(-remainingToAllocate)} more has been posted than this payment covers. Review the postings below.
          </p>
        )}

        {(reference || postedLines.length > 0) && (
          <button onClick={resetPaymentSource} className="text-xs text-slate-500 border border-slate-200 rounded-lg px-2.5 py-1.5 mt-3 hover:bg-slate-50">
            Start a new payment
          </button>
        )}
      </Card>

      {/* ---------- 2. patient ---------- */}
      {!patient ? (
        <>
          <div className="relative mb-3 max-w-lg">
            <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
            <input
              value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search patient by name, account number, date of birth, or phone"
              className={`${inputCls} pl-9`}
            />
          </div>

          {!query ? (
            <SearchFirstPrompt
              icon={Search}
              total={new Set(openCharges.map(c => c.patientId)).size}
              noun={{ one: "patient with open claims", many: "patients with open claims" }}
              hint="Find the patient this payment belongs to. Only patients with unpaid or partially paid claims are listed."
            />
          ) : (
            <Card>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                    <th className="px-4 py-2.5 font-medium">Patient</th>
                    <th className="px-4 py-2.5 font-medium">Account</th>
                    <th className="px-4 py-2.5 font-medium">DOB</th>
                    <th className="px-4 py-2.5 font-medium text-right">Open claims</th>
                    <th className="px-4 py-2.5 font-medium text-right">Total balance</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {patientMatches.map(p => {
                    const mine = openCharges.filter(c => c.patientId === p.id);
                    const bal = mine.reduce((s, c) => s + balanceOf(c), 0);
                    return (
                      <tr key={p.id} onClick={() => setPatientId(p.id)} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 cursor-pointer">
                        <td className="px-4 py-2.5 font-medium text-slate-800">{p.name}</td>
                        <td className="px-4 py-2.5 text-slate-500 text-xs">{p.id}</td>
                        <td className="px-4 py-2.5 text-slate-600">{fmtDate(p.dob)}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{mine.length}</td>
                        <td className="px-4 py-2.5 text-right font-medium text-rose-600">{money(bal)}</td>
                        <td className="px-4 py-2.5 text-slate-300"><ChevronRight size={16} /></td>
                      </tr>
                    );
                  })}
                  {patientMatches.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                      No patient with open claims matches &ldquo;{search.trim()}&rdquo;.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </Card>
          )}
        </>
      ) : (
        <>
          {/* ---------- 3. selected patient ---------- */}
          <div className="flex items-start justify-between mb-3">
            <div>
              <div className="text-xs text-slate-400">Selected patient</div>
              <h3 className="text-lg font-semibold text-slate-800">{patient.name}</h3>
              <p className="text-xs text-slate-500">
                Account {patient.id} · DOB {fmtDate(patient.dob)}
              </p>
            </div>
            <button onClick={() => { setPatientId(null); setSearch(""); }} className="text-xs text-slate-600 border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-50">
              Change patient
            </button>
          </div>

          {/* ---------- 4. open claims, this patient only ---------- */}
          {patientClaims.length === 0 ? (
            <Card className="p-8 text-center">
              <p className="font-medium text-slate-700">No open claims</p>
              <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                This patient currently has no unpaid or partially paid claims available for manual posting.
                Paid-off claims are deliberately not listed here.
              </p>
            </Card>
          ) : (
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                    {[["DOS", "dos"], ["Claim #", "claim"], ["CPT", "cpt"], ["Insurance", "insurance"]].map(([label, key]) => (
                      <th key={key} className="px-3 py-2.5 font-medium">
                        <button onClick={() => sortBy(key)} className="hover:text-slate-700">
                          {label}{sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                        </button>
                      </th>
                    ))}
                    <th className="px-3 py-2.5 font-medium">Physician</th>
                    <th className="px-3 py-2.5 font-medium text-right">Charge</th>
                    <th className="px-3 py-2.5 font-medium text-right">Paid</th>
                    <th className="px-3 py-2.5 font-medium text-right">Write-off</th>
                    <th className="px-3 py-2.5 font-medium text-right">
                      <button onClick={() => sortBy("balance")} className="hover:text-slate-700">
                        Balance{sortKey === "balance" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                      </button>
                    </th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-3 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {patientClaims.map(({ charge: c, claim, insurance, balance }) => (
                    <tr key={c.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-3 py-2.5 text-slate-700 whitespace-nowrap">{fmtDate(c.dos)}</td>
                      <td className="px-3 py-2.5 text-slate-500 text-xs">{claim?.id || "Not billed"}</td>
                      <td className="px-3 py-2.5 font-medium text-slate-800">{c.cpt}</td>
                      <td className="px-3 py-2.5 text-slate-600">{insurance}</td>
                      <td className="px-3 py-2.5 text-slate-600">{c.provider || "—"}</td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{money(c.charge)}</td>
                      <td className="px-3 py-2.5 text-right text-emerald-700">{money(c.paid)}</td>
                      <td className="px-3 py-2.5 text-right text-slate-500">{money(c.writeoff + (c.credits || 0))}</td>
                      <td className="px-3 py-2.5 text-right font-medium text-rose-600">{money(balance)}</td>
                      <td className="px-3 py-2.5"><StatusPill status={chargeStatus(c)} /></td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          onClick={() => setPostingCharge(c)}
                          disabled={!hasOpenBatch || !sourceReady}
                          title={!hasOpenBatch ? "Open your batch first" : !sourceReady ? `Enter the ${typeDef.refLabel.toLowerCase()} first` : ""}
                          className="flex items-center gap-1.5 bg-teal-600 text-white text-xs font-medium px-3 py-1.5 rounded-lg hover:bg-teal-700 ml-auto disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                        >
                          <CreditCard size={13} /> Post
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-slate-400 px-3 py-2 border-t border-slate-100">
                Open claims only — a claim disappears from this list once its balance reaches zero. Post one claim at a time.
              </p>
            </Card>
          )}
        </>
      )}

      {/* ---------- session log ---------- */}
      {postedLines.length > 0 && (
        <Card className="p-3 mt-4">
          <SectionTitle>Posted with this payment</SectionTitle>
          <div className="space-y-1">
            {postedLines.map(l => <p key={l.id} className="text-emerald-700 text-xs">✓ {l.text}</p>)}
          </div>
          <p className="text-xs text-slate-500 mt-2 border-t border-slate-100 pt-2">
            {postedLines.length} posting{postedLines.length === 1 ? "" : "s"} · {money(allocated)} allocated
            {totalPayment > 0 && ` of ${money(totalPayment)}`}
          </p>
        </Card>
      )}

      {/* ---------- after payment: where does the remaining balance go? ---------- */}
      {routeAfterPost && (
        <Modal title="Balance remaining - select the next payer" onClose={() => setRouteAfterPost(null)}>
          <p className="text-sm text-slate-600 mb-1">
            {fmtDate(routeAfterPost.dos)} · CPT {routeAfterPost.cpt} still has a balance of{" "}
            <strong className="text-rose-600">{money(routeAfterPost.remaining)}</strong>.
          </p>
          <p className="text-xs text-slate-500 mb-4">
            Choose who it should be billed to next. This sets the claim&apos;s payer - it does not move any
            money, and the payment you just posted is unaffected.
          </p>

          <div className="space-y-2 mb-4">
            {(policies || [])
              .filter(pol => pol.patientId === routeAfterPost.patientId && pol.status === "Active")
              // Primary, then Secondary, then Tertiary: the order benefits are coordinated in.
              .sort((a, b) => priorities.indexOf(a.priority) - priorities.indexOf(b.priority))
              .map(pol => (
                <button
                  key={pol.id}
                  onClick={() => applyRouting(pol.id)}
                  className="w-full flex items-center justify-between border border-slate-200 rounded-lg px-3 py-2.5 hover:border-teal-400 hover:bg-teal-50/50 text-left"
                >
                  <span className="flex items-center gap-2">
                    <PriorityBadge priority={pol.priority} />
                    <span className="text-sm text-slate-700">{pol.insuranceCompany}</span>
                    {pol.insuranceType && (
                      <span className="text-[10px] bg-slate-100 border border-slate-200 rounded-full px-1.5 py-0.5 text-slate-600">
                        {pol.insuranceType}
                      </span>
                    )}
                    {pol.memberId && <span className="text-xs text-slate-400">· {pol.memberId}</span>}
                  </span>
                  <ChevronRight size={15} className="text-slate-300" />
                </button>
              ))}

            <button
              onClick={() => applyRouting("self")}
              className="w-full flex items-center justify-between border border-slate-200 rounded-lg px-3 py-2.5 hover:border-teal-400 hover:bg-teal-50/50 text-left"
            >
              <span className="flex items-center gap-2">
                <Users size={14} className="text-slate-400" />
                <span className="text-sm text-slate-700">Self / Patient responsibility</span>
              </span>
              <ChevronRight size={15} className="text-slate-300" />
            </button>
          </div>

          {(policies || []).filter(pol => pol.patientId === routeAfterPost.patientId && pol.status === "Active").length === 0 && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
              This patient has no active insurance on file, so the balance can only be billed to the patient.
            </p>
          )}

          <button
            onClick={() => setRouteAfterPost(null)}
            className="w-full border border-slate-200 text-slate-600 text-sm py-2 rounded-lg hover:bg-slate-50"
          >
            Leave the payer unchanged
          </button>
        </Modal>
      )}

      {/* ---------- 5. posting panel ---------- */}
      {postingCharge && (
        <Modal
          title={`Post payment · ${patientById[postingCharge.patientId]?.name || postingCharge.patientId} · ${fmtDate(postingCharge.dos)}`}
          onClose={() => setPostingCharge(null)}
        >
          <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-3">
            <div className="font-medium text-slate-700 mb-1">Payment source</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-slate-600">
              <span>Type: <strong>{typeDef.label}</strong></span>
              <span>{typeDef.refLabel}: <strong>{reference || "—"}</strong></span>
              <span>Post date: <strong>{fmtDate(postDate)}</strong></span>
              {totalPayment > 0 && <span>Remaining to allocate: <strong>{money(remainingToAllocate)}</strong></span>}
            </div>
          </div>
          <ManualLinePostingForm
            charge={postingCharge}
            policies={policies.filter(p => p.patientId === postingCharge.patientId && p.status === "Active")}
            defaultCheckNumber={reference}
            defaultPostDate={postDate}
            onSubmit={handleSubmit}
          />
        </Modal>
      )}
    </div>
  );
}

// Guided single-charge posting: ask check number / insurance / amount first, then let the
// biller key an EOB's allowed amount and auto-split it into copay/coinsurance/deductible,
// leaving any gap between billed and allowed as a write-off that requires a reason.
function ManualLinePostingForm({ charge, policies, defaultCheckNumber, defaultPostDate, onSubmit }) {
  const bal = balanceOf(charge);
  const [f, setF] = useState({
    checkNumber: defaultCheckNumber || "", insuranceName: policies[0]?.insuranceCompany || "", paymentDate: defaultPostDate || TODAY,
    amount: "", allowedAmount: "", copay: "", coinsurance: "", deductible: "", writeoff: "", writeoffReason: "", notes: "",
  });
  const [error, setError] = useState("");
  const set = (k) => (e) => setF(prev => ({ ...prev, [k]: e.target.value }));

  function autoCalculate() {
    const allowed = Number(f.allowedAmount) || 0;
    const policy = policies.find(p => p.insuranceCompany === f.insuranceName);
    const { copay, deductible, coinsurance, insurancePaid } = splitAllowedAmount(allowed, policy);
    const amount = Math.min(bal, insurancePaid);
    const writeoff = Math.min(Math.max(0, bal - amount), Math.max(0, charge.charge - allowed));
    setF(prev => ({
      ...prev,
      copay: copay ? String(copay) : "", coinsurance: coinsurance ? String(coinsurance) : "", deductible: deductible ? String(deductible) : "",
      amount: amount ? String(amount) : "0", writeoff: writeoff ? String(writeoff) : "",
    }));
  }

  const amtNum = Number(f.amount) || 0;
  const willOverpay = amtNum > bal + BALANCE_EPSILON;
  // Overpayment is supported by the ledger (balanceOf goes negative and the surplus becomes a
  // patient credit), so it is offered as a deliberate confirmation rather than silently allowed.
  const [allowOver, setAllowOver] = useState(false);
  const [offerOverpayment, setOfferOverpayment] = useState(false);

  function submit() {
    const amt = Number(f.amount) || 0;
    const writeoffAmt = Number(f.writeoff) || 0;
    if (!f.checkNumber.trim()) { setError("Check number is required."); return; }
    if (amt <= 0 && writeoffAmt <= 0) { setError("Enter a payment or write-off amount greater than 0."); return; }
    // A payment may exceed the remaining balance (overpayment) — only the write-off can't.
    if (writeoffAmt > Math.max(0, bal) + BALANCE_EPSILON) { setError(`Write-off can't exceed the remaining balance (${money(Math.max(0, bal))}).`); return; }
    if (writeoffAmt > 0 && !f.writeoffReason.trim()) { setError("A write-off reason is required."); return; }
    setError("");
    // onSubmit re-checks the claim against live data and can refuse: the balance may have been
    // paid by another biller since this panel opened, or the amount may exceed what is owed.
    const outcome = onSubmit({ ...f, amount: amt, writeoff: writeoffAmt, billedAmount: charge.charge, allowOverpayment: allowOver });
    if (outcome && outcome.error) {
      setError(outcome.error);
      setOfferOverpayment(Boolean(outcome.overpayment));
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-4">
        <span>Billed {money(charge.charge)}</span>
        <span>Adjusted {money(adjustedOf(charge))}</span>
        <span className={bal < -BALANCE_EPSILON ? "text-violet-700 font-medium" : bal > BALANCE_EPSILON ? "text-rose-600 font-medium" : "font-medium"}>Remaining {money(bal)}</span>
      </div>

      <SectionTitle>Payment</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Check / EFT number"><input className={inputCls} value={f.checkNumber} onChange={set("checkNumber")} /></Field>
        <Field label="Insurance">
          <select className={inputCls} value={f.insuranceName} onChange={set("insuranceName")}>
            <option value="">Self / Patient payment</option>
            {policies.map(p => (
              <option key={p.id} value={p.insuranceCompany}>
                {p.insuranceCompany}
                {p.insuranceType ? ` - ${p.insuranceType}` : ""}
                {p.priority ? ` (${p.priority})` : ""}
              </option>
            ))}
          </select>
        </Field>
        <AmountField label={`Amount received (balance ${money(bal)})`} value={f.amount} onChange={set("amount")} />
        <Field label="Payment date"><input type="date" className={inputCls} value={f.paymentDate} onChange={set("paymentDate")} /></Field>
      </div>
      {willOverpay && (
        <p className="text-xs text-violet-700 bg-violet-50 border border-violet-200 rounded-lg px-3 py-2 mb-3">
          This payment exceeds the remaining balance by {money(amtNum - bal)} — the charge will post as an <strong>overpayment</strong> with a negative balance instead of being capped at $0.00.
        </p>
      )}

      <SectionTitle>Claim posting (from EOB)</SectionTitle>
      <div className="flex items-end gap-2 mb-1">
        <div className="flex-1"><AmountField label="Allowed amount" value={f.allowedAmount} onChange={set("allowedAmount")} /></div>
        <button type="button" onClick={autoCalculate} disabled={!f.allowedAmount} className="h-9 mb-4 flex items-center gap-1.5 text-xs text-teal-700 border border-teal-200 bg-teal-50 rounded-lg px-3 hover:bg-teal-100 disabled:opacity-40 whitespace-nowrap">
          <Wand2 size={13} /> Auto-calculate
        </button>
      </div>
      <p className="text-xs text-slate-400 mb-3">Auto-calculate splits the allowed amount into copay/deductible/coinsurance using this patient's policy, fills the payment amount with what's left, and write-off with billed minus allowed. All fields stay editable.</p>
      <div className="grid grid-cols-3 gap-3">
        <AmountField label="Copay" value={f.copay} onChange={set("copay")} />
        <AmountField label="Coinsurance" value={f.coinsurance} onChange={set("coinsurance")} />
        <AmountField label="Deductible" value={f.deductible} onChange={set("deductible")} />
      </div>

      <SectionTitle>Write off</SectionTitle>
      <AmountField label="Write-off amount" value={f.writeoff} onChange={set("writeoff")} />
      {Number(f.writeoff) > 0 && (
        <Field label="Write-off reason (required)"><input className={inputCls} value={f.writeoffReason} onChange={set("writeoffReason")} placeholder="Contractual adjustment, timely filing, etc." /></Field>
      )}

      <Field label="Notes"><textarea className={`${inputCls} h-16 resize-none`} value={f.notes} onChange={set("notes")} /></Field>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      {/* Shown only after a payment was refused for exceeding the balance. The ledger supports
          overpayments - the surplus becomes a patient credit - so this is a confirmation, not a
          way around the check. */}
      {offerOverpayment && (
        <label className="flex items-start gap-2 text-xs text-slate-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-2 cursor-pointer">
          <input type="checkbox" checked={allowOver} onChange={(e) => setAllowOver(e.target.checked)} className="mt-0.5 accent-amber-600" />
          <span>
            Post as an overpayment. The amount above the balance becomes a patient credit that can be
            refunded or applied to another claim.
          </span>
        </label>
      )}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Post payment</button>
    </div>
  );
}

function ElectronicRemittance({ claims, patientById, chargeById, onPostERA, onPostingSession, hasOpenBatch }) {
  const [rawText, setRawText] = useState("");
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState("");
  const [postedMsg, setPostedMsg] = useState("");
  const [manualMatch, setManualMatch] = useState({}); // parsed claimId -> chargeId override

  function loadSample() {
    const sample = generateSampleERA(claims, patientById, chargeById);
    if (!sample) { setError("No submitted claims are available to simulate an ERA for. Submit a claim first."); return; }
    setError(""); setRawText(sample); setParsed(null); setPostedMsg("");
  }

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setRawText(String(reader.result || "")); setParsed(null); setPostedMsg(""); };
    reader.readAsText(file);
  }

  function runParse() {
    if (!rawText.trim()) { setError("Paste 835 content or upload a file first."); return; }
    try {
      const result = parse835(rawText);
      if (result.claims.length === 0) { setError("No CLP (claim payment) segments were found in this file."); return; }
      setError(""); setParsed(result); setPostedMsg("");
    } catch (e) {
      setError("Couldn't parse this file as an 835 — check the format.");
    }
  }

  function resolveChargeId(claimRow) {
    if (manualMatch[claimRow.claimId]) return manualMatch[claimRow.claimId];
    // internal claims carry a chargeId — this app posted CLP01 as the internal claim id
    const claim = claims.find(cl => cl.id === claimRow.claimId);
    return claim ? claim.chargeId : null;
  }

  const rowsForPosting = parsed ? parsed.claims.map(cr => {
    const chargeId = resolveChargeId(cr);
    const coAdj = cr.adjustments.filter(a => a.group === "CO").reduce((s, a) => s + a.amount, 0);
    return { ...cr, chargeId, paid: cr.totalPaid, writeoff: coAdj };
  }) : [];

  const matchedCount = rowsForPosting.filter(r => r.chargeId).length;

  // A remittance states its own total in the BPR segment. Anything whose claim could not be
  // matched to a charge is money the file paid but this application has not posted - the
  // electronic equivalent of a cheque with an amount left over.
  const eraTotal = parsed ? Number(parsed.totalPaymentAmount) || 0 : 0;
  const eraPostable = rowsForPosting.filter(r => r.chargeId).reduce((sum, r) => sum + (Number(r.paid) || 0), 0);

  useEffect(() => {
    if (!onPostingSession) return undefined;
    if (parsed && eraTotal > 0) {
      onPostingSession("era", {
        label: `Electronic remittance (835) - ${parsed.payerName || "payer"}`,
        reference: parsed.checkEft || "",
        total: eraTotal,
        // What WOULD be posted if the biller posted now. While claims are unmatched this is less
        // than the remittance total, and that gap is what blocks the batch.
        allocated: eraPostable,
      });
    } else {
      onPostingSession("era", null);
    }
    return () => onPostingSession("era", null);
  }, [onPostingSession, parsed, eraTotal, eraPostable]);

  function postAllMatched() {
    const matched = rowsForPosting.filter(r => r.chargeId);
    if (matched.length === 0) return;
    onPostERA(matched, { source: parsed.payerName || "Payer ERA", reference: parsed.checkEft || "" });
    setPostedMsg(`Posted ${matched.length} claim payment${matched.length > 1 ? "s" : ""} from remittance ${parsed.checkEft || ""}.`);
    setParsed(null); setRawText("");
  }

  return (
    <div>
      <Card className="p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-slate-700">Import an 835 file</span>
          <button onClick={loadSample} className="flex items-center gap-1.5 text-xs text-slate-500 border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-50">
            <Wand2 size={13} /> Load sample ERA for testing
          </button>
        </div>
        <div className="flex items-center gap-3 mb-3">
          <label className="flex items-center gap-1.5 text-xs text-teal-700 border border-teal-200 bg-teal-50 rounded-lg px-3 py-1.5 cursor-pointer hover:bg-teal-100">
            <Upload size={13} /> Upload .835 / .txt file
            <input type="file" accept=".835,.txt,.edi" className="hidden" onChange={handleFile} />
          </label>
          <span className="text-xs text-slate-400">or paste raw X12 835 content below</span>
        </div>
        <textarea
          className={`${inputCls} h-32 font-mono text-xs resize-y`}
          placeholder="ISA*00*...~GS*HP*...~ST*835*0001~BPR*I*...~CLP*CLM-7001*1*110.00*88.00*0*12*...~"
          value={rawText}
          onChange={(e) => { setRawText(e.target.value); setParsed(null); }}
        />
        {error && <p className="text-rose-600 text-xs mt-2">{error}</p>}
        <button onClick={runParse} className="mt-3 bg-slate-800 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-slate-900">Parse remittance</button>
      </Card>

      {parsed && (
        <>
          <Card className="p-4 mb-4">
            <div className="grid grid-cols-4 gap-4 text-sm">
              <div><span className="text-slate-400 text-xs block">Payer</span>{parsed.payerName || "—"}</div>
              <div><span className="text-slate-400 text-xs block">Check / EFT #</span>{parsed.checkEft || "—"}</div>
              <div><span className="text-slate-400 text-xs block">Total payment</span>{money(parsed.totalPaymentAmount)}</div>
              <div><span className="text-slate-400 text-xs block">Claims found</span>{parsed.claims.length} ({matchedCount} matched)</div>
            </div>
          </Card>

          <Card>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="px-4 py-2.5 font-medium">Claim ID</th>
                  <th className="px-4 py-2.5 font-medium">Patient</th>
                  <th className="px-4 py-2.5 font-medium text-right">Billed</th>
                  <th className="px-4 py-2.5 font-medium text-right">Paid</th>
                  <th className="px-4 py-2.5 font-medium text-right">Adjustment (CO)</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Match</th>
                </tr>
              </thead>
              <tbody>
                {rowsForPosting.map(r => (
                  <tr key={r.claimId} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2.5 font-medium text-slate-800">{r.claimId}</td>
                    <td className="px-4 py-2.5 text-slate-600">{r.patientName || "—"}</td>
                    <td className="px-4 py-2.5 text-right">{money(r.totalCharge)}</td>
                    <td className="px-4 py-2.5 text-right text-emerald-700">{money(r.paid)}</td>
                    <td className="px-4 py-2.5 text-right text-slate-500">{money(r.writeoff)}</td>
                    <td className="px-4 py-2.5"><StatusPill status={r.statusLabel === "Denied" ? "Denied" : "Paid"} /></td>
                    <td className="px-4 py-2.5">
                      {r.chargeId ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2 size={12} /> Matched</span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-amber-600"><AlertCircle size={12} /> Unmatched — needs manual review</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="flex items-center justify-between mt-4">
            <p className="text-xs text-slate-400 max-w-md">Unmatched rows didn't find a claim with a matching internal claim ID and won't be posted automatically — reconcile those from the Claims tab.</p>
            <button onClick={postAllMatched} disabled={matchedCount === 0 || !hasOpenBatch} title={hasOpenBatch ? "" : "Open your batch first"} className="flex items-center gap-1.5 bg-teal-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap">
              <CreditCard size={15} /> Post {matchedCount} matched claim{matchedCount === 1 ? "" : "s"}
            </button>
          </div>
        </>
      )}
      {postedMsg && <p className="text-emerald-600 text-sm mt-3">{postedMsg}</p>}
    </div>
  );
}

// ---------- Billing: individual patient account ----------

// ---------- Patient statement (Billing -> Claim / Ledger -> Generate statement) ----------
//
// A four-step wizard over the two /api/statements endpoints. Every figure shown here arrives from
// the server: this component sends a patient id, a basis, a date range and an optional message,
// and renders what comes back. It never computes a total, and the PDF is rebuilt server-side from
// the database rather than from the previewed numbers, so nothing shown on this screen can change
// what the document says.

const STATEMENT_STEPS = ["Statement type", "Date range", "Review", "Download"];

// Cents from the API, formatted the same way money() formats dollars elsewhere in the app.
const centsToMoney = (c) => money((Number(c) || 0) / 100);

function StatementStepper({ step }) {
  return (
    <ol className="flex items-center gap-1.5 mb-5 text-xs">
      {STATEMENT_STEPS.map((label, i) => {
        const state = i === step ? "current" : i < step ? "done" : "todo";
        return (
          <li key={label} className="flex items-center gap-1.5">
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold ${
                state === "current" ? "bg-teal-600 text-white"
                  : state === "done" ? "bg-teal-100 text-teal-700"
                  : "bg-slate-100 text-slate-400"
              }`}
            >
              {state === "done" ? "✓" : i + 1}
            </span>
            <span className={state === "todo" ? "text-slate-400" : "text-slate-700"}>{label}</span>
            {i < STATEMENT_STEPS.length - 1 && <span className="text-slate-300 mx-1">→</span>}
          </li>
        );
      })}
    </ol>
  );
}

// The two bases answer genuinely different questions, and picking the wrong one produces a
// plausible-looking statement covering the wrong services — so each option says what it means
// rather than just naming itself.
const STATEMENT_BASES = [
  {
    id: "dos",
    label: "By Date of Service",
    sub: "DOS",
    detail: "Includes the care delivered in the selected window, whenever it was billed.",
    icon: Stethoscope,
  },
  {
    id: "transaction",
    label: "By Transaction Date",
    sub: "Posted to the ledger",
    detail: "Includes what was keyed in during the window, whenever the care happened.",
    icon: Receipt,
  },
];

function StatementWizard({ patient, onClose }) {
  const [step, setStep] = useState(0);
  const [basis, setBasis] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(TODAY);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [downloaded, setDownloaded] = useState(false);

  const basisMeta = STATEMENT_BASES.find(b => b.id === basis);

  async function loadPreview() {
    setBusy(true);
    setError("");
    try {
      const data = await api("/api/statements/preview", {
        method: "POST",
        body: { patientId: patient.id, basis, from, to, message },
      });
      setPreview(data);
      setStep(2);
    } catch (e) {
      setError(e?.message || "Could not build the statement.");
    } finally {
      setBusy(false);
    }
  }

  async function generatePDF() {
    setBusy(true);
    setError("");
    try {
      const { blob, filename } = await apiBlob("/api/statements/pdf", {
        body: { patientId: patient.id, basis, from, to, message },
      });
      downloadBlob(filename, blob);
      setDownloaded(true);
      setStep(3);
    } catch (e) {
      setError(e?.message || "Could not generate the PDF.");
    } finally {
      setBusy(false);
    }
  }

  const rangeValid = from && to && from <= to;

  return (
    <Modal title={`Patient statement · ${patient.name}`} onClose={onClose} size="max-w-5xl">
      <StatementStepper step={step} />

      {error && (
        <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ---------- Step 1: how should this statement be built ---------- */}
      {step === 0 && (
        <div>
          <p className="text-sm text-slate-500 mb-4">
            Choose which date the statement should be built from. These are not interchangeable — a
            visit in August billed in September appears in one and not the other.
          </p>
          <div className="grid grid-cols-2 gap-3">
            {STATEMENT_BASES.map(b => {
              const Icon = b.icon;
              const on = basis === b.id;
              return (
                <button
                  key={b.id}
                  onClick={() => setBasis(b.id)}
                  className={`text-left border rounded-xl p-4 transition-colors ${
                    on ? "border-teal-500 bg-teal-50/60 ring-1 ring-teal-500" : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Icon size={16} className={on ? "text-teal-600" : "text-slate-400"} />
                    <span className="font-medium text-slate-800 text-sm">{b.label}</span>
                  </div>
                  <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1.5">{b.sub}</div>
                  <p className="text-xs text-slate-500">{b.detail}</p>
                </button>
              );
            })}
          </div>
          <div className="flex justify-end gap-2 mt-5">
            <button onClick={onClose} className="px-3 py-2 border border-slate-300 rounded-lg text-sm hover:bg-slate-50">Cancel</button>
            <button
              disabled={!basis}
              onClick={() => setStep(1)}
              className="px-4 py-2 bg-teal-600 text-white rounded-lg text-sm hover:bg-teal-700 disabled:bg-slate-200 disabled:text-slate-400"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {/* ---------- Step 2: the window ---------- */}
      {step === 1 && (
        <div>
          <div className="mb-4 text-xs inline-flex items-center gap-1.5 bg-slate-100 text-slate-600 rounded-full px-3 py-1">
            <basisMeta.icon size={12} /> Selecting a <strong>{basisMeta.id === "dos" ? "date of service" : "transaction date"}</strong> range
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={basisMeta.id === "dos" ? "Service from" : "Posted from"}>
              <input type="date" className={inputCls} value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label={basisMeta.id === "dos" ? "Service to" : "Posted to"}>
              <input type="date" className={inputCls} value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
          {from && to && from > to && (
            <p className="text-xs text-rose-600 -mt-1 mb-2">The start date is after the end date.</p>
          )}
          <div className="flex justify-between gap-2 mt-5">
            <button onClick={() => setStep(0)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm hover:bg-slate-50">Back</button>
            <button
              disabled={!rangeValid || busy}
              onClick={loadPreview}
              className="px-4 py-2 bg-teal-600 text-white rounded-lg text-sm hover:bg-teal-700 disabled:bg-slate-200 disabled:text-slate-400"
            >
              {busy ? "Building…" : "Review statement"}
            </button>
          </div>
        </div>
      )}

      {/* ---------- Step 3: review what the patient will receive ---------- */}
      {step === 2 && preview && (
        <div>
          <StatementPreview statement={preview} />

          <div className="mt-5">
            <Field
              label="Statement message (optional)"
              hint="Appears on the statement. Leave blank and no message section is printed."
            >
              <textarea
                className={`${inputCls} h-20 resize-none`}
                value={message}
                maxLength={2000}
                placeholder="Please contact our billing department if you have any questions regarding this statement."
                onChange={(e) => setMessage(e.target.value)}
              />
            </Field>
          </div>

          <div className="flex justify-between gap-2 mt-3">
            <button onClick={() => setStep(1)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm hover:bg-slate-50">Back</button>
            <button
              disabled={busy}
              onClick={generatePDF}
              className="px-4 py-2 bg-teal-600 text-white rounded-lg text-sm hover:bg-teal-700 disabled:bg-slate-200 disabled:text-slate-400 flex items-center gap-1.5"
            >
              <FileText size={14} />
              {busy ? "Generating…" : "Generate statement"}
            </button>
          </div>
        </div>
      )}

      {/* ---------- Step 4: the document ---------- */}
      {step === 3 && (
        <div className="text-center py-6">
          <div className="w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto mb-3">
            <FileText size={22} />
          </div>
          <p className="font-medium text-slate-800">Statement generated</p>
          <p className="text-sm text-slate-500 mt-1">
            {downloaded ? "The PDF has been downloaded." : "The PDF is ready."} This generation is recorded in the patient's audit history.
          </p>

          <div className="flex items-center justify-center gap-2 mt-5">
            <button
              onClick={generatePDF}
              disabled={busy}
              className="px-4 py-2 border border-slate-300 rounded-lg text-sm hover:bg-slate-50 flex items-center gap-1.5 disabled:text-slate-400"
            >
              <Download size={14} /> {busy ? "Generating…" : "Download again"}
            </button>
            <button onClick={onClose} className="px-4 py-2 bg-teal-600 text-white rounded-lg text-sm hover:bg-teal-700">Done</button>
          </div>

          {/* Emailing is not wired up: this application has no mail transport, and inventing one
              would put an unreviewed delivery path in front of patient financial data. The seam is
              a single POST alongside the two statement endpoints when that decision gets made. */}
          <p className="text-xs text-slate-400 mt-5">
            Sending by email is not available this deployment has no mail service configured.
            {preview?.patient?.email
              ? ` The address on file is ${preview.patient.email}.`
              : " No email address is on file for this patient."}
          </p>
        </div>
      )}
    </Modal>
  );
}

// The review table. Deliberately shows the same columns in the same order as the PDF, so what the
// reviewer approves is what prints.
function StatementPreview({ statement: st }) {
  const hasLines = st.lines && st.lines.length > 0;

  return (
    <div>
      <div className="grid grid-cols-3 gap-4 mb-4 text-sm">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">Statement for</div>
          <div className="font-medium text-slate-800">{st.patient.name}</div>
          <div className="text-slate-500 text-xs mt-0.5">
            {st.patient.address || "No address on file"}
            {(st.patient.city || st.patient.state || st.patient.zip) && (
              <><br />{[st.patient.city, st.patient.state].filter(Boolean).join(", ")} {st.patient.zip}</>
            )}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">Account</div>
          <div className="font-medium text-slate-800">{st.patient.id}</div>
          <div className="text-slate-500 text-xs mt-0.5">
            {basisLabelFor(st.basis)}: {fmtDate(st.from)} – {fmtDate(st.to)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">Amount due</div>
          <div className="text-2xl font-semibold text-slate-900">{centsToMoney(st.totals.amountDue)}</div>
        </div>
      </div>

      <div className="border border-slate-200 rounded-lg overflow-x-auto">
        <table className="w-full text-xs whitespace-nowrap">
          <thead>
            <tr className="text-left text-slate-500 bg-slate-50 border-b border-slate-200">
              <th className="px-2.5 py-2 font-medium">DOS</th>
              <th className="px-2.5 py-2 font-medium">Txn date</th>
              <th className="px-2.5 py-2 font-medium">Proc</th>
              <th className="px-2.5 py-2 font-medium">CPT</th>
              <th className="px-2.5 py-2 font-medium">Physician</th>
              <th className="px-2.5 py-2 font-medium">Insurance</th>
              <th className="px-2.5 py-2 font-medium text-right">Charges</th>
              <th className="px-2.5 py-2 font-medium text-right">Ins paid</th>
              <th className="px-2.5 py-2 font-medium text-right">Adjust</th>
              <th className="px-2.5 py-2 font-medium text-right">Copay</th>
              <th className="px-2.5 py-2 font-medium text-right">Deduct</th>
              <th className="px-2.5 py-2 font-medium text-right">Pt paid</th>
              <th className="px-2.5 py-2 font-medium text-right">Self-pay</th>
            </tr>
          </thead>
          <tbody>
            {st.lines.map(l => (
              <tr key={l.chargeId} className="border-b border-slate-100 last:border-0">
                <td className="px-2.5 py-2 text-slate-600">{fmtDate(l.dos)}</td>
                <td className="px-2.5 py-2 text-slate-600">{fmtDate(l.transactionDate)}</td>
                <td className="px-2.5 py-2 text-slate-600">{l.procedureCode || "—"}</td>
                <td className="px-2.5 py-2 text-slate-600">{l.cpt}</td>
                <td className="px-2.5 py-2 text-slate-600">{l.physician || "—"}</td>
                <td className="px-2.5 py-2 text-slate-600">{l.insuranceName || "Unassigned"}</td>
                <td className="px-2.5 py-2 text-right">{centsToMoney(l.charge)}</td>
                <td className="px-2.5 py-2 text-right">{centsToMoney(l.insurancePaid)}</td>
                <td className="px-2.5 py-2 text-right">{centsToMoney(l.adjustment)}</td>
                <td className="px-2.5 py-2 text-right">{centsToMoney(l.copay)}</td>
                <td className="px-2.5 py-2 text-right">{centsToMoney(l.deductible)}</td>
                <td className="px-2.5 py-2 text-right">{centsToMoney(l.patientPaid)}</td>
                <td className="px-2.5 py-2 text-right font-medium">{centsToMoney(l.selfPay)}</td>
              </tr>
            ))}
            {!hasLines && (
              <tr><td colSpan={13} className="px-3 py-6 text-center text-slate-400">No activity in this period. The statement will print as a zero-balance notice.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-2 gap-4 mt-4">
        <div>
          {st.insurers?.length > 0 && (
            <>
              <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1.5">Insurance activity</div>
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <tbody>
                    {st.insurers.map(i => (
                      <tr key={i.name} className="border-b border-slate-100 last:border-0">
                        <td className="px-2.5 py-1.5 text-slate-700">{i.name}</td>
                        <td className="px-2.5 py-1.5 text-right text-slate-500">paid {centsToMoney(i.paid)}</td>
                        <td className="px-2.5 py-1.5 text-right text-slate-500">pt resp {centsToMoney(i.patientBalance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {st.physicians?.length > 0 && (
            <p className="text-[11px] text-slate-400 mt-2">
              {st.physicians.map(p => `${p.name}${p.hasSignature ? "" : " (no signature on file)"}`).join(" · ")}
            </p>
          )}
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1.5">Financial summary</div>
          <div className="border border-slate-200 rounded-lg px-3 py-2 text-sm">
            {[
              ["Total charges", st.totals.charges],
              ["Insurance paid", -st.totals.insurancePaid],
              ["Adjustments", -st.totals.adjustments],
              ["Patient payments", -st.totals.patientPayments],
            ].map(([label, v]) => (
              <div key={label} className="flex justify-between py-0.5">
                <span className="text-slate-500">{label}</span>
                <span className="text-slate-700">{centsToMoney(v)}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-slate-200 mt-1.5 pt-1.5 font-semibold">
              <span>Amount due</span>
              <span>{centsToMoney(st.totals.amountDue)}</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              Of which copay {centsToMoney(st.totals.copay)} and deductible {centsToMoney(st.totals.deductible)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function basisLabelFor(basis) {
  return basis === "transaction" ? "Transaction date" : "Date of service";
}

function PatientBilling({
  patient, charges, claims, policies, insurances, idDocuments, auditLogs, patientMemos, appointments, allPatients, allCharges, patientById, patientCreditBalances, insuranceCreditBalances, session,
  onBack, onUpdatePatient, onAddCharge, onGenerateClaim,
  onAddInsurance, onEditInsurance, onSetPriority, onEndCoverage, onUploadCard, onUploadIdDoc, onDeleteIdDoc,
  onAddPatientMemo, onAddAppointment, onPostCheck, onPostCard, onPostInsuranceCredit, onPostPatientCredit,
  onWriteOffDOS, onCreditDOS, onSelectChargeInsurance, onSetSelfPay, onEditClaimFields, onAddFollowUp, onDebitPosting, onApplyCreditBalance,
  hasOpenBatch, onCreateTickler,
}) {
  const [pageTab, setPageTab] = useState("demography");
  const totalBalance = charges.reduce((s, c) => s + Math.max(0, balanceOf(c)), 0);
  const totalOverpaid = charges.reduce((s, c) => s + Math.max(0, -balanceOf(c)), 0);
  const activePolicies = policies.filter(p => p.status === "Active").sort((a, b) => a.priority.localeCompare(b.priority));

  const pageTabs = [
    { id: "demography", label: "Demography", icon: Users },
    { id: "insurance", label: "Insurance", icon: Shield },
    { id: "memo", label: "Memo", icon: MessageSquarePlus },
    { id: "claimledger", label: "Claim / Ledger", icon: Receipt },
    { id: "appointment", label: "Appointment", icon: CalendarDays },
    { id: "documents", label: "ID Documents", icon: IdCard },
    { id: "audit", label: "Audit History", icon: History },
  ];

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4">
        <ChevronLeft size={15} /> Back to billing search
      </button>

      {/* Patient context header — stays visible across every secondary-nav section */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-xs text-slate-400 mb-0.5">Patient</div>
          <h1 className="text-xl font-semibold text-slate-800">{patient.name}</h1>
          <p className="text-xs text-slate-500">MRN {patient.id} · DOB {fmtDate(patient.dob)}</p>
          <div className="flex gap-1.5 mt-1.5">
            {activePolicies.map(pol => (
              <span key={pol.id} className="flex items-center gap-1 text-xs bg-slate-50 border border-slate-200 rounded-full px-2 py-0.5">
                <PriorityBadge priority={pol.priority} /> {pol.insuranceCompany}
              </span>
            ))}
            {activePolicies.length === 0 && <span className="text-xs text-slate-400">Self-pay — no active insurance</span>}
          </div>
        </div>
        <div className={`text-right ${totalBalance > 0 ? "text-rose-600" : "text-slate-700"}`}>
          <div className="text-2xl font-semibold">{money(totalBalance)}</div>
          <div className="text-xs text-slate-400">Total balance due</div>
          {totalOverpaid > BALANCE_EPSILON && (
            <div className="flex items-center justify-end gap-1 text-xs text-violet-700 font-medium mt-1">
              <StatusPill status="Overpayment" /> {money(totalOverpaid)} owed back
            </div>
          )}
        </div>
      </div>

      {/* Secondary navigation — belongs to the selected patient */}
      <div className="flex items-center gap-1 mb-5 border border-slate-200 bg-white rounded-lg p-1 w-fit flex-wrap">
        {pageTabs.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setPageTab(t.id)} className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md whitespace-nowrap ${pageTab === t.id ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}>
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {pageTab === "demography" && <DemographyTab patient={patient} onUpdatePatient={onUpdatePatient} />}

      {pageTab === "insurance" && (
        <PatientInsuranceTab
          policies={policies}
          insurances={insurances}
          onAdd={onAddInsurance} onEdit={onEditInsurance} onSetPriority={onSetPriority}
          onEndCoverage={onEndCoverage} onUploadCard={onUploadCard}
        />
      )}

      {pageTab === "memo" && <MemoTab memos={patientMemos} onAdd={onAddPatientMemo} />}

      {pageTab === "claimledger" && (
        <ClaimLedgerTab
          patientId={patient.id} charges={charges} allCharges={allCharges} allPatients={allPatients} patientById={patientById}
          claims={claims} policies={policies} session={session}
          patientCreditBalances={patientCreditBalances} insuranceCreditBalances={insuranceCreditBalances}
          onAddCharge={onAddCharge} onGenerateClaim={onGenerateClaim}
          onPostCheck={onPostCheck} onPostCard={onPostCard} onPostInsuranceCredit={onPostInsuranceCredit} onPostPatientCredit={onPostPatientCredit}
          onWriteOffDOS={onWriteOffDOS} onCreditDOS={onCreditDOS}
          onSelectChargeInsurance={onSelectChargeInsurance} onSetSelfPay={onSetSelfPay}
          onEditClaimFields={onEditClaimFields} onAddFollowUp={onAddFollowUp} onDebitPosting={onDebitPosting} onApplyCreditBalance={onApplyCreditBalance}
          hasOpenBatch={hasOpenBatch} onCreateTickler={onCreateTickler}
        />
      )}

      {pageTab === "appointment" && (
        <AppointmentTab appointments={appointments} patient={patient} allPatients={allPatients} onAdd={onAddAppointment} />
      )}

      {pageTab === "documents" && (
        <PatientIdDocuments
          documents={idDocuments}
          onUpload={onUploadIdDoc}
          onDelete={onDeleteIdDoc}
          canManage={["SUPER_ADMIN", "MANAGER", "BILLER"].includes(session.role)}
        />
      )}

      {pageTab === "audit" && <AuditHistory auditLogs={auditLogs} />}
    </div>
  );
}

// ---------- Patient billing: Demography tab ----------

function DemographyTab({ patient, onUpdatePatient }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(patient);
  function save() { onUpdatePatient(form); setEditing(false); }

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-slate-700">Demographics</h3>
        {!editing ? (
          <button onClick={() => { setForm(patient); setEditing(true); }} className="text-xs text-teal-700 flex items-center gap-1"><Pencil size={12} /> Edit</button>
        ) : (
          <div className="flex gap-2">
            <button onClick={save} className="text-xs text-teal-700 font-medium">Save</button>
            <button onClick={() => setEditing(false)} className="text-xs text-slate-400">Cancel</button>
          </div>
        )}
      </div>
      {!editing ? (
        <div className="grid grid-cols-4 gap-y-3 text-sm">
          <div><span className="text-slate-400 text-xs block">Name</span>{patient.name}</div>
          <div><span className="text-slate-400 text-xs block">DOB</span>{fmtDate(patient.dob)}</div>
          <div><span className="text-slate-400 text-xs block">Phone</span>{patient.phone}</div>
          <div><span className="text-slate-400 text-xs block">Email</span>{patient.email}</div>
          <div><span className="text-slate-400 text-xs block">SSN</span>{maskSSN(patient.ssn)}</div>
          <div><span className="text-slate-400 text-xs block">Address</span>{patient.address}, {patient.city}, {patient.state} {patient.zip}</div>
          <div><span className="text-slate-400 text-xs block">Emergency contact</span>{patient.emergencyContact?.name} ({patient.emergencyContact?.relationship}) {patient.emergencyContact?.phone}</div>
          <div><span className="text-slate-400 text-xs block">Guarantor</span>{patient.guarantor?.name} · {patient.guarantor?.employer}</div>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-3">
          <Field label="Name"><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="DOB"><input type="date" className={inputCls} value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} /></Field>
          <Field label="Phone"><input className={inputCls} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Email"><input className={inputCls} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="SSN"><input className={inputCls} value={form.ssn || ""} onChange={(e) => setForm({ ...form, ssn: e.target.value })} /></Field>
          <Field label="Address"><input className={inputCls} value={form.address || ""} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
          <Field label="City"><input className={inputCls} value={form.city || ""} onChange={(e) => setForm({ ...form, city: e.target.value })} /></Field>
          <Field label="State"><input className={inputCls} value={form.state || ""} onChange={(e) => setForm({ ...form, state: e.target.value })} /></Field>
        </div>
      )}
    </Card>
  );
}

// ---------- Patient billing: Memo tab (patient-level, distinct from per-DOS follow-ups) ----------

function MemoTab({ memos, onAdd }) {
  const [text, setText] = useState("");
  const sorted = [...memos].sort((a, b) => b.date.localeCompare(a.date));
  function submit() {
    if (!text.trim()) return;
    onAdd(text.trim());
    setText("");
  }
  return (
    <div>
      <Card className="p-4 mb-4">
        <h3 className="font-medium text-slate-700 mb-2">Add a memo</h3>
        <textarea className={`${inputCls} h-20 resize-none`} placeholder="Billing/administrative note about this patient…" value={text} onChange={(e) => setText(e.target.value)} />
        <button onClick={submit} className="mt-2 bg-teal-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-teal-700">Save memo</button>
      </Card>
      <div className="space-y-2">
        {sorted.map(m => (
          <Card key={m.id} className="p-3">
            <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
              <span>{m.user}</span><span>{fmtDate(m.date)}</span>
            </div>
            <p className="text-sm text-slate-700">{m.text}</p>
          </Card>
        ))}
        {sorted.length === 0 && <p className="text-sm text-slate-400">No memos on file for this patient.</p>}
      </div>
    </div>
  );
}

// ---------- Patient billing: Appointment tab ----------

function AppointmentTab({ appointments, patient, allPatients, onAdd }) {
  const [showAdd, setShowAdd] = useState(false);
  const sorted = [...appointments].sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-slate-700">Appointments</h3>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 bg-teal-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-teal-700"><Plus size={13} /> New appointment</button>
      </div>
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5 font-medium">Date</th><th className="px-4 py-2.5 font-medium">Time</th>
              <th className="px-4 py-2.5 font-medium">Provider</th><th className="px-4 py-2.5 font-medium">Type</th><th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(a => (
              <tr key={a.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2.5 text-slate-600">{fmtDate(a.date)}</td>
                <td className="px-4 py-2.5 text-slate-600">{a.time}</td>
                <td className="px-4 py-2.5 text-slate-600">{a.provider}</td>
                <td className="px-4 py-2.5 text-slate-600">{a.type}</td>
                <td className="px-4 py-2.5"><StatusPill status={a.status} /></td>
              </tr>
            ))}
            {sorted.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">No appointments on file.</td></tr>}
          </tbody>
        </table>
      </Card>
      {showAdd && (
        <Modal title="New appointment" onClose={() => setShowAdd(false)}>
          <AddApptForm patients={[patient, ...allPatients.filter(p => p.id !== patient.id)]} onSubmit={(entry) => { onAdd(entry); setShowAdd(false); }} />
        </Modal>
      )}
    </div>
  );
}

// ---------- Patient billing: Claim / Ledger tab ----------
// Div 1 = DOS/claim summary table (left-click selects, right-click opens the custom context menu).
// Div 2 = per-DOS posting/payment/follow-up detail for whichever charge is selected.

function ClaimLedgerTab({
  patientId, charges, allCharges, allPatients, patientById, claims, policies, session, onAddCharge, onGenerateClaim,
  onPostCheck, onPostCard, onPostInsuranceCredit, onPostPatientCredit,
  onWriteOffDOS, onCreditDOS, onSelectChargeInsurance, onSetSelfPay, onEditClaimFields, onAddFollowUp, onDebitPosting,
  patientCreditBalances, insuranceCreditBalances, onApplyCreditBalance, hasOpenBatch, onCreateTickler,
}) {
  const [selectedId, setSelectedId] = useState(charges[0]?.id || null);
  const [menu, setMenu] = useState(null); // { x, y, chargeId }
  const [showAddCharge, setShowAddCharge] = useState(false);
  const [showStatement, setShowStatement] = useState(false);
  const [dialog, setDialog] = useState(null); // { type, chargeId }
  const [applyPool, setApplyPool] = useState(null); // 'patient' | 'insurance' | null

  const sorted = [...charges].sort((a, b) => b.dos.localeCompare(a.dos));
  const selected = charges.find(c => c.id === selectedId) || sorted[0];
  const hasClaim = (chargeId) => claims.some(cl => cl.chargeId === chargeId);

  const totalCharge = charges.reduce((s, c) => s + c.charge, 0);
  const totalBalanceDue = charges.reduce((s, c) => s + Math.max(0, balanceOf(c)), 0);
  const totalOverpayment = charges.reduce((s, c) => s + Math.max(0, -balanceOf(c)), 0);
  const myPatientCredits = patientCreditBalances.filter(c => c.patientId === patientId && c.remaining > 0);
  const relevantInsurerNames = new Set(policies.map(p => p.insuranceCompany));
  const myInsuranceCredits = insuranceCreditBalances.filter(c => relevantInsurerNames.has(c.insuranceName) && c.remaining > 0);
  const patientCreditTotal = myPatientCredits.reduce((s, c) => s + c.remaining, 0);
  const insuranceCreditTotal = myInsuranceCredits.reduce((s, c) => s + c.remaining, 0);

  function openMenu(e, chargeId) {
    e.preventDefault();
    const wrapWidth = 220, wrapHeight = 340;
    const x = Math.min(e.clientX, window.innerWidth - wrapWidth - 12);
    const y = Math.min(e.clientY, window.innerHeight - wrapHeight - 12);
    setMenu({ x, y, chargeId });
  }

  function closeMenuAnd(fn) { setMenu(null); if (fn) fn(); }

  return (
    <div onClick={() => menu && setMenu(null)}>
      {showStatement && (
        <StatementWizard
          patient={patientById[patientId] || { id: patientId, name: patientId }}
          onClose={() => setShowStatement(false)}
        />
      )}

      {/* ---------- DIV 1: DOS / claim summary ---------- */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-slate-700">DOS / claim summary</h3>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowStatement(true)} className="flex items-center gap-1.5 border border-slate-300 text-slate-700 text-xs px-3 py-1.5 rounded-lg hover:bg-slate-50"><FileText size={13} /> Generate statement</button>
          <button onClick={() => setShowAddCharge(true)} className="flex items-center gap-1.5 bg-teal-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-teal-700"><Plus size={13} /> Add charge</button>
        </div>
      </div>
      <Card className="mb-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200 sticky top-0 bg-white">
              <th className="px-4 py-2.5 font-medium">DOS</th>
              <th className="px-4 py-2.5 font-medium">CPT</th>
              <th className="px-4 py-2.5 font-medium text-right">Charge</th>
              <th className="px-4 py-2.5 font-medium text-right">Payment</th>
              <th className="px-4 py-2.5 font-medium text-right">Adjustment</th>
              <th className="px-4 py-2.5 font-medium text-right">Remaining balance</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Physician</th>
              <th className="px-4 py-2.5 font-medium">Referral physician</th>
              <th className="px-4 py-2.5 font-medium">Payer</th>
              <th className="px-4 py-2.5 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(c => {
              const bal = balanceOf(c);
              const isSelected = selected && c.id === selected.id;
              return (
                <tr
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  onContextMenu={(e) => { e.stopPropagation(); openMenu(e, c.id); }}
                  className={`border-b border-slate-100 last:border-0 cursor-pointer select-none ${isSelected ? "bg-teal-50/70" : "hover:bg-slate-50"}`}
                >
                  <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">{fmtDate(c.dos)}</td>
                  <td className="px-4 py-2.5 font-medium text-slate-800">{c.cpt}</td>
                  <td className="px-4 py-2.5 text-right">{money(c.charge)}</td>
                  <td className="px-4 py-2.5 text-right text-emerald-700">{money(c.paid)}</td>
                  <td className="px-4 py-2.5 text-right text-slate-500">{money(c.writeoff + (c.credits || 0))}</td>
                  <td className={`px-4 py-2.5 text-right font-medium whitespace-nowrap ${bal < -BALANCE_EPSILON ? "text-violet-700" : bal > BALANCE_EPSILON ? "text-rose-600" : "text-slate-700"}`}>
                    {money(bal)}
                  </td>
                  <td className="px-4 py-2.5"><StatusPill status={chargeStatus(c)} /></td>
                  <td className="px-4 py-2.5 text-slate-600">{c.provider}</td>
                  <td className="px-4 py-2.5 text-slate-500">{c.referralPhysician || "—"}</td>
                  <td className="px-4 py-2.5 text-slate-600">{payerLabel(c, policies)}</td>
                  <td className="px-4 py-2.5">
                    <button onClick={(e) => { e.stopPropagation(); openMenu(e, c.id); }} className="text-slate-400 hover:text-slate-700 px-1" title="More actions (or right-click the row)">⋯</button>
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && <tr><td colSpan={11} className="px-4 py-6 text-center text-slate-400">No charges on file yet.</td></tr>}
          </tbody>
        </table>
      </Card>

      {/* ---------- DIV 2: per-DOS details ---------- */}
      {selected && <PerDosDetails charge={selected} claims={claims} policies={policies} hasClaim={hasClaim(selected.id)} onGenerateClaim={onGenerateClaim} onDebitPosting={onDebitPosting} />}

      {/* ---------- Bottom summary: totals + applicable credit balances ---------- */}
      <div className="grid grid-cols-4 gap-3 mt-6">
        <Card className="p-3">
          <div className="text-xs text-slate-400">Total charge</div>
          <div className="text-lg font-semibold text-slate-800">{money(totalCharge)}</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-slate-400">Balance due</div>
          <div className={`text-lg font-semibold ${totalBalanceDue > 0 ? "text-rose-600" : "text-slate-800"}`}>{money(totalBalanceDue)}</div>
          {totalOverpayment > BALANCE_EPSILON && (
            <div className="flex items-center gap-1 text-xs text-violet-700 font-medium mt-1">
              <StatusPill status="Overpayment" /> {money(totalOverpayment)} owed back
            </div>
          )}
        </Card>
        <Card className="p-3">
          <div className="text-xs text-slate-400">Patient credit balance</div>
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold text-emerald-700">{money(patientCreditTotal)}</div>
            {patientCreditTotal > 0 && <button onClick={() => setApplyPool("patient")} className="text-xs text-teal-700 border border-teal-200 bg-teal-50 rounded-lg px-2 py-1 hover:bg-teal-100">Apply</button>}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-slate-400">Insurance credit balance</div>
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold text-emerald-700">{money(insuranceCreditTotal)}</div>
            {insuranceCreditTotal > 0 && <button onClick={() => setApplyPool("insurance")} className="text-xs text-teal-700 border border-teal-200 bg-teal-50 rounded-lg px-2 py-1 hover:bg-teal-100">Apply</button>}
          </div>
        </Card>
      </div>

      {menu && (
        <DOSContextMenu
          x={menu.x} y={menu.y}
          hasOpenBatch={hasOpenBatch}
          onClose={() => setMenu(null)}
          onAction={(type) => closeMenuAnd(() => setDialog({ type, chargeId: menu.chargeId }))}
          onCreateTickler={() => closeMenuAnd(() => {
            const c = charges.find(ch => ch.id === menu.chargeId);
            if (!c) return;
            const linkedClaim = claims.find(cl => cl.chargeId === c.id);
            onCreateTickler({
              patientId: c.patientId, patientName: patientById[c.patientId]?.name || "",
              dos: c.dos, cpt: c.cpt, claimId: linkedClaim?.id || "",
              title: `${c.cpt} — ${fmtDate(c.dos)}`,
            });
          })}
        />
      )}

      {showAddCharge && (
        <Modal title="Add charge" onClose={() => setShowAddCharge(false)} wide>
          <AddChargeForm onSubmit={(entry) => { onAddCharge(entry); setShowAddCharge(false); }} />
        </Modal>
      )}

      {dialog && (
        <ChargeActionDialog
          dialog={dialog}
          charge={charges.find(c => c.id === dialog.chargeId)}
          policies={policies}
          onClose={() => setDialog(null)}
          onPostCheck={onPostCheck} onPostCard={onPostCard} onPostInsuranceCredit={onPostInsuranceCredit} onPostPatientCredit={onPostPatientCredit}
          onWriteOffDOS={onWriteOffDOS} onCreditDOS={onCreditDOS}
          onSelectChargeInsurance={onSelectChargeInsurance} onSetSelfPay={onSetSelfPay} onEditClaimFields={onEditClaimFields} onAddFollowUp={onAddFollowUp}
        />
      )}

      {applyPool && (
        <Modal title={`Apply ${applyPool === "patient" ? "patient" : "insurance"} credit balance`} onClose={() => setApplyPool(null)} wide>
          <ApplyCreditBalanceForm
            poolType={applyPool}
            credits={applyPool === "patient" ? myPatientCredits : myInsuranceCredits}
            allCharges={allCharges} allPatients={allPatients} patientById={patientById}
            onSubmit={(creditId, targetChargeId, amount) => { onApplyCreditBalance(applyPool, creditId, targetChargeId, amount); setApplyPool(null); }}
            onClose={() => setApplyPool(null)}
          />
        </Modal>
      )}
    </div>
  );
}

function DOSContextMenu({ x, y, onClose, onAction, hasOpenBatch, onCreateTickler }) {
  const [paymentOpen, setPaymentOpen] = useState(true);

  React.useEffect(() => {
    function handleKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const itemCls = "w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 rounded-md flex items-center gap-2";
  const disabledItemCls = "w-full text-left px-3 py-1.5 text-sm text-slate-300 rounded-md flex items-center gap-2 cursor-not-allowed";
  const moneyItemCls = hasOpenBatch ? itemCls : disabledItemCls;
  const moneyAction = (type) => hasOpenBatch && onAction(type);

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ position: "fixed", left: x, top: y, width: 230, zIndex: 100 }}
      className="bg-white border border-slate-200 rounded-xl shadow-xl p-1.5"
    >
      {!hasOpenBatch && (
        <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 mb-1">Open your batch to post payments/adjustments</div>
      )}
      <button onClick={() => setPaymentOpen(o => !o)} className={itemCls + " font-medium justify-between"}>
        <span className="flex items-center gap-2"><CreditCard size={13} /> Post Payment</span>
        <span className="text-slate-400">{paymentOpen ? "▾" : "▸"}</span>
      </button>
      {paymentOpen && (
        <div className="pl-4 border-l border-slate-100 ml-3 mb-1">
          <button onClick={() => moneyAction("check")} className={moneyItemCls}>Check</button>
          <button onClick={() => moneyAction("card")} className={moneyItemCls}>Credit Card</button>
          <button onClick={() => moneyAction("insurance")} className={moneyItemCls}>Insurance Credit</button>
          <button onClick={() => moneyAction("patient")} className={moneyItemCls}>Patient Credit</button>
        </div>
      )}
      <div className="border-t border-slate-100 my-1" />
      <button onClick={() => moneyAction("writeoff")} className={moneyItemCls}><ScissorsLineDashed size={13} /> Write Off</button>
      <button onClick={() => moneyAction("creditdos")} className={moneyItemCls}><TrendingDown size={13} /> Credit Date of Service</button>
      <button onClick={() => onAction("selectinsurance")} className={itemCls}><Shield size={13} /> Select Insurance</button>
      <button onClick={() => onAction("self")} className={itemCls}><Users size={13} /> Self</button>
      <div className="border-t border-slate-100 my-1" />
      <button onClick={() => onAction("editclaim")} className={itemCls}><Pencil size={13} /> Edit Claim</button>
      <button onClick={() => onAction("followup")} className={itemCls}><MessageSquarePlus size={13} /> Add Follow-Up</button>
      <button onClick={onCreateTickler} className={itemCls}><Bell size={13} /> Create Tickler</button>
    </div>
  );
}

function PerDosDetails({ charge, claims, policies, hasClaim, onGenerateClaim, onDebitPosting }) {
  const latestPosting = charge.postings && charge.postings.length ? charge.postings[charge.postings.length - 1] : null;
  const followUps = [...(charge.memos || [])].reverse();
  const linkedClaim = claims.find(cl => cl.chargeId === charge.id);
  const [debitTarget, setDebitTarget] = useState(null); // posting being debited

  const debitablePostings = new Set(["Check", "Credit Card", "Insurance Credit", "Patient Credit"]);
  function remainingDebitable(p) { return Math.max(0, p.amount - (p.debited || 0)); }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-slate-700">Per-DOS details — {fmtDate(charge.dos)} · {charge.cpt}</h3>
        {!hasClaim && <button onClick={() => onGenerateClaim(charge)} className="text-xs text-sky-700 border border-sky-200 bg-sky-50 rounded-lg px-2.5 py-1.5 hover:bg-sky-100">Generate claim</button>}
        {linkedClaim && <StatusPill status={linkedClaim.status} />}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card className="p-4">
          <SectionTitle>Latest posting</SectionTitle>
          {latestPosting ? (
            <div className="grid grid-cols-2 gap-y-2 text-sm">
              <div><span className="text-slate-400 text-xs block">Type</span>{latestPosting.type}</div>
              <div><span className="text-slate-400 text-xs block">Amount</span>{money(latestPosting.amount)}</div>
              {latestPosting.checkNumber && <div><span className="text-slate-400 text-xs block">Check number</span>{latestPosting.checkNumber}</div>}
              {latestPosting.depositDate && <div><span className="text-slate-400 text-xs block">Deposit date</span>{fmtDate(latestPosting.depositDate)}</div>}
              {latestPosting.insuranceName && <div><span className="text-slate-400 text-xs block">Insurance</span>{latestPosting.insuranceName}</div>}
              {latestPosting.reference && <div><span className="text-slate-400 text-xs block">Reference</span>{latestPosting.reference}</div>}
              <div><span className="text-slate-400 text-xs block">Posted by</span>{latestPosting.postedBy}</div>
              <div><span className="text-slate-400 text-xs block">Posted at</span>{fmtDateTime(latestPosting.postedAt)}</div>
            </div>
          ) : <p className="text-xs text-slate-400">No postings recorded for this DOS yet.</p>}

          {(latestPosting?.copay || latestPosting?.coinsurance || latestPosting?.deductible || latestPosting?.allowedAmount) && (
            <>
              <SectionTitle>Financial posting</SectionTitle>
              <div className="grid grid-cols-2 gap-y-2 text-sm">
                <div><span className="text-slate-400 text-xs block">Copay</span>{money(Number(latestPosting.copay || 0))}</div>
                <div><span className="text-slate-400 text-xs block">Coinsurance</span>{money(Number(latestPosting.coinsurance || 0))}</div>
                <div><span className="text-slate-400 text-xs block">Deductible</span>{money(Number(latestPosting.deductible || 0))}</div>
                <div><span className="text-slate-400 text-xs block">Allowed amount</span>{money(Number(latestPosting.allowedAmount || 0))}</div>
              </div>
            </>
          )}

          <SectionTitle>Claim details</SectionTitle>
          <div className="grid grid-cols-2 gap-y-2 text-sm mb-1">
            <div><span className="text-slate-400 text-xs block">Practice / facility</span>{charge.facilityName || "—"}</div>
            <div><span className="text-slate-400 text-xs block">Physician NPI</span>{charge.npi || "—"}</div>
            <div className="col-span-2"><span className="text-slate-400 text-xs block">Facility address</span>{charge.facilityAddress || "—"}</div>
            <div><span className="text-slate-400 text-xs block">Tax ID</span>{charge.taxId || "—"}</div>
            <div><span className="text-slate-400 text-xs block">Units / Time</span>{charge.units || 1}{charge.time ? ` · ${charge.time} min` : ""}</div>
            {charge.ndc && <div><span className="text-slate-400 text-xs block">NDC</span>{charge.ndc}</div>}
          </div>
          {charge.diagnosisCodes?.some(d => d) && (
            <div className="mb-1">
              <span className="text-slate-400 text-xs block mb-1">Diagnosis codes</span>
              <div className="flex flex-wrap gap-1">
                {charge.diagnosisCodes.filter(d => d).map((d, i) => (
                  <span key={i} className="text-xs bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5">{d}</span>
                ))}
              </div>
            </div>
          )}

          <SectionTitle>Totals</SectionTitle>
          <div className="grid grid-cols-2 gap-y-2 text-sm">
            <div><span className="text-slate-400 text-xs block">Charge</span>{money(charge.charge)}</div>
            <div><span className="text-slate-400 text-xs block">Adjusted (paid + write-off + credit)</span>{money(adjustedOf(charge))}</div>
            <div className="col-span-2">
              <span className="text-slate-400 text-xs block">Remaining balance</span>
              <span className="flex items-center gap-2">
                <span className={
                  balanceOf(charge) < -BALANCE_EPSILON ? "text-violet-700 font-semibold" :
                  balanceOf(charge) > BALANCE_EPSILON ? "text-rose-600 font-medium" : "text-slate-700"
                }>{money(balanceOf(charge))}</span>
                <StatusPill status={chargeStatus(charge)} />
              </span>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <SectionTitle>Follow-up history</SectionTitle>
          <div className="space-y-1.5 max-h-56 overflow-y-auto">
            {followUps.map((f, i) => (
              <div key={i} className={`text-xs border rounded-lg px-2.5 py-2 ${f.type === "System Debit" ? "border-rose-200 bg-rose-50" : "border-slate-100"}`}>
                <div className="flex items-center justify-between text-slate-400 mb-0.5">
                  <span className={f.type === "System Debit" ? "text-rose-600 font-medium" : ""}>{f.type || "Note"} · {f.user}</span><span>{fmtDate(f.date)}</span>
                </div>
                <div className="text-slate-700">{f.text}</div>
                {f.nextFollowUpDate && <div className="text-slate-400 mt-1">Next follow-up: {fmtDate(f.nextFollowUpDate)}</div>}
              </div>
            ))}
            {followUps.length === 0 && <p className="text-xs text-slate-400">No follow-ups recorded.</p>}
          </div>

          <SectionTitle>Posting history</SectionTitle>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {(charge.postings || []).slice().reverse().map(p => {
              const canDebit = debitablePostings.has(p.type) && remainingDebitable(p) > 0;
              return (
                <div key={p.id} className="border border-slate-100 rounded-lg px-2.5 py-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className={p.type === "Debit" ? "text-rose-600 font-medium" : ""}>{p.type}{p.type === "Debit" ? ` — ${p.reason}` : ""}</span>
                    <span className={`font-medium ${p.type === "Debit" ? "text-rose-600" : "text-emerald-700"}`}>{p.type === "Debit" ? "-" : ""}{money(p.amount)}</span>
                    <span className="text-slate-400">{fmtDate(p.date)}</span>
                  </div>
                  {canDebit && (
                    <button onClick={() => setDebitTarget(p)} className="mt-1 text-[11px] text-rose-600 border border-rose-200 bg-rose-50 rounded-md px-2 py-0.5 hover:bg-rose-100">
                      Debit {(p.debited || 0) > 0 ? `(${money(remainingDebitable(p))} left)` : ""}
                    </button>
                  )}
                </div>
              );
            })}
            {(!charge.postings || charge.postings.length === 0) && <p className="text-xs text-slate-400">No postings yet.</p>}
          </div>
        </Card>
      </div>

      {debitTarget && (
        <Modal title={`Debit posting · ${debitTarget.type} on ${fmtDate(charge.dos)}`} onClose={() => setDebitTarget(null)}>
          <DebitPostingForm
            posting={debitTarget}
            max={remainingDebitable(debitTarget)}
            onSubmit={(form) => { onDebitPosting(charge.id, debitTarget.id, form); setDebitTarget(null); }}
          />
        </Modal>
      )}
    </div>
  );
}

function DebitPostingForm({ posting, max, onSubmit }) {
  const kind = postingPayerKind(posting);
  const debitTypeOptions = kind === "insurance" ? ["Insurance Refund", "Insurance Credit Balance"] : ["Patient Refund", "Patient Credit Balance"];
  const [mode, setMode] = useState("debit"); // "debit" (reason required, keeps history) | "system" (no reason, removes the posting)
  const [f, setF] = useState({ amount: String(max), debitType: debitTypeOptions[0], reason: debitReasons[0], date: TODAY, notes: "" });
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  function requestSubmit() {
    if (mode === "system") { setError(""); setConfirming(true); return; }
    const amt = Number(f.amount);
    if (!amt || amt <= 0) { setError("Enter a debit amount greater than 0."); return; }
    if (amt > max) { setError(`Cannot debit more than ${money(max)} — the remaining amount on this posting.`); return; }
    setError("");
    setConfirming(true);
  }

  function confirmSubmit() {
    onSubmit(mode === "system" ? { systemDebit: true } : f);
  }

  if (confirming) {
    return (
      <div>
        <div className="flex items-center gap-2 text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 mb-4 text-sm">
          <AlertTriangle size={16} className="shrink-0" />
          {mode === "system" ? (
            <span>You're about to <strong>system debit</strong> this posting — <strong>{posting.type} {money(max)}</strong> posted {fmtDate(posting.date)}. It will be removed entirely, along with its recorded payment — no reason is captured, and this cannot be undone.</span>
          ) : (
            <span>You're about to debit <strong>{money(Number(f.amount))}</strong> as <strong>{f.debitType}</strong> ({f.reason}). This reduces the recorded payment on this posting and cannot be undone. Continue?</span>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={() => setConfirming(false)} className="flex-1 border border-slate-200 text-slate-600 text-sm font-medium py-2 rounded-lg hover:bg-slate-50">Go back</button>
          <button onClick={confirmSubmit} className="flex-1 bg-rose-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-rose-700">{mode === "system" ? "Confirm system debit" : "Confirm debit"}</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-1 mb-4 border border-slate-200 bg-white rounded-lg p-1 w-fit">
        <button onClick={() => { setMode("debit"); setError(""); }} className={`px-3 py-1.5 text-sm rounded-md ${mode === "debit" ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}>Debit</button>
        <button onClick={() => { setMode("system"); setError(""); }} className={`px-3 py-1.5 text-sm rounded-md ${mode === "system" ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}>System Debit</button>
      </div>

      <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-4">
        Debiting <strong>{posting.type}</strong> posted {fmtDate(posting.date)} for {money(posting.amount)}. Up to <strong>{money(max)}</strong> is available to debit from this posting.
      </div>

      {mode === "system" ? (
        <>
          <p className="text-xs text-slate-500 mb-3">
            Use System Debit only to correct a posting that should never have existed — wrong patient, duplicate entry, mis-click. It removes this posting and its recorded payment entirely, for the full {money(max)} available. No reason is required, and no debit/credit pair is left behind in the ledger history.
          </p>
          {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
          <button onClick={requestSubmit} className="w-full bg-rose-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-rose-700">Review system debit</button>
        </>
      ) : (
        <>
          <AmountField label={`Debit amount (max ${money(max)})`} value={f.amount} onChange={set("amount")} />
          <Field label="Debit type">
            <select className={inputCls} value={f.debitType} onChange={set("debitType")}>{debitTypeOptions.map(o => <option key={o}>{o}</option>)}</select>
          </Field>
          <Field label="Reason">
            <select className={inputCls} value={f.reason} onChange={set("reason")}>{debitReasons.map(r => <option key={r}>{r}</option>)}</select>
          </Field>
          <Field label="Date"><input type="date" className={inputCls} value={f.date} onChange={set("date")} /></Field>
          <Field label="Notes"><textarea className={`${inputCls} h-16 resize-none`} value={f.notes} onChange={set("notes")} /></Field>
          {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
          <button onClick={requestSubmit} className="w-full bg-rose-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-rose-700">Review debit</button>
        </>
      )}
    </div>
  );
}


// ---------- Charge action dialogs (opened from the DOS context menu) ----------

function ChargeActionDialog({ dialog, charge, policies, onClose, onPostCheck, onPostCard, onPostInsuranceCredit, onPostPatientCredit, onWriteOffDOS, onCreditDOS, onSelectChargeInsurance, onSetSelfPay, onEditClaimFields, onAddFollowUp }) {
  if (!charge) return null;
  const bal = balanceOf(charge);

  const titles = {
    check: "Post payment — Check", card: "Post payment — Credit card", insurance: "Post payment — Insurance credit",
    patient: "Post payment — Patient credit", writeoff: "Write off", creditdos: "Credit date of service",
    selectinsurance: "Select insurance", self: "Change payer to Self / Patient", editclaim: "Edit claim", followup: "Add follow-up",
  };

  return (
    <Modal title={`${titles[dialog.type]} · ${fmtDate(charge.dos)}`} onClose={onClose} wide={dialog.type === "editclaim"}>
      <div className="flex items-center justify-between text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-4">
        <span>Charge {money(charge.charge)}</span>
        <span>Adjusted {money(adjustedOf(charge))}</span>
        <span className={bal < -BALANCE_EPSILON ? "text-violet-700 font-medium" : bal > BALANCE_EPSILON ? "text-rose-600 font-medium" : "font-medium"}>Remaining {money(bal)}</span>
      </div>

      {dialog.type === "check" && <CheckPaymentForm max={bal} onSubmit={(f) => { onPostCheck(charge.id, f); onClose(); }} />}
      {dialog.type === "card" && <CardPaymentForm max={bal} onSubmit={(f) => { onPostCard(charge.id, f); onClose(); }} />}
      {dialog.type === "insurance" && <InsuranceCreditForm max={bal} policies={policies} onSubmit={(f) => { onPostInsuranceCredit(charge.id, f); onClose(); }} />}
      {dialog.type === "patient" && <PatientCreditForm max={bal} onSubmit={(f) => { onPostPatientCredit(charge.id, f); onClose(); }} />}
      {dialog.type === "writeoff" && <WriteOffDOSForm max={bal} onSubmit={(f) => { onWriteOffDOS(charge.id, f); onClose(); }} />}
      {dialog.type === "creditdos" && <CreditDOSForm max={bal} onSubmit={(f) => { onCreditDOS(charge.id, f); onClose(); }} />}
      {dialog.type === "selectinsurance" && <SelectInsuranceForm policies={policies} current={charge.chargeInsuranceId} onSubmit={(id) => { onSelectChargeInsurance(charge.id, id); onClose(); }} />}
      {dialog.type === "self" && <SelfPayConfirm onConfirm={() => { onSetSelfPay(charge.id); onClose(); }} onCancel={onClose} />}
      {dialog.type === "editclaim" && <EditClaimForm charge={charge} onSubmit={(f) => { onEditClaimFields(charge.id, f); onClose(); }} />}
      {dialog.type === "followup" && <FollowUpForm onSubmit={(f) => { onAddFollowUp(charge.id, f); onClose(); }} />}
    </Modal>
  );
}

function ApplyCreditBalanceForm({ poolType, credits, allCharges, allPatients, patientById, onSubmit, onClose }) {
  const [creditId, setCreditId] = useState(credits[0]?.id || "");
  const [targetPatientId, setTargetPatientId] = useState("");
  const [targetChargeId, setTargetChargeId] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");

  const credit = credits.find(c => c.id === creditId);
  const targetOpenCharges = allCharges.filter(c => c.patientId === targetPatientId && balanceOf(c) > 0);
  const targetCharge = allCharges.find(c => c.id === targetChargeId);
  const maxApply = credit && targetCharge ? Math.min(credit.remaining, balanceOf(targetCharge)) : 0;

  function submit() {
    const amt = Number(amount);
    if (!credit) { setError("Select a credit balance to apply."); return; }
    if (!targetCharge) { setError("Select a patient and a charge to apply the credit toward."); return; }
    if (!amt || amt <= 0) { setError("Enter an amount greater than 0."); return; }
    if (amt > maxApply) { setError(`Cannot apply more than ${money(maxApply)} (limited by remaining credit and target balance).`); return; }
    setError("");
    onSubmit(creditId, targetChargeId, amt);
  }

  return (
    <div>
      <SectionTitle>Credit balance to apply</SectionTitle>
      <div className="space-y-2 mb-4">
        {credits.map(c => (
          <label key={c.id} className={`flex items-center justify-between border rounded-lg px-3 py-2 text-sm cursor-pointer ${creditId === c.id ? "border-teal-400 bg-teal-50/50" : "border-slate-200 hover:bg-slate-50"}`}>
            <span className="flex items-center gap-2">
              <input type="radio" name="credit" checked={creditId === c.id} onChange={() => setCreditId(c.id)} />
              <span>
                {poolType === "insurance" ? c.insuranceName : `From ${patientById[c.patientId]?.name || c.patientId}`} — {c.reason} · {fmtDate(c.date)}
              </span>
            </span>
            <span className="font-medium text-emerald-700">{money(c.remaining)} available</span>
          </label>
        ))}
      </div>

      <SectionTitle>Apply to</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Patient">
          <select className={inputCls} value={targetPatientId} onChange={(e) => { setTargetPatientId(e.target.value); setTargetChargeId(""); }}>
            <option value="">Select a patient…</option>
            {allPatients.map(p => <option key={p.id} value={p.id}>{p.name}{credit && p.id === credit.patientId ? " (originating patient)" : ""}</option>)}
          </select>
        </Field>
        <Field label="Open charge">
          <select className={inputCls} value={targetChargeId} onChange={(e) => setTargetChargeId(e.target.value)} disabled={!targetPatientId}>
            <option value="">Select a charge…</option>
            {targetOpenCharges.map(c => <option key={c.id} value={c.id}>{fmtDate(c.dos)} · {c.cpt} — balance {money(balanceOf(c))}</option>)}
          </select>
        </Field>
      </div>
      {targetPatientId && targetOpenCharges.length === 0 && <p className="text-xs text-slate-400 mb-3">This patient has no open balance to apply credit toward.</p>}

      <AmountField label={`Amount to apply${maxApply ? ` (max ${money(maxApply)})` : ""}`} value={amount} onChange={(e) => setAmount(e.target.value)} />
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <p className="text-xs text-slate-400 mb-3">Applying credit generated by one patient to another patient's account is intentionally supported here (e.g. family accounts) — it's logged to both patients' audit history.</p>
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Apply credit</button>
    </div>
  );
}

function AmountField({ label, value, onChange, hint }) {
  return <Field label={label} hint={hint}><input type="number" min="0" step="0.01" className={inputCls} value={value} onChange={onChange} placeholder="0.00" /></Field>;
}

function CheckPaymentForm({ max, onSubmit }) {
  const [f, setF] = useState({ amount: "", checkNumber: "", checkDate: TODAY, payer: "", insurance: "", depositDate: TODAY, paymentDate: TODAY, notes: "" });
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  function submit() {
    const amt = Number(f.amount);
    if (!amt || amt <= 0) { setError("Enter a payment amount greater than 0."); return; }
    if (!f.checkNumber.trim()) { setError("Check number is required."); return; }
    setError(""); onSubmit(f);
  }
  return (
    <div>
      <AmountField label={`Payment amount (balance ${money(max)})`} value={f.amount} onChange={set("amount")} />
      {Number(f.amount) > max + BALANCE_EPSILON && (
        <p className="text-xs text-violet-700 bg-violet-50 border border-violet-200 rounded-lg px-3 py-2 mb-3">
          This exceeds the remaining balance — it will post as an overpayment with a negative balance.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Check number"><input className={inputCls} value={f.checkNumber} onChange={set("checkNumber")} /></Field>
        <Field label="Check date"><input type="date" className={inputCls} value={f.checkDate} onChange={set("checkDate")} /></Field>
        <Field label="Payer"><input className={inputCls} value={f.payer} onChange={set("payer")} placeholder="Payer or patient name" /></Field>
        <Field label="Insurance"><input className={inputCls} value={f.insurance} onChange={set("insurance")} placeholder="If applicable" /></Field>
        <Field label="Deposit date"><input type="date" className={inputCls} value={f.depositDate} onChange={set("depositDate")} /></Field>
        <Field label="Payment date"><input type="date" className={inputCls} value={f.paymentDate} onChange={set("paymentDate")} /></Field>
      </div>
      <Field label="Notes"><textarea className={`${inputCls} h-16 resize-none`} value={f.notes} onChange={set("notes")} /></Field>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Post check payment</button>
    </div>
  );
}

function CardPaymentForm({ max, onSubmit }) {
  const [f, setF] = useState({ amount: "", paymentDate: TODAY, payer: "", reference: "", notes: "" });
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  function submit() {
    const amt = Number(f.amount);
    if (!amt || amt <= 0) { setError("Enter a payment amount greater than 0."); return; }
    setError(""); onSubmit(f);
  }
  return (
    <div>
      <p className="text-xs text-slate-400 mb-3">Only a reference/transaction number is stored — never a card number or CVV.</p>
      <AmountField label={`Payment amount (balance ${money(max)})`} value={f.amount} onChange={set("amount")} />
      {Number(f.amount) > max + BALANCE_EPSILON && (
        <p className="text-xs text-violet-700 bg-violet-50 border border-violet-200 rounded-lg px-3 py-2 mb-3">
          This exceeds the remaining balance — it will post as an overpayment with a negative balance.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Payment date"><input type="date" className={inputCls} value={f.paymentDate} onChange={set("paymentDate")} /></Field>
        <Field label="Payer"><input className={inputCls} value={f.payer} onChange={set("payer")} /></Field>
        <Field label="Reference / transaction #"><input className={inputCls} value={f.reference} onChange={set("reference")} /></Field>
      </div>
      <Field label="Notes"><textarea className={`${inputCls} h-16 resize-none`} value={f.notes} onChange={set("notes")} /></Field>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Post card payment</button>
    </div>
  );
}

function InsuranceCreditForm({ max, policies, onSubmit }) {
  const [f, setF] = useState({ insuranceName: policies[0]?.insuranceCompany || "", amount: "", reference: "", depositDate: TODAY, paymentDate: TODAY, copay: "", coinsurance: "", deductible: "", allowedAmount: "", notes: "" });
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  function submit() {
    const amt = Number(f.amount);
    if (!amt || amt <= 0) { setError("Enter a payment amount greater than 0."); return; }
    setError(""); onSubmit(f);
  }
  return (
    <div>
      <Field label="Insurance company">
        <select className={inputCls} value={f.insuranceName} onChange={set("insuranceName")}>
          {policies.map(p => <option key={p.id}>{p.insuranceCompany}</option>)}
          {policies.length === 0 && <option value="">No policies on file</option>}
        </select>
      </Field>
      <AmountField label={`Payment amount (balance ${money(max)})`} value={f.amount} onChange={set("amount")} />
      {Number(f.amount) > max + BALANCE_EPSILON && (
        <p className="text-xs text-violet-700 bg-violet-50 border border-violet-200 rounded-lg px-3 py-2 mb-3">
          This exceeds the remaining balance — it will post as an overpayment with a negative balance.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Check / EFT / ERA reference"><input className={inputCls} value={f.reference} onChange={set("reference")} /></Field>
        <Field label="Deposit date"><input type="date" className={inputCls} value={f.depositDate} onChange={set("depositDate")} /></Field>
        <Field label="Payment date"><input type="date" className={inputCls} value={f.paymentDate} onChange={set("paymentDate")} /></Field>
      </div>
      <SectionTitle>Claim posting</SectionTitle>
      <div className="grid grid-cols-4 gap-3">
        <AmountField label="Copay" value={f.copay} onChange={set("copay")} />
        <AmountField label="Coinsurance" value={f.coinsurance} onChange={set("coinsurance")} />
        <AmountField label="Deductible" value={f.deductible} onChange={set("deductible")} />
        <AmountField label="Allowed amount" value={f.allowedAmount} onChange={set("allowedAmount")} />
      </div>
      <Field label="Notes"><textarea className={`${inputCls} h-16 resize-none`} value={f.notes} onChange={set("notes")} /></Field>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Post insurance credit</button>
    </div>
  );
}

function PatientCreditForm({ max, onSubmit }) {
  const [f, setF] = useState({ amount: "", method: "Cash", date: TODAY, reference: "", notes: "" });
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  function submit() {
    const amt = Number(f.amount);
    if (!amt || amt <= 0) { setError("Enter a payment amount greater than 0."); return; }
    setError(""); onSubmit(f);
  }
  return (
    <div>
      <AmountField label={`Payment amount (balance ${money(max)})`} value={f.amount} onChange={set("amount")} />
      {Number(f.amount) > max + BALANCE_EPSILON && (
        <p className="text-xs text-violet-700 bg-violet-50 border border-violet-200 rounded-lg px-3 py-2 mb-3">
          This exceeds the remaining balance — it will post as an overpayment with a negative balance.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Method">
          <select className={inputCls} value={f.method} onChange={set("method")}><option>Cash</option><option>Check</option><option>Credit Card</option><option>Debit Card</option><option>Online Payment</option></select>
        </Field>
        <Field label="Date"><input type="date" className={inputCls} value={f.date} onChange={set("date")} /></Field>
        <Field label="Reference #"><input className={inputCls} value={f.reference} onChange={set("reference")} /></Field>
      </div>
      <Field label="Notes"><textarea className={`${inputCls} h-16 resize-none`} value={f.notes} onChange={set("notes")} /></Field>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Post patient payment</button>
    </div>
  );
}

function WriteOffDOSForm({ max, onSubmit }) {
  const [f, setF] = useState({ amount: "", reason: "", date: TODAY, notes: "" });
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  function submit() {
    const amt = Number(f.amount);
    if (!amt || amt <= 0) { setError("Enter a write-off amount greater than 0."); return; }
    if (!f.reason.trim()) { setError("A reason is required for the audit trail."); return; }
    setError(""); onSubmit(f);
  }
  return (
    <div>
      <div className="flex gap-2 mb-3">
        <AmountField label={`Write-off amount (max ${money(max)})`} value={f.amount} onChange={set("amount")} />
        <button onClick={() => setF({ ...f, amount: String(max) })} className="h-9 mt-5 text-xs text-slate-500 border border-slate-200 rounded-lg px-2 whitespace-nowrap">Full balance</button>
      </div>
      <Field label="Reason"><input className={inputCls} value={f.reason} onChange={set("reason")} placeholder="Contractual adjustment, timely filing, etc." /></Field>
      <Field label="Date"><input type="date" className={inputCls} value={f.date} onChange={set("date")} /></Field>
      <Field label="Notes"><textarea className={`${inputCls} h-16 resize-none`} value={f.notes} onChange={set("notes")} /></Field>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-slate-800 text-white text-sm font-medium py-2 rounded-lg hover:bg-slate-900">Post write-off</button>
    </div>
  );
}

function CreditDOSForm({ max, onSubmit }) {
  const [f, setF] = useState({ amount: "", reason: "", date: TODAY, notes: "" });
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  function submit() {
    const amt = Number(f.amount);
    if (!amt || amt <= 0) { setError("Enter a credit amount greater than 0."); return; }
    setError(""); onSubmit(f);
  }
  return (
    <div>
      <AmountField label={`Credit amount (max ${money(max)})`} value={f.amount} onChange={set("amount")} />
      <Field label="Reason"><input className={inputCls} value={f.reason} onChange={set("reason")} placeholder="Courtesy credit, billing error correction, etc." /></Field>
      <Field label="Date"><input type="date" className={inputCls} value={f.date} onChange={set("date")} /></Field>
      <Field label="Notes"><textarea className={`${inputCls} h-16 resize-none`} value={f.notes} onChange={set("notes")} /></Field>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-slate-800 text-white text-sm font-medium py-2 rounded-lg hover:bg-slate-900">Post credit</button>
    </div>
  );
}

function SelectInsuranceForm({ policies, current, onSubmit }) {
  const [choice, setChoice] = useState(current || "");
  return (
    <div>
      <p className="text-xs text-slate-400 mb-3">Only insurance records belonging to this patient are shown. This associates a specific policy with this date of service — useful when billing to coverage that was active at the time of service.</p>
      <div className="space-y-2 mb-4">
        {policies.map(p => (
          <label key={p.id} className="flex items-center gap-2 border border-slate-200 rounded-lg px-3 py-2 text-sm cursor-pointer hover:bg-slate-50">
            <input type="radio" name="ins" checked={choice === p.id} onChange={() => setChoice(p.id)} />
            <span className="flex-1">{p.insuranceCompany} — <PriorityBadge priority={p.priority} /></span>
            <StatusPill status={p.status} />
          </label>
        ))}
        {policies.length === 0 && <p className="text-xs text-slate-400">This patient has no insurance on file.</p>}
      </div>
      <button onClick={() => onSubmit(choice || null)} disabled={!choice} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700 disabled:opacity-40">Save</button>
    </div>
  );
}

function SelfPayConfirm({ onConfirm, onCancel }) {
  return (
    <div>
      <p className="text-sm text-slate-600 mb-4">Change payer to Self / Patient for this date of service? The existing insurance association on this claim is preserved in history — it will not be deleted.</p>
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 border border-slate-200 text-slate-600 text-sm font-medium py-2 rounded-lg hover:bg-slate-50">Cancel</button>
        <button onClick={onConfirm} className="flex-1 bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Confirm</button>
      </div>
    </div>
  );
}

function EditClaimForm({ charge, onSubmit }) {
  const cptCatalog = useContext(CptCatalogContext);
  const providerOptions = useProviderOptions(charge.provider);
  const npiByProvider = useNpiByProvider();
  const cptOptions = useCptOptions(charge.cpt);
  const [f, setF] = useState({
    dos: charge.dos, cpt: charge.cpt, provider: charge.provider, referralPhysician: charge.referralPhysician || "",
    facilityName: charge.facilityName || PRACTICE_INFO.name, facilityAddress: charge.facilityAddress || PRACTICE_INFO.address,
    taxId: charge.taxId || PRACTICE_INFO.taxId, npi: charge.npi || "", ndc: charge.ndc || "",
    units: charge.units || 1, time: charge.time || "",
    diagnosisCodes: charge.diagnosisCodes && charge.diagnosisCodes.length === 10 ? [...charge.diagnosisCodes] : emptyDxCodes(),
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  function setDx(i, val) {
    const next = [...f.diagnosisCodes];
    next[i] = val.toUpperCase();
    setF({ ...f, diagnosisCodes: next });
  }
  function setProviderAndNPI(p) { setF({ ...f, provider: p, npi: npiByProvider[p] || f.npi }); }
  function submit() {
    const entry = cptCatalog.find(c => c.code === f.cpt);
    onSubmit({
      dos: f.dos, cpt: f.cpt, desc: entry ? entry.desc : charge.desc, provider: f.provider, referralPhysician: f.referralPhysician,
      facilityName: f.facilityName, facilityAddress: f.facilityAddress, taxId: f.taxId, npi: f.npi, ndc: f.ndc,
      units: Number(f.units) || 1, time: f.time, diagnosisCodes: f.diagnosisCodes,
    });
  }
  return (
    <div>
      <SectionTitle>Service</SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Date of service"><input type="date" className={inputCls} value={f.dos} onChange={set("dos")} /></Field>
        <Field label="CPT code">
          <select className={inputCls} value={f.cpt} onChange={set("cpt")}>{cptOptions.map(c => <option key={c.code} value={c.code}>{c.code} — {c.desc}</option>)}</select>
        </Field>
        <Field label="Units"><input type="number" min="1" className={inputCls} value={f.units} onChange={set("units")} /></Field>
        <Field label="Time (minutes)"><input className={inputCls} value={f.time} onChange={set("time")} /></Field>
        <Field label="National Drug Code (NDC)"><input className={inputCls} value={f.ndc} onChange={set("ndc")} /></Field>
      </div>
      <SectionTitle>Providers</SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Physician">
          <select className={inputCls} value={f.provider} onChange={(e) => setProviderAndNPI(e.target.value)}>{providerOptions.map(p => <option key={p}>{p}</option>)}</select>
        </Field>
        <Field label="Physician NPI"><input className={inputCls} value={f.npi} onChange={set("npi")} /></Field>
        <Field label="Referral physician"><input className={inputCls} value={f.referralPhysician} onChange={set("referralPhysician")} placeholder="Optional" /></Field>
      </div>
      <SectionTitle>Facility &amp; billing entity</SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Practice name"><input className={inputCls} value={f.facilityName} onChange={set("facilityName")} /></Field>
        <Field label="Facility address"><input className={inputCls} value={f.facilityAddress} onChange={set("facilityAddress")} /></Field>
        <Field label="Tax ID"><input className={inputCls} value={f.taxId} onChange={set("taxId")} /></Field>
      </div>
      <SectionTitle>Diagnosis codes (ICD-10, up to 4)</SectionTitle>
      <div className="grid grid-cols-5 gap-2 mb-3">
        {f.diagnosisCodes.map((code, i) => (
          <input key={i} className={`${inputCls} text-center`} value={code} onChange={(e) => setDx(i, e.target.value)} placeholder={`Dx ${i + 1}`} />
        ))}
      </div>
      <p className="text-xs text-slate-400 mb-3">Changing the CPT here updates the claim's coding fields only — use "Recode" from the ledger if you also need the charge amount to change.</p>
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Save claim edits</button>
    </div>
  );
}

function FollowUpForm({ onSubmit }) {
  const [f, setF] = useState({ type: followUpTypes[0], text: "", date: TODAY, nextFollowUpDate: "", status: "Open" });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const [error, setError] = useState("");
  function submit() {
    if (!f.text.trim()) { setError("Follow-up note can't be empty."); return; }
    setError(""); onSubmit(f);
  }
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
          <select className={inputCls} value={f.type} onChange={set("type")}>{followUpTypes.map(t => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="Date"><input type="date" className={inputCls} value={f.date} onChange={set("date")} /></Field>
      </div>
      <Field label="Note"><textarea className={`${inputCls} h-20 resize-none`} value={f.text} onChange={set("text")} placeholder="e.g. Called insurance, claim under review" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Next follow-up date"><input type="date" className={inputCls} value={f.nextFollowUpDate} onChange={set("nextFollowUpDate")} /></Field>
        <Field label="Status">
          <select className={inputCls} value={f.status} onChange={set("status")}>{followUpStatuses.map(s => <option key={s}>{s}</option>)}</select>
        </Field>
      </div>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Save follow-up</button>
    </div>
  );
}

// ---------- Patient billing: Insurance tab (versioned history) ----------

function PatientInsuranceTab({ policies, insurances, onAdd, onEdit, onSetPriority, onEndCoverage, onUploadCard }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editPolicy, setEditPolicy] = useState(null);
  const [historyPolicy, setHistoryPolicy] = useState(null);

  const active = policies.filter(p => p.status === "Active").sort((a, b) => a.priority.localeCompare(b.priority));
  const sorted = [...policies].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-slate-700">Current coverage</h3>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 bg-teal-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-teal-700"><Plus size={13} /> Add insurance</button>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        {priorities.map(pr => {
          const pol = active.find(p => p.priority === pr);
          return (
            <Card key={pr} className="p-3">
              <div className="flex items-center justify-between mb-2"><PriorityBadge priority={pr} />{!pol && <span className="text-xs text-slate-300">Empty</span>}</div>
              {pol ? (
                <div>
                  <div className="font-medium text-slate-800 text-sm">{pol.insuranceCompany}</div>
                  <div className="text-xs text-slate-500">{pol.planName}</div>
                  <div className="text-xs text-slate-500 mt-1">Member {pol.memberId} · Grp {pol.groupNumber}</div>
                  <div className="text-xs text-slate-400 mt-1">Eff. {fmtDate(pol.effectiveDate)}</div>
                </div>
              ) : <p className="text-xs text-slate-400">No {pr.toLowerCase()} coverage</p>}
            </Card>
          );
        })}
      </div>

      <h3 className="font-medium text-slate-700 mb-3">Insurance history</h3>
      <p className="text-xs text-slate-400 mb-3">Adding new insurance never deletes an old record — it's marked Terminated and kept here permanently.</p>
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5 font-medium">Insurance</th>
              <th className="px-4 py-2.5 font-medium">Member ID</th>
              <th className="px-4 py-2.5 font-medium">Effective</th>
              <th className="px-4 py-2.5 font-medium">Termination</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Priority</th>
              <th className="px-4 py-2.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(pol => (
              <tr key={pol.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2.5 font-medium text-slate-800">{pol.insuranceCompany}<div className="text-xs text-slate-400 font-normal">{pol.planName}</div></td>
                <td className="px-4 py-2.5 text-slate-600">{pol.memberId}</td>
                <td className="px-4 py-2.5 text-slate-600">{fmtDate(pol.effectiveDate)}</td>
                <td className="px-4 py-2.5 text-slate-600">{pol.terminationDate || "—"}</td>
                <td className="px-4 py-2.5"><StatusPill status={pol.status} /></td>
                <td className="px-4 py-2.5"><PriorityBadge priority={pol.priority} /></td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    <button onClick={() => setEditPolicy(pol)} className="text-xs text-teal-700 border border-teal-200 bg-teal-50 rounded-lg px-2 py-1 hover:bg-teal-100">Edit</button>
                    <button onClick={() => setHistoryPolicy(pol)} className="text-xs text-slate-600 border border-slate-200 rounded-lg px-2 py-1 hover:bg-slate-50">History</button>
                    {pol.status === "Active" && priorities.filter(p => p !== pol.priority).map(p => (
                      <button key={p} onClick={() => onSetPriority(pol.id, p)} className="text-xs text-sky-700 border border-sky-200 bg-sky-50 rounded-lg px-2 py-1 hover:bg-sky-100">Set {p}</button>
                    ))}
                    {pol.status === "Active" && (
                      <button onClick={() => onEndCoverage(pol.id, TODAY)} className="text-xs text-rose-600 border border-rose-200 bg-rose-50 rounded-lg px-2 py-1 hover:bg-rose-100 flex items-center gap-1"><Ban size={11} /> End</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {sorted.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-400">No insurance on file — self-pay.</td></tr>}
          </tbody>
        </table>
      </Card>

      {showAdd && (
        <Modal title="Add insurance" onClose={() => setShowAdd(false)} wide>
          <InsuranceForm insurances={insurances} onSubmit={(f) => { onAdd(f); setShowAdd(false); }} onUploadCard={null} />
        </Modal>
      )}
      {editPolicy && (
        <Modal title={`Edit insurance · ${editPolicy.insuranceCompany}`} onClose={() => setEditPolicy(null)} wide>
          <InsuranceForm
            insurances={insurances}
            initial={editPolicy}
            onSubmit={(f, createNew) => { onEdit(editPolicy.id, f, createNew); setEditPolicy(null); }}
            onUploadCard={(side, dataUrl) => onUploadCard(editPolicy.id, side, dataUrl)}
            isEdit
          />
        </Modal>
      )}
      {historyPolicy && (
        <Modal title={`Field change history · ${historyPolicy.insuranceCompany}`} onClose={() => setHistoryPolicy(null)}>
          <div className="space-y-2">
            {historyPolicy.fieldHistory.length === 0 && <p className="text-sm text-slate-400">No field-level edits recorded for this policy yet.</p>}
            {historyPolicy.fieldHistory.slice().reverse().map((h, i) => (
              <div key={i} className="text-xs border border-slate-100 rounded-lg px-3 py-2">
                <div className="font-medium text-slate-700">{h.field}</div>
                <div className="text-slate-500">{String(h.oldValue)} → {String(h.newValue)}</div>
                <div className="text-slate-400 mt-1">{h.changedBy} · {fmtDateTime(h.changedAt)}</div>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function InsuranceForm({ initial, onSubmit, onUploadCard, isEdit, insurances = [] }) {
  const [form, setForm] = useState(initial || {
    insuranceId: "", insuranceAddress: "", insuranceCompany: "", planName: "", insuranceType: insuranceTypes[0], memberId: "", subscriberId: "",
    groupNumber: "", payerId: "", effectiveDate: TODAY, terminationDate: "", priority: "Primary",
    subscriberName: "", subscriberDob: "", subscriberRelationship: "Self",
    copay: "", deductible: "", coinsurance: "", authRequired: false, referralRequired: false, notes: "",
    cardFront: initial?.cardFront || null, cardBack: initial?.cardBack || null,
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setBool = (k) => (e) => setForm({ ...form, [k]: e.target.checked });
  const [error, setError] = useState("");

  // Picking a master row copies its payer details onto the policy. They are copied rather than
  // joined on purpose: a claim is submitted to the payer ID and address that were correct on the
  // day, so a later correction to the master must not rewrite what an old policy recorded.
  function selectInsurance(ins) {
    if (!ins) {
      setForm({ ...form, insuranceId: "", insuranceCompany: "", payerId: "", insuranceAddress: "" });
      return;
    }
    setForm({
      ...form,
      insuranceId: ins.id,
      insuranceCompany: ins.name,
      payerId: ins.payerId || "",
      insuranceAddress: ins.address || "",
    });
  }

  function validate() {
    if (!form.insuranceCompany.trim() || !form.memberId.trim() || !form.effectiveDate) return "Insurance company, member ID, and effective date are required.";
    if (form.terminationDate && form.terminationDate < form.effectiveDate) return "Termination date can't be before the effective date.";
    return "";
  }
  function saveInPlace() { const err = validate(); if (err) { setError(err); return; } setError(""); onSubmit(form, false); }
  function saveAsNew() { const err = validate(); if (err) { setError(err); return; } setError(""); onSubmit(form, true); }

  return (
    <div>
      <SectionTitle>Payer information</SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-3">
          <InsuranceSelect
            insurances={insurances}
            value={form.insuranceId}
            onChange={selectInsurance}
          />
        </div>

        {/* Master details, filled in from the selected row. Read-only here: correcting a payer ID
            belongs in Settings > Insurance Management, where it is permissioned and audited, not
            on one patient's policy where it would silently disagree with every other patient's. */}
        <Field label="Payer ID" hint="From the master insurance record.">
          <input className={`${inputCls} bg-slate-50 text-slate-600`} value={form.payerId || ""} readOnly />
        </Field>
        <Field label="Insurance address" hint="From the master insurance record.">
          <input className={`${inputCls} bg-slate-50 text-slate-600`} value={form.insuranceAddress || ""} readOnly />
        </Field>
        <Field label="Plan name"><input className={inputCls} value={form.planName} onChange={set("planName")} /></Field>
        <Field label="Insurance type">
          <select className={inputCls} value={form.insuranceType} onChange={set("insuranceType")}>{insuranceTypes.map(t => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="Member ID"><input className={inputCls} value={form.memberId} onChange={set("memberId")} /></Field>
        <Field label="Group number"><input className={inputCls} value={form.groupNumber} onChange={set("groupNumber")} /></Field>
        <Field label="Priority">
          <select className={inputCls} value={form.priority} onChange={set("priority")}>{priorities.map(p => <option key={p}>{p}</option>)}</select>
        </Field>
        <Field label="Effective date"><input type="date" className={inputCls} value={form.effectiveDate} onChange={set("effectiveDate")} /></Field>
        <Field label="Termination date"><input type="date" className={inputCls} value={form.terminationDate} onChange={set("terminationDate")} /></Field>
      </div>

      <SectionTitle>Subscriber</SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Subscriber name"><input className={inputCls} value={form.subscriberName} onChange={set("subscriberName")} /></Field>
        <Field label="Subscriber DOB"><input type="date" className={inputCls} value={form.subscriberDob} onChange={set("subscriberDob")} /></Field>
        <Field label="Relationship">
          <select className={inputCls} value={form.subscriberRelationship} onChange={set("subscriberRelationship")}><option>Self</option><option>Spouse</option><option>Child</option><option>Other</option></select>
        </Field>
        <Field label="Subscriber ID"><input className={inputCls} value={form.subscriberId} onChange={set("subscriberId")} /></Field>
      </div>

      <SectionTitle>Financial &amp; requirements</SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Copay"><input className={inputCls} value={form.copay} onChange={set("copay")} placeholder="$" /></Field>
        <Field label="Deductible"><input className={inputCls} value={form.deductible} onChange={set("deductible")} placeholder="$" /></Field>
        <Field label="Coinsurance"><input className={inputCls} value={form.coinsurance} onChange={set("coinsurance")} placeholder="e.g. 20%" /></Field>
      </div>
      <div className="flex gap-6 mb-3">
        <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={form.authRequired} onChange={setBool("authRequired")} /> Prior authorization required</label>
        <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={form.referralRequired} onChange={setBool("referralRequired")} /> Referral required</label>
      </div>
      <Field label="Notes"><textarea className={`${inputCls} h-16 resize-none`} value={form.notes} onChange={set("notes")} /></Field>

      <SectionTitle>Insurance card</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        <FileDrop label="Front of card" value={form.cardFront} onChange={(dataUrl) => { setForm({ ...form, cardFront: dataUrl }); if (isEdit && onUploadCard) onUploadCard("cardFront", dataUrl); }} />
        <FileDrop label="Back of card" value={form.cardBack} onChange={(dataUrl) => { setForm({ ...form, cardBack: dataUrl }); if (isEdit && onUploadCard) onUploadCard("cardBack", dataUrl); }} />
      </div>

      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      {!isEdit ? (
        <button onClick={saveInPlace} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">
          Add insurance {form.priority === "Primary" ? "(any existing active primary moves to history)" : ""}
        </button>
      ) : (
        <div className="flex gap-2">
          <button onClick={saveInPlace} className="flex-1 bg-slate-800 text-white text-sm font-medium py-2 rounded-lg hover:bg-slate-900">Save changes to this record</button>
          <button onClick={saveAsNew} className="flex-1 bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Save as new coverage record</button>
        </div>
      )}
      {isEdit && <p className="text-xs text-slate-400 mt-2">"Save changes" edits this record in place and logs a field-level audit entry. "Save as new" ends this record and creates a fresh one — use this for an actual coverage change, not a correction.</p>}
    </div>
  );
}

// ---------- Patient billing: ID Documents tab ----------

// Deleting an ID document is permanent — the scanned file is removed from the database rather
// than archived — so it goes through a confirmation first.
function confirmDelete(d) {
  return window.confirm(`Delete this ${d.idType}${d.idNumber ? ` (#${d.idNumber})` : ""} permanently?

The scanned file is removed from the system and cannot be recovered.`);
}

function PatientIdDocuments({ documents, onUpload, onDelete, canManage }) {
  const [showAdd, setShowAdd] = useState(false);
  const isPdf = (d) => d.fileType === "application/pdf" || (d.file || "").startsWith("data:application/pdf");
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-slate-700">ID documents</h3>
        {canManage && <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 bg-teal-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-teal-700"><Upload size={13} /> Upload ID document</button>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {documents.map(d => (
          <Card key={d.id} className="p-3">
            <div className="flex items-center gap-3">
              {isPdf(d) ? (
                <div className="w-14 h-14 rounded-md bg-slate-100 flex items-center justify-center shrink-0"><FileText size={18} className="text-slate-400" /></div>
              ) : d.file ? (
                <img src={d.file} alt="" className="w-14 h-14 object-cover rounded-md border border-slate-200 shrink-0" />
              ) : (
                <div className="w-14 h-14 rounded-md bg-slate-100 flex items-center justify-center shrink-0"><IdCard size={18} className="text-slate-400" /></div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-800 truncate">{d.fileName || d.idType}</div>
                <div className="text-xs text-slate-500">{d.idType} · #{d.idNumber} · exp {d.expirationDate || "—"}</div>
                <div className="text-xs text-slate-400">Uploaded {fmtDate(d.uploadedAt)} by {d.uploadedBy}</div>
                <div className="text-xs text-slate-400">{d.fileType || "Unknown type"} · {formatFileSize(d.fileSize)}</div>
              </div>
              <StatusPill status={d.status} />
            </div>
            <div className="flex items-center gap-2 mt-2.5 pt-2.5 border-t border-slate-100">
              <button onClick={() => openIdDocumentViewerWindow(d)} disabled={!d.file} className="flex items-center gap-1 text-xs text-teal-700 border border-teal-200 bg-teal-50 rounded-lg px-2.5 py-1 hover:bg-teal-100 disabled:opacity-40">
                <Eye size={12} /> View
              </button>
              {canManage && (
                <button onClick={() => confirmDelete(d) && onDelete(d.id)} className="flex items-center gap-1 text-xs text-rose-600 border border-rose-200 bg-rose-50 rounded-lg px-2.5 py-1 hover:bg-rose-100">
                  <Trash2 size={12} /> Delete
                </button>
              )}
            </div>
          </Card>
        ))}
        {documents.length === 0 && <p className="text-sm text-slate-400 col-span-2">No ID documents on file.</p>}
      </div>
      {showAdd && (
        <Modal title="Upload ID document" onClose={() => setShowAdd(false)}>
          <IdDocForm onSubmit={async (doc) => { await onUpload(doc); setShowAdd(false); }} />
        </Modal>
      )}
    </div>
  );
}

// Firestore documents cap out at 1 MiB; base64 adds ~33% overhead on top of the raw file, so
// keep a comfortable margin under that for the file plus its other fields.
const MAX_ID_DOC_BYTES = 2028 * 1024;

function IdDocForm({ onSubmit }) {
  const [form, setForm] = useState({ idType: idTypes[0], idNumber: "", issuingState: "NY", issueDate: "", expirationDate: "", file: null, fileName: "", fileType: "", fileSize: null });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit() {
    if (!form.file) { setError("Upload or scan an image or PDF of the ID first."); return; }
    if (form.fileSize > MAX_ID_DOC_BYTES) { setError(`That file is too large (${formatFileSize(form.fileSize)}) — this stores documents directly in the database, so keep it under ${formatFileSize(MAX_ID_DOC_BYTES)}.`); return; }
    setError("");
    setSaving(true);
    await onSubmit(form);
    setSaving(false);
  }
  return (
    <div>
      <Field label="ID type">
        <select className={inputCls} value={form.idType} onChange={set("idType")}>{idTypes.map(t => <option key={t}>{t}</option>)}</select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="ID number"><input className={inputCls} value={form.idNumber} onChange={set("idNumber")} /></Field>
        <Field label="Issuing state / country"><input className={inputCls} value={form.issuingState} onChange={set("issuingState")} /></Field>
        <Field label="Issue date"><input type="date" className={inputCls} value={form.issueDate} onChange={set("issueDate")} /></Field>
        <Field label="Expiration date"><input type="date" className={inputCls} value={form.expirationDate} onChange={set("expirationDate")} /></Field>
      </div>
      <FileDrop
        label="ID image or PDF"
        value={form.file}
        onChange={(dataUrl, file) => setForm({ ...form, file: dataUrl, fileName: file?.name || form.fileName, fileType: file?.type || form.fileType, fileSize: file ? file.size : form.fileSize })}
      />
      <p className="text-xs text-slate-400 mb-3">OCR isn't wired up in this prototype — enter fields manually and confirm before saving. Keep files under {formatFileSize(MAX_ID_DOC_BYTES)}.</p>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} disabled={saving} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700 disabled:opacity-60">{saving ? "Saving…" : "Save document"}</button>
    </div>
  );
}

// ---------- Patient billing: Audit History tab ----------

function AuditHistory({ auditLogs }) {
  return (
    <Card>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
            <th className="px-4 py-2.5 font-medium">Timestamp</th>
            <th className="px-4 py-2.5 font-medium">User</th>
            <th className="px-4 py-2.5 font-medium">Action</th>
            <th className="px-4 py-2.5 font-medium">Old value</th>
            <th className="px-4 py-2.5 font-medium">New value</th>
          </tr>
        </thead>
        <tbody>
          {auditLogs.map(a => (
            <tr key={a.id} className="border-b border-slate-100 last:border-0">
              <td className="px-4 py-2.5 text-slate-500 text-xs whitespace-nowrap">{fmtDateTime(a.timestamp)}</td>
              <td className="px-4 py-2.5 text-slate-600">{a.user}</td>
              <td className="px-4 py-2.5 font-medium text-slate-800">{a.action}</td>
              <td className="px-4 py-2.5 text-slate-500 text-xs max-w-[220px]">{a.oldValues || "—"}</td>
              <td className="px-4 py-2.5 text-slate-600 text-xs max-w-[240px]">{a.newValues || "—"}</td>
            </tr>
          ))}
          {auditLogs.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">No audit events yet.</td></tr>}
        </tbody>
      </table>
    </Card>
  );
}

function ManageChargeForm({ charge, onRecordPayment, onWriteOff, onRecode, onAddMemo, onClose }) {
  const cptOptions = useCptOptions(charge.cpt);
  const bal = balanceOf(charge);
  const [paymentAmt, setPaymentAmt] = useState("");
  const [writeoffAmt, setWriteoffAmt] = useState("");
  const [newCode, setNewCode] = useState(charge.cpt);
  const [memoText, setMemoText] = useState("");
  const [error, setError] = useState("");

  function handlePayment() {
    const amt = Number(paymentAmt);
    if (!amt || amt <= 0) { setError("Enter a payment amount greater than 0."); return; }
    setError(""); onRecordPayment(amt); setPaymentAmt("");
  }
  function handleWriteoff() {
    const amt = Number(writeoffAmt);
    if (!amt || amt <= 0) { setError("Enter a write-off amount greater than 0."); return; }
    setError(""); onWriteOff(amt); setWriteoffAmt("");
  }
  function handleRecode() {
    if (newCode === charge.cpt) return;
    onRecode(newCode);
  }
  function handleMemo() {
    if (!memoText.trim()) { setError("Memo can't be empty."); return; }
    setError(""); onAddMemo(memoText.trim()); setMemoText("");
  }

  return (
    <div>
      <div className="flex items-center justify-between text-sm bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-4">
        <span>Charge {money(charge.charge)}</span>
        <span>Paid {money(charge.paid)}</span>
        <span>Write-off {money(charge.writeoff)}</span>
        <span className={`font-medium ${bal > 0 ? "text-rose-600" : "text-slate-700"}`}>Balance {money(bal)}</span>
      </div>

      <div className="border-t border-slate-100 pt-3 mb-3">
        <span className="flex items-center gap-1.5 text-sm font-medium text-slate-700 mb-2"><CreditCard size={14} /> Record payment</span>
        <div className="flex gap-2">
          <input type="number" min="0" step="0.01" className={inputCls} placeholder="Amount" value={paymentAmt} onChange={(e) => setPaymentAmt(e.target.value)} />
          <button onClick={handlePayment} className="bg-teal-600 text-white text-xs font-medium px-3 rounded-lg hover:bg-teal-700 whitespace-nowrap">Apply</button>
        </div>
      </div>

      <div className="border-t border-slate-100 pt-3 mb-3">
        <span className="flex items-center gap-1.5 text-sm font-medium text-slate-700 mb-2"><ScissorsLineDashed size={14} /> Write off balance</span>
        <div className="flex gap-2">
          <input type="number" min="0" step="0.01" className={inputCls} placeholder="Amount" value={writeoffAmt} onChange={(e) => setWriteoffAmt(e.target.value)} />
          <button onClick={() => setWriteoffAmt(String(bal))} className="text-xs text-slate-500 border border-slate-200 rounded-lg px-2 whitespace-nowrap">Full balance</button>
          <button onClick={handleWriteoff} className="bg-slate-700 text-white text-xs font-medium px-3 rounded-lg hover:bg-slate-800 whitespace-nowrap">Write off</button>
        </div>
      </div>

      <div className="border-t border-slate-100 pt-3 mb-3">
        <span className="text-sm font-medium text-slate-700 mb-2 block">Credit / recode CPT</span>
        <div className="flex gap-2">
          <select className={inputCls} value={newCode} onChange={(e) => setNewCode(e.target.value)}>
            {cptOptions.map(c => <option key={c.code} value={c.code}>{c.code} — {c.desc} ({money(c.charge)})</option>)}
          </select>
          <button onClick={handleRecode} className="bg-sky-600 text-white text-xs font-medium px-3 rounded-lg hover:bg-sky-700 whitespace-nowrap">Recode</button>
        </div>
        <p className="text-xs text-slate-400 mt-1">Corrects the CPT code and updates the charge amount for this line.</p>
      </div>

      <div className="border-t border-slate-100 pt-3 mb-4">
        <span className="flex items-center gap-1.5 text-sm font-medium text-slate-700 mb-2"><MessageSquarePlus size={14} /> Add follow-up memo</span>
        <textarea className={`${inputCls} h-16 resize-none`} placeholder="e.g. Call patient about balance at next visit" value={memoText} onChange={(e) => setMemoText(e.target.value)} />
        <button onClick={handleMemo} className="mt-2 text-xs text-teal-700 border border-teal-200 bg-teal-50 rounded-lg px-3 py-1.5 hover:bg-teal-100">Add memo</button>
        {charge.memos.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {charge.memos.slice().reverse().map((m, i) => (
              <div key={i} className="text-xs text-slate-600 bg-slate-50 border border-slate-100 rounded-lg px-2 py-1.5">
                <span className="text-slate-400">{fmtDate(m.date)}</span> — {m.text}
              </div>
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={onClose} className="w-full border border-slate-200 text-slate-600 text-sm font-medium py-2 rounded-lg hover:bg-slate-50">Done</button>
    </div>
  );
}

function AddChargeForm({ onSubmit }) {
  const cptCatalog = useContext(CptCatalogContext);
  const providerOptions = useProviderOptions();
  const npiByProvider = useNpiByProvider();
  const cptOptions = useCptOptions();
  const [dos, setDos] = useState("2026-08-24");
  const [cpt, setCpt] = useState(cptOptions[0]?.code || "");
  const [provider, setProvider] = useState(providerOptions[0] || "");
  const [referralPhysician, setReferralPhysician] = useState("");
  const [facilityName, setFacilityName] = useState(PRACTICE_INFO.name);
  const [facilityAddress, setFacilityAddress] = useState(PRACTICE_INFO.address);
  const [taxId, setTaxId] = useState(PRACTICE_INFO.taxId);
  const [npi, setNpi] = useState(npiByProvider[providerOptions[0]] || "");
  const [ndc, setNdc] = useState("");
  const [units, setUnits] = useState("1");
  const [time, setTime] = useState("");
  const [dxCodes, setDxCodes] = useState(emptyDxCodes());
  const [error, setError] = useState("");

  function setProviderAndNPI(p) {
    setProvider(p);
    setNpi(npiByProvider[p] || "");
  }
  function setDx(i, val) {
    const next = [...dxCodes];
    next[i] = val.toUpperCase();
    setDxCodes(next);
  }

  function submit() {
    if (!dos) { setError("Date of service is required."); return; }
    const entry = cptCatalog.find(c => c.code === cpt);
    if (!entry) { setError("Select a CPT code."); return; }
    setError("");
    onSubmit({
      dos, provider, referralPhysician, cpt: entry.code, desc: entry.desc, charge: entry.charge,
      facilityName, facilityAddress, taxId, npi, ndc, units: Number(units) || 1, time,
      diagnosisCodes: dxCodes,
    });
  }

  return (
    <div>
      <SectionTitle>Service</SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Date of service"><input type="date" className={inputCls} value={dos} onChange={(e) => setDos(e.target.value)} /></Field>
        <Field label="CPT code">
          <select className={inputCls} value={cpt} onChange={(e) => setCpt(e.target.value)}>
            {cptOptions.map(c => <option key={c.code} value={c.code}>{c.code} — {c.desc} ({money(c.charge)})</option>)}
          </select>
        </Field>
        <Field label="Units"><input type="number" min="1" className={inputCls} value={units} onChange={(e) => setUnits(e.target.value)} /></Field>
        <Field label="Time (minutes)" hint="For time-based CPT codes"><input className={inputCls} value={time} onChange={(e) => setTime(e.target.value)} placeholder="Optional" /></Field>
        <Field label="National Drug Code (NDC)" hint="If applicable"><input className={inputCls} value={ndc} onChange={(e) => setNdc(e.target.value)} placeholder="e.g. 0069-0420-01" /></Field>
      </div>

      <SectionTitle>Providers</SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Physician">
          <select className={inputCls} value={provider} onChange={(e) => setProviderAndNPI(e.target.value)}>{providerOptions.map(p => <option key={p}>{p}</option>)}</select>
        </Field>
        <Field label="Physician NPI"><input className={inputCls} value={npi} onChange={(e) => setNpi(e.target.value)} /></Field>
        <Field label="Referral physician"><input className={inputCls} value={referralPhysician} onChange={(e) => setReferralPhysician(e.target.value)} placeholder="Optional" /></Field>
      </div>

      <SectionTitle>Facility &amp; billing entity</SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Practice name"><input className={inputCls} value={facilityName} onChange={(e) => setFacilityName(e.target.value)} /></Field>
        <Field label="Facility address" className="col-span-2"><input className={inputCls} value={facilityAddress} onChange={(e) => setFacilityAddress(e.target.value)} /></Field>
        <Field label="Tax ID"><input className={inputCls} value={taxId} onChange={(e) => setTaxId(e.target.value)} /></Field>
      </div>

      <SectionTitle>Diagnosis codes (ICD-10, up to 10)</SectionTitle>
      <div className="grid grid-cols-5 gap-2 mb-3">
        {dxCodes.map((code, i) => (
          <input key={i} className={`${inputCls} text-center`} value={code} onChange={(e) => setDx(i, e.target.value)} placeholder={`Dx ${i + 1}`} />
        ))}
      </div>

      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Add charge</button>
    </div>
  );
}

// ---------- Claims ----------

function Claims({ claims, patientById, onSubmit }) {
  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-800 mb-6">Claims</h1>
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5 font-medium">Claim</th>
              <th className="px-4 py-2.5 font-medium">Patient</th>
              <th className="px-4 py-2.5 font-medium">Payer</th>
              <th className="px-4 py-2.5 font-medium">CPT / Dx</th>
              <th className="px-4 py-2.5 font-medium text-right">Amount</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {claims.map(c => (
              <tr key={c.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2.5 font-medium text-slate-800">{c.id}</td>
                <td className="px-4 py-2.5 text-slate-600">{patientById[c.patientId]?.name}</td>
                <td className="px-4 py-2.5 text-slate-600">{c.payer}</td>
                <td className="px-4 py-2.5 text-slate-600">{c.cpt} / {c.dx || "—"}</td>
                <td className="px-4 py-2.5 text-right">{money(c.amount)}</td>
                <td className="px-4 py-2.5"><StatusPill status={c.status} /></td>
                <td className="px-4 py-2.5">
                  {c.status === "Draft" && (
                    <button onClick={() => onSubmit(c.id)} className="flex items-center gap-1 text-xs text-teal-700 border border-teal-200 bg-teal-50 rounded-lg px-2 py-1 hover:bg-teal-100">
                      <Send size={12} /> Submit
                    </button>
                  )}
                  {c.status === "Denied" && <span className="flex items-center gap-1 text-xs text-rose-600"><AlertCircle size={12} /> Needs appeal</span>}
                  {c.status === "Paid" && <span className="flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2 size={12} /> Closed</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ---------- Reports ----------

function Reports({ revenueByMonth, claimStatusData, charges, patientById, transactions, patients, policies, batches, userAccounts, session, isOversight }) {
  const [view, setView] = useState("overview");

  return (
    <div>
      <div className="flex items-center justify-between mb-6 print:hidden">
        <h1 className="text-xl font-semibold text-slate-800">Reports</h1>
        <div className="flex items-center gap-1 border border-slate-200 bg-white rounded-lg p-1">
          <button onClick={() => setView("overview")} className={`px-3 py-1.5 text-sm rounded-md ${view === "overview" ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}>Overview</button>
          <button onClick={() => setView("center")} className={`px-3 py-1.5 text-sm rounded-md ${view === "center" ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}>Report center</button>
        </div>
      </div>

      {view === "overview" && (
        <div className="grid grid-cols-2 gap-4">
          <Card className="p-4">
            <h3 className="font-medium text-slate-700 mb-3">Revenue trend</h3>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={revenueByMonth}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} stroke="#94a3b8" />
                <YAxis tick={{ fontSize: 12 }} stroke="#94a3b8" />
                <Tooltip formatter={(v) => money(v)} />
                <Line type="monotone" dataKey="revenue" stroke="#0d9488" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </Card>
          <Card className="p-4">
            <h3 className="font-medium text-slate-700 mb-3">Claims by status</h3>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={claimStatusData} dataKey="value" nameKey="name" outerRadius={80} label>
                  {claimStatusData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Legend /><Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        </div>
      )}

      {view === "center" && (
        <ReportCenter
          charges={charges} patientById={patientById} transactions={transactions} patients={patients} policies={policies}
          batches={batches} userAccounts={userAccounts} session={session} isOversight={isOversight}
        />
      )}
    </div>
  );
}

// ---------- Settings: Change password (every role) ----------

function ChangePasswordForm({ onSubmit, onDone }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function submit() {
    if (!current) { setError("Enter your current password."); return; }
    if (next.length < 6) { setError("Your new password must be at least 6 characters."); return; }
    if (next !== confirm) { setError("The two new passwords don't match."); return; }
    if (next === current) { setError("Your new password must be different from your current one."); return; }
    setError("");
    setSaving(true);
    try {
      await onSubmit(current, next);
      setDone(true);
    } catch (err) {
      // The server answers 403 when the current password is wrong — the one failure worth
      // spelling out, since there is nothing the user can do about the others.
      setError(err?.status === 403 ? "Your current password is not correct." : "Couldn't change your password. Please try again.");
    }
    setSaving(false);
  }

  if (done) {
    return (
      <div>
        <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-3">
          Your password has been changed. Your current session stays signed in — the new password applies the next time you log in.
        </p>
        <button onClick={onDone} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Done</button>
      </div>
    );
  }

  return (
    <div>
      <Field label="Current password"><input type="password" autoComplete="current-password" className={inputCls} value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
      <Field label="New password" hint="At least 6 characters."><input type="password" autoComplete="new-password" className={inputCls} value={next} onChange={(e) => setNext(e.target.value)} /></Field>
      <Field label="Confirm new password"><input type="password" autoComplete="new-password" className={inputCls} value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} disabled={saving} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700 disabled:opacity-60">{saving ? "Changing…" : "Change password"}</button>
    </div>
  );
}

// ---------- Settings: Practice catalog — physicians + CPT codes (SUPER_ADMIN only) ----------

// Both lists behave the same way from an admin's point of view — a table, an inline row editor,
// and an active/inactive toggle — so they share one screen and one editor component instead of
// two near-identical ones.
//
// Nothing here hard-deletes. A physician or CPT code is referenced by every charge, claim and
// appointment ever written against it; removing the row would leave those records pointing at
// something that no longer exists. Deactivating instead keeps the history readable and only
// takes the entry out of the dropdowns new work is created from.

// A row is being added when `draft.id` is absent, edited when it is present. `fields` drives both
// the form and the table columns, so the two cannot disagree about what an entry holds.
function CatalogEditor({ fields, draft, onChange, onSave, onCancel, error, signature }) {
  return (
    <div className="border border-teal-200 bg-teal-50/40 rounded-lg p-3 mb-3">
      <div className="grid grid-cols-2 gap-x-3">
        {fields.map(f => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <input
              className={inputCls}
              value={draft[f.key] ?? ""}
              onChange={(e) => onChange(f.key, e.target.value)}
              placeholder={f.placeholder || ""}
              inputMode={f.numeric ? "decimal" : undefined}
            />
          </Field>
        ))}
      </div>
      {signature && (
        <FileDrop
          label="Electronic signature (optional)"
          value={draft.signature || ""}
          onChange={(dataUrl) => onChange("signature", dataUrl)}
        />
      )}
      {error && <p className="text-xs text-rose-600 mb-2">{error}</p>}
      <div className="flex gap-2">
        <button onClick={onSave} className="px-3 py-1.5 bg-teal-600 text-white rounded-lg text-sm hover:bg-teal-700">
          {draft.id ? "Save changes" : "Add"}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm hover:bg-slate-50">Cancel</button>
      </div>
    </div>
  );
}

const PHYSICIAN_FIELDS = [
  { key: "name", label: "Physician name", placeholder: "Dr. J. Smith" },
  { key: "npi", label: "NPI", placeholder: "10 digits", hint: "Box 24J on the CMS-1500." },
  { key: "specialty", label: "Specialty", placeholder: "Optional" },
];

const CPT_FIELDS = [
  { key: "code", label: "CPT code", placeholder: "99213" },
  { key: "charge", label: "Charge", placeholder: "110.00", numeric: true },
  { key: "desc", label: "Description", placeholder: "Office visit, established patient" },
  { key: "category", label: "Category", placeholder: "Office Visit" },
];

function PracticeCatalog({ physicians, cptCatalog, charges, appointments, onSavePhysician, onSaveCpt, onSetActive }) {
  const [section, setSection] = useState("physicians");
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");

  const isPhysicians = section === "physicians";
  const fields = isPhysicians ? PHYSICIAN_FIELDS : CPT_FIELDS;

  const rows = useMemo(() => {
    const list = isPhysicians ? physicians : cptCatalog;
    const key = isPhysicians ? "name" : "code";
    return [...list].sort((a, b) => (a[key] || "").localeCompare(b[key] || ""));
  }, [isPhysicians, physicians, cptCatalog]);

  // How many records already name each entry, shown beside the deactivate button so an admin can
  // see what a change reaches before making it.
  const usage = useMemo(() => {
    const counts = {};
    const bump = (v) => { if (v) counts[v] = (counts[v] || 0) + 1; };
    (charges || []).forEach(c => bump(isPhysicians ? c.provider : c.cpt));
    (appointments || []).forEach(a => bump(isPhysicians ? a.provider : a.cpt));
    return counts;
  }, [isPhysicians, charges, appointments]);

  function switchSection(next) {
    setSection(next);
    setDraft(null);
    setError("");
  }

  function validate() {
    if (isPhysicians) {
      if (!draft.name?.trim()) return "Physician name is required.";
      // An NPI is 10 digits. A payer rejects the entire claim on a malformed one, and that
      // rejection only surfaces weeks later on a remittance — worth catching at entry.
      if (!/^\d{10}$/.test((draft.npi || "").trim())) return "NPI must be exactly 10 digits.";
      const clash = physicians.find(p => p.id !== draft.id && (p.name || "").trim().toLowerCase() === draft.name.trim().toLowerCase());
      if (clash) return "Another physician already uses that name.";
    } else {
      if (!/^\w{5}$/.test((draft.code || "").trim())) return "A CPT code is 5 characters.";
      if (!draft.desc?.trim()) return "Description is required.";
      if (!(Number(draft.charge) > 0)) return "Charge must be greater than zero.";
      const clash = cptCatalog.find(c => c.id !== draft.id && (c.code || "").trim() === draft.code.trim());
      if (clash) return "That CPT code is already in the catalog.";
    }
    return "";
  }

  function save() {
    const problem = validate();
    if (problem) { setError(problem); return; }
    if (isPhysicians) {
      onSavePhysician({
        id: draft.id, name: draft.name.trim(), npi: draft.npi.trim(),
        specialty: (draft.specialty || "").trim(),
        signature: draft.signature || "",
      });
    } else {
      onSaveCpt({
        id: draft.id, code: draft.code.trim(), desc: draft.desc.trim(),
        charge: Number(draft.charge), category: (draft.category || "").trim(),
      });
    }
    setDraft(null);
    setError("");
  }

  const tabCls = (on) => `px-3 py-1.5 text-sm rounded-lg ${on ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-100"}`;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1">
          <button onClick={() => switchSection("physicians")} className={tabCls(isPhysicians)}>Physicians</button>
          <button onClick={() => switchSection("cpt")} className={tabCls(!isPhysicians)}>CPT codes</button>
        </div>
        {!draft && (
          <button
            onClick={() => { setDraft(isPhysicians ? { name: "", npi: "", specialty: "", signature: "" } : { code: "", desc: "", charge: "", category: "" }); setError(""); }}
            className="px-3 py-1.5 bg-teal-600 text-white rounded-lg text-sm hover:bg-teal-700"
          >
            {isPhysicians ? "Add physician" : "Add CPT code"}
          </button>
        )}
      </div>

      <p className="text-slate-500 text-sm mb-3">
        {isPhysicians
          ? "The provider dropdown on charges, claims, appointments and clinical notes is built from this list, and the NPI here is what lands in Box 24J of the CMS-1500."
          : "The CPT dropdown on charges and appointments is built from this list. Editing an amount here only affects charges posted from now on it never reprices one already sitting on an account."}
      </p>

      {draft && (
        <CatalogEditor
          fields={fields} draft={draft} error={error} signature={isPhysicians}
          onChange={(k, v) => setDraft({ ...draft, [k]: v })}
          onSave={save}
          onCancel={() => { setDraft(null); setError(""); }}
        />
      )}

      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 bg-slate-50 border-b border-slate-200">
              {fields.map(f => <th key={f.key} className="px-3 py-2 font-medium">{f.label}</th>)}
              {isPhysicians && <th className="px-3 py-2 font-medium">Signature</th>}
              <th className="px-3 py-2 font-medium">In use</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const active = r.active !== false;
              const used = usage[isPhysicians ? r.name : r.code] || 0;
              return (
                <tr key={r.id} className={`border-b border-slate-100 last:border-0 ${active ? "" : "bg-slate-50 text-slate-400"}`}>
                  {fields.map(f => (
                    <td key={f.key} className="px-3 py-2">{f.numeric ? money(r[f.key]) : (r[f.key] || "—")}</td>
                  ))}
                  {isPhysicians && (
                    <td className="px-3 py-2 text-xs">
                      {r.signature
                        ? <span className="text-emerald-700">On file</span>
                        : <span className="text-slate-400">—</span>}
                    </td>
                  )}
                  <td className="px-3 py-2 text-slate-500 text-xs">{used ? `${used} record${used === 1 ? "" : "s"}` : "—"}</td>
                  <td className="px-3 py-2"><StatusPill status={active ? "Active" : "Terminated"} /></td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button onClick={() => { setDraft({ ...r }); setError(""); }} className="text-teal-700 hover:underline text-xs mr-3">Edit</button>
                    <button
                      onClick={() => onSetActive(isPhysicians ? "physicians" : "cptCatalog", r, !active)}
                      className="text-slate-500 hover:underline text-xs"
                    >
                      {active ? "Deactivate" : "Reactivate"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={fields.length + (isPhysicians ? 4 : 3)} className="px-3 py-6 text-center text-slate-400">Nothing in this list yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400 mt-3">
        Entries are deactivated, never deleted — charges and appointments already naming one keep
        reading correctly, and a deactivated entry simply stops appearing in the dropdowns. Every
        change here is written to the audit log.
      </p>
    </div>
  );
}

// ---------- Master insurance list ----------
//
// One authoritative row per payer, managed from Settings > Insurance Management and selected on
// the patient insurance form. Before this, the insurer was free text on every policy: two billers
// spelling "UnitedHealthcare" differently produced two payers as far as every report was
// concerned, and a mistyped payer ID is a rejected claim nobody sees until the remittance.
//
// The permission identifiers below must match the constants in server/permissions.go - the server
// is the authority, and these strings are only how the UI asks the same question locally so it can
// hide what the caller cannot do anyway.
const PERM_INSURANCE = {
  view: "insurance.view",
  create: "insurance.create",
  update: "insurance.update",
  delete: "insurance.delete",
};

// Resolves the signed-in user's action grants from the same rolePermissions rows the server reads.
//
// This governs what the interface OFFERS, never what it permits: every one of these actions is
// re-checked server-side in writeAllowed/deleteAllowed. Hiding a button the API would reject is a
// courtesy to the user, not a security boundary.
function useInsurancePermissions(session, rolePermissions) {
  return useMemo(() => {
    if (session?.role === "SUPER_ADMIN") {
      return { view: true, create: true, update: true, delete: true, any: true };
    }
    const row = rolePermissions.find(r => r.id === session?.role);
    const held = new Set(Array.isArray(row?.permissions) ? row.permissions : []);
    const out = {
      view: held.has(PERM_INSURANCE.view),
      create: held.has(PERM_INSURANCE.create),
      update: held.has(PERM_INSURANCE.update),
      delete: held.has(PERM_INSURANCE.delete),
    };
    // Being able to add or edit implies being able to see the list - otherwise the grant is
    // unusable and an administrator has to know to tick two boxes to mean one thing.
    out.view = out.view || out.create || out.update || out.delete;
    out.any = out.view;
    return out;
  }, [session?.role, rolePermissions]);
}

const INSURANCE_STATUSES = ["Active", "Inactive"];

// ---------- Settings: Insurance Management ----------

function InsuranceManagement({ insurances, policies, perms, onSave, onSetStatus, onDelete }) {
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(null); // { row, inUse }
  const [search, setSearch] = useState("");

  // How many patient policies point at each master row. Shown beside the row so an administrator
  // can see what a change reaches, and used to decide whether deletion is even offered.
  const usage = useMemo(() => {
    const counts = {};
    (policies || []).forEach(p => {
      if (p.insuranceId) counts[p.insuranceId] = (counts[p.insuranceId] || 0) + 1;
    });
    return counts;
  }, [policies]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = [...insurances].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    if (!q) return list;
    return list.filter(i =>
      (i.name || "").toLowerCase().includes(q) || (i.payerId || "").toLowerCase().includes(q));
  }, [insurances, search]);

  function validate() {
    if (!draft.name?.trim()) return "Insurance name is required.";
    if (!draft.payerId?.trim()) return "Payer ID is required.";
    if (!draft.address?.trim()) return "Insurance address is required.";
    // The database enforces both of these too (see migrations/005); checking here as well turns a
    // 400 from the server into an inline message before the round trip.
    const name = draft.name.trim().toLowerCase();
    if (insurances.some(i => i.id !== draft.id && (i.name || "").trim().toLowerCase() === name)) {
      return "An insurance company with that name already exists.";
    }
    const payer = draft.payerId.trim();
    if (insurances.some(i => i.id !== draft.id && (i.payerId || "").trim() === payer)) {
      const clash = insurances.find(i => i.id !== draft.id && (i.payerId || "").trim() === payer);
      return `Payer ID ${payer} is already used by ${clash.name}.`;
    }
    return "";
  }

  function save() {
    const problem = validate();
    if (problem) { setError(problem); return; }
    onSave({
      id: draft.id,
      name: draft.name.trim(),
      payerId: draft.payerId.trim(),
      address: draft.address.trim(),
      phone: (draft.phone || "").trim(),
      website: (draft.website || "").trim(),
      notes: (draft.notes || "").trim(),
      status: draft.status || "Active",
    });
    setDraft(null);
    setError("");
  }

  function askRemove(row) {
    setConfirm({ row, inUse: usage[row.id] || 0 });
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <input
          className={`${inputCls} max-w-xs`}
          placeholder="Search by name or payer ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {perms.create && !draft && (
          <button
            onClick={() => { setDraft({ name: "", payerId: "", address: "", phone: "", website: "", notes: "", status: "Active" }); setError(""); }}
            className="px-3 py-1.5 bg-teal-600 text-white rounded-lg text-sm hover:bg-teal-700 whitespace-nowrap"
          >
            Add insurance
          </button>
        )}
      </div>

      <p className="text-slate-500 text-sm mb-3">
        The insurance picker on a patient's policy is built from this list, and the payer ID and
        address it fills in come from here. Editing a row changes what new policies pick up — it
        never rewrites the payer details already recorded on an existing policy.
      </p>

      {draft && (
        <div className="border border-teal-200 bg-teal-50/40 rounded-lg p-3 mb-3">
          <div className="grid grid-cols-2 gap-x-3">
            <Field label="Insurance name"><input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Aetna" /></Field>
            <Field label="Payer ID" hint="The identifier claims are routed on."><input className={inputCls} value={draft.payerId} onChange={(e) => setDraft({ ...draft, payerId: e.target.value })} placeholder="60054" /></Field>
          </div>
          <Field label="Insurance address">
            <textarea className={`${inputCls} h-16 resize-none`} value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder="151 Farmington Avenue, Hartford, CT 06156" />
          </Field>
          <div className="grid grid-cols-3 gap-x-3">
            <Field label="Phone (optional)"><input className={inputCls} value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} /></Field>
            <Field label="Website (optional)"><input className={inputCls} value={draft.website} onChange={(e) => setDraft({ ...draft, website: e.target.value })} /></Field>
            <Field label="Status">
              <select className={inputCls} value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                {INSURANCE_STATUSES.map(s => <option key={s}>{s}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Notes (optional)"><input className={inputCls} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></Field>

          {error && <p className="text-xs text-rose-600 mb-2">{error}</p>}
          <div className="flex gap-2">
            <button onClick={save} className="px-3 py-1.5 bg-teal-600 text-white rounded-lg text-sm hover:bg-teal-700">{draft.id ? "Save changes" : "Add"}</button>
            <button onClick={() => { setDraft(null); setError(""); }} className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm hover:bg-slate-50">Cancel</button>
          </div>
        </div>
      )}

      <div className="border border-slate-200 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 bg-slate-50 border-b border-slate-200">
              <th className="px-3 py-2 font-medium">Insurance name</th>
              <th className="px-3 py-2 font-medium">Payer ID</th>
              <th className="px-3 py-2 font-medium">Address</th>
              <th className="px-3 py-2 font-medium">In use</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Updated</th>
              <th className="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const active = (r.status || "Active") === "Active";
              const used = usage[r.id] || 0;
              return (
                <tr key={r.id} className={`border-b border-slate-100 last:border-0 ${active ? "" : "bg-slate-50 text-slate-400"}`}>
                  <td className="px-3 py-2 font-medium text-slate-800">{r.name}</td>
                  <td className="px-3 py-2 text-slate-600">{r.payerId || "—"}</td>
                  <td className="px-3 py-2 text-slate-500 text-xs max-w-[220px] whitespace-normal">{r.address || "—"}</td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{used ? `${used} ${used === 1 ? "policy" : "policies"}` : "—"}</td>
                  <td className="px-3 py-2"><StatusPill status={active ? "Active" : "Terminated"} /></td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{fmtDate(r.createdAt)}</td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{fmtDate(r.updatedAt)}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {perms.update && (
                      <button onClick={() => { setDraft({ ...r, status: r.status || "Active" }); setError(""); }} className="text-teal-700 hover:underline text-xs mr-3">Edit</button>
                    )}
                    {perms.update && (
                      <button
                        onClick={() => onSetStatus(r, active ? "Inactive" : "Active")}
                        className="text-slate-500 hover:underline text-xs mr-3"
                      >
                        {active ? "Deactivate" : "Reactivate"}
                      </button>
                    )}
                    {perms.delete && (
                      <button onClick={() => askRemove(r)} className="text-rose-600 hover:underline text-xs">Delete</button>
                    )}
                    {!perms.update && !perms.delete && <span className="text-xs text-slate-300">View only</span>}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                {insurances.length === 0 ? "No insurance companies yet." : `Nothing matches "${search.trim()}".`}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {confirm && (
        <Modal title={confirm.inUse > 0 ? "Deactivate insurance" : "Delete insurance"} onClose={() => setConfirm(null)}>
          {confirm.inUse > 0 ? (
            <>
              <p className="text-sm text-slate-600 mb-3">
                <strong>{confirm.row.name}</strong> is used by{" "}
                <strong>{confirm.inUse} patient {confirm.inUse === 1 ? "policy" : "policies"}</strong>, so it cannot be deleted.
              </p>
              <p className="text-sm text-slate-600 mb-4">
                Deactivating it instead takes it out of the picker for new policies. Existing patient
                records are not affected and keep showing the payer details they were created with.
              </p>
              <div className="flex justify-end gap-2">
                <button onClick={() => setConfirm(null)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm hover:bg-slate-50">Cancel</button>
                <button
                  onClick={() => { onSetStatus(confirm.row, "Inactive"); setConfirm(null); }}
                  className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm hover:bg-amber-600"
                >
                  Deactivate
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-600 mb-4">
                Delete <strong>{confirm.row.name}</strong>? No patient policy references it, so nothing
                else changes. This cannot be undone — deactivate instead if you may need it later.
              </p>
              <div className="flex justify-end gap-2">
                <button onClick={() => setConfirm(null)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm hover:bg-slate-50">Cancel</button>
                <button
                  onClick={() => { onSetStatus(confirm.row, "Inactive"); setConfirm(null); }}
                  className="px-3 py-2 border border-slate-300 rounded-lg text-sm hover:bg-slate-50"
                >
                  Deactivate instead
                </button>
                <button
                  onClick={() => { onDelete(confirm.row); setConfirm(null); }}
                  className="px-4 py-2 bg-rose-600 text-white rounded-lg text-sm hover:bg-rose-700"
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

// ---------- Searchable single-select for picking a master insurer ----------
//
// A practice can carry hundreds of payers, so this filters as you type rather than rendering the
// whole list. Inactive rows are excluded unless one is already selected on the policy being
// edited - a retired payer must stay visible on the record that already uses it, or reopening an
// old policy would silently blank its insurer.
function InsuranceSelect({ insurances, value, onChange, error, disabled }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef(null);

  const selected = insurances.find(i => i.id === value) || null;

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = insurances.filter(i => (i.status || "Active") === "Active" || i.id === value);
    const list = q
      ? base.filter(i => (i.name || "").toLowerCase().includes(q) || (i.payerId || "").toLowerCase().includes(q))
      : base;
    return [...list].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [insurances, query, value]);

  // Close when the click lands outside, so the list does not stay open over the rest of the form.
  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function choose(ins) {
    onChange(ins);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHighlight(h => Math.min(h + 1, options.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && open && options[highlight]) { e.preventDefault(); choose(options[highlight]); }
    else if (e.key === "Escape") { setOpen(false); }
  }

  return (
    <div className="mb-3" ref={boxRef}>
      <span className="block text-xs font-medium text-slate-500 mb-1">Insurance company</span>

      {selected && !open ? (
        <div className={`flex items-center justify-between gap-2 border rounded-lg px-3 py-2 ${error ? "border-rose-300" : "border-slate-300"}`}>
          <span className="text-sm text-slate-800">
            {selected.name}
            {(selected.status || "Active") !== "Active" && <span className="ml-2 text-xs text-amber-600">(inactive)</span>}
          </span>
          {!disabled && (
            <div className="flex items-center gap-2 shrink-0">
              <button type="button" onClick={() => { setOpen(true); setQuery(""); }} className="text-xs text-teal-700 hover:underline">Change</button>
              <button type="button" onClick={() => onChange(null)} className="text-xs text-slate-400 hover:text-slate-600">Clear</button>
            </div>
          )}
        </div>
      ) : (
        <div className="relative">
          <input
            className={`${inputCls} ${error ? "border-rose-300" : ""}`}
            placeholder="Search insurance by name or payer ID…"
            value={query}
            disabled={disabled}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); setHighlight(0); }}
            onFocus={() => { setOpen(true); setHighlight(0); }}
            onKeyDown={onKeyDown}
          />
          {open && (
            <div className="absolute z-30 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg">
              {options.length === 0 ? (
                <div className="px-3 py-3 text-xs text-slate-400">
                  {insurances.length === 0
                    ? "No insurance companies have been set up yet. An administrator adds them in Settings → Insurance Management."
                    : `No insurance matches "${query.trim()}".`}
                </div>
              ) : options.map((ins, i) => (
                <button
                  type="button"
                  key={ins.id}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => choose(ins)}
                  className={`w-full text-left px-3 py-2 border-b border-slate-100 last:border-0 ${i === highlight ? "bg-teal-50" : "hover:bg-slate-50"}`}
                >
                  <div className="text-sm text-slate-800">{ins.name}</div>
                  <div className="text-[11px] text-slate-400">
                    Payer ID {ins.payerId || "—"}{ins.address ? ` · ${ins.address}` : ""}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <span className="block text-[11px] text-rose-600 mt-1">{error}</span>}
    </div>
  );
}

// ---------- Settings: Manage roles (SUPER_ADMIN only) ----------

// Grants are edited as a role x tab grid and saved one role at a time, so a half-finished edit to
// one role never rides along with another. Super Admin is shown for orientation but locked: it
// always holds every tab, which is what guarantees there is a way back into this screen.
// The four insurance actions, in the order they are stored and displayed. Must match the
// constants in server/permissions.go - the server rejects anything it does not recognise.
const INSURANCE_PERMISSION_COLUMNS = [
  { id: "insurance.view", label: "View" },
  { id: "insurance.create", label: "Add" },
  { id: "insurance.update", label: "Edit" },
  { id: "insurance.delete", label: "Delete" },
];

function ManageRoles({ rolePermissions, users, navItems, onSave }) {
  const [draft, setDraft] = useState(() => {
    const out = {};
    userRoles.forEach(r => {
      const row = rolePermissions.find(p => p.id === r);
      out[r] = Array.isArray(row?.tabs) ? [...row.tabs] : [...(DEFAULT_ROLE_TABS[r] || [])];
    });
    return out;
  });
  // Action grants are tracked separately from tab grants because they are a different kind of
  // decision: a tab controls navigation, an action controls writing shared billing reference
  // data. Nobody holds any of these until an administrator grants them.
  const [permDraft, setPermDraft] = useState(() => {
    const out = {};
    userRoles.forEach(r => {
      const row = rolePermissions.find(p => p.id === r);
      out[r] = Array.isArray(row?.permissions) ? [...row.permissions] : [];
    });
    return out;
  });
  const [savedRole, setSavedRole] = useState("");

  // "users" is no longer in navItems (it moved into the Settings menu), so it is appended here —
  // it still governs who can reach User accounts and Manage roles.
  const columns = [...navItems.map(n => ({ id: n.id, label: n.label })), { id: "users", label: "Administration" }];

  function toggle(role, tabId) {
    setDraft(d => {
      const has = d[role].includes(tabId);
      return { ...d, [role]: has ? d[role].filter(t => t !== tabId) : [...d[role], tabId] };
    });
    setSavedRole("");
  }

  function togglePerm(role, permId) {
    setPermDraft(d => {
      const has = d[role].includes(permId);
      return { ...d, [role]: has ? d[role].filter(t => t !== permId) : [...d[role], permId] };
    });
    setSavedRole("");
  }

  function isChanged(role) {
    const row = rolePermissions.find(p => p.id === role);
    const savedTabs = Array.isArray(row?.tabs) ? row.tabs : (DEFAULT_ROLE_TABS[role] || []);
    const tabsChanged = savedTabs.length !== draft[role].length || savedTabs.some(t => !draft[role].includes(t));

    const savedPerms = Array.isArray(row?.permissions) ? row.permissions : [];
    const permsChanged = savedPerms.length !== permDraft[role].length || savedPerms.some(t => !permDraft[role].includes(t));

    return tabsChanged || permsChanged;
  }

  function save(role) {
    // Store in nav order rather than click order, so the audit entry reads as a real diff
    // instead of a reshuffle.
    const ordered = columns.map(c => c.id).filter(id => draft[role].includes(id));
    const orderedPerms = INSURANCE_PERMISSION_COLUMNS.map(c => c.id).filter(id => permDraft[role].includes(id));
    onSave(role, ordered, orderedPerms);
    setSavedRole(role);
  }

  return (
    <div>
      <p className="text-slate-500 text-sm mb-4">
        Controls which screens each role can open. These grants are enforced by the server as well as the
        interface — a role without <span className="font-medium">Billing</span> can't post charges through the
        API either, not merely have the tab hidden. Changes apply the next time that person loads the app.
      </p>

      <Card className="overflow-x-auto mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5 font-medium">Role</th>
              {columns.map(c => <th key={c.id} className="px-2 py-2.5 font-medium text-center whitespace-nowrap">{c.label}</th>)}
              <th className="px-4 py-2.5 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {userRoles.map(role => {
              const locked = role === "SUPER_ADMIN";
              const count = users.filter(u => u.role === role && !u.disabled).length;
              return (
                <tr key={role} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-slate-800 whitespace-nowrap">{ROLE_LABELS[role]}</div>
                    <div className="text-xs text-slate-400 whitespace-nowrap">{count} active {count === 1 ? "user" : "users"}</div>
                  </td>
                  {columns.map(c => (
                    <td key={c.id} className="px-2 py-2.5 text-center">
                      <input
                        type="checkbox"
                        className="w-4 h-4 accent-teal-600 disabled:opacity-40"
                        checked={locked || draft[role].includes(c.id)}
                        disabled={locked}
                        onChange={() => toggle(role, c.id)}
                      />
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    {locked ? (
                      <span className="text-xs text-slate-400">Always full access</span>
                    ) : isChanged(role) ? (
                      <button onClick={() => save(role)} className="text-xs bg-teal-600 text-white rounded-lg px-2.5 py-1 hover:bg-teal-700">Save</button>
                    ) : (
                      <span className="text-xs text-slate-400">{savedRole === role ? "Saved" : "—"}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <h4 className="text-sm font-medium text-slate-700 mb-1">Insurance Management</h4>
      <p className="text-slate-500 text-sm mb-3">
        Who may work with the master insurance list — the payer names, payer IDs and addresses that
        every patient policy is built from. Separate from the Billing tab on purpose: posting a payment
        and rewriting the payer list are different kinds of trust. Ticking any box here puts Insurance
        Management in that role's Settings menu. Save with the button on the role's row above.
      </p>

      <Card className="overflow-x-auto mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5 font-medium">Role</th>
              {INSURANCE_PERMISSION_COLUMNS.map(c => (
                <th key={c.id} className="px-2 py-2.5 font-medium text-center whitespace-nowrap">{c.label}</th>
              ))}
              <th className="px-4 py-2.5 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {userRoles.map(role => {
              const locked = role === "SUPER_ADMIN";
              return (
                <tr key={role} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2.5 font-medium text-slate-800 whitespace-nowrap">{ROLE_LABELS[role]}</td>
                  {INSURANCE_PERMISSION_COLUMNS.map(c => (
                    <td key={c.id} className="px-2 py-2.5 text-center">
                      <input
                        type="checkbox"
                        className="w-4 h-4 accent-teal-600 disabled:opacity-40"
                        checked={locked || permDraft[role].includes(c.id)}
                        disabled={locked}
                        onChange={() => togglePerm(role, c.id)}
                      />
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    {locked && <span className="text-xs text-slate-400">Always full access</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <p className="text-xs text-slate-400">
        Every role keeps the Dashboard, Batch Management and their own password regardless of this grid.
        The Super Admin role can't be edited and only a Super Admin can open this screen — together that is
        what stops the last admin from locking everyone out.
      </p>
    </div>
  );
}

// ---------- User account administration (SUPER_ADMIN only) ----------

const userRoles = ["SUPER_ADMIN", "MANAGER", "NURSE", "RECEPTIONIST", "BILLER"];

function UserManagement({ users, auditLogs, session, onAddUser, onSetDisabled, onChangeRole, onResetPassword }) {
  const [showAdd, setShowAdd] = useState(false);
  const [resetting, setResetting] = useState(null);
  const sorted = [...users].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const recentActions = auditLogs.filter(a => a.entityType === "user").slice(0, 8);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold text-slate-800">User accounts</h1>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 bg-teal-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-teal-700"><Plus size={15} /> Add user</button>
      </div>
      <p className="text-slate-500 text-sm mb-4">Only Super Admins can see this page. Deactivating an account blocks that person from signing in, it doesn't delete their history, the same way nothing else in this app is ever hard-deleted.</p>

      <Card className="mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">Email</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(u => {
              const isSelf = u.email === session.email;
              return (
                <tr key={u.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2.5 font-medium text-slate-800">{u.name}{isSelf && <span className="text-slate-400 font-normal"> (you)</span>}</td>
                  <td className="px-4 py-2.5 text-slate-600">{u.email}</td>
                  <td className="px-4 py-2.5">
                    <select
                      className="border border-slate-300 rounded-lg px-2 py-1 text-xs"
                      value={u.role}
                      disabled={isSelf}
                      onChange={(e) => onChangeRole(u.id, e.target.value)}
                    >
                      {userRoles.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2.5"><StatusPill status={u.disabled ? "Terminated" : "Active"} /></td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <button onClick={() => setResetting(u)} className="text-xs text-slate-600 border border-slate-200 rounded-lg px-2.5 py-1 hover:bg-slate-50 mr-1.5">Reset password</button>
                    {!isSelf && (
                      u.disabled ? (
                        <button onClick={() => onSetDisabled(u.id, false)} className="text-xs text-teal-700 border border-teal-200 bg-teal-50 rounded-lg px-2.5 py-1 hover:bg-teal-100">Reactivate</button>
                      ) : (
                        <button onClick={() => onSetDisabled(u.id, true)} className="text-xs text-rose-600 border border-rose-200 bg-rose-50 rounded-lg px-2.5 py-1 hover:bg-rose-100">Deactivate</button>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">No user accounts yet.</td></tr>}
          </tbody>
        </table>
      </Card>

      <h3 className="font-medium text-slate-700 mb-2">Recent account changes</h3>
      <Card>
        <div className="divide-y divide-slate-100">
          {recentActions.map(a => (
            <div key={a.id} className="px-4 py-2.5 text-xs flex items-center justify-between">
              <span className="text-slate-700">{a.action} — {a.newValues}</span>
              <span className="text-slate-400 whitespace-nowrap ml-3">{a.user} · {fmtDateTime(a.timestamp)}</span>
            </div>
          ))}
          {recentActions.length === 0 && <p className="px-4 py-4 text-center text-slate-400 text-xs">No account changes yet.</p>}
        </div>
      </Card>

      {showAdd && (
        <Modal title="Add user" onClose={() => setShowAdd(false)}>
          <AddUserForm onSubmit={async (form) => { await onAddUser(form); setShowAdd(false); }} />
        </Modal>
      )}

      {resetting && (
        <Modal title={`Reset password — ${resetting.name}`} onClose={() => setResetting(null)}>
          <ResetPasswordForm
            user={resetting}
            onSubmit={(pw) => onResetPassword(resetting.id, pw)}
            onDone={() => setResetting(null)}
          />
        </Modal>
      )}
    </div>
  );
}

// Admin-side reset. Deliberately does not ask for the admin's own password: the session already
// proves who they are, and the account being reset is by definition one nobody can get into.
function ResetPasswordForm({ user, onSubmit, onDone }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function submit() {
    if (pw.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (pw !== confirm) { setError("The two passwords don't match."); return; }
    setError("");
    setSaving(true);
    try {
      await onSubmit(pw);
      setDone(true);
    } catch {
      setError("Couldn't reset the password. Please try again.");
    }
    setSaving(false);
  }

  if (done) {
    return (
      <div>
        <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-3">
          Password reset for {user.name}. Give it to them directly — it isn't emailed, and it isn't recorded
          in the audit log.
        </p>
        <button onClick={onDone} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Done</button>
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm text-slate-500 mb-3">Sets a new password for <span className="font-medium text-slate-700">{user.email}</span>. Any session they already have open stays signed in.</p>
      <Field label="New password" hint="At least 6 characters."><input type="password" autoComplete="new-password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
      <Field label="Confirm new password"><input type="password" autoComplete="new-password" className={inputCls} value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} disabled={saving} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700 disabled:opacity-60">{saving ? "Resetting…" : "Reset password"}</button>
    </div>
  );
}

function AddUserForm({ onSubmit }) {
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "RECEPTIONIST" });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!form.name.trim()) { setError("Name is required."); return; }
    if (!/^\S+@\S+\.\S+$/.test(form.email)) { setError("Enter a valid email address."); return; }
    if (form.password.length < 6) { setError("Password must be at least 6 characters."); return; }
    setError("");
    setSaving(true);
    try {
      await onSubmit(form);
    } catch (err) {
      setError(err?.code === "auth/email-already-in-use" ? "An account with that email already exists." : "Couldn't create the account. Please try again.");
      setSaving(false);
    }
  }

  return (
    <div>
      <Field label="Full name"><input className={inputCls} value={form.name} onChange={set("name")} /></Field>
      <Field label="Email"><input type="email" className={inputCls} value={form.email} onChange={set("email")} /></Field>
      <Field label="Temporary password" hint="At least 6 characters — share this with them directly."><input className={inputCls} value={form.password} onChange={set("password")} /></Field>
      <Field label="Role">
        <select className={inputCls} value={form.role} onChange={set("role")}>
          {userRoles.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
      </Field>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} disabled={saving} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700 disabled:opacity-60">{saving ? "Creating…" : "Create account"}</button>
    </div>
  );
}

// ---------- Report center: aging / debit / credit, with CSV / PDF export ----------

function ReportCenter({ charges, patientById, transactions, patients, policies, batches, userAccounts, session, isOversight }) {
  const [reportType, setReportType] = useState("aging");
  const [groupBy, setGroupBy] = useState("physician");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [showDailyTxn, setShowDailyTxn] = useState(false);
  // Held here rather than inside the modal so the printable block can live outside it — the modal
  // panel is fixed and scroll-clipped, which would truncate the printout.
  const [dailyTxnResult, setDailyTxnResult] = useState(null);

  const batchLabelById = useMemo(
    () => Object.fromEntries((batches || []).map(b => [b.id, b.batchNumber || b.id])),
    [batches]
  );

  // ----- Aging report -----
  const openCharges = charges.filter(c => balanceOf(c) > 0);

  const agingDetailRows = useMemo(() => {
    if (reportType !== "aging") return [];
    const base = groupBy === "self"
      ? openCharges.filter(c => !currentPrimaryPolicy(c.patientId, policies))
      : openCharges;

    // ONE SERVICE = ONE ROW. `base` is already filtered above, so grouping happens after
    // filtering and the totals always describe exactly what is on screen.
    //
    // The invariant that keeps the money right: Balance is accumulated once per CHARGE, in the
    // outer loop below, and never inside the memo loop. A service with twenty memos therefore
    // still has the balance of its charge(s) — activity cannot inflate it.
    const services = new Map();

    for (const c of base) {
      const p = patientById[c.patientId] || null;
      const primary = currentPrimaryPolicy(c.patientId, policies);
      const group = groupBy === "physician" ? c.provider : groupBy === "insurance" ? (primary ? primary.insuranceCompany : "Self-pay") : "Self-pay";
      const key = JSON.stringify([group, c.patientId, isoDay(c.dos), normCpt(c.cpt)]);

      let svc = services.get(key);
      if (!svc) {
        svc = {
          Group: group,
          // A charge always carries its own account number, so an account whose patient record is
          // missing is still identified rather than rendered as a blank row. Reading these only
          // out of patientById is why charges belonging to many DIFFERENT accounts all appeared
          // with an empty Patient/Account/DOB/Phone and read as the same row repeated.
          Patient: p ? p.name : "(patient record missing)",
          Account: p ? p.id : c.patientId,
          DOB: p ? fmtDate(p.dob) : "",
          Phone: p ? p.phone || "" : "",
          SSN: p ? maskSSN(p.ssn) : "",
          "Insurance name": primary ? primary.insuranceCompany : "Self-pay",
          "Insurance ID": primary ? primary.memberId : "",
          CPT: c.cpt,
          DOS: fmtDate(c.dos),
          Bucket: agingBucket(daysBetween(c.dos, TODAY)),
          Charge: 0,
          Paid: 0,
          Adjustment: 0,
          Credit: 0,
          Balance: 0,
          // Whose money this is, derived exactly as the Insurance name above is, so the
          // statement's split can never disagree with the column beside it.
          _responsibility: primary ? "insurance" : "patient",
          _activity: [],
        };
        services.set(key, svc);
      }

      // Once per charge row. A service split across two charge rows (the same lab billed twice on
      // one visit) sums to one row instead of appearing twice. These are the charge's own stored
      // columns and balanceOf() - the same figures every other screen bills from, not a second
      // calculation - so Charge - Paid - Adjustment - Credit still equals Balance.
      svc.Charge += c.charge;
      svc.Paid += c.paid;
      svc.Adjustment += c.writeoff;
      svc.Credit += c.credits || 0;
      svc.Balance += balanceOf(c);

      // Activity is collected, never counted. Nothing in this loop touches Balance.
      for (const m of c.memos || []) {
        svc._activity.push({
          date: fmtDate(m.date),
          time: fmtTime(m.at),
          sort: `${isoDay(m.date)}T${String(m.at || "").slice(11) || "00:00:00"}`,
          user: m.user || "",
          type: m.type || "Note",
          text: m.text || "",
        });
      }
    }

    return [...services.values()].map(svc => {
      // Oldest first inside the box, so the follow-up trail reads top to bottom.
      svc._activity.sort((a, b) => a.sort.localeCompare(b.sort));
      // One cell for CSV and the PDF, which cannot draw a box. Same content, flattened.
      svc.Memo = svc._activity.map(a => `${a.date}${a.time ? " " + a.time : ""} ${a.user}: ${a.text}`).join(" | ");
      svc["Memo count"] = svc._activity.length;
      return svc;
    }).sort((a, b) => a.Group.localeCompare(b.Group) || b.Balance - a.Balance);
  }, [reportType, groupBy, openCharges, patientById, policies]);

  const agingGroupTotals = useMemo(() => {
    const totals = {};
    agingDetailRows.forEach(r => { totals[r.Group] = (totals[r.Group] || 0) + r.Balance; });
    return totals;
  }, [agingDetailRows]);

  // ----- Debit report (charges posted) -----
  const debitRows = useMemo(() => {
    if (reportType !== "debit") return [];
    return transactions
      .filter(t => t.type === "charge" || t.type === "debit")
      .filter(t => (!fromDate || t.date >= fromDate) && (!toDate || t.date <= toDate))
      .map(t => {
        const charge = charges.find(c => c.id === t.chargeId);
        const isDebit = t.type === "debit";
        return {
          Date: fmtDate(t.date), Patient: patientById[t.patientId]?.name || "", Physician: charge?.provider || "",
          CPT: charge?.cpt || "", Description: isDebit ? `Debit — ${t.reference} (${t.source})` : (charge?.desc || ""), Amount: t.amount,
        };
      })
      .sort((a, b) => b.Date.localeCompare(a.Date));
  }, [reportType, transactions, charges, patientById, fromDate, toDate]);

  // ----- Credit report (payments + write-offs posted) -----
  const creditRows = useMemo(() => {
    if (reportType !== "credit") return [];
    return transactions
      .filter(t => t.type === "payment" || t.type === "writeoff")
      .filter(t => (!fromDate || t.date >= fromDate) && (!toDate || t.date <= toDate))
      .map(t => {
        const charge = charges.find(c => c.id === t.chargeId);
        return {
          Date: fmtDate(t.date), Patient: patientById[t.patientId]?.name || "", Physician: charge?.provider || "",
          Type: t.type === "payment" ? "Payment" : "Write-off", Source: t.source || "", Reference: t.reference || "", Amount: t.amount,
        };
      })
      .sort((a, b) => b.Date.localeCompare(a.Date));
  }, [reportType, transactions, charges, patientById, fromDate, toDate]);

  const reportTitle = {
    aging: `Aging report  by ${groupBy === "physician" ? "physician" : groupBy === "insurance" ? "insurance type" : "self-pay"}`,
    debit: "Debit report charges posted",
    credit: "Credit report payments & write-offs posted",
  }[reportType];

  // CSV and the PDF read their columns straight off the row objects, so the structured activity
  // list is dropped here — its flattened text is already in the Memo column. Both therefore get
  // exactly the same grouped rows the table shows: one per service, never one per activity.
  const exportRows = useMemo(() => {
    const rows = reportType === "aging" ? agingDetailRows : reportType === "debit" ? debitRows : creditRows;
    return rows.map(r => {
      const out = {};
      for (const [k, v] of Object.entries(r)) if (!k.startsWith("_")) out[k] = v;
      return out;
    });
  }, [reportType, agingDetailRows, debitRows, creditRows]);
  const filenameBase = reportType === "aging" ? `aging-report-${groupBy}` : reportType === "debit" ? "debit-report" : "credit-report";

  const grandTotal = reportType === "aging"
    ? agingDetailRows.reduce((s, r) => s + r.Balance, 0)
    : exportRows.reduce((s, r) => s + (r.Amount || 0), 0);

  const [pdfError, setPdfError] = useState("");

  // The PDF is built from exportRows - the very array the CSV button exports - so
  // the two can never disagree, and no report calculation is repeated here.
  function handleExportPDF() {
    setPdfError("");

    // The aging report gets a dedicated Accounts Receivable Statement. The debit and credit
    // reports keep the existing table-style PDF untouched - they are transaction listings, not
    // statements, and nothing about them was asked to change.
    const result = reportType === "aging"
      ? openAgingStatementPDF({
          // agingDetailRows, not exportRows: the statement needs the structured activity list
          // that CSV cannot carry. Both come from the same grouped, already-filtered array.
          rows: agingDetailRows,
          groupTotals: agingGroupTotals,
          groupLabel: groupBy === "physician" ? "Physician" : groupBy === "insurance" ? "Insurance" : "Self-pay",
          criteria: {
            "Report type": "Aging — accounts receivable",
            "Grouped by": groupBy === "physician" ? "Physician" : groupBy === "insurance" ? "Insurance type" : "Self-pay accounts",
            "Aging as-of date": fmtDate(TODAY),
            "Balances included": "Outstanding only",
            "Services": String(agingDetailRows.length),
            "Prepared by": session?.name || "",
          },
          filename: safeFilename("Aging_Report", groupBy === "self" ? "Self_Pay" : groupBy, TODAY) + ".pdf",
        })
      : openReportPDF({
          title: reportTitle,
          meta: [
            `Date range: ${fromDate ? fmtDate(fromDate) : "all dates"} to ${toDate ? fmtDate(toDate) : "all dates"}`,
            "Generated " + fmtDate(TODAY),
          ],
          rows: exportRows,
          totalLabel: "Total",
          totalValue: grandTotal,
          filename: `${filenameBase}.pdf`,
          groupTotals: null,
        });

    if (!result.ok) setPdfError(result.error);
    else if (result.popupBlocked) {
      setPdfError("Your browser blocked the new tab, so the PDF was downloaded instead.");
    }
  }

  return (
    <div>
      {/* Print-only styling: hides everything except #printable-report when printReport() is called */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #printable-report, #printable-report * { visibility: visible; }
          #printable-report { position: absolute; top: 0; left: 0; width: 100%; padding: 24px; }
        }
      `}</style>

      <div className="mb-4 print:hidden">
        <SectionTitle>Daily Report</SectionTitle>
        <button
          onClick={() => setShowDailyTxn(true)}
          className="flex items-center gap-2 text-sm text-slate-700 border border-slate-200 rounded-lg px-3 py-2 hover:bg-slate-50 hover:border-teal-300"
        >
          <CalendarDays size={14} className="text-teal-600" /> Daily Transaction
        </button>
      </div>

      <div className="flex items-center gap-2 mb-3 print:hidden">
        <span className="text-xs text-slate-400">Quick generate:</span>
        <button onClick={() => setReportType("debit")} className={`text-xs px-3 py-1.5 rounded-lg border ${reportType === "debit" ? "bg-slate-900 text-white border-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>Debit report</button>
        <button onClick={() => setReportType("credit")} className={`text-xs px-3 py-1.5 rounded-lg border ${reportType === "credit" ? "bg-slate-900 text-white border-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>Credit report</button>
        <button onClick={() => setReportType("aging")} className={`text-xs px-3 py-1.5 rounded-lg border ${reportType === "aging" ? "bg-slate-900 text-white border-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>Aging report</button>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-4 print:hidden">
        <Field label="Report type">
          <select className={inputCls} value={reportType} onChange={(e) => setReportType(e.target.value)}>
            <option value="aging">Aging report</option>
            <option value="debit">Debit report (charges + debited payments)</option>
            <option value="credit">Credit report (payments &amp; write-offs)</option>
          </select>
        </Field>
        {reportType === "aging" && (
          <Field label="Group by">
            <select className={inputCls} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              <option value="physician">Physician</option>
              <option value="insurance">Insurance type</option>
              <option value="self">Self-pay</option>
            </select>
          </Field>
        )}
        {reportType !== "aging" && (
          <>
            <Field label="From"><input type="date" className={inputCls} value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></Field>
            <Field label="To"><input type="date" className={inputCls} value={toDate} onChange={(e) => setToDate(e.target.value)} /></Field>
          </>
        )}

        <div className="flex gap-2 mb-3">
          <button onClick={() => exportCSV(`${filenameBase}.csv`, exportRows)} className="flex items-center gap-1.5 text-xs text-slate-600 border border-slate-200 rounded-lg px-3 py-2 hover:bg-slate-50">
            <Download size={13} /> CSV
          </button>
          <button onClick={handleExportPDF} className="flex items-center gap-1.5 text-xs text-slate-600 border border-slate-200 rounded-lg px-3 py-2 hover:bg-slate-50">
            <Printer size={13} /> PDF
          </button>
        </div>
      </div>

      {pdfError && (
        <div className="mb-3 print:hidden text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 flex items-start gap-2">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{pdfError}</span>
        </div>
      )}

      <div id="printable-report">
        <div className="hidden print:block mb-4">
          <h2 className="text-lg font-semibold">Retro EHR {reportTitle}</h2>
          <p className="text-xs text-slate-500">Generated {TODAY}</p>
        </div>

        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-medium text-slate-700">{reportTitle}</h3>
            <span className="text-sm text-slate-500">Total: <span className="font-semibold text-slate-800">{money(grandTotal)}</span></span>
          </div>

          {reportType === "aging" && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                    <th className="py-2 pr-3 font-medium">Patient</th>
                    <th className="py-2 pr-3 font-medium">Account</th>
                    <th className="py-2 pr-3 font-medium">DOB</th>
                    <th className="py-2 pr-3 font-medium">Phone</th>
                    <th className="py-2 pr-3 font-medium">SSN</th>
                    <th className="py-2 pr-3 font-medium">Insurance name</th>
                    <th className="py-2 pr-3 font-medium">Insurance ID</th>
                    <th className="py-2 pr-3 font-medium">CPT</th>
                    <th className="py-2 pr-3 font-medium">DOS</th>
                    <th className="py-2 pr-3 font-medium">Bucket</th>
                    <th className="py-2 pr-3 font-medium">Memo</th>
                    <th className="py-2 pr-3 font-medium text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    let lastGroup = null;
                    const out = [];
                    agingDetailRows.forEach((r, i) => {
                      if (r.Group !== lastGroup) {
                        lastGroup = r.Group;
                        out.push(
                          <tr key={`grp-${r.Group}-${i}`} className="bg-slate-50">
                            <td colSpan={11} className="py-1.5 pr-3 font-medium text-slate-600 text-xs uppercase tracking-wide">{r.Group}</td>
                            <td className="py-1.5 pr-3 text-right font-semibold text-slate-700">{money(agingGroupTotals[r.Group])}</td>
                          </tr>
                        );
                      }
                      out.push(
                        <tr key={i} className="border-b border-slate-100 last:border-0">
                          <td className="py-2 pr-3 text-slate-700">{r.Patient}</td>
                          <td className="py-2 pr-3 text-slate-500 text-xs">{r.Account}</td>
                          <td className="py-2 pr-3 text-slate-600">{r.DOB}</td>
                          <td className="py-2 pr-3 text-slate-600">{r.Phone}</td>
                          <td className="py-2 pr-3 text-slate-500 text-xs">{r.SSN}</td>
                          <td className="py-2 pr-3 text-slate-600">{r["Insurance name"]}</td>
                          <td className="py-2 pr-3 text-slate-500 text-xs">{r["Insurance ID"]}</td>
                          <td className="py-2 pr-3 text-slate-600">{r.CPT}</td>
                          <td className="py-2 pr-3 text-slate-600">{r.DOS}</td>
                          <td className="py-2 pr-3"><StatusPill status={r.Bucket === "0-30" ? "Open" : r.Bucket === "90+" ? "Denied" : "Partial"} /></td>
                          {/* ONE memo box per service. It scrolls rather than growing, so a
                              service with forty activities is still one normal-height row. */}
                          <td className="py-2 pr-3 align-top">
                            {r._activity && r._activity.length > 0 ? (
                              <div className="w-[260px] max-h-24 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50/60 divide-y divide-slate-200">
                                {r._activity.map((a, ai) => (
                                  <div key={ai} className="px-2 py-1.5 text-xs whitespace-normal">
                                    <div className="text-slate-400">
                                      {a.date}{a.time ? ` ${a.time}` : ""}{a.type && a.type !== "Note" ? ` · ${a.type}` : ""}
                                    </div>
                                    <div className="text-slate-600">{a.text}</div>
                                    {a.user && <div className="text-slate-400">Posted by: {a.user}</div>}
                                  </div>
                                ))}
                              </div>
                            ) : <span className="text-xs text-slate-400">No memo</span>}
                          </td>
                          <td className="py-2 pr-3 text-right font-medium text-rose-600">{money(r.Balance)}</td>
                        </tr>
                      );
                    });
                    return out;
                  })()}
                  {agingDetailRows.length === 0 && <tr><td colSpan={12} className="py-3 text-slate-400">No outstanding balances.</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {reportType === "debit" && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 font-medium">Date</th>
                  <th className="py-2 font-medium">Patient</th>
                  <th className="py-2 font-medium">Physician</th>
                  <th className="py-2 font-medium">CPT</th>
                  <th className="py-2 font-medium">Description</th>
                  <th className="py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {debitRows.map((r, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 text-slate-600">{r.Date}</td>
                    <td className="py-2 text-slate-700">{r.Patient}</td>
                    <td className="py-2 text-slate-600">{r.Physician}</td>
                    <td className="py-2 text-slate-600">{r.CPT}</td>
                    <td className="py-2 text-slate-600">{r.Description}</td>
                    <td className="py-2 text-right font-medium flex items-center justify-end gap-1"><TrendingUp size={12} className="text-slate-400" />{money(r.Amount)}</td>
                  </tr>
                ))}
                {debitRows.length === 0 && <tr><td colSpan={6} className="py-3 text-slate-400">No charges posted in this period.</td></tr>}
              </tbody>
            </table>
          )}

          {reportType === "credit" && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 font-medium">Date</th>
                  <th className="py-2 font-medium">Patient</th>
                  <th className="py-2 font-medium">Physician</th>
                  <th className="py-2 font-medium">Type</th>
                  <th className="py-2 font-medium">Source / payer</th>
                  <th className="py-2 font-medium">Reference</th>
                  <th className="py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {creditRows.map((r, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 text-slate-600">{r.Date}</td>
                    <td className="py-2 text-slate-700">{r.Patient}</td>
                    <td className="py-2 text-slate-600">{r.Physician}</td>
                    <td className="py-2"><StatusPill status={r.Type === "Payment" ? "Paid" : "Written off"} /></td>
                    <td className="py-2 text-slate-600">{r.Source}</td>
                    <td className="py-2 text-slate-500 text-xs">{r.Reference || "—"}</td>
                    <td className="py-2 text-right font-medium text-emerald-700 flex items-center justify-end gap-1"><TrendingDown size={12} className="text-emerald-500" />{money(r.Amount)}</td>
                  </tr>
                ))}
                {creditRows.length === 0 && <tr><td colSpan={7} className="py-3 text-slate-400">No payments or write-offs posted in this period.</td></tr>}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {showDailyTxn && (
        <DailyTransactionModal
          charges={charges} patientById={patientById} transactions={transactions} policies={policies || []}
          batches={batches || []} userAccounts={userAccounts || []} session={session} isOversight={isOversight}
          onClose={() => { setShowDailyTxn(false); setDailyTxnResult(null); }}
          onResult={setDailyTxnResult}
        />
      )}

      {/* Sibling of the modal, not a child: printing the full filtered dataset from inside a
          fixed, scroll-clipped panel would truncate it at the visible page. */}
      {showDailyTxn && dailyTxnResult && (
        <DailyTransactionPrintable
          result={dailyTxnResult}
          columns={dailyTxnColumns(dailyTxnResult.filters)}
          batchLabelById={batchLabelById}
          generatedBy={session?.name || ""}
        />
      )}
    </div>
  );
}

// ---------- Daily Transaction report (Reports -> Report center -> Daily Report) ----------

// Searchable multi-select used by the procedure / doctor / user / batch pickers. The search box
// is debounced so typing does not re-filter a long option list on every keystroke.
function MultiSelectSearch({ options, selected, onChange, placeholder, error }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const filtered = useMemo(() => {
    const q = debounced.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => o.label.toLowerCase().includes(q));
  }, [options, debounced]);

  function toggle(value) {
    onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]);
  }

  return (
    <div>
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
        <input
          className={`${inputCls} pl-8`} value={query} placeholder={placeholder}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {selected.map(v => {
            const opt = options.find(o => o.value === v);
            return (
              <span key={v} className="inline-flex items-center gap-1 bg-teal-50 text-teal-700 border border-teal-200 rounded-full px-2 py-0.5 text-xs">
                {opt ? opt.label : v}
                <button type="button" onClick={() => toggle(v)} className="text-teal-500 hover:text-teal-800"><X size={11} /></button>
              </span>
            );
          })}
        </div>
      )}
      <div className="mt-2 max-h-36 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
        {filtered.map(o => (
          <label key={o.value} className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 cursor-pointer">
            <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} className="accent-teal-600" />
            <span>{o.label}</span>
          </label>
        ))}
        {filtered.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">No matches.</p>}
      </div>
      {error && <p className="text-xs text-rose-600 mt-1">{error}</p>}
    </div>
  );
}

function RadioRow({ options, value, onChange, name }) {
  return (
    <div className="flex flex-wrap gap-4">
      {options.map(o => (
        <label key={o.value} className="flex items-center gap-1.5 text-sm text-slate-700 cursor-pointer">
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} className="accent-teal-600" />
          {o.label}
        </label>
      ))}
    </div>
  );
}

const dailyTxnBasedOnLabel = { service: "Service Date", deposit: "Deposit Date", transaction: "Transaction Date" };
const dailyTxnPatientLabel = { name: "Patient Name", total: "Total Patient Names" };
const dailyTxnPrintLabel = { both: "Charges and Receipt", charge: "Charge Only", receipt: "Receipt Only" };

// Human-readable list of the filters used, shown above the preview and on the printout (spec §19).
function dailyTxnFilterSummary(f, batchLabelById) {
  const list = (arr, all) => (arr.length ? arr.join(", ") : all);
  const batchNames = (ids) => ids.map(id => batchLabelById[id] || id);
  return [
    ["Patient Display", dailyTxnPatientLabel[f.patientDisplay]],
    ...(f.patientDisplay === "name" ? [["Print Type", dailyTxnPrintLabel[f.printWithName]]] : []),
    ["Procedure", f.procedureMode === "all" ? "All Procedure Codes" : list(f.procedureCodes, "All Procedure Codes")],
    ["Doctor", f.doctorMode === "all" ? "All Doctors" : list(f.doctors, "All Doctors")],
    ["User", f.userMode === "all" ? "All Users" : list(f.users, "All Users")],
    ["Batch", f.batchMode === "all" ? "All Batches" : list(batchNames(f.batchIds), "All Batches")],
    ["Report From", f.reportFrom === "closing" ? `Closing — ${list(batchNames(f.closingBatchIds), "none")}` : "Date Span"],
    ["Report Based On", dailyTxnBasedOnLabel[f.basedOn]],
    ...(f.reportFrom === "dateSpan" ? [["Date Span", `${f.startDate || "—"} – ${f.endDate || "—"}`]] : []),
    ["Included", [f.includeCharges && "Charges", f.includeReceipts && "Receipts"].filter(Boolean).join(" + ") || "None"],
  ];
}

function DailyTxnSummary({ totals }) {
  const items = [
    ["Total Patients", String(totals.totalPatients)],
    ["Total Transactions", String(totals.totalTransactions)],
    ["Total Charges", money(totals.totalCharges)],
    ["Total Adjustments", money(totals.totalAdjustments)],
    ["Total Receipts", money(totals.totalReceipts)],
    ["Remaining Balance", money(totals.remainingBalance)],
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
      {items.map(([label, value]) => (
        <div key={label} className="border border-slate-200 rounded-lg px-3 py-2">
          <span className="block text-[11px] uppercase tracking-wide text-slate-400">{label}</span>
          <span className="text-sm font-semibold text-slate-800">{value}</span>
        </div>
      ))}
    </div>
  );
}

function DailyTxnTable({ rows, columns }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm whitespace-nowrap">
        <thead>
          <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
            {columns.map(c => (
              <th key={c.key} className={`py-2 pr-3 font-medium ${c.align === "right" ? "text-right" : ""}`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key} className="border-b border-slate-100 last:border-0">
              {columns.map(c => {
                const v = c.get(r);
                return (
                  <td key={c.key} className={`py-2 pr-3 ${c.align === "right" ? "text-right font-medium" : "text-slate-600"}`}>
                    {c.money ? money(v) : v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Daily Transaction: PDF document ----------
//
// A dedicated financial document, not a rendering of the screen and never window.print(). It is
// built from result.summary and result.rows - the same filtered data the web report and the CSV
// use - so the three agree by construction.
//
// Landscape Letter throughout: the transaction detail carries fifteen columns, and portrait would
// mean either dropping columns or shrinking type past readability.

/**
 * @param {object} result   a generateDailyTransactionReport() result
 * @param {object[]} criteria [label, value] pairs describing the filters used
 * @param {string} generatedBy
 * @returns {{ok: boolean, error?: string, popupBlocked?: boolean}}
 */
function openDailyTxnPDF({ result, criteria, generatedBy, filename }) {
  if (!result || !result.rows.length) {
    return { ok: false, error: "There are no transactions in this report to put in a PDF." };
  }

  // Opened synchronously inside the click; a popup opened later from an async continuation is
  // blocked, and laying out a few thousand rows easily takes that long.
  const tab = window.open("", "_blank");

  try {
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "letter" });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const L = 12;
    const R = W - L;
    const s = result.summary;
    const t = s.totals;

    const tableBase = {
      margin: { left: L, right: L, top: 24, bottom: 16 },
      theme: "grid",
      styles: { fontSize: 7.5, cellPadding: 1.6, overflow: "linebreak", lineColor: [226, 232, 240] },
      headStyles: { fillColor: [241, 245, 249], textColor: [30, 41, 59], fontStyle: "bold" },
      footStyles: { fillColor: [255, 255, 255], textColor: [15, 23, 42], fontStyle: "bold" },
      showHead: "everyPage",
      rowPageBreak: "avoid",
    };

    let y = 14;
    const heading = (text) => {
      if (y > H - 34) { doc.addPage(); y = 24; }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(15, 23, 42);
      doc.text(pdfText(text).toUpperCase(), L, y);
      y += 1.6;
      doc.setDrawColor(203, 213, 225);
      doc.setLineWidth(0.3);
      doc.line(L, y, R, y);
      y += 4.5;
    };

    /** Draws a table and leaves `y` below it. Sections with no rows say so instead of
        rendering an empty grid, which reads as a bug rather than as "nothing happened". */
    const section = (title, head, body, opts = {}) => {
      heading(title);
      if (!body.length) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.5);
        doc.setTextColor(120, 130, 145);
        doc.text(pdfText(opts.empty || "None in this report."), L, y);
        y += 7;
        return;
      }
      autoTable(doc, { ...tableBase, ...opts.table, head: [head], body, startY: y });
      y = doc.lastAutoTable.finalY + 7;
    };

    // ---------- 1. header ----------
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.setTextColor(15, 23, 42);
    doc.text(pdfText(PRACTICE_INFO.name), L, y + 3);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(pdfText(PRACTICE_INFO.address), L, y + 8);
    doc.text(pdfText(`Tax ID ${PRACTICE_INFO.taxId}`), L, y + 12);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(15, 23, 42);
    doc.text("DAILY TRANSACTION REPORT", R, y + 3, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text(pdfText("Daily Financial & Reconciliation Report"), R, y + 8, { align: "right" });
    doc.setFontSize(8);
    doc.text(pdfText(`Generated ${fmtDateTime(nowIso())}`), R, y + 12, { align: "right" });

    y += 16;
    doc.setDrawColor(15, 23, 42);
    doc.setLineWidth(0.6);
    doc.line(L, y, R, y);
    y += 7;

    // ---------- 2. criteria ----------
    heading("Report criteria");
    doc.setFontSize(8);
    const entries = (criteria || []).filter(([, v]) => v !== "" && v != null);
    const per = Math.ceil(entries.length / 3) || 1;
    const colW = (R - L) / 3;
    let maxRow = 0;
    entries.forEach(([label, value], i) => {
      const col = Math.floor(i / per);
      const row = i % per;
      maxRow = Math.max(maxRow, row);
      const yy = y + row * 4.4;
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100, 116, 139);
      doc.text(pdfText(`${label}:`), L + col * colW, yy);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(30, 41, 59);
      doc.text(pdfText(String(value)).slice(0, 44), L + col * colW + 34, yy);
    });
    y += (maxRow + 1) * 4.4 + 6;

    // ---------- 3. summary cards ----------
    heading("Daily financial summary");
    const cards = [
      ["Total charges", money(t.charges)], ["Total payments", money(t.payments)],
      ["Net collection", money(t.netCollection)], ["Write-offs", money(t.writeOffs)],
      ["Credits", money(t.credits)], ["Credit transfers", money(t.creditTransfers)],
      ["Refunds", `(${money(t.refunds)})`], ["Transactions", String(result.rows.length)],
    ];
    const cardW = (R - L - 7 * 2) / 8;
    cards.forEach(([label, value], i) => {
      const x = L + i * (cardW + 2);
      doc.setDrawColor(203, 213, 225);
      doc.setLineWidth(0.3);
      doc.roundedRect(x, y, cardW, 13, 1.2, 1.2);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(5.8);
      doc.setTextColor(100, 116, 139);
      doc.text(pdfText(label.toUpperCase()), x + 2, y + 4.5);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(label === "Refunds" ? 190 : 15, label === "Refunds" ? 40 : 23, label === "Refunds" ? 60 : 42);
      doc.text(pdfText(value), x + 2, y + 10);
    });
    y += 17;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text(pdfText("Net collection = payments - refunds. Write-offs are not cash. Credit transfers move money collected earlier and are excluded."), L, y);
    y += 7;

    const m = (n) => money(Number(n) || 0);

    // ---------- 4-8. rollups ----------
    section("Payment method summary",
      ["Method", "Transactions", "Total"],
      s.byMethod.map(r => [pdfText(r.name), String(r.count), m(r.payments)]),
      { empty: "No payments in this report.", table: { columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } } },
        });

    section("Insurance summary",
      ["Insurance", "Charges", "Paid", "Write-off", "Credit", "Refund", "Balance"],
      s.byInsurance.map(r => [pdfText(r.name), m(r.charges), m(r.payments), m(r.writeOffs), m(r.credits), m(r.refunds), m(r.balance)]),
      { empty: "No insurance activity.", table: { columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" } } } });

    section("Physician summary",
      ["Physician", "Charges", "Payments", "Write-off", "Refund", "Balance"],
      s.byPhysician.map(r => [pdfText(r.name), m(r.charges), m(r.payments), m(r.writeOffs), m(r.refunds), m(r.balance)]),
      { empty: "No physician activity.", table: { columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" } } } });

    section("Posted-by summary",
      ["Posted by", "Charges", "Payments", "Write-off", "Refund", "Transfers"],
      s.byUser.map(r => [pdfText(r.name), m(r.charges), m(r.payments), m(r.writeOffs), m(r.refunds), m(r.creditTransfers)]),
      { empty: "No attributed activity.", table: { columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" } } } });

    section("Procedure (CPT) summary",
      ["CPT", "Services", "Charges", "Payments", "Write-off", "Credits", "Balance"],
      s.byCpt.map(r => [pdfText(r.name), String(r.count), m(r.charges), m(r.payments), m(r.writeOffs), m(r.credits), m(r.balance)]),
      { empty: "No procedure-coded activity.", table: { columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" } } } });

    // ---------- 9-11. movement out, and money that is not a collection ----------
    section("Credit transfer summary",
      ["Date", "Patient", "DOS", "CPT", "Detail", "Posted by", "Amount"],
      s.transfers.map(r => [fmtDate(r.receiptDate || r.transactionDate), pdfText(r.patientName), fmtDate(r.serviceDate), pdfText(r.cpt), pdfText(r.notes || r.reason).slice(0, 70), pdfText(r.user), m(r.creditTransfer)]),
      { empty: "No credit transfers in this report.", table: { columnStyles: { 6: { halign: "right" } } } });

    section("Refund summary",
      ["Date", "Patient", "Type", "Reason", "Posted by", "Amount"],
      s.refunds.map(r => [fmtDate(r.receiptDate || r.transactionDate), pdfText(r.patientName), pdfText(r.paymentType), pdfText(r.reason || r.notes).slice(0, 60), pdfText(r.user), m(r.refund)]),
      { empty: "No refunds in this report.", table: { columnStyles: { 5: { halign: "right" } } } });

    section("Write-off summary",
      ["Patient", "DOS", "CPT", "Insurance", "Physician", "Posted by", "Amount"],
      s.writeOffs.map(r => [pdfText(r.patientName), fmtDate(r.serviceDate), pdfText(r.cpt), pdfText(r.insurance), pdfText(r.doctor), pdfText(r.user), m(r.writeOff)]),
      { empty: "No write-offs in this report.", table: { columnStyles: { 6: { halign: "right" } } } });

    section("Check payments",
      ["Check #", "Deposit date", "Payer", "Patient", "Posted by", "Amount"],
      s.checks.map(r => [pdfText(r.checkNumber || r.receiptNumber), fmtDate(r.depositDate), pdfText(r.insurance), pdfText(r.patientName), pdfText(r.user), m(r.payment)]),
      { empty: "No check payments in this report.", table: { columnStyles: { 5: { halign: "right" } } } });

    // ---------- 12. detail ----------
    doc.addPage();
    y = 24;
    section("Detailed transactions",
      ["Date", "Patient", "DOS", "CPT", "Insurance", "Physician", "Type", "Method", "Charge", "Payment", "Write-off", "Refund", "Transfer", "Balance", "Posted by"],
      result.rows.map(r => [
        fmtDate(r.transactionDate || r.receiptDate), pdfText(r.patientName), fmtDate(r.serviceDate),
        pdfText(r.cpt), pdfText(r.insurance), pdfText(r.doctor), pdfText(r.txnType), pdfText(r.method),
        r.charge ? m(r.charge) : "", r.payment ? m(r.payment) : "", r.writeOff ? m(r.writeOff) : "",
        r.refund ? m(r.refund) : "", r.creditTransfer ? m(r.creditTransfer) : "",
        r.balance ? m(r.balance) : "", pdfText(r.user),
      ]),
      {
        table: {
          styles: { ...tableBase.styles, fontSize: 6.4, cellPadding: 1.2 },
          columnStyles: Object.fromEntries([8, 9, 10, 11, 12, 13].map(i => [i, { halign: "right" }])),
          foot: [[
            "TOTAL", "", "", "", "", "", "", "",
            m(t.charges), m(t.payments), m(t.writeOffs), m(t.refunds), m(t.creditTransfers), m(t.balance), "",
          ]],
        },
      });

    // ---------- 13. final totals ----------
    if (y > H - 30) { doc.addPage(); y = 24; }
    doc.setDrawColor(15, 23, 42);
    doc.setLineWidth(0.5);
    doc.line(R - 90, y - 2, R, y - 2);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(15, 23, 42);
    doc.text("NET COLLECTION", R - 90, y + 4);
    doc.text(money(t.netCollection), R, y + 4, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(pdfText(`${result.rows.length} transactions - payments ${money(t.payments)} less refunds ${money(t.refunds)}`), L, y + 4);

    // ---------- 14. running header and footer on every page ----------
    const pages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      if (i > 1) {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8.5);
        doc.setTextColor(15, 23, 42);
        doc.text(pdfText(PRACTICE_INFO.name), L, 12);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.5);
        doc.setTextColor(100, 116, 139);
        doc.text("Daily Transaction Report", L, 16);
        doc.text(pdfText(`Generated ${fmtDateTime(nowIso())}`), R, 12, { align: "right" });
        doc.setDrawColor(203, 213, 225);
        doc.setLineWidth(0.3);
        doc.line(L, 18, R, 18);
      }
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7);
      doc.setTextColor(120, 130, 145);
      doc.text(pdfText(`Daily Transaction Report - ${generatedBy || ""} - generated ${fmtDateTime(nowIso())}`), L, H - 7);
      doc.text(`Page ${i} of ${pages}`, R, H - 7, { align: "right" });
    }

    const blob = doc.output("blob");
    const url = URL.createObjectURL(blob);
    if (tab) { tab.location = url; return { ok: true }; }
    downloadBlob(filename, blob);
    return { ok: true, popupBlocked: true };
  } catch (err) {
    if (tab) tab.close();
    return { ok: false, error: `The PDF could not be generated: ${err?.message || err}` };
  }
}

// ---------- Daily Transaction: summary sections ----------
//
// Rendered from result.summary, which was computed once from the filtered rows. The same object
// feeds the on-screen report, the print layout and the PDF, so the three cannot disagree.

/** A labelled money figure. `tone` marks money going out. */
function DailyTxnStat({ label, value, tone, sub }) {
  const colour = tone === "out" ? "text-rose-600" : tone === "net" ? "text-emerald-700" : "text-slate-800";
  return (
    <div className="border border-slate-200 rounded-lg px-3 py-2.5 bg-white">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`text-lg font-semibold ${colour}`}>{tone === "out" && value > 0 ? `(${money(value)})` : money(value)}</div>
      {sub && <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

/** A breakdown table. `cols` is [label, accessor, isMoney]. */
function DailyTxnBreakdown({ title, rows, cols, empty, note }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="mb-5">
        <SectionTitle>{title}</SectionTitle>
        <p className="text-xs text-slate-400">{empty}</p>
      </div>
    );
  }
  const totals = cols.map(([, get, isMoney]) => (isMoney ? rows.reduce((s, r) => s + (Number(get(r)) || 0), 0) : null));
  return (
    <div className="mb-5">
      <SectionTitle>{title}</SectionTitle>
      {note && <p className="text-[11px] text-slate-400 mb-1.5">{note}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-200">
              {cols.map(([label, , isMoney]) => (
                <th key={label} className={`py-1.5 pr-3 font-medium ${isMoney ? "text-right" : ""}`}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.name || r.key || i} className="border-b border-slate-100 last:border-0">
                {cols.map(([label, get, isMoney]) => (
                  <td key={label} className={`py-1.5 pr-3 ${isMoney ? "text-right font-medium text-slate-700" : "text-slate-600"}`}>
                    {isMoney ? money(Number(get(r)) || 0) : (get(r) || UNATTRIBUTED)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 font-semibold text-slate-800">
              {cols.map(([label, , isMoney], i) => (
                <td key={label} className={`py-1.5 pr-3 ${isMoney ? "text-right" : ""}`}>
                  {i === 0 ? "TOTAL" : isMoney ? money(totals[i]) : ""}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function DailyTxnSummarySections({ summary }) {
  if (!summary) return null;
  const t = summary.totals;
  const c = summary.counts;

  return (
    <div>
      <SectionTitle>Daily financial summary</SectionTitle>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
        <DailyTxnStat label="Total charges" value={t.charges} sub={`${c.charges} charge${c.charges === 1 ? "" : "s"}`} />
        <DailyTxnStat label="Total payments" value={t.payments} sub={`${c.payments} payment${c.payments === 1 ? "" : "s"}`} />
        <DailyTxnStat label="Write-offs" value={t.writeOffs} />
        <DailyTxnStat label="Credits" value={t.credits} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
        <DailyTxnStat label="Credit transfers" value={t.creditTransfers} sub={`${c.creditTransfers} transfer${c.creditTransfers === 1 ? "" : "s"} — not new money`} />
        <DailyTxnStat label="Refunds" value={t.refunds} tone="out" sub={`${c.refunds} refund${c.refunds === 1 ? "" : "s"}`} />
        <DailyTxnStat label="Net collection" value={t.netCollection} tone="net" sub="payments − refunds" />
        <DailyTxnStat label="Transactions" value={0} sub={`${c.charges + c.payments + c.refunds + c.creditTransfers} in total`} />
      </div>
      {/* Stated rather than assumed: a manager reconciling the day should not have to work out
          which figures were netted off. */}
      <p className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-5">
        <strong>Net collection = payments − refunds.</strong> Write-offs are not cash and are excluded.
        Credit transfers move money collected on an earlier day and are excluded too, so they are never
        counted as a new collection.
      </p>

      <DailyTxnBreakdown
        title="Payment method summary"
        rows={summary.byMethod}
        empty="No payments in this report."
        cols={[["Method", r => r.name], ["Transactions", r => r.count], ["Total", r => r.payments, true]]}
      />

      <DailyTxnBreakdown
        title="Insurance summary"
        rows={summary.byInsurance}
        empty="No activity to break down by insurance."
        cols={[
          ["Insurance", r => r.name], ["Charges", r => r.charges, true], ["Paid", r => r.payments, true],
          ["Write-off", r => r.writeOffs, true], ["Credit", r => r.credits, true],
          ["Refund", r => r.refunds, true], ["Balance", r => r.balance, true],
        ]}
      />

      <DailyTxnBreakdown
        title="Physician summary"
        rows={summary.byPhysician}
        empty="No activity to break down by physician."
        cols={[
          ["Physician", r => r.name], ["Charges", r => r.charges, true], ["Payments", r => r.payments, true],
          ["Write-off", r => r.writeOffs, true], ["Refund", r => r.refunds, true], ["Balance", r => r.balance, true],
        ]}
      />

      <DailyTxnBreakdown
        title="Posted-by summary"
        rows={summary.byUser}
        empty="No attributed activity."
        note="For reconciliation: who keyed each transaction."
        cols={[
          ["Posted by", r => r.name], ["Charges", r => r.charges, true], ["Payments", r => r.payments, true],
          ["Write-off", r => r.writeOffs, true], ["Refund", r => r.refunds, true], ["Transfers", r => r.creditTransfers, true],
        ]}
      />

      <DailyTxnBreakdown
        title="Procedure (CPT) summary"
        rows={summary.byCpt}
        empty="No procedure-coded activity."
        cols={[
          ["CPT", r => r.name], ["Services", r => r.count], ["Charges", r => r.charges, true],
          ["Payments", r => r.payments, true], ["Write-off", r => r.writeOffs, true],
          ["Credits", r => r.credits, true], ["Balance", r => r.balance, true],
        ]}
      />

      <DailyTxnBreakdown
        title={`Check payments — ${c.checks} check${c.checks === 1 ? "" : "s"}`}
        rows={summary.checks}
        empty="No check payments in this report."
        cols={[
          ["Check #", r => r.checkNumber || r.receiptNumber], ["Deposit date", r => fmtDate(r.depositDate)],
          ["Payer", r => r.insurance], ["Patient", r => r.patientName],
          ["Posted by", r => r.user], ["Amount", r => r.payment, true],
        ]}
      />

      <DailyTxnBreakdown
        title={`Credit card payments — ${c.creditCards} transaction${c.creditCards === 1 ? "" : "s"}`}
        rows={summary.cards}
        empty="No credit card payments in this report."
        // Only the reference the application already stores is shown. No card number is held
        // anywhere in this system, so none can be displayed.
        note="Reference only — no card numbers are stored by this application."
        cols={[
          ["Patient", r => r.patientName], ["Date", r => fmtDate(r.receiptDate || r.transactionDate)],
          ["Reference", r => r.reference || r.receiptNumber], ["Posted by", r => r.user],
          ["Amount", r => r.payment, true],
        ]}
      />

      <DailyTxnBreakdown
        title={`Patient / self payments — ${c.selfPayments} transaction${c.selfPayments === 1 ? "" : "s"}`}
        rows={summary.selfPayments}
        empty="No patient-paid transactions in this report."
        cols={[
          ["Patient", r => r.patientName], ["Date", r => fmtDate(r.receiptDate || r.transactionDate)],
          ["Method", r => r.paymentType], ["Posted by", r => r.user], ["Amount", r => r.payment, true],
        ]}
      />

      <DailyTxnBreakdown
        title={`Credit transfers — ${c.creditTransfers}`}
        rows={summary.transfers}
        empty="No credit transfers in this report."
        note="Movement of a credit already collected. Not included in payments or net collection."
        cols={[
          ["Date", r => fmtDate(r.receiptDate || r.transactionDate)], ["Patient", r => r.patientName],
          ["DOS", r => fmtDate(r.serviceDate)], ["CPT", r => r.cpt],
          ["Detail", r => r.notes || r.reason], ["Posted by", r => r.user], ["Amount", r => r.creditTransfer, true],
        ]}
      />

      <DailyTxnBreakdown
        title={`Refunds — ${c.refunds}`}
        rows={summary.refunds}
        empty="No refunds in this report."
        note="Money returned. Deducted from net collection, never shown as a payment."
        cols={[
          ["Date", r => fmtDate(r.receiptDate || r.transactionDate)], ["Patient", r => r.patientName],
          ["Type", r => r.paymentType], ["Reason", r => r.reason || r.notes],
          ["Posted by", r => r.user], ["Amount", r => r.refund, true],
        ]}
      />

      <DailyTxnBreakdown
        title="Write-offs"
        rows={summary.writeOffs}
        empty="No write-offs in this report."
        cols={[
          ["Patient", r => r.patientName], ["DOS", r => fmtDate(r.serviceDate)], ["CPT", r => r.cpt],
          ["Insurance", r => r.insurance], ["Physician", r => r.doctor],
          ["Posted by", r => r.user], ["Amount", r => r.writeOff, true],
        ]}
      />

      <SectionTitle>Transaction counts</SectionTitle>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1 text-xs text-slate-600 mb-2">
        {[
          ["Charges", c.charges], ["Payments", c.payments], ["Checks", c.checks],
          ["Credit cards", c.creditCards], ["Self payments", c.selfPayments],
          ["Insurance payments", c.insurancePayments], ["Credit transfers", c.creditTransfers],
          ["Refunds", c.refunds], ["Write-offs", c.writeOffs],
        ].map(([label, n]) => (
          <div key={label} className="flex justify-between border-b border-slate-100 py-0.5">
            <span className="text-slate-500">{label}</span><span className="font-medium">{n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// The print view. Rendered outside the modal (the modal panel is fixed + scroll-clipped, which
// would truncate the printout) and always over the complete filtered dataset rather than the
// currently visible preview page.
function DailyTransactionPrintable({ result, columns, batchLabelById, generatedBy }) {
  const f = result.filters;
  return (
    <div id="daily-txn-printable" className="hidden print:block">
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #daily-txn-printable, #daily-txn-printable * { visibility: visible !important; }
          #daily-txn-printable { position: absolute; top: 0; left: 0; width: 100%; padding: 24px; }
        }
      `}</style>

      <div className="text-center border-b-2 border-slate-800 pb-2 mb-3">
        <h1 className="text-base font-bold tracking-wide">{PRACTICE_INFO.name.toUpperCase()} — MEDICAL BILLING SYSTEM</h1>
        <h2 className="text-sm font-semibold">DAILY TRANSACTION REPORT</h2>
      </div>

      <table className="text-[11px] mb-3">
        <tbody>
          {dailyTxnFilterSummary(f, batchLabelById).map(([k, v]) => (
            <tr key={k}><td className="pr-3 font-semibold align-top">{k}:</td><td>{v}</td></tr>
          ))}
          <tr><td className="pr-3 font-semibold">Generated By:</td><td>{generatedBy}</td></tr>
          <tr><td className="pr-3 font-semibold">Generated Date:</td><td>{TODAY}</td></tr>
        </tbody>
      </table>

      {result.rows.length === 0 ? (
        <p className="text-xs">No transactions match the selected report filters and date range.</p>
      ) : (
        <>
          {/* The print layout carries the same summary sections as the screen, so a printed copy
              is a complete report rather than a bare table. */}
          <DailyTxnSummarySections summary={result.summary} />
          <h3 className="text-xs font-bold mb-1 mt-3">PATIENT TRANSACTION DETAIL</h3>
          <DailyTxnTable rows={result.rows} columns={columns} />
        </>
      )}

      <div className="mt-4 border-t-2 border-slate-800 pt-2">
        <h3 className="text-xs font-bold mb-1">REPORT SUMMARY</h3>
        <table className="text-[11px]">
          <tbody>
            <tr><td className="pr-4">Total Patients:</td><td className="font-semibold">{result.totals.totalPatients}</td></tr>
            <tr><td className="pr-4">Total Transactions:</td><td className="font-semibold">{result.totals.totalTransactions}</td></tr>
            <tr><td className="pr-4">Total Charges:</td><td className="font-semibold">{money(result.totals.totalCharges)}</td></tr>
            <tr><td className="pr-4">Total Adjustments:</td><td className="font-semibold">{money(result.totals.totalAdjustments)}</td></tr>
            <tr><td className="pr-4">Total Receipts:</td><td className="font-semibold">{money(result.totals.totalReceipts)}</td></tr>
            <tr><td className="pr-4">Remaining Balance:</td><td className="font-semibold">{money(result.totals.remainingBalance)}</td></tr>
          </tbody>
        </table>
        <p className="text-[10px] text-slate-500 mt-2">
          Adjustment and remaining balance are lifetime figures for each charge, not amounts limited to the reporting period.
        </p>
      </div>
    </div>
  );
}

function DailyTransactionModal({ charges, patientById, transactions, policies, batches, userAccounts, session, isOversight, onClose, onResult }) {
  const providerOptions = useProviderOptions();
  const cptOptions = useCptOptions();
  const [f, setF] = useState(DAILY_TXN_DEFAULTS);
  const [result, setResult] = useState(null);
  const [page, setPage] = useState(1);
  const [generating, setGenerating] = useState(false);
  const [touched, setTouched] = useState(false);
  const [toast, setToast] = useState("");

  // Non-oversight users only ever see their own batches, mirroring BatchManagement.
  const visibleBatches = useMemo(
    () => (isOversight ? batches : batches.filter(b => b.userId === session.uid)),
    [batches, isOversight, session.uid]
  );
  const batchLabelById = useMemo(
    () => Object.fromEntries(visibleBatches.map(b => [b.id, b.batchNumber || b.id])),
    [visibleBatches]
  );

  // Flattening every charge + posting is the expensive step, so it is memoised on the raw data
  // and re-run only when Firestore pushes new documents — never when a filter changes.
  const allRows = useMemo(
    () => buildDailyTransactionRows({ charges, patientById, transactions, policies }),
    [charges, patientById, transactions, policies]
  );

  // Insurance options come from the data actually present, not a hard-coded payer list, so a
  // payer added in Insurance Management appears here without a code change.
  const insuranceOptions = useMemo(
    () => [...new Set(allRows.map(r => r.insurance).filter(Boolean))].sort(),
    [allRows]
  );

  const closedBatches = useMemo(
    () => visibleBatches.filter(b => b.status === "CLOSED").sort((a, b) => (b.batchDate || "").localeCompare(a.batchDate || "")),
    [visibleBatches]
  );
  // Per-batch receipt total, shown in the Closing picker so staff can recognise a batch by amount.
  const closingTotals = useMemo(() => {
    const totals = {};
    allRows.forEach(r => { if (r.batchId) totals[r.batchId] = (totals[r.batchId] || 0) + r.receipt; });
    return totals;
  }, [allRows]);

  const errors = validateDailyTxnFilters(f);
  const hasErrors = Object.keys(errors).length > 0;
  const show = (key) => (touched ? errors[key] : undefined);

  // Any filter change invalidates a generated report, so the preview, CSV and print can never
  // reflect options the user has since changed.
  function set(key, value) {
    setF(prev => ({ ...prev, [key]: value }));
    setResult(null);
    setPage(1);
  }

  const columns = useMemo(() => dailyTxnColumns(result ? result.filters : f), [result, f]);

  function runReport() {
    setTouched(true);
    if (hasErrors) return null;
    setGenerating(true);
    const r = generateDailyTransactionReport(f, allRows);
    setResult(r);
    setPage(1);
    setGenerating(false);
    return r;
  }

  // CSV and print reuse whatever Generate already produced, and only generate themselves if the
  // user pressed them first — so all three always describe the same dataset.
  function ensureResult() {
    if (result) return result;
    return runReport();
  }

  function handleExport() {
    const r = ensureResult();
    if (!r) return;
    if (!r.rows.length) { setToast("Nothing to export no transactions match these filters."); return; }
    const cols = dailyTxnColumns(r.filters);
    exportCSV(dailyTxnFilename(r.filters, batchLabelById), dailyTxnCsvRows(r.rows, cols));
    setToast(`Exported ${r.rows.length} transaction${r.rows.length === 1 ? "" : "s"} to CSV.`);
  }

  // A real PDF document opened in the browser's own viewer. Deliberately NOT printReport(): the
  // Print button below is the one that opens a print dialog, and it does so against the dedicated
  // print layout rather than this modal.
  function handlePDF() {
    const r = ensureResult();
    if (!r) return;
    const result = openDailyTxnPDF({
      result: r,
      criteria: dailyTxnFilterSummary(r.filters, batchLabelById),
      generatedBy: session?.name || "",
      filename: dailyTxnPdfFilename(r.filters, batchLabelById),
    });
    if (!result.ok) setToast(result.error);
    else if (result.popupBlocked) setToast("Your browser blocked the new tab, so the PDF was downloaded instead.");
    else setToast(`PDF opened with ${r.rows.length} transaction${r.rows.length === 1 ? "" : "s"}.`);
  }

  function handlePrint() {
    const r = ensureResult();
    if (!r) return;
    onResult(r);
    // Let React paint the printable block before opening the print dialog.
    setTimeout(printReport, 50);
  }

  useEffect(() => { onResult(result); }, [result, onResult]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const pageCount = result ? Math.max(1, Math.ceil(result.rows.length / DAILY_TXN_PAGE_SIZE)) : 1;
  const pageRows = result ? result.rows.slice((page - 1) * DAILY_TXN_PAGE_SIZE, page * DAILY_TXN_PAGE_SIZE) : [];

  const procedureOptions = useMemo(
    () => cptOptions.map(c => ({ value: c.code, label: `${c.code} — ${c.desc}` })),
    [cptOptions]
  );
  const userOptions = useMemo(
    () => userAccounts.filter(u => u.name).map(u => ({ value: u.name, label: `${u.name} (${ROLE_LABELS[u.role] || u.role})` })),
    [userAccounts]
  );
  const batchOptions = useMemo(
    () => visibleBatches.map(b => ({ value: b.id, label: `${b.batchNumber} — ${fmtDate(b.batchDate)} (${b.userName})` })),
    [visibleBatches]
  );

  return (
    <Modal title="Daily Transaction Report" onClose={onClose} size="max-w-5xl">
      <div className="space-y-5">
        <div className="grid md:grid-cols-2 gap-x-6">
          <div>
            <SectionTitle>Patient Information</SectionTitle>
            <RadioRow
              name="dt-patient" value={f.patientDisplay} onChange={(v) => set("patientDisplay", v)}
              options={[{ value: "total", label: "Show Total Patient Names" }, { value: "name", label: "Show Patient Name" }]}
            />

            {/* Only meaningful once names are shown — it scopes what prints next to each name. */}
            {f.patientDisplay === "name" && (
              <>
                <SectionTitle>Print With Name</SectionTitle>
                <RadioRow
                  name="dt-print" value={f.printWithName} onChange={(v) => set("printWithName", v)}
                  options={[
                    { value: "both", label: "Charges and Receipt" },
                    { value: "charge", label: "Charge Only" },
                    { value: "receipt", label: "Receipt Only" },
                  ]}
                />
              </>
            )}

            <SectionTitle>Report From</SectionTitle>
            <RadioRow
              name="dt-from" value={f.reportFrom} onChange={(v) => set("reportFrom", v)}
              options={[{ value: "dateSpan", label: "Date Span" }, { value: "closing", label: "Closing" }]}
            />

            {f.reportFrom === "dateSpan" ? (
              <>
                <SectionTitle>Report Based On</SectionTitle>
                <RadioRow
                  name="dt-based" value={f.basedOn} onChange={(v) => set("basedOn", v)}
                  options={[
                    { value: "service", label: "Service Date" },
                    { value: "deposit", label: "Deposit Date" },
                    { value: "transaction", label: "Transaction Date" },
                  ]}
                />
                {f.basedOn === "deposit" && (
                  <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mt-2">
                    Only payments carry a deposit date, so this report covers receipts only charge rows are excluded.
                  </p>
                )}
                {show("basedOn") && <p className="text-xs text-rose-600 mt-1">{errors.basedOn}</p>}

                <SectionTitle>Select Date Span</SectionTitle>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Start Date">
                    <input type="date" className={inputCls} value={f.startDate} onChange={(e) => set("startDate", e.target.value)} />
                    {show("startDate") && <span className="block text-xs text-rose-600 mt-1">{errors.startDate}</span>}
                  </Field>
                  <Field label="End Date">
                    <input type="date" className={inputCls} value={f.endDate} onChange={(e) => set("endDate", e.target.value)} />
                    {show("endDate") && <span className="block text-xs text-rose-600 mt-1">{errors.endDate}</span>}
                  </Field>
                </div>
              </>
            ) : (
              <>
                <SectionTitle>Closed Batches</SectionTitle>
                {closedBatches.length === 0 ? (
                  <p className="text-xs text-slate-400 border border-slate-200 rounded-lg px-3 py-2">No closed batches available.</p>
                ) : (
                  <div className="max-h-44 overflow-y-auto border border-slate-200 rounded-lg">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-slate-500 border-b border-slate-200">
                          <th className="py-1.5 px-2 font-medium"></th>
                          <th className="py-1.5 px-2 font-medium">Batch</th>
                          <th className="py-1.5 px-2 font-medium">Closing Date</th>
                          <th className="py-1.5 px-2 font-medium">User</th>
                          <th className="py-1.5 px-2 font-medium text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {closedBatches.map(b => (
                          <tr key={b.id} className="border-b border-slate-100 last:border-0">
                            <td className="py-1.5 px-2">
                              <input
                                type="checkbox" className="accent-teal-600"
                                checked={f.closingBatchIds.includes(b.id)}
                                onChange={() => set("closingBatchIds", f.closingBatchIds.includes(b.id)
                                  ? f.closingBatchIds.filter(x => x !== b.id)
                                  : [...f.closingBatchIds, b.id])}
                              />
                            </td>
                            <td className="py-1.5 px-2 text-slate-700">{b.batchNumber}</td>
                            <td className="py-1.5 px-2 text-slate-600">{fmtDate(b.closedAt || b.batchDate)}</td>
                            <td className="py-1.5 px-2 text-slate-600">{b.userName}</td>
                            <td className="py-1.5 px-2 text-right font-medium">{money(closingTotals[b.id] || 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {show("closingBatchIds") && <p className="text-xs text-rose-600 mt-1">{errors.closingBatchIds}</p>}
              </>
            )}
          </div>

          <div>
            <SectionTitle>Procedure Code</SectionTitle>
            <RadioRow
              name="dt-proc" value={f.procedureMode} onChange={(v) => set("procedureMode", v)}
              options={[{ value: "all", label: "All Procedure Codes" }, { value: "specific", label: "Specific Procedure Code(s)" }]}
            />
            {f.procedureMode === "specific" && (
              <div className="mt-2">
                <MultiSelectSearch
                  options={procedureOptions} selected={f.procedureCodes} placeholder="Search CPT codes…"
                  onChange={(v) => set("procedureCodes", v)} error={show("procedureCodes")}
                />
              </div>
            )}

            {/* Added filters. Each follows the same all/specific pattern as the existing ones,
                and each is applied in the same single pipeline. */}
            <SectionTitle>Insurance</SectionTitle>
            <RadioRow
              name="dt-ins" value={f.insuranceMode} onChange={(v) => set("insuranceMode", v)}
              options={[{ value: "all", label: "All Insurance" }, { value: "specific", label: "Specific Insurance" }]}
            />
            {f.insuranceMode === "specific" && (
              <div className="mt-2">
                <MultiSelectSearch
                  options={insuranceOptions.map(i => ({ value: i, label: i }))} selected={f.insurances}
                  placeholder="Search insurance…" onChange={(v) => set("insurances", v)}
                />
              </div>
            )}

            <SectionTitle>Transaction Type</SectionTitle>
            <RadioRow
              name="dt-type" value={f.txnTypeMode} onChange={(v) => set("txnTypeMode", v)}
              options={[{ value: "all", label: "All Types" }, { value: "specific", label: "Specific Type(s)" }]}
            />
            {f.txnTypeMode === "specific" && (
              <div className="mt-2">
                <MultiSelectSearch
                  options={DAILY_TXN_TYPES.map(x => ({ value: x, label: x }))} selected={f.txnTypes}
                  placeholder="Search transaction types…" onChange={(v) => set("txnTypes", v)}
                />
              </div>
            )}

            <SectionTitle>Payment Method</SectionTitle>
            <RadioRow
              name="dt-method" value={f.methodMode} onChange={(v) => set("methodMode", v)}
              options={[{ value: "all", label: "All Methods" }, { value: "specific", label: "Specific Method(s)" }]}
            />
            {f.methodMode === "specific" && (
              <div className="mt-2">
                <MultiSelectSearch
                  options={DAILY_TXN_METHODS.map(x => ({ value: x, label: x }))} selected={f.methods}
                  placeholder="Search payment methods…" onChange={(v) => set("methods", v)}
                />
              </div>
            )}

            <SectionTitle>Patient</SectionTitle>
            <input
              className={inputCls}
              placeholder="Filter by patient name or account number…"
              value={f.patientQuery}
              onChange={(e) => set("patientQuery", e.target.value)}
            />

            <SectionTitle>Doctor</SectionTitle>
            <RadioRow
              name="dt-doc" value={f.doctorMode} onChange={(v) => set("doctorMode", v)}
              options={[{ value: "all", label: "All Doctors" }, { value: "specific", label: "Specific Doctor" }]}
            />
            {f.doctorMode === "specific" && (
              <div className="mt-2">
                <MultiSelectSearch
                  options={providerOptions.map(p => ({ value: p, label: p }))} selected={f.doctors} placeholder="Search doctors…"
                  onChange={(v) => set("doctors", v)} error={show("doctors")}
                />
              </div>
            )}

            <SectionTitle>User</SectionTitle>
            <RadioRow
              name="dt-user" value={f.userMode} onChange={(v) => set("userMode", v)}
              options={[{ value: "all", label: "All Users" }, { value: "specific", label: "Specific User" }]}
            />
            {f.userMode === "specific" && (
              <div className="mt-2">
                <MultiSelectSearch
                  options={userOptions} selected={f.users} placeholder="Search users…"
                  onChange={(v) => set("users", v)} error={show("users")}
                />
              </div>
            )}

            <SectionTitle>Batch</SectionTitle>
            <RadioRow
              name="dt-batch" value={f.batchMode} onChange={(v) => set("batchMode", v)}
              options={[{ value: "all", label: "All Batches" }, { value: "specific", label: "Specific Batch" }]}
            />
            {f.batchMode === "specific" && (
              <div className="mt-2">
                <MultiSelectSearch
                  options={batchOptions} selected={f.batchIds} placeholder="Search batches…"
                  onChange={(v) => set("batchIds", v)} error={show("batchIds")}
                />
              </div>
            )}

            <SectionTitle>Include</SectionTitle>
            <div className="flex gap-5">
              <label className="flex items-center gap-1.5 text-sm text-slate-700 cursor-pointer">
                <input type="checkbox" className="accent-teal-600" checked={f.includeCharges} onChange={(e) => set("includeCharges", e.target.checked)} />
                Charges
              </label>
              <label className="flex items-center gap-1.5 text-sm text-slate-700 cursor-pointer">
                <input type="checkbox" className="accent-teal-600" checked={f.includeReceipts} onChange={(e) => set("includeReceipts", e.target.checked)} />
                Receipts
              </label>
            </div>
            {show("include") && <p className="text-xs text-rose-600 mt-1">{errors.include}</p>}
          </div>
        </div>

        {touched && hasErrors && (
          <div className="flex items-start gap-2 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>Fix the highlighted options before generating the report.</span>
          </div>
        )}
        {toast && (
          <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <CheckCircle2 size={15} /> {toast}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-4">
          <button
            onClick={() => { setF(DAILY_TXN_DEFAULTS); setResult(null); setTouched(false); setToast(""); setPage(1); }}
            className="text-sm text-slate-600 border border-slate-200 rounded-lg px-4 py-2 hover:bg-slate-50"
          >
            Reset
          </button>
          <div className="flex flex-wrap gap-2">
            <button onClick={runReport} className="flex items-center gap-1.5 text-sm bg-teal-600 text-white rounded-lg px-4 py-2 hover:bg-teal-700">
              <BarChart3 size={14} /> Generate Report
            </button>
            <button onClick={handleExport} className="flex items-center gap-1.5 text-sm text-slate-600 border border-slate-200 rounded-lg px-4 py-2 hover:bg-slate-50">
              <Download size={14} /> Export CSV
            </button>
            <button onClick={handlePDF} className="flex items-center gap-1.5 text-sm text-slate-600 border border-slate-200 rounded-lg px-4 py-2 hover:bg-slate-50">
              <FileText size={14} /> PDF
            </button>
            <button onClick={handlePrint} className="flex items-center gap-1.5 text-sm text-slate-600 border border-slate-200 rounded-lg px-4 py-2 hover:bg-slate-50">
              <Printer size={14} /> Print Report
            </button>
          </div>
        </div>

        {generating && <p className="text-sm text-slate-500">Generating report…</p>}

        {result && (
          <div className="border-t border-slate-200 pt-4">
            <h4 className="font-semibold text-slate-800 mb-1">Report preview</h4>
            <p className="text-xs text-slate-500 mb-3">
              {result.rows.length} record{result.rows.length === 1 ? "" : "s"} · {result.totals.totalPatients} patient{result.totals.totalPatients === 1 ? "" : "s"}
            </p>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500 mb-3">
              {dailyTxnFilterSummary(result.filters, batchLabelById).map(([k, v]) => (
                <span key={k}><span className="text-slate-400">{k}:</span> {v}</span>
              ))}
            </div>

            {result.rows.length === 0 ? (
              <div className="text-center py-8 border border-dashed border-slate-200 rounded-lg">
                <p className="font-medium text-slate-600">No transactions found</p>
                <p className="text-xs text-slate-400 mt-1">No transactions match the selected report filters and date range.</p>
              </div>
            ) : (
              <>
                {/* Every summary section, from result.summary - the same object the CSV totals and
                    the PDF are built from. */}
                <DailyTxnSummarySections summary={result.summary} />

                <SectionTitle>Patient transaction detail</SectionTitle>
                {/* Only the visible page is rendered; CSV, PDF and print always use result.rows in full. */}
                <DailyTxnTable rows={pageRows} columns={columns} />
                {pageCount > 1 && (
                  <div className="flex items-center justify-between mt-3">
                    <span className="text-xs text-slate-500">Page {page} of {pageCount}</span>
                    <div className="flex gap-1">
                      <button disabled={page === 1} onClick={() => setPage(p => p - 1)} className="flex items-center gap-1 text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                        <ChevronLeft size={13} /> Prev
                      </button>
                      <button disabled={page === pageCount} onClick={() => setPage(p => p + 1)} className="flex items-center gap-1 text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                        Next <ChevronRight size={13} />
                      </button>
                    </div>
                  </div>
                )}

                <h4 className="font-semibold text-slate-800 mt-5 mb-2">Report summary</h4>
                <DailyTxnSummary totals={result.totals} />
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------- Clinical: patient search ----------

function ClinicalSearch({ patients, allergiesByPatient, onSelect }) {
  const [search, setSearch] = useState("");
  const filtered = patients.filter(p => p.name.toLowerCase().includes(search.toLowerCase()) || p.id.toLowerCase().includes(search.toLowerCase()));
  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-800 mb-1">Clinical</h1>
      <p className="text-slate-500 text-sm mb-4">Select a patient to open their clinical chart.</p>
      <div className="relative mb-4 max-w-sm">
        <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or ID" className={`${inputCls} pl-9`} />
      </div>
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5 font-medium">Patient</th>
              <th className="px-4 py-2.5 font-medium">DOB</th>
              <th className="px-4 py-2.5 font-medium">Allergies</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(p => {
              const allergyList = allergiesByPatient[p.id] || [];
              return (
                <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 cursor-pointer" onClick={() => onSelect(p.id)}>
                  <td className="px-4 py-2.5"><div className="font-medium text-slate-800">{p.name}</div><div className="text-xs text-slate-400">{p.id}</div></td>
                  <td className="px-4 py-2.5 text-slate-600">{fmtDate(p.dob)}</td>
                  <td className="px-4 py-2.5">
                    {allergyList.length > 0 ? (
                      <span className="flex items-center gap-1 text-xs text-rose-600"><AlertTriangle size={12} /> {allergyList.map(a => a.substance).join(", ")}</span>
                    ) : <span className="text-xs text-slate-400">NKDA</span>}
                  </td>
                  <td className="px-4 py-2.5 text-slate-300"><ChevronRight size={16} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ---------- Clinical: patient chart ----------

function ClinicalChart({ patient, vitals, allergies, medications, problems, notes, onBack, onAddVital, onAddAllergy, onUpdateAllergyStatus, onAddMedication, onUpdateMedicationStatus, onAddProblem, onUpdateProblemStatus, onAddNote, onSignNote, onAmendNote }) {
  const [tab, setTab] = useState("vitals");
  const activeAllergies = allergies.filter(a => a.status === "Active");

  const tabs = [
    { id: "vitals", label: "Vitals", icon: Activity },
    { id: "allergies", label: "Allergies", icon: AlertTriangle },
    { id: "medications", label: "Medications", icon: Pill },
    { id: "problems", label: "Problems", icon: ClipboardList },
    { id: "notes", label: "Notes", icon: FileSignature },
  ];

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4">
        <ChevronLeft size={15} /> Back to clinical search
      </button>

      <Card className="p-4 mb-4">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-lg font-semibold text-slate-800">{patient.name}</h1>
            <p className="text-xs text-slate-500">DOB {fmtDate(patient.dob)} · {patient.id} · {patient.phone}</p>
          </div>
          {activeAllergies.length > 0 ? (
            <div className="flex items-center gap-1.5 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-1.5">
              <AlertTriangle size={14} /> Allergies: {activeAllergies.map(a => a.substance).join(", ")}
            </div>
          ) : (
            <div className="text-sm text-slate-400">No known drug allergies</div>
          )}
        </div>
      </Card>

      <div className="flex items-center gap-1 mb-5 border border-slate-200 bg-white rounded-lg p-1 w-fit">
        {tabs.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${tab === t.id ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}>
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === "vitals" && <VitalsTab vitals={vitals} onAdd={onAddVital} />}
      {tab === "allergies" && <AllergiesTab allergies={allergies} onAdd={onAddAllergy} onUpdateStatus={onUpdateAllergyStatus} />}
      {tab === "medications" && <MedicationsTab medications={medications} onAdd={onAddMedication} onUpdateStatus={onUpdateMedicationStatus} />}
      {tab === "problems" && <ProblemsTab problems={problems} onAdd={onAddProblem} onUpdateStatus={onUpdateProblemStatus} />}
      {tab === "notes" && <NotesTab notes={notes} onAdd={onAddNote} onSign={onSignNote} onAmend={onAmendNote} />}
    </div>
  );
}

function VitalsTab({ vitals, onAdd }) {
  const [showAdd, setShowAdd] = useState(false);
  const sorted = [...vitals].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-slate-700">Vital signs</h3>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 bg-teal-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-teal-700"><Plus size={13} /> Record vitals</button>
      </div>
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5 font-medium">Date</th>
              <th className="px-4 py-2.5 font-medium">Ht / Wt / BMI</th>
              <th className="px-4 py-2.5 font-medium">BP</th>
              <th className="px-4 py-2.5 font-medium">Pulse</th>
              <th className="px-4 py-2.5 font-medium">Resp</th>
              <th className="px-4 py-2.5 font-medium">Temp</th>
              <th className="px-4 py-2.5 font-medium">SpO2</th>
              <th className="px-4 py-2.5 font-medium">Pain</th>
              <th className="px-4 py-2.5 font-medium">Recorded by</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(v => (
              <tr key={v.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">{fmtDate(v.date)}</td>
                <td className="px-4 py-2.5 text-slate-600">{v.height} / {v.weight} / {v.bmi}</td>
                <td className="px-4 py-2.5 font-medium text-slate-800">{v.bp}</td>
                <td className="px-4 py-2.5 text-slate-600">{v.pulse}</td>
                <td className="px-4 py-2.5 text-slate-600">{v.resp}</td>
                <td className="px-4 py-2.5 text-slate-600">{v.temp}</td>
                <td className="px-4 py-2.5 text-slate-600">{v.spo2}</td>
                <td className="px-4 py-2.5 text-slate-600">{v.pain}/10</td>
                <td className="px-4 py-2.5 text-slate-500 text-xs">{v.recordedBy}</td>
              </tr>
            ))}
            {sorted.length === 0 && <tr><td colSpan={9} className="px-4 py-6 text-center text-slate-400">No vitals recorded yet.</td></tr>}
          </tbody>
        </table>
      </Card>
      {showAdd && (
        <Modal title="Record vitals" onClose={() => setShowAdd(false)}>
          <VitalForm onSubmit={(entry) => { onAdd(entry); setShowAdd(false); }} />
        </Modal>
      )}
    </div>
  );
}

function VitalForm({ onSubmit }) {
  const [form, setForm] = useState({ date: TODAY, height: "", weight: "", bmi: "", bp: "", pulse: "", resp: "", temp: "", spo2: "", pain: "0" });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const [error, setError] = useState("");
  function submit() {
    if (!form.bp || !form.pulse) { setError("Blood pressure and pulse are required."); return; }
    setError(""); onSubmit(form);
  }
  return (
    <div>
      <Field label="Date"><input type="date" className={inputCls} value={form.date} onChange={set("date")} /></Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Height"><input className={inputCls} value={form.height} onChange={set("height")} placeholder="170 cm" /></Field>
        <Field label="Weight"><input className={inputCls} value={form.weight} onChange={set("weight")} placeholder="70 kg" /></Field>
        <Field label="BMI"><input className={inputCls} value={form.bmi} onChange={set("bmi")} placeholder="24.2" /></Field>
        <Field label="Blood pressure"><input className={inputCls} value={form.bp} onChange={set("bp")} placeholder="120/80" /></Field>
        <Field label="Pulse"><input className={inputCls} value={form.pulse} onChange={set("pulse")} placeholder="72" /></Field>
        <Field label="Respiratory rate"><input className={inputCls} value={form.resp} onChange={set("resp")} placeholder="16" /></Field>
        <Field label="Temperature"><input className={inputCls} value={form.temp} onChange={set("temp")} placeholder="98.6°F" /></Field>
        <Field label="Oxygen saturation"><input className={inputCls} value={form.spo2} onChange={set("spo2")} placeholder="99%" /></Field>
        <Field label="Pain score (0-10)"><input className={inputCls} value={form.pain} onChange={set("pain")} /></Field>
      </div>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Save vitals</button>
    </div>
  );
}

function AllergiesTab({ allergies, onAdd, onUpdateStatus }) {
  const [showAdd, setShowAdd] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-slate-700">Allergies</h3>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 bg-teal-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-teal-700"><Plus size={13} /> Add allergy</button>
      </div>
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5 font-medium">Substance</th>
              <th className="px-4 py-2.5 font-medium">Reaction</th>
              <th className="px-4 py-2.5 font-medium">Severity</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Recorded</th>
              <th className="px-4 py-2.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {allergies.map(a => (
              <tr key={a.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2.5 font-medium text-slate-800">{a.substance}</td>
                <td className="px-4 py-2.5 text-slate-600">{a.reaction}</td>
                <td className="px-4 py-2.5"><StatusPill status={a.severity} /></td>
                <td className="px-4 py-2.5"><StatusPill status={a.status} /></td>
                <td className="px-4 py-2.5 text-slate-500 text-xs">{a.recordedDate} · {a.recordedBy}</td>
                <td className="px-4 py-2.5">
                  {a.status === "Active" && (
                    <button onClick={() => onUpdateStatus(a.id, "Resolved")} className="text-xs text-slate-600 border border-slate-200 rounded-lg px-2 py-1 hover:bg-slate-50">Mark resolved</button>
                  )}
                </td>
              </tr>
            ))}
            {allergies.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">No known drug allergies on file.</td></tr>}
          </tbody>
        </table>
      </Card>
      {showAdd && (
        <Modal title="Add allergy" onClose={() => setShowAdd(false)}>
          <AllergyForm onSubmit={(entry) => { onAdd(entry); setShowAdd(false); }} />
        </Modal>
      )}
    </div>
  );
}

function AllergyForm({ onSubmit }) {
  const [form, setForm] = useState({ substance: "", reaction: "", severity: "Moderate", notes: "", recordedDate: TODAY });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const [error, setError] = useState("");
  function submit() {
    if (!form.substance.trim()) { setError("Substance is required."); return; }
    setError(""); onSubmit(form);
  }
  return (
    <div>
      <Field label="Substance"><input className={inputCls} value={form.substance} onChange={set("substance")} placeholder="Penicillin" /></Field>
      <Field label="Reaction"><input className={inputCls} value={form.reaction} onChange={set("reaction")} placeholder="Hives, swelling" /></Field>
      <Field label="Severity">
        <select className={inputCls} value={form.severity} onChange={set("severity")}>{allergySeverities.map(s => <option key={s}>{s}</option>)}</select>
      </Field>
      <Field label="Notes"><textarea className={`${inputCls} h-16 resize-none`} value={form.notes} onChange={set("notes")} /></Field>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Save allergy</button>
    </div>
  );
}

function MedicationsTab({ medications, onAdd, onUpdateStatus }) {
  const [showAdd, setShowAdd] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-slate-700">Medications</h3>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 bg-teal-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-teal-700"><Plus size={13} /> Add medication</button>
      </div>
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5 font-medium">Medication</th>
              <th className="px-4 py-2.5 font-medium">Dose / route</th>
              <th className="px-4 py-2.5 font-medium">Frequency</th>
              <th className="px-4 py-2.5 font-medium">Prescriber</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {medications.map(m => (
              <tr key={m.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2.5 font-medium text-slate-800">{m.name}<div className="text-xs text-slate-400 font-normal">{m.instructions}</div></td>
                <td className="px-4 py-2.5 text-slate-600">{m.dose} · {m.route}</td>
                <td className="px-4 py-2.5 text-slate-600">{m.frequency}</td>
                <td className="px-4 py-2.5 text-slate-600">{m.prescriber}</td>
                <td className="px-4 py-2.5"><StatusPill status={m.status} /></td>
                <td className="px-4 py-2.5">
                  {m.status === "Active" && (
                    <button onClick={() => onUpdateStatus(m.id, "Discontinued")} className="text-xs text-rose-600 border border-rose-200 bg-rose-50 rounded-lg px-2 py-1 hover:bg-rose-100">Discontinue</button>
                  )}
                </td>
              </tr>
            ))}
            {medications.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">No medications on file.</td></tr>}
          </tbody>
        </table>
      </Card>
      {showAdd && (
        <Modal title="Add medication" onClose={() => setShowAdd(false)}>
          <MedicationForm onSubmit={(entry) => { onAdd(entry); setShowAdd(false); }} />
        </Modal>
      )}
    </div>
  );
}

function MedicationForm({ onSubmit }) {
  const [form, setForm] = useState({ name: "", dose: "", route: "Oral", frequency: "", quantity: "", refills: "0", startDate: TODAY, endDate: "", prescriber: "", instructions: "" });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const [error, setError] = useState("");
  function submit() {
    if (!form.name.trim() || !form.dose.trim()) { setError("Medication name and dose are required."); return; }
    setError(""); onSubmit(form);
  }
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Medication name"><input className={inputCls} value={form.name} onChange={set("name")} /></Field>
        <Field label="Dose"><input className={inputCls} value={form.dose} onChange={set("dose")} placeholder="10mg" /></Field>
        <Field label="Route">
          <select className={inputCls} value={form.route} onChange={set("route")}><option>Oral</option><option>Topical</option><option>Injection</option><option>Inhaled</option><option>Other</option></select>
        </Field>
        <Field label="Frequency"><input className={inputCls} value={form.frequency} onChange={set("frequency")} placeholder="Once daily" /></Field>
        <Field label="Quantity"><input className={inputCls} value={form.quantity} onChange={set("quantity")} /></Field>
        <Field label="Refills"><input className={inputCls} value={form.refills} onChange={set("refills")} /></Field>
        <Field label="Start date"><input type="date" className={inputCls} value={form.startDate} onChange={set("startDate")} /></Field>
        <Field label="Prescriber"><input className={inputCls} value={form.prescriber} onChange={set("prescriber")} placeholder="Dr. S. Reyes" /></Field>
      </div>
      <Field label="Instructions"><textarea className={`${inputCls} h-16 resize-none`} value={form.instructions} onChange={set("instructions")} /></Field>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Save medication</button>
    </div>
  );
}

function ProblemsTab({ problems, onAdd, onUpdateStatus }) {
  const [showAdd, setShowAdd] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-slate-700">Problem list</h3>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 bg-teal-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-teal-700"><Plus size={13} /> Add problem</button>
      </div>
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5 font-medium">Diagnosis</th>
              <th className="px-4 py-2.5 font-medium">ICD-10</th>
              <th className="px-4 py-2.5 font-medium">Onset</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {problems.map(p => (
              <tr key={p.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2.5 font-medium text-slate-800">{p.diagnosis}<div className="text-xs text-slate-400 font-normal max-w-xs">{p.description}</div></td>
                <td className="px-4 py-2.5 text-slate-600">{p.icd10}</td>
                <td className="px-4 py-2.5 text-slate-600">{p.onsetDate}</td>
                <td className="px-4 py-2.5"><StatusPill status={p.status} /></td>
                <td className="px-4 py-2.5">
                  {p.status === "Active" && (
                    <button onClick={() => onUpdateStatus(p.id, "Resolved")} className="text-xs text-slate-600 border border-slate-200 rounded-lg px-2 py-1 hover:bg-slate-50">Mark resolved</button>
                  )}
                </td>
              </tr>
            ))}
            {problems.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">No problems on file.</td></tr>}
          </tbody>
        </table>
      </Card>
      {showAdd && (
        <Modal title="Add problem" onClose={() => setShowAdd(false)}>
          <ProblemForm onSubmit={(entry) => { onAdd(entry); setShowAdd(false); }} />
        </Modal>
      )}
    </div>
  );
}

function ProblemForm({ onSubmit }) {
  const [form, setForm] = useState({ diagnosis: "", icd10: "", description: "", onsetDate: TODAY, notes: "" });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const [error, setError] = useState("");
  function submit() {
    if (!form.diagnosis.trim() || !form.icd10.trim()) { setError("Diagnosis and ICD-10 code are required."); return; }
    setError(""); onSubmit(form);
  }
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Diagnosis"><input className={inputCls} value={form.diagnosis} onChange={set("diagnosis")} /></Field>
        <Field label="ICD-10 code"><input className={inputCls} value={form.icd10} onChange={set("icd10")} placeholder="I10" /></Field>
        <Field label="Onset date"><input type="date" className={inputCls} value={form.onsetDate} onChange={set("onsetDate")} /></Field>
      </div>
      <Field label="Description"><textarea className={`${inputCls} h-16 resize-none`} value={form.description} onChange={set("description")} /></Field>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Save problem</button>
    </div>
  );
}

function NotesTab({ notes, onAdd, onSign, onAmend }) {
  const [showAdd, setShowAdd] = useState(false);
  const [amendNoteId, setAmendNoteId] = useState(null);
  const [amendText, setAmendText] = useState("");
  const sorted = [...notes].sort((a, b) => b.date.localeCompare(a.date));

  function submitAmend() {
    if (!amendText.trim()) return;
    onAmend(amendNoteId, amendText.trim(), "Dr. S. Reyes");
    setAmendNoteId(null); setAmendText("");
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-slate-700">Clinical notes</h3>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 bg-teal-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-teal-700"><Plus size={13} /> New note</button>
      </div>
      <div className="space-y-3">
        {sorted.map(n => (
          <Card key={n.id} className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="font-medium text-slate-800">{n.type}</span>
                <span className="text-xs text-slate-400 ml-2">{fmtDate(n.date)} · {n.provider}</span>
              </div>
              <StatusPill status={n.status} />
            </div>
            <div className="text-sm space-y-1.5 text-slate-600">
              <p><span className="text-slate-400 text-xs">S:</span> {n.subjective}</p>
              <p><span className="text-slate-400 text-xs">O:</span> {n.objective}</p>
              <p><span className="text-slate-400 text-xs">A:</span> {n.assessment}</p>
              <p><span className="text-slate-400 text-xs">P:</span> {n.plan}</p>
            </div>
            {n.amendments.length > 0 && (
              <div className="mt-3 pt-3 border-t border-slate-100 space-y-1.5">
                {n.amendments.map((a, i) => (
                  <div key={i} className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                    <span className="font-medium">Amendment</span> — {a.text} <span className="text-amber-500">({a.by}, {fmtDateTime(a.at)})</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2 mt-3">
              {n.status === "Draft" && (
                <button onClick={() => onSign(n.id, n.provider)} className="flex items-center gap-1 text-xs text-teal-700 border border-teal-200 bg-teal-50 rounded-lg px-2 py-1 hover:bg-teal-100"><FileSignature size={12} /> Sign note</button>
              )}
              {(n.status === "Signed" || n.status === "Amended") && (
                <button onClick={() => setAmendNoteId(n.id)} className="text-xs text-slate-600 border border-slate-200 rounded-lg px-2 py-1 hover:bg-slate-50">Add amendment</button>
              )}
            </div>
          </Card>
        ))}
        {sorted.length === 0 && <p className="text-sm text-slate-400">No clinical notes yet.</p>}
      </div>

      {showAdd && (
        <Modal title="New clinical note" onClose={() => setShowAdd(false)} wide>
          <NoteForm onSubmit={(entry) => { onAdd(entry); setShowAdd(false); }} />
        </Modal>
      )}
      {amendNoteId && (
        <Modal title="Add amendment" onClose={() => setAmendNoteId(null)}>
          <p className="text-xs text-slate-400 mb-3">Signed notes are never edited in place this appends an amendment and keeps the original note intact.</p>
          <Field label="Amendment text"><textarea className={`${inputCls} h-24 resize-none`} value={amendText} onChange={(e) => setAmendText(e.target.value)} /></Field>
          <button onClick={submitAmend} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Save amendment</button>
        </Modal>
      )}
    </div>
  );
}

function NoteForm({ onSubmit }) {
  const providerOptions = useProviderOptions();
  const [form, setForm] = useState({ type: noteTypes[0], date: TODAY, provider: providerOptions[0] || "", subjective: "", objective: "", assessment: "", plan: "" });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const [error, setError] = useState("");
  function submit() {
    if (!form.assessment.trim() || !form.plan.trim()) { setError("Assessment and plan are required."); return; }
    setError(""); onSubmit(form);
  }
  return (
    <div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Note type">
          <select className={inputCls} value={form.type} onChange={set("type")}>{noteTypes.map(t => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="Date"><input type="date" className={inputCls} value={form.date} onChange={set("date")} /></Field>
        <Field label="Provider">
          <select className={inputCls} value={form.provider} onChange={set("provider")}>{providerOptions.map(p => <option key={p}>{p}</option>)}</select>
        </Field>
      </div>
      <Field label="Subjective"><textarea className={`${inputCls} h-16 resize-none`} value={form.subjective} onChange={set("subjective")} /></Field>
      <Field label="Objective"><textarea className={`${inputCls} h-16 resize-none`} value={form.objective} onChange={set("objective")} /></Field>
      <Field label="Assessment"><textarea className={`${inputCls} h-16 resize-none`} value={form.assessment} onChange={set("assessment")} /></Field>
      <Field label="Plan"><textarea className={`${inputCls} h-16 resize-none`} value={form.plan} onChange={set("plan")} /></Field>
      <p className="text-xs text-slate-400 mb-3">Note saves as a draft — sign it from the notes list once complete. Signed notes can only be amended, never silently overwritten.</p>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Save draft</button>
    </div>
  );
}

// ---------- Forms ----------

function AddPatientForm({ onSubmit }) {
  const [form, setForm] = useState({
    name: "", dob: "", phone: "", email: "", ssn: "",
    address: "", city: "", state: "NY", zip: "",
    emergencyContact: { name: "", relationship: "Spouse", phone: "" },
    guarantor: { name: "", relationship: "Self", employer: "" },
  });
  const [error, setError] = useState("");
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setEC = (k) => (e) => setForm({ ...form, emergencyContact: { ...form.emergencyContact, [k]: e.target.value } });
  const setG = (k) => (e) => setForm({ ...form, guarantor: { ...form.guarantor, [k]: e.target.value } });

  function submit() {
    if (!form.name.trim() || !form.dob) { setError("Name and date of birth are required."); return; }
    setError(""); onSubmit(form);
  }

  return (
    <div>
      <SectionTitle>Demographics</SectionTitle>
      <Field label="Full name"><input className={inputCls} value={form.name} onChange={set("name")} placeholder="Jane Doe" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date of birth"><input type="date" className={inputCls} value={form.dob} onChange={set("dob")} /></Field>
        <Field label="SSN" hint="Optional — stored masked, shown as last 4 digits only."><input className={inputCls} value={form.ssn} onChange={set("ssn")} placeholder="123-45-6789" /></Field>
        <Field label="Phone"><input className={inputCls} value={form.phone} onChange={set("phone")} placeholder="(555) 555-0100" /></Field>
        <Field label="Email"><input className={inputCls} value={form.email} onChange={set("email")} placeholder="jane@email.com" /></Field>
      </div>

      <SectionTitle>Address</SectionTitle>
      <Field label="Street address"><input className={inputCls} value={form.address} onChange={set("address")} /></Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="City"><input className={inputCls} value={form.city} onChange={set("city")} /></Field>
        <Field label="State"><input className={inputCls} value={form.state} onChange={set("state")} /></Field>
        <Field label="ZIP"><input className={inputCls} value={form.zip} onChange={set("zip")} /></Field>
      </div>

      <SectionTitle>Emergency contact</SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Name"><input className={inputCls} value={form.emergencyContact.name} onChange={setEC("name")} /></Field>
        <Field label="Relationship">
          <select className={inputCls} value={form.emergencyContact.relationship} onChange={setEC("relationship")}>
            <option>Spouse</option><option>Child</option><option>Sibling</option><option>Other</option>
          </select>
        </Field>
        <Field label="Phone"><input className={inputCls} value={form.emergencyContact.phone} onChange={setEC("phone")} /></Field>
      </div>

      <SectionTitle>Responsible party / guarantor</SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Name" hint="Defaults to patient if self"><input className={inputCls} value={form.guarantor.name} onChange={setG("name")} /></Field>
        <Field label="Relationship">
          <select className={inputCls} value={form.guarantor.relationship} onChange={setG("relationship")}>
            <option>Self</option><option>Spouse</option><option>Parent</option><option>Other</option>
          </select>
        </Field>
        <Field label="Employer"><input className={inputCls} value={form.guarantor.employer} onChange={setG("employer")} /></Field>
      </div>

      <p className="text-xs text-slate-400 mb-3">Insurance isn't collected here add it from the patient's Insurance tab after registration, so it's properly versioned and never overwritten.</p>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700 mt-2">Register patient</button>
    </div>
  );
}

function DuplicateWarning({ dupes, onUseExisting, onCreateAnyway, onCancel }) {
  return (
    <div>
      <div className="flex items-center gap-2 text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4 text-sm">
        <AlertCircle size={16} /> Possible existing patient{dupes.length > 1 ? "s" : ""} found
      </div>
      <div className="space-y-2 mb-4">
        {dupes.map(d => (
          <div key={d.id} className="flex items-center justify-between border border-slate-200 rounded-lg px-3 py-2">
            <div>
              <div className="font-medium text-slate-800">{d.name}</div>
              <div className="text-xs text-slate-500">{d.id} · DOB {fmtDate(d.dob)} · {d.phone}</div>
            </div>
            <button onClick={() => onUseExisting(d.id)} className="text-xs text-teal-700 border border-teal-200 bg-teal-50 rounded-lg px-3 py-1.5 hover:bg-teal-100">View this patient</button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 border border-slate-200 text-slate-600 text-sm font-medium py-2 rounded-lg hover:bg-slate-50">Cancel</button>
        <button onClick={onCreateAnyway} className="flex-1 bg-slate-800 text-white text-sm font-medium py-2 rounded-lg hover:bg-slate-900">Create new patient anyway</button>
      </div>
    </div>
  );
}

function AddApptForm({ patients, onSubmit }) {
  const providerOptions = useProviderOptions();
  const cptOptions = useCptOptions();
  const [form, setForm] = useState({ patientId: patients[0]?.id || "", date: "2026-08-24", time: "09:00", provider: providerOptions[0] || "", type: "Follow-up", cpt: cptOptions[0]?.code || "" });
  const [error, setError] = useState("");
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  function submit() {
    if (!form.patientId || !form.date || !form.time) { setError("Patient, date, and time are required."); return; }
    setError(""); onSubmit(form);
  }

  return (
    <div>
      <Field label="Patient">
        <select className={inputCls} value={form.patientId} onChange={set("patientId")}>{patients.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date"><input type="date" className={inputCls} value={form.date} onChange={set("date")} /></Field>
        <Field label="Time"><input type="time" className={inputCls} value={form.time} onChange={set("time")} /></Field>
      </div>
      <Field label="Provider">
        <select className={inputCls} value={form.provider} onChange={set("provider")}>{providerOptions.map(p => <option key={p}>{p}</option>)}</select>
      </Field>
      <Field label="Visit type"><input className={inputCls} value={form.type} onChange={set("type")} /></Field>
      <Field label="Expected CPT code">
        <select className={inputCls} value={form.cpt} onChange={set("cpt")}>{cptOptions.map(c => <option key={c.code} value={c.code}>{c.code} — {c.desc}</option>)}</select>
      </Field>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700 mt-2">Schedule appointment</button>
    </div>
  );
}
