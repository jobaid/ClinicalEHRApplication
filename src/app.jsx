import React, { useState, useMemo } from "react";
import Papa from "papaparse";
import {
  LayoutDashboard, CalendarDays, Users, Receipt, FileStack, BarChart3,
  Plus, X, Search, ChevronRight, ChevronLeft, AlertCircle, CheckCircle2, Clock,
  Send, DollarSign, Stethoscope, Settings, Trash2, Pencil, MessageSquarePlus,
  ScissorsLineDashed, CreditCard, Upload, FileCheck2, Landmark, Wand2,
  Download, Printer, TrendingDown, TrendingUp,
  Shield, History, IdCard, Ban, Eye, FileText,
  Activity, Pill, ClipboardList, FileSignature, AlertTriangle, HeartPulse
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, Legend
} from "recharts";

// ---------- Seed data ----------

const seedPatients = [
  { id: "P1001", name: "Maria Alvarez", dob: "1985-03-14", phone: "(516) 555-0142", email: "maria.a@email.com", ssn: "123-45-6781",
    address: "12 Oak St", city: "Bellerose", state: "NY", zip: "11426",
    emergencyContact: { name: "Rosa Alvarez", relationship: "Spouse", phone: "(516) 555-0143" },
    guarantor: { name: "Maria Alvarez", relationship: "Self", employer: "Northwell Health" } },
  { id: "P1002", name: "James Whitfield", dob: "1972-11-02", phone: "(516) 555-0198", email: "j.whitfield@email.com", ssn: "234-56-7892",
    address: "45 Elm St", city: "Floral Park", state: "NY", zip: "11001",
    emergencyContact: { name: "Karen Whitfield", relationship: "Spouse", phone: "(516) 555-0199" },
    guarantor: { name: "James Whitfield", relationship: "Self", employer: "Bank of America" } },
  { id: "P1003", name: "Priya Natarajan", dob: "1990-07-22", phone: "(631) 555-0110", email: "priya.n@email.com", ssn: "345-67-8903",
    address: "88 Cedar Ave", city: "Huntington", state: "NY", zip: "11743",
    emergencyContact: { name: "Raj Natarajan", relationship: "Sibling", phone: "(631) 555-0198" },
    guarantor: { name: "Priya Natarajan", relationship: "Self", employer: "Self-employed" } },
  { id: "P1004", name: "Deshawn Carter", dob: "1965-01-09", phone: "(631) 555-0173", email: "d.carter@email.com", ssn: "456-78-9014",
    address: "300 Maple Dr", city: "Huntington", state: "NY", zip: "11743",
    emergencyContact: { name: "Tanya Carter", relationship: "Child", phone: "(631) 555-0174" },
    guarantor: { name: "Deshawn Carter", relationship: "Self", employer: "Suffolk County" } },
  { id: "P1005", name: "Linda Kowalski", dob: "1958-09-30", phone: "(516) 555-0221", email: "l.kowalski@email.com", ssn: "567-89-0125",
    address: "9 Birch Ln", city: "Bellerose", state: "NY", zip: "11426",
    emergencyContact: { name: "Mark Kowalski", relationship: "Child", phone: "(516) 555-0222" },
    guarantor: { name: "Linda Kowalski", relationship: "Self", employer: "Retired" } },
  { id: "P1006", name: "Omar Haddad", dob: "1999-04-17", phone: "(646) 555-0109", email: "omar.h@email.com", ssn: "678-90-1236",
    address: "210 5th Ave", city: "New York", state: "NY", zip: "10010",
    emergencyContact: { name: "Layla Haddad", relationship: "Sibling", phone: "(646) 555-0111" },
    guarantor: { name: "Omar Haddad", relationship: "Self", employer: "Freelance" } },
];

const providers = ["Dr. S. Reyes", "Dr. A. Okafor", "Dr. M. Lin"];

// ---------- Auth / RBAC (demo only — see LoginPage/Forbidden for the honesty caveat) ----------
// This gates the UI so each role sees the right nav, matching the permission matrix in the spec.
// It is NOT real security: there is no backend here to enforce it against direct API calls,
// Postman, curl, etc. Real enforcement has to live in the Express API layer.

const DEMO_USERS = [
  { email: "admin@medbill.local", password: "Admin@12345", name: "Jobaid Azim", role: "SUPER_ADMIN" },
  { email: "manager@medbill.local", password: "Manager@12345", name: "Ibnat Nuha", role: "MANAGER" },
  { email: "nurse@medbill.local", password: "Nurse@12345", name: "Dana Ruiz", role: "NURSE" },
  { email: "reception@medbill.local", password: "Reception@12345", name: "Leah Ford", role: "RECEPTIONIST" },
  { email: "biller@medbill.local", password: "Biller@12345", name: "Marcus Webb", role: "BILLER" },
];

const ROLE_LABELS = {
  SUPER_ADMIN: "Super Admin", MANAGER: "Manager", NURSE: "Nurse", RECEPTIONIST: "Receptionist", BILLER: "Biller",
};

// Which top-nav tabs each role may open. Nurse/Receptionist never see Billing/Claims/Reports;
// Biller never sees Clinical; Manager/Super Admin see everything.
const ROLE_TABS = {
  SUPER_ADMIN: ["dashboard", "schedule", "patients", "clinical", "billing", "claims", "reports"],
  MANAGER: ["dashboard", "schedule", "patients", "clinical", "billing", "claims", "reports"],
  NURSE: ["dashboard", "schedule", "patients", "clinical"],
  RECEPTIONIST: ["dashboard", "schedule", "patients"],
  BILLER: ["dashboard", "patients", "billing", "claims", "reports"],
};

const cptCatalog = [
  { code: "99213", desc: "Office visit, established patient (low complexity)", charge: 110 },
  { code: "99214", desc: "Office visit, established patient (moderate complexity)", charge: 165 },
  { code: "99385", desc: "Preventive visit, new patient (18-39y)", charge: 190 },
  { code: "90471", desc: "Immunization administration", charge: 35 },
  { code: "80053", desc: "Comprehensive metabolic panel", charge: 48 },
  { code: "93000", desc: "Electrocardiogram, complete", charge: 72 },
];

// ---------- Insurance (versioned — never overwritten, see addInsurance/editInsurance) ----------

const insuranceTypes = ["Commercial", "Medicare", "Medicaid", "Tricare", "Workers' Comp", "Other"];
const priorities = ["Primary", "Secondary", "Tertiary"];
const idTypes = ["Driver's License", "State ID", "Passport", "Other Government ID"];

// One row per coverage period. Adding new insurance at an occupied priority terminates
// the old row (status + terminationDate) instead of overwriting it — full history stays queryable.
const seedInsurancePolicies = [
  { id: "POL-1001", patientId: "P1001", insuranceCompany: "Aetna", planName: "Aetna Choice POS II", insuranceType: "Commercial",
    memberId: "AET-88213", subscriberId: "AET-88213", groupNumber: "GRP-4471", payerId: "60054",
    effectiveDate: "2025-01-01", terminationDate: "2025-12-31", status: "Terminated", priority: "Primary",
    subscriberName: "Maria Alvarez", subscriberDob: "1985-03-14", subscriberRelationship: "Self",
    copay: "25", deductible: "1500", coinsurance: "20%", authRequired: false, referralRequired: false, notes: "",
    cardFront: null, cardBack: null, fieldHistory: [], createdBy: "System (seed)", createdAt: "2025-01-01T09:00:00", updatedAt: "2026-01-01T09:00:00" },
  { id: "POL-1002", patientId: "P1001", insuranceCompany: "UnitedHealthcare", planName: "UHC Choice Plus", insuranceType: "Commercial",
    memberId: "UHC-40217", subscriberId: "UHC-40217", groupNumber: "GRP-1190", payerId: "87726",
    effectiveDate: "2026-01-01", terminationDate: "", status: "Active", priority: "Primary",
    subscriberName: "Maria Alvarez", subscriberDob: "1985-03-14", subscriberRelationship: "Self",
    copay: "20", deductible: "1000", coinsurance: "10%", authRequired: false, referralRequired: true, notes: "Referral required for specialists.",
    cardFront: null, cardBack: null, fieldHistory: [], createdBy: "System (seed)", createdAt: "2026-01-01T09:05:00", updatedAt: "2026-01-01T09:05:00" },
  { id: "POL-1003", patientId: "P1002", insuranceCompany: "UnitedHealthcare", planName: "UHC Choice Plus", insuranceType: "Commercial",
    memberId: "UHC-33920", subscriberId: "UHC-33920", groupNumber: "GRP-1190", payerId: "87726",
    effectiveDate: "2025-06-01", terminationDate: "", status: "Active", priority: "Primary",
    subscriberName: "James Whitfield", subscriberDob: "1972-11-02", subscriberRelationship: "Self",
    copay: "20", deductible: "1000", coinsurance: "10%", authRequired: false, referralRequired: false, notes: "",
    cardFront: null, cardBack: null, fieldHistory: [], createdBy: "System (seed)", createdAt: "2025-06-01T09:00:00", updatedAt: "2025-06-01T09:00:00" },
  { id: "POL-1004", patientId: "P1003", insuranceCompany: "Cigna", planName: "Cigna Open Access", insuranceType: "Commercial",
    memberId: "CIG-77410", subscriberId: "CIG-77410", groupNumber: "GRP-2201", payerId: "62308",
    effectiveDate: "2025-09-01", terminationDate: "", status: "Active", priority: "Primary",
    subscriberName: "Priya Natarajan", subscriberDob: "1990-07-22", subscriberRelationship: "Self",
    copay: "30", deductible: "2000", coinsurance: "20%", authRequired: false, referralRequired: false, notes: "",
    cardFront: null, cardBack: null, fieldHistory: [], createdBy: "System (seed)", createdAt: "2025-09-01T09:00:00", updatedAt: "2025-09-01T09:00:00" },
  { id: "POL-1005", patientId: "P1004", insuranceCompany: "Aetna", planName: "Aetna Choice POS II", insuranceType: "Commercial",
    memberId: "AET-91004", subscriberId: "AET-91004", groupNumber: "GRP-4471", payerId: "60054",
    effectiveDate: "2025-03-01", terminationDate: "", status: "Active", priority: "Primary",
    subscriberName: "Deshawn Carter", subscriberDob: "1965-01-09", subscriberRelationship: "Self",
    copay: "25", deductible: "1500", coinsurance: "20%", authRequired: true, referralRequired: false, notes: "",
    cardFront: null, cardBack: null, fieldHistory: [], createdBy: "System (seed)", createdAt: "2025-03-01T09:00:00", updatedAt: "2025-03-01T09:00:00" },
  { id: "POL-1006", patientId: "P1005", insuranceCompany: "Medicare", planName: "Medicare Part B", insuranceType: "Medicare",
    memberId: "MED-10029", subscriberId: "MED-10029", groupNumber: "-", payerId: "00590",
    effectiveDate: "2023-10-01", terminationDate: "", status: "Active", priority: "Primary",
    subscriberName: "Linda Kowalski", subscriberDob: "1958-09-30", subscriberRelationship: "Self",
    copay: "0", deductible: "240", coinsurance: "20%", authRequired: false, referralRequired: false, notes: "",
    cardFront: null, cardBack: null, fieldHistory: [], createdBy: "System (seed)", createdAt: "2023-10-01T09:00:00", updatedAt: "2023-10-01T09:00:00" },
  { id: "POL-1007", patientId: "P1006", insuranceCompany: "Cigna", planName: "Cigna Open Access", insuranceType: "Commercial",
    memberId: "CIG-50213", subscriberId: "CIG-50213", groupNumber: "GRP-2201", payerId: "62308",
    effectiveDate: "2026-02-01", terminationDate: "", status: "Active", priority: "Primary",
    subscriberName: "Omar Haddad", subscriberDob: "1999-04-17", subscriberRelationship: "Self",
    copay: "30", deductible: "2000", coinsurance: "20%", authRequired: false, referralRequired: false, notes: "",
    cardFront: null, cardBack: null, fieldHistory: [], createdBy: "System (seed)", createdAt: "2026-02-01T09:00:00", updatedAt: "2026-02-01T09:00:00" },
];

const seedAuditLogs = [
  { id: "AUD-1001", patientId: "P1001", user: "System (seed)", action: "Patient created", entityType: "patient", entityId: "P1001", oldValues: null, newValues: "Maria Alvarez registered", timestamp: "2025-01-01T09:00:00" },
  { id: "AUD-1002", patientId: "P1001", user: "System (seed)", action: "Insurance added", entityType: "insurance", entityId: "POL-1001", oldValues: null, newValues: "Aetna Choice POS II, Member AET-88213, Primary, effective 2025-01-01", timestamp: "2025-01-01T09:00:00" },
  { id: "AUD-1003", patientId: "P1001", user: "System (seed)", action: "Insurance terminated", entityType: "insurance", entityId: "POL-1001", oldValues: "Active", newValues: "Terminated 2025-12-31 (superseded by UnitedHealthcare)", timestamp: "2026-01-01T09:05:00" },
  { id: "AUD-1004", patientId: "P1001", user: "System (seed)", action: "Insurance added", entityType: "insurance", entityId: "POL-1002", oldValues: null, newValues: "UnitedHealthcare Choice Plus, Member UHC-40217, Primary, effective 2026-01-01", timestamp: "2026-01-01T09:05:00" },
];

const seedIdDocuments = [];

// ---------- Clinical charting (EHR-lite: vitals, allergies, medications, problems, notes) ----------

const allergySeverities = ["Mild", "Moderate", "Severe", "Unknown"];
const medicationStatuses = ["Active", "Discontinued", "Completed", "Historical"];
const problemStatuses = ["Active", "Resolved", "Historical"];
const noteTypes = ["SOAP Note", "Progress Note", "Consultation", "Procedure Note", "Discharge Note", "Telephone Note"];

const seedVitals = [
  { id: "VIT-1001", patientId: "P1001", date: "2026-08-10", height: "165 cm", weight: "68 kg", bmi: "25.0", bp: "118/76", pulse: "72", resp: "16", temp: "98.4°F", spo2: "99%", pain: "0", recordedBy: "Dr. S. Reyes" },
  { id: "VIT-1002", patientId: "P1004", date: "2026-08-05", height: "178 cm", weight: "92 kg", bmi: "29.0", bp: "138/88", pulse: "80", resp: "18", temp: "98.6°F", spo2: "97%", pain: "2", recordedBy: "Dr. M. Lin" },
];

const seedAllergies = [
  { id: "ALG-1001", patientId: "P1001", substance: "Penicillin", reaction: "Hives, difficulty breathing", severity: "Severe", status: "Active", notes: "Confirmed on prior admission.", recordedDate: "2025-02-10", recordedBy: "Dr. S. Reyes" },
  { id: "ALG-1002", patientId: "P1004", substance: "Sulfa drugs", reaction: "Rash", severity: "Moderate", status: "Active", notes: "", recordedDate: "2025-03-05", recordedBy: "Dr. M. Lin" },
];

const seedMedications = [
  { id: "MED-1001", patientId: "P1001", name: "Lisinopril", dose: "10mg", route: "Oral", frequency: "Once daily", quantity: "30", refills: "3", startDate: "2026-01-05", endDate: "", status: "Active", prescriber: "Dr. S. Reyes", instructions: "Take in the morning with water." },
  { id: "MED-1002", patientId: "P1004", name: "Metformin", dose: "500mg", route: "Oral", frequency: "Twice daily", quantity: "60", refills: "5", startDate: "2025-03-10", endDate: "", status: "Active", prescriber: "Dr. M. Lin", instructions: "Take with meals." },
];

const seedProblems = [
  { id: "PRB-1001", patientId: "P1001", diagnosis: "Essential hypertension", icd10: "I10", description: "Diagnosed 2026, well controlled on Lisinopril.", onsetDate: "2026-01-05", status: "Active", notes: "" },
  { id: "PRB-1002", patientId: "P1004", diagnosis: "Type 2 diabetes mellitus", icd10: "E11.9", description: "Diet and Metformin controlled.", onsetDate: "2025-03-10", status: "Active", notes: "Recheck A1c in 3 months." },
];

const seedClinicalNotes = [
  { id: "NOTE-1001", patientId: "P1001", type: "SOAP Note", date: "2026-08-10", provider: "Dr. S. Reyes",
    subjective: "Patient reports occasional mild headaches, otherwise feeling well.", objective: "BP 118/76, HR 72. No acute distress.",
    assessment: "Hypertension, well controlled.", plan: "Continue Lisinopril 10mg daily. Follow up in 3 months.",
    status: "Signed", signedBy: "Dr. S. Reyes", signedAt: "2026-08-10T11:20:00", amendments: [] },
];

const seedAppointments = [
  { id: "A1", patientId: "P1001", date: "2026-08-24", time: "09:00", provider: providers[0], type: "Follow-up", status: "Checked out", cpt: "99213" },
  { id: "A2", patientId: "P1002", date: "2026-08-24", time: "09:30", provider: providers[1], type: "Annual physical", status: "In progress", cpt: "99385" },
  { id: "A3", patientId: "P1003", date: "2026-08-24", time: "10:15", provider: providers[0], type: "New complaint", status: "Scheduled", cpt: "99214" },
  { id: "A4", patientId: "P1004", date: "2026-08-24", time: "11:00", provider: providers[2], type: "Lab review", status: "Scheduled", cpt: "80053" },
  { id: "A5", patientId: "P1005", date: "2026-08-25", time: "09:00", provider: providers[0], type: "Follow-up", status: "Scheduled", cpt: "99213" },
  { id: "A6", patientId: "P1006", date: "2026-08-25", time: "13:30", provider: providers[1], type: "Vaccination", status: "Scheduled", cpt: "90471" },
];

// Charges = the patient ledger. One row per CPT code / date of service.
const seedCharges = [
  { id: "C5001", patientId: "P1001", dos: "2026-08-10", provider: providers[0], cpt: "99213", desc: "Office visit, established patient (low complexity)", charge: 110, paid: 0, writeoff: 0, memos: [] },
  { id: "C5002", patientId: "P1004", dos: "2026-08-05", provider: providers[2], cpt: "99214", desc: "Office visit, established patient (moderate complexity)", charge: 165, paid: 0, writeoff: 0, memos: [{ date: "2026-08-06", text: "Claim denied for missing modifier. Follow up with Aetna." }] },
  { id: "C5003", patientId: "P1004", dos: "2026-08-05", provider: providers[2], cpt: "80053", desc: "Comprehensive metabolic panel", charge: 48, paid: 0, writeoff: 0, memos: [] },
  { id: "C5004", patientId: "P1003", dos: "2026-08-15", provider: providers[0], cpt: "99213", desc: "Office visit, established patient (low complexity)", charge: 110, paid: 65, writeoff: 0, memos: [] },
  { id: "C5005", patientId: "P1002", dos: "2026-08-01", provider: providers[1], cpt: "99385", desc: "Preventive visit, new patient (18-39y)", charge: 190, paid: 190, writeoff: 0, memos: [] },
  { id: "C5006", patientId: "P1006", dos: "2026-08-18", provider: providers[1], cpt: "90471", desc: "Immunization administration", charge: 35, paid: 0, writeoff: 0, memos: [{ date: "2026-08-19", text: "Call patient re: self-pay balance next visit." }] },
];

const seedClaims = [
  { id: "CLM-7001", patientId: "P1001", chargeId: "C5001", payer: "Aetna", cpt: "99213", dx: "M54.5", amount: 110, submitted: "2026-08-11", status: "Submitted" },
  { id: "CLM-7002", patientId: "P1004", chargeId: "C5002", payer: "Aetna", cpt: "99214", dx: "E11.9", amount: 165, submitted: "2026-08-06", status: "Denied" },
  { id: "CLM-7003", patientId: "P1003", chargeId: "C5004", payer: "Cigna", cpt: "99213", dx: "J06.9", amount: 110, submitted: "2026-08-16", status: "Paid" },
  { id: "CLM-7004", patientId: "P1002", chargeId: "C5005", payer: "UnitedHealthcare", cpt: "99385", dx: "Z00.00", amount: 190, submitted: "2026-08-02", status: "Paid" },
];

const revenueByMonth = [
  { month: "Mar", revenue: 8200 }, { month: "Apr", revenue: 9100 }, { month: "May", revenue: 8700 },
  { month: "Jun", revenue: 10250 }, { month: "Jul", revenue: 11020 }, { month: "Aug", revenue: 6480 },
];

const COLORS = ["#0d9488", "#f59e0b", "#e11d48", "#0ea5e9", "#84cc16"];

// ---------- Helpers ----------

const TODAY = "2026-08-24";

function daysBetween(dateStr, todayStr) {
  const d1 = new Date(dateStr + "T00:00");
  const d2 = new Date(todayStr + "T00:00");
  return Math.max(0, Math.round((d2 - d1) / 86400000));
}

function agingBucket(days) {
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

// Builds an initial transaction ledger (debits = charges, credits = payments/write-offs)
// from the seed charges, so the report center has real data to show on first load.
function buildSeedTransactions(seedCharges) {
  const txns = [];
  seedCharges.forEach(c => {
    txns.push({ id: uid("TXN"), chargeId: c.id, patientId: c.patientId, type: "charge", amount: c.charge, date: c.dos, source: "", reference: "" });
    if (c.paid > 0) txns.push({ id: uid("TXN"), chargeId: c.id, patientId: c.patientId, type: "payment", amount: c.paid, date: c.dos, source: "Insurance", reference: "" });
    if (c.writeoff > 0) txns.push({ id: uid("TXN"), chargeId: c.id, patientId: c.patientId, type: "writeoff", amount: c.writeoff, date: c.dos, source: "Contractual adjustment", reference: "" });
  });
  return txns;
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

function printReport() {
  window.print();
}

const money = (n) => Number(n || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const maskSSN = (ssn) => ssn ? `***-**-${ssn.slice(-4)}` : "—";
const uid = (prefix) => `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;
const balanceOf = (c) => c.charge - c.paid - c.writeoff;
const chargeStatus = (c) => {
  const bal = balanceOf(c);
  if (bal <= 0 && c.writeoff > 0 && c.paid === 0) return "Written off";
  if (bal <= 0) return "Paid";
  if (c.paid > 0 || c.writeoff > 0) return "Partial";
  return "Open";
};

function nowIso() { return TODAY + "T" + new Date().toTimeString().slice(0, 8); }

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
    "N1*PE*Jobaid Clinic*XX*1912345678~",
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

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-4">
      <div className={`bg-white rounded-xl shadow-xl w-full ${wide ? "max-w-2xl" : "max-w-md"} max-h-[85vh] overflow-y-auto`}>
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
  async function handle(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    onChange(await fileToDataUrl(file));
  }
  return (
    <div className="mb-3">
      <span className="block text-xs font-medium text-slate-500 mb-1">{label}</span>
      {value ? (
        <div className="flex items-center gap-3 border border-slate-200 rounded-lg p-2">
          <img src={value} alt={label} className="w-16 h-16 object-cover rounded-md border border-slate-200" />
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

function LoginPage({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function submit(e) {
    e.preventDefault();
    setLoading(true);
    setTimeout(() => {
      const user = DEMO_USERS.find(u => u.email.toLowerCase() === email.trim().toLowerCase() && u.password === password);
      if (!user) {
        setError("Invalid email or password.");
        setLoading(false);
        return;
      }
      setError("");
      setLoading(false);
      onLogin(user);
    }, 350); // simulated request latency
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

        <Card className="p-4 mt-4 bg-amber-50 border-amber-200">
          <p className="text-xs font-medium text-amber-800 mb-2 flex items-center gap-1.5"><AlertTriangle size={13} /> Development-only credentials</p>
          <div className="space-y-1 text-xs text-amber-700">
            {DEMO_USERS.map(u => (
              <div key={u.email} className="flex justify-between">
                <span>{ROLE_LABELS[u.role]}</span>
                <button onClick={() => { setEmail(u.email); setPassword(u.password); }} className="underline hover:no-underline">{u.email}</button>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-amber-600 mt-2">Shown here because this is a demo build — a real deployment must hide this panel outside development and never ship hardcoded passwords.</p>
        </Card>
      </div>
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

export default function ClinicBilling() {
  const [session, setSession] = useState(null);
  const [loginAudit, setLoginAudit] = useState([]); // lightweight system-level log (login/logout aren't tied to a patient)

  function handleLogin(user) {
    setSession(user);
    setLoginAudit(prev => [{ id: uid("SYS"), action: "Login", user: user.name, role: user.role, timestamp: nowIso() }, ...prev]);
  }
  function handleLogout() {
    setLoginAudit(prev => [{ id: uid("SYS"), action: "Logout", user: session?.name, role: session?.role, timestamp: nowIso() }, ...prev]);
    setSession(null);
  }

  if (!session) return <LoginPage onLogin={handleLogin} />;
  return <ClinicApp session={session} onLogout={handleLogout} />;
}

function ClinicApp({ session, onLogout }) {
  const [tab, setTab] = useState("dashboard");
  const [patients, setPatients] = useState(seedPatients);
  const [appointments, setAppointments] = useState(seedAppointments);
  const [charges, setCharges] = useState(seedCharges);
  const [claims, setClaims] = useState(seedClaims);
  const [transactions, setTransactions] = useState(() => buildSeedTransactions(seedCharges));
  const [policies, setPolicies] = useState(seedInsurancePolicies);
  const [auditLogs, setAuditLogs] = useState(seedAuditLogs);
  const [idDocuments, setIdDocuments] = useState(seedIdDocuments);
  const [vitals, setVitals] = useState(seedVitals);
  const [allergies, setAllergies] = useState(seedAllergies);
  const [medications, setMedications] = useState(seedMedications);
  const [problems, setProblems] = useState(seedProblems);
  const [clinicalNotes, setClinicalNotes] = useState(seedClinicalNotes);

  const [showAddPatient, setShowAddPatient] = useState(false);
  const [showAddAppt, setShowAddAppt] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState(null);

  // Billing drill-down: null = list view, otherwise a patientId
  const [billingPatientId, setBillingPatientId] = useState(null);
  // Billing sub-view when no patient is selected: 'search' or 'post'
  const [billingMode, setBillingMode] = useState("search");
  // Clinical drill-down: null = patient list, otherwise a patientId
  const [clinicalPatientId, setClinicalPatientId] = useState(null);

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
  const allowedTabs = ROLE_TABS[session.role] || ["dashboard"];
  const nav = allNav.filter(item => allowedTabs.includes(item.id));
  const tabAllowed = allowedTabs.includes(tab);

  // ---------- Handlers ----------

  function addAudit(patientId, action, entityType, entityId, oldValues, newValues) {
    setAuditLogs(prev => [{ id: uid("AUD"), patientId, user: "Front Desk User", action, entityType, entityId, oldValues, newValues, timestamp: nowIso() }, ...prev]);
  }

  function addPatient(form) {
    const dupes = findDuplicatePatients(form, patients);
    if (dupes.length > 0 && !form._forceCreate) {
      setDuplicateWarning({ form, dupes });
      return;
    }
    const id = uid("P");
    const patient = { ...form, id };
    delete patient._forceCreate;
    setPatients(prev => [...prev, patient]);
    addAudit(id, "Patient created", "patient", id, null, `${patient.name} registered`);
    setShowAddPatient(false);
    setDuplicateWarning(null);
  }

  function updatePatient(patientId, updates) {
    const before = patientById[patientId];
    setPatients(prev => prev.map(p => p.id === patientId ? { ...p, ...updates } : p));
    const changed = Object.keys(updates).filter(k => JSON.stringify(before[k]) !== JSON.stringify(updates[k]));
    if (changed.length) addAudit(patientId, "Patient updated", "patient", patientId, changed.map(k => `${k}: ${before[k]}`).join("; "), changed.map(k => `${k}: ${updates[k]}`).join("; "));
  }

  // ----- Insurance: the never-overwrite rule -----
  function addInsurance(patientId, form) {
    const conflict = policies.find(pol => pol.patientId === patientId && pol.priority === form.priority && pol.status === "Active");
    if (conflict) {
      const endDate = form.effectiveDate ? new Date(new Date(form.effectiveDate + "T00:00") - 86400000).toISOString().slice(0, 10) : TODAY;
      setPolicies(prev => prev.map(pol => pol.id === conflict.id ? { ...pol, status: "Terminated", terminationDate: endDate, updatedAt: nowIso() } : pol));
      addAudit(patientId, "Insurance terminated", "insurance", conflict.id, "Active", `Terminated ${endDate} (superseded by ${form.insuranceCompany})`);
    }
    const id = uid("POL");
    setPolicies(prev => [...prev, { id, patientId, status: "Active", fieldHistory: [], createdBy: "Front Desk User", createdAt: nowIso(), updatedAt: nowIso(), ...form }]);
    addAudit(patientId, "Insurance added", "insurance", id, null, `${form.insuranceCompany} ${form.planName}, Member ${form.memberId}, ${form.priority}, effective ${form.effectiveDate}`);
  }

  function editInsurance(policyId, updates, createNew) {
    const policy = policies.find(p => p.id === policyId);
    if (!policy) return;
    if (createNew) { addInsurance(policy.patientId, { ...policy, ...updates, id: undefined }); return; }
    const changedFields = Object.keys(updates).filter(k => policy[k] !== updates[k]);
    const historyEntries = changedFields.map(k => ({ field: k, oldValue: policy[k], newValue: updates[k], changedAt: nowIso(), changedBy: "Front Desk User" }));
    setPolicies(prev => prev.map(p => p.id === policyId ? { ...p, ...updates, fieldHistory: [...p.fieldHistory, ...historyEntries], updatedAt: nowIso() } : p));
    if (changedFields.length) addAudit(policy.patientId, "Insurance updated", "insurance", policyId, changedFields.map(k => `${k}: ${policy[k]}`).join("; "), changedFields.map(k => `${k}: ${updates[k]}`).join("; "));
  }

  function setPolicyPriority(policyId, newPriority) {
    const policy = policies.find(p => p.id === policyId);
    if (!policy) return;
    const holder = policies.find(p => p.patientId === policy.patientId && p.priority === newPriority && p.status === "Active" && p.id !== policyId);
    setPolicies(prev => prev.map(p => {
      if (p.id === policyId) return { ...p, priority: newPriority, updatedAt: nowIso() };
      if (holder && p.id === holder.id) return { ...p, priority: policy.priority, updatedAt: nowIso() };
      return p;
    }));
    addAudit(policy.patientId, "Insurance priority changed", "insurance", policyId, policy.priority, newPriority);
  }

  function endCoverage(policyId, endDate) {
    const policy = policies.find(p => p.id === policyId);
    if (!policy) return;
    setPolicies(prev => prev.map(p => p.id === policyId ? { ...p, status: "Terminated", terminationDate: endDate, updatedAt: nowIso() } : p));
    addAudit(policy.patientId, "Insurance ended", "insurance", policyId, "Active", `Terminated ${endDate}`);
  }

  function uploadInsuranceCard(policyId, side, dataUrl) {
    const policy = policies.find(p => p.id === policyId);
    setPolicies(prev => prev.map(p => p.id === policyId ? { ...p, [side]: dataUrl, updatedAt: nowIso() } : p));
    addAudit(policy.patientId, "Insurance card uploaded", "insurance", policyId, null, side === "cardFront" ? "Front card image" : "Back card image");
  }

  function uploadIdDocument(patientId, doc) {
    // Previous ID docs of the same type are archived, never deleted — history stays queryable.
    setIdDocuments(prev => prev.map(d => d.patientId === patientId && d.idType === doc.idType && d.status === "Active" ? { ...d, status: "Archived" } : d));
    const id = uid("DOC");
    setIdDocuments(prev => [...prev, { id, patientId, status: "Active", uploadedBy: "Front Desk User", uploadedAt: nowIso(), ...doc }]);
    addAudit(patientId, "ID uploaded", "document", id, null, `${doc.idType} ${doc.idNumber || ""}`.trim());
  }

  // ----- Clinical charting -----
  function addVital(patientId, entry) {
    const id = uid("VIT");
    setVitals(prev => [...prev, { id, patientId, recordedBy: "Dr. S. Reyes", ...entry }]);
    addAudit(patientId, "Vitals recorded", "vital", id, null, `BP ${entry.bp}, HR ${entry.pulse}, Wt ${entry.weight}`);
  }

  function addAllergy(patientId, entry) {
    const id = uid("ALG");
    setAllergies(prev => [...prev, { id, patientId, status: "Active", recordedBy: "Dr. S. Reyes", ...entry }]);
    addAudit(patientId, "Allergy recorded", "allergy", id, null, `${entry.substance} (${entry.severity})`);
  }

  function updateAllergyStatus(id, patientId, status) {
    setAllergies(prev => prev.map(a => a.id === id ? { ...a, status } : a));
    addAudit(patientId, "Allergy updated", "allergy", id, "Active", status);
  }

  function addMedication(patientId, entry) {
    const id = uid("MED");
    setMedications(prev => [...prev, { id, patientId, status: "Active", ...entry }]);
    addAudit(patientId, "Medication added", "medication", id, null, `${entry.name} ${entry.dose}, ${entry.frequency}`);
  }

  function updateMedicationStatus(id, patientId, status) {
    const med = medications.find(m => m.id === id);
    setMedications(prev => prev.map(m => m.id === id ? { ...m, status, endDate: status === "Active" ? m.endDate : (m.endDate || TODAY) } : m));
    addAudit(patientId, "Medication updated", "medication", id, med?.status, status);
  }

  function addProblem(patientId, entry) {
    const id = uid("PRB");
    setProblems(prev => [...prev, { id, patientId, status: "Active", ...entry }]);
    addAudit(patientId, "Problem added", "problem", id, null, `${entry.diagnosis} (${entry.icd10})`);
  }

  function updateProblemStatus(id, patientId, status) {
    setProblems(prev => prev.map(p => p.id === id ? { ...p, status } : p));
    addAudit(patientId, "Problem updated", "problem", id, "Active", status);
  }

  function addClinicalNote(patientId, entry) {
    const id = uid("NOTE");
    setClinicalNotes(prev => [...prev, { id, patientId, status: "Draft", amendments: [], ...entry }]);
    addAudit(patientId, "Note created", "note", id, null, `${entry.type}, draft`);
  }

  function signNote(id, patientId, provider) {
    setClinicalNotes(prev => prev.map(n => n.id === id ? { ...n, status: "Signed", signedBy: provider, signedAt: nowIso() } : n));
    addAudit(patientId, "Note signed", "note", id, "Draft", `Signed by ${provider}`);
  }

  // Signed notes are never edited in place — an amendment is appended and the original stays intact.
  function amendNote(id, patientId, text, provider) {
    setClinicalNotes(prev => prev.map(n => n.id === id ? { ...n, status: "Amended", amendments: [...n.amendments, { text, by: provider, at: nowIso() }] } : n));
    addAudit(patientId, "Note amended", "note", id, null, text);
  }

  function addAppointment(a) {
    setAppointments(prev => [...prev, { ...a, id: uid("A"), status: "Scheduled" }]);
    setShowAddAppt(false);
  }

  function addCharge(patientId, entry) {
    const id = uid("C");
    setCharges(prev => [...prev, { id, patientId, paid: 0, writeoff: 0, memos: [], ...entry }]);
    setTransactions(prev => [...prev, { id: uid("TXN"), chargeId: id, patientId, type: "charge", amount: entry.charge, date: entry.dos, source: "", reference: "" }]);
  }

  function recordPayment(chargeId, amount, meta = {}) {
    const target = charges.find(c => c.id === chargeId);
    if (!target) return;
    const room = Math.max(0, target.charge - target.paid - target.writeoff);
    const applied = Math.min(room, amount);
    setCharges(prev => prev.map(c => c.id === chargeId ? { ...c, paid: c.paid + applied } : c));
    if (applied > 0) {
      setTransactions(prev => [...prev, { id: uid("TXN"), chargeId, patientId: target.patientId, type: "payment", amount: applied, date: meta.date || TODAY, source: meta.source || "Manual", reference: meta.reference || "" }]);
    }
  }

  function writeOff(chargeId, amount, meta = {}) {
    const target = charges.find(c => c.id === chargeId);
    if (!target) return;
    const room = Math.max(0, target.charge - target.paid - target.writeoff);
    const applied = Math.min(room, amount);
    setCharges(prev => prev.map(c => c.id === chargeId ? { ...c, writeoff: c.writeoff + applied } : c));
    if (applied > 0) {
      setTransactions(prev => [...prev, { id: uid("TXN"), chargeId, patientId: target.patientId, type: "writeoff", amount: applied, date: meta.date || TODAY, source: meta.source || "Manual write-off", reference: meta.reference || "" }]);
    }
  }

  function creditAndRecode(chargeId, newCode) {
    const cpt = cptCatalog.find(c => c.code === newCode);
    if (!cpt) return;
    setCharges(prev => prev.map(c => c.id === chargeId ? { ...c, cpt: cpt.code, desc: cpt.desc, charge: cpt.charge } : c));
  }

  function addMemo(chargeId, text) {
    setCharges(prev => prev.map(c => c.id === chargeId ? { ...c, memos: [...c.memos, { date: "2026-08-24", text }] } : c));
  }

  function generateClaimFromCharge(charge) {
    if (claims.some(c => c.chargeId === charge.id)) return;
    const primary = primaryPolicyByPatient[charge.patientId];
    const newClaim = {
      id: uid("CLM-7"), patientId: charge.patientId, chargeId: charge.id,
      payer: primary ? primary.insuranceCompany : "Self-pay", cpt: charge.cpt, dx: "", amount: charge.charge, submitted: "", status: "Draft",
    };
    setClaims(prev => [...prev, newClaim]);
    setTab("claims");
  }

  function submitClaim(id) {
    setClaims(prev => prev.map(c => c.id === id ? { ...c, status: "Submitted", submitted: "2026-08-24" } : c));
  }

  function openBillingFor(patientId) {
    setBillingPatientId(patientId);
    setTab("billing");
  }

  // Manual payment posting: apply a batch of {chargeId, payment, writeoff} rows at once.
  function postManualBatch(rows, meta = {}) {
    setCharges(prev => prev.map(c => {
      const row = rows.find(r => r.chargeId === c.id);
      if (!row) return c;
      const room = Math.max(0, c.charge - c.paid - c.writeoff);
      const paidApplied = Math.min(room, row.payment || 0);
      const writeoffApplied = Math.min(room - paidApplied, row.writeoff || 0);
      return { ...c, paid: c.paid + paidApplied, writeoff: c.writeoff + writeoffApplied };
    }));
    setClaims(prev => prev.map(cl => {
      const row = rows.find(r => r.chargeId === cl.chargeId);
      if (!row) return cl;
      return cl.status === "Draft" ? cl : { ...cl, status: "Paid" };
    }));
    const newTxns = [];
    rows.forEach(row => {
      const target = charges.find(c => c.id === row.chargeId);
      if (!target) return;
      const room = Math.max(0, target.charge - target.paid - target.writeoff);
      const paidApplied = Math.min(room, row.payment || 0);
      const writeoffApplied = Math.min(room - paidApplied, row.writeoff || 0);
      if (paidApplied > 0) newTxns.push({ id: uid("TXN"), chargeId: row.chargeId, patientId: target.patientId, type: "payment", amount: paidApplied, date: meta.date || TODAY, source: meta.payer || "Manual", reference: meta.reference || "" });
      if (writeoffApplied > 0) newTxns.push({ id: uid("TXN"), chargeId: row.chargeId, patientId: target.patientId, type: "writeoff", amount: writeoffApplied, date: meta.date || TODAY, source: meta.payer || "Manual write-off", reference: meta.reference || "" });
    });
    if (newTxns.length) setTransactions(prev => [...prev, ...newTxns]);
  }

  // Electronic remittance (835) posting: apply parsed, matched claim rows in one batch.
  function postERABatch(matchedRows, meta = {}) {
    setCharges(prev => prev.map(c => {
      const row = matchedRows.find(r => r.chargeId === c.id);
      if (!row) return c;
      const room = Math.max(0, c.charge - c.paid - c.writeoff);
      const paidApplied = Math.min(room, row.paid || 0);
      const writeoffApplied = Math.min(room - paidApplied, row.writeoff || 0);
      return { ...c, paid: c.paid + paidApplied, writeoff: c.writeoff + writeoffApplied };
    }));
    setClaims(prev => prev.map(cl => {
      const row = matchedRows.find(r => r.claimId === cl.id);
      if (!row) return cl;
      return { ...cl, status: row.statusLabel === "Denied" ? "Denied" : "Paid" };
    }));
    const newTxns = [];
    matchedRows.forEach(row => {
      const target = charges.find(c => c.id === row.chargeId);
      if (!target) return;
      const room = Math.max(0, target.charge - target.paid - target.writeoff);
      const paidApplied = Math.min(room, row.paid || 0);
      const writeoffApplied = Math.min(room - paidApplied, row.writeoff || 0);
      if (paidApplied > 0) newTxns.push({ id: uid("TXN"), chargeId: row.chargeId, patientId: target.patientId, type: "payment", amount: paidApplied, date: TODAY, source: meta.source || "Payer ERA", reference: meta.reference || "" });
      if (writeoffApplied > 0) newTxns.push({ id: uid("TXN"), chargeId: row.chargeId, patientId: target.patientId, type: "writeoff", amount: writeoffApplied, date: TODAY, source: "Contractual adjustment", reference: meta.reference || "" });
    });
    if (newTxns.length) setTransactions(prev => [...prev, ...newTxns]);
  }

  return (
    <div className="flex flex-col h-full min-h-[700px] bg-slate-50 text-slate-800 font-sans text-sm">
      <header className="bg-slate-900 text-slate-300 shrink-0">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-teal-500 flex items-center justify-center text-white">
              <Stethoscope size={18} />
            </div>
            <div>
              <div className="text-white font-semibold text-sm leading-tight">Jobaid Clinic</div>
              <div className="text-xs text-slate-500">Practice manager</div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden md:flex items-center gap-2 text-xs text-slate-500">
              <Settings size={14} /> 
            </span>
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
            onStatusChange={(id, status) => setAppointments(prev => prev.map(a => a.id === id ? { ...a, status } : a))}
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

        {tabAllowed && tab === "clinical" && clinicalPatientId && (
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
                onPostManual={postManualBatch}
                onPostERA={postERABatch}
              />
            )}
          </div>
        )}

        {tabAllowed && tab === "billing" && billingPatientId && (
          <PatientBilling
            patient={patientById[billingPatientId]}
            charges={charges.filter(c => c.patientId === billingPatientId)}
            claims={claims.filter(c => c.patientId === billingPatientId)}
            policies={policies.filter(p => p.patientId === billingPatientId)}
            idDocuments={idDocuments.filter(d => d.patientId === billingPatientId)}
            auditLogs={auditLogs.filter(a => a.patientId === billingPatientId)}
            onBack={() => setBillingPatientId(null)}
            onUpdatePatient={(updates) => updatePatient(billingPatientId, updates)}
            onAddCharge={(entry) => addCharge(billingPatientId, entry)}
            onRecordPayment={recordPayment}
            onWriteOff={writeOff}
            onRecode={creditAndRecode}
            onAddMemo={addMemo}
            onGenerateClaim={generateClaimFromCharge}
            onAddInsurance={(f) => addInsurance(billingPatientId, f)}
            onEditInsurance={editInsurance}
            onSetPriority={setPolicyPriority}
            onEndCoverage={endCoverage}
            onUploadCard={uploadInsuranceCard}
            onUploadIdDoc={(doc) => uploadIdDocument(billingPatientId, doc)}
          />
        )}

        {tabAllowed && tab === "claims" && (
          <Claims claims={claims} patientById={patientById} onSubmit={submitClaim} />
        )}

        {tabAllowed && tab === "reports" && (
          <Reports
            revenueByMonth={revenueByMonth} claimStatusData={claimStatusData} charges={charges} patientById={patientById}
            transactions={transactions} patients={patients} policies={policies}
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
          <p className="text-slate-500 text-sm">Monday, August 24, 2026</p>
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
          <h3 className="text-sm font-medium text-slate-500 mb-2">{new Date(date + "T00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</h3>
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

function Patients({ patients, patientBalance, primaryPolicyByPatient, onAdd, onSelect }) {
  const [search, setSearch] = useState("");
  const filtered = patients.filter(p => p.name.toLowerCase().includes(search.toLowerCase()) || p.id.toLowerCase().includes(search.toLowerCase()));
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
          </tbody>
        </table>
      </Card>
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
                  <td className="px-4 py-2.5 text-slate-600">{p.dob}</td>
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

function PaymentPosting({ charges, claims, patients, patientById, chargeById, onPostManual, onPostERA }) {
  const [mode, setMode] = useState("manual");
  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-800 mb-1">Post payments</h1>
      <p className="text-slate-500 text-sm mb-4">Post insurance and patient payments manually, or import an electronic remittance (835) file.</p>

      <div className="flex items-center gap-1 mb-5 border border-slate-200 bg-white rounded-lg p-1 w-fit">
        <button onClick={() => setMode("manual")} className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${mode === "manual" ? "bg-teal-600 text-white" : "text-slate-500 hover:bg-slate-50"}`}>
          <Landmark size={14} /> Manual post
        </button>
        <button onClick={() => setMode("electronic")} className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${mode === "electronic" ? "bg-teal-600 text-white" : "text-slate-500 hover:bg-slate-50"}`}>
          <FileCheck2 size={14} /> Electronic remittance (835)
        </button>
      </div>

      {mode === "manual" && <ManualPosting charges={charges} patientById={patientById} onPostManual={onPostManual} />}
      {mode === "electronic" && <ElectronicRemittance charges={charges} claims={claims} patientById={patientById} chargeById={chargeById} onPostERA={onPostERA} />}
    </div>
  );
}

function ManualPosting({ charges, patientById, onPostManual }) {
  const openCharges = charges.filter(c => balanceOf(c) > 0);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState({}); // chargeId -> { payment, writeoff }
  const [payer, setPayer] = useState("");
  const [reference, setReference] = useState("");
  const [postDate, setPostDate] = useState(TODAY);
  const [postedMsg, setPostedMsg] = useState("");

  const filtered = openCharges.filter(c => {
    const name = patientById[c.patientId]?.name?.toLowerCase() || "";
    return name.includes(search.toLowerCase()) || c.id.toLowerCase().includes(search.toLowerCase());
  });

  function setRow(chargeId, field, value) {
    setRows(prev => ({ ...prev, [chargeId]: { ...prev[chargeId], [field]: Number(value) || 0 } }));
  }

  const batchTotal = Object.values(rows).reduce((s, r) => s + (r.payment || 0), 0);
  const linesToPost = Object.entries(rows).filter(([, r]) => (r.payment || 0) > 0 || (r.writeoff || 0) > 0);

  function postBatch() {
    if (linesToPost.length === 0) return;
    onPostManual(
      linesToPost.map(([chargeId, r]) => ({ chargeId, payment: r.payment || 0, writeoff: r.writeoff || 0 })),
      { payer: payer || "Manual", reference, date: postDate }
    );
    setPostedMsg(`Posted ${linesToPost.length} line${linesToPost.length > 1 ? "s" : ""} totaling ${money(batchTotal)}.`);
    setRows({});
  }

  return (
    <div>
      <Card className="p-4 mb-4">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Payment source">
            <select className={inputCls} value={payer} onChange={(e) => setPayer(e.target.value)}>
              <option value="">Select…</option>
              <option>Patient payment</option><option>Aetna</option><option>UnitedHealthcare</option><option>Cigna</option><option>Medicare</option>
            </select>
          </Field>
          <Field label="Check / EFT / reference #"><input className={inputCls} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. 4471029" /></Field>
          <Field label="Post date"><input type="date" className={inputCls} value={postDate} onChange={(e) => setPostDate(e.target.value)} /></Field>
        </div>
      </Card>

      <div className="relative mb-3 max-w-sm">
        <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter open charges by patient or charge ID" className={`${inputCls} pl-9`} />
      </div>

      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5 font-medium">Patient</th>
              <th className="px-4 py-2.5 font-medium">DOS / CPT</th>
              <th className="px-4 py-2.5 font-medium text-right">Balance</th>
              <th className="px-4 py-2.5 font-medium text-right">Payment</th>
              <th className="px-4 py-2.5 font-medium text-right">Write-off</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(c => {
              const bal = balanceOf(c);
              const row = rows[c.id] || {};
              return (
                <tr key={c.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2.5 text-slate-700">{patientById[c.patientId]?.name}</td>
                  <td className="px-4 py-2.5 text-slate-500 text-xs">{c.dos} · {c.cpt}</td>
                  <td className="px-4 py-2.5 text-right font-medium text-rose-600">{money(bal)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <input type="number" min="0" step="0.01" className="w-24 border border-slate-300 rounded-lg px-2 py-1 text-sm text-right" value={row.payment || ""} onChange={(e) => setRow(c.id, "payment", e.target.value)} />
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <input type="number" min="0" step="0.01" className="w-24 border border-slate-300 rounded-lg px-2 py-1 text-sm text-right" value={row.writeoff || ""} onChange={(e) => setRow(c.id, "writeoff", e.target.value)} />
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">No open balances match this filter.</td></tr>}
          </tbody>
        </table>
      </Card>

      <div className="flex items-center justify-between mt-4">
        <div className="text-sm text-slate-600">Batch payment total: <span className="font-semibold text-slate-800">{money(batchTotal)}</span></div>
        <button onClick={postBatch} disabled={linesToPost.length === 0} className="flex items-center gap-1.5 bg-teal-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed">
          <CreditCard size={15} /> Post batch
        </button>
      </div>
      {postedMsg && <p className="text-emerald-600 text-sm mt-2">{postedMsg}</p>}
    </div>
  );
}

function ElectronicRemittance({ claims, patientById, chargeById, onPostERA }) {
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
            <button onClick={postAllMatched} disabled={matchedCount === 0} className="flex items-center gap-1.5 bg-teal-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap">
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

function PatientBilling({ patient, charges, claims, policies, idDocuments, auditLogs, onBack, onUpdatePatient, onAddCharge, onRecordPayment, onWriteOff, onRecode, onAddMemo, onGenerateClaim, onAddInsurance, onEditInsurance, onSetPriority, onEndCoverage, onUploadCard, onUploadIdDoc }) {
  const [pageTab, setPageTab] = useState("ledger");
  const [editingDemo, setEditingDemo] = useState(false);
  const [demoForm, setDemoForm] = useState(patient);
  const [showAddCharge, setShowAddCharge] = useState(false);
  const [manageChargeId, setManageChargeId] = useState(null);

  const totalBalance = charges.reduce((s, c) => s + Math.max(0, balanceOf(c)), 0);
  const hasClaim = (chargeId) => claims.some(cl => cl.chargeId === chargeId);
  const manageCharge = charges.find(c => c.id === manageChargeId);
  const activePolicies = policies.filter(p => p.status === "Active").sort((a, b) => a.priority.localeCompare(b.priority));

  function saveDemo() { onUpdatePatient(demoForm); setEditingDemo(false); }

  const pageTabs = [
    { id: "ledger", label: "Ledger & demographics", icon: Receipt },
    { id: "insurance", label: "Insurance", icon: Shield },
    { id: "documents", label: "ID Documents", icon: IdCard },
    { id: "audit", label: "Audit History", icon: History },
  ];

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4">
        <ChevronLeft size={15} /> Back to billing search
      </button>

      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">{patient.name}</h1>
          <p className="text-xs text-slate-500">{patient.id} · DOB {patient.dob}</p>
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
        </div>
      </div>

      <div className="flex items-center gap-1 mb-5 border border-slate-200 bg-white rounded-lg p-1 w-fit">
        {pageTabs.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setPageTab(t.id)} className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${pageTab === t.id ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}>
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {pageTab === "ledger" && (
        <div>
          <Card className="p-4 mb-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-medium text-slate-700">Demographics</h3>
              {!editingDemo ? (
                <button onClick={() => { setDemoForm(patient); setEditingDemo(true); }} className="text-xs text-teal-700 flex items-center gap-1"><Pencil size={12} /> Edit</button>
              ) : (
                <div className="flex gap-2">
                  <button onClick={saveDemo} className="text-xs text-teal-700 font-medium">Save</button>
                  <button onClick={() => setEditingDemo(false)} className="text-xs text-slate-400">Cancel</button>
                </div>
              )}
            </div>
            {!editingDemo ? (
              <div className="grid grid-cols-4 gap-y-3 text-sm">
                <div><span className="text-slate-400 text-xs block">Name</span>{patient.name}</div>
                <div><span className="text-slate-400 text-xs block">DOB</span>{patient.dob}</div>
                <div><span className="text-slate-400 text-xs block">Phone</span>{patient.phone}</div>
                <div><span className="text-slate-400 text-xs block">Email</span>{patient.email}</div>
                <div><span className="text-slate-400 text-xs block">SSN</span>{maskSSN(patient.ssn)}</div>
                <div><span className="text-slate-400 text-xs block">Address</span>{patient.address}, {patient.city}, {patient.state} {patient.zip}</div>
                <div><span className="text-slate-400 text-xs block">Emergency contact</span>{patient.emergencyContact?.name} ({patient.emergencyContact?.relationship}) {patient.emergencyContact?.phone}</div>
                <div><span className="text-slate-400 text-xs block">Guarantor</span>{patient.guarantor?.name} · {patient.guarantor?.employer}</div>
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-3">
                <Field label="Name"><input className={inputCls} value={demoForm.name} onChange={(e) => setDemoForm({ ...demoForm, name: e.target.value })} /></Field>
                <Field label="DOB"><input type="date" className={inputCls} value={demoForm.dob} onChange={(e) => setDemoForm({ ...demoForm, dob: e.target.value })} /></Field>
                <Field label="Phone"><input className={inputCls} value={demoForm.phone} onChange={(e) => setDemoForm({ ...demoForm, phone: e.target.value })} /></Field>
                <Field label="Email"><input className={inputCls} value={demoForm.email} onChange={(e) => setDemoForm({ ...demoForm, email: e.target.value })} /></Field>
                <Field label="SSN"><input className={inputCls} value={demoForm.ssn || ""} onChange={(e) => setDemoForm({ ...demoForm, ssn: e.target.value })} /></Field>
                <Field label="Address"><input className={inputCls} value={demoForm.address || ""} onChange={(e) => setDemoForm({ ...demoForm, address: e.target.value })} /></Field>
                <Field label="City"><input className={inputCls} value={demoForm.city || ""} onChange={(e) => setDemoForm({ ...demoForm, city: e.target.value })} /></Field>
                <Field label="State"><input className={inputCls} value={demoForm.state || ""} onChange={(e) => setDemoForm({ ...demoForm, state: e.target.value })} /></Field>
              </div>
            )}
          </Card>

          <div className="flex items-center justify-between mb-3">
            <h3 className="font-medium text-slate-700">Charge ledger</h3>
            <button onClick={() => setShowAddCharge(true)} className="flex items-center gap-1.5 bg-teal-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-teal-700">
              <Plus size={13} /> Add charge
            </button>
          </div>

          <Card>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="px-4 py-2.5 font-medium">DOS</th>
                  <th className="px-4 py-2.5 font-medium">CPT</th>
                  <th className="px-4 py-2.5 font-medium">Description</th>
                  <th className="px-4 py-2.5 font-medium text-right">Charge</th>
                  <th className="px-4 py-2.5 font-medium text-right">Paid</th>
                  <th className="px-4 py-2.5 font-medium text-right">Write-off</th>
                  <th className="px-4 py-2.5 font-medium text-right">Balance</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Memo</th>
                  <th className="px-4 py-2.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {charges.sort((a, b) => b.dos.localeCompare(a.dos)).map(c => {
                  const bal = balanceOf(c);
                  const lastMemo = c.memos[c.memos.length - 1];
                  return (
                    <tr key={c.id} className="border-b border-slate-100 last:border-0 align-top">
                      <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">{c.dos}</td>
                      <td className="px-4 py-2.5 font-medium text-slate-800">{c.cpt}</td>
                      <td className="px-4 py-2.5 text-slate-600 max-w-[160px]">{c.desc}</td>
                      <td className="px-4 py-2.5 text-right">{money(c.charge)}</td>
                      <td className="px-4 py-2.5 text-right text-emerald-700">{money(c.paid)}</td>
                      <td className="px-4 py-2.5 text-right text-slate-500">{money(c.writeoff)}</td>
                      <td className={`px-4 py-2.5 text-right font-medium ${bal > 0 ? "text-rose-600" : "text-slate-700"}`}>{money(bal)}</td>
                      <td className="px-4 py-2.5"><StatusPill status={chargeStatus(c)} /></td>
                      <td className="px-4 py-2.5 text-xs text-slate-500 max-w-[140px]">{lastMemo ? lastMemo.text : "—"}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-col gap-1">
                          <button onClick={() => setManageChargeId(c.id)} className="text-xs text-teal-700 border border-teal-200 bg-teal-50 rounded-lg px-2 py-1 hover:bg-teal-100 text-left">Manage</button>
                          {!hasClaim(c.id) && (
                            <button onClick={() => onGenerateClaim(c)} className="text-xs text-sky-700 border border-sky-200 bg-sky-50 rounded-lg px-2 py-1 hover:bg-sky-100 text-left">Generate claim</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {charges.length === 0 && (
                  <tr><td colSpan={10} className="px-4 py-6 text-center text-slate-400">No charges on file yet.</td></tr>
                )}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {pageTab === "insurance" && (
        <PatientInsuranceTab
          policies={policies}
          onAdd={onAddInsurance} onEdit={onEditInsurance} onSetPriority={onSetPriority}
          onEndCoverage={onEndCoverage} onUploadCard={onUploadCard}
        />
      )}

      {pageTab === "documents" && (
        <PatientIdDocuments documents={idDocuments} onUpload={onUploadIdDoc} />
      )}

      {pageTab === "audit" && <AuditHistory auditLogs={auditLogs} />}

      {showAddCharge && (
        <Modal title="Add charge" onClose={() => setShowAddCharge(false)}>
          <AddChargeForm onSubmit={(entry) => { onAddCharge(entry); setShowAddCharge(false); }} />
        </Modal>
      )}

      {manageCharge && (
        <Modal title={`Manage charge · ${manageCharge.cpt} on ${manageCharge.dos}`} onClose={() => setManageChargeId(null)}>
          <ManageChargeForm
            charge={manageCharge}
            onRecordPayment={(amt) => onRecordPayment(manageCharge.id, amt)}
            onWriteOff={(amt) => onWriteOff(manageCharge.id, amt)}
            onRecode={(code) => onRecode(manageCharge.id, code)}
            onAddMemo={(text) => onAddMemo(manageCharge.id, text)}
            onClose={() => setManageChargeId(null)}
          />
        </Modal>
      )}
    </div>
  );
}

// ---------- Patient billing: Insurance tab (versioned history) ----------

function PatientInsuranceTab({ policies, onAdd, onEdit, onSetPriority, onEndCoverage, onUploadCard }) {
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
                  <div className="text-xs text-slate-400 mt-1">Eff. {pol.effectiveDate}</div>
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
                <td className="px-4 py-2.5 text-slate-600">{pol.effectiveDate}</td>
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
          <InsuranceForm onSubmit={(f) => { onAdd(f); setShowAdd(false); }} onUploadCard={null} />
        </Modal>
      )}
      {editPolicy && (
        <Modal title={`Edit insurance · ${editPolicy.insuranceCompany}`} onClose={() => setEditPolicy(null)} wide>
          <InsuranceForm
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
                <div className="text-slate-400 mt-1">{h.changedBy} · {h.changedAt.slice(0, 16).replace("T", " ")}</div>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function InsuranceForm({ initial, onSubmit, onUploadCard, isEdit }) {
  const [form, setForm] = useState(initial || {
    insuranceCompany: "", planName: "", insuranceType: insuranceTypes[0], memberId: "", subscriberId: "",
    groupNumber: "", payerId: "", effectiveDate: TODAY, terminationDate: "", priority: "Primary",
    subscriberName: "", subscriberDob: "", subscriberRelationship: "Self",
    copay: "", deductible: "", coinsurance: "", authRequired: false, referralRequired: false, notes: "",
    cardFront: initial?.cardFront || null, cardBack: initial?.cardBack || null,
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setBool = (k) => (e) => setForm({ ...form, [k]: e.target.checked });
  const [error, setError] = useState("");

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
        <Field label="Insurance company"><input className={inputCls} value={form.insuranceCompany} onChange={set("insuranceCompany")} /></Field>
        <Field label="Plan name"><input className={inputCls} value={form.planName} onChange={set("planName")} /></Field>
        <Field label="Insurance type">
          <select className={inputCls} value={form.insuranceType} onChange={set("insuranceType")}>{insuranceTypes.map(t => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="Payer ID"><input className={inputCls} value={form.payerId} onChange={set("payerId")} /></Field>
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

function PatientIdDocuments({ documents, onUpload }) {
  const [showAdd, setShowAdd] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-slate-700">ID documents</h3>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 bg-teal-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-teal-700"><Upload size={13} /> Upload ID</button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {documents.map(d => (
          <Card key={d.id} className="p-3 flex items-center gap-3">
            {d.file ? <img src={d.file} className="w-14 h-14 object-cover rounded-md border border-slate-200" /> : <div className="w-14 h-14 rounded-md bg-slate-100 flex items-center justify-center"><FileText size={18} className="text-slate-400" /></div>}
            <div className="flex-1">
              <div className="text-sm font-medium text-slate-800">{d.idType}</div>
              <div className="text-xs text-slate-500">#{d.idNumber} · exp {d.expirationDate || "—"}</div>
              <div className="text-xs text-slate-400">Uploaded {d.uploadedAt?.slice(0, 10)} by {d.uploadedBy}</div>
            </div>
            <StatusPill status={d.status} />
          </Card>
        ))}
        {documents.length === 0 && <p className="text-sm text-slate-400 col-span-2">No ID documents on file.</p>}
      </div>
      {showAdd && (
        <Modal title="Upload ID document" onClose={() => setShowAdd(false)}>
          <IdDocForm onSubmit={(doc) => { onUpload(doc); setShowAdd(false); }} />
        </Modal>
      )}
    </div>
  );
}

function IdDocForm({ onSubmit }) {
  const [form, setForm] = useState({ idType: idTypes[0], idNumber: "", issuingState: "NY", issueDate: "", expirationDate: "", file: null });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const [error, setError] = useState("");
  function submit() {
    if (!form.file) { setError("Upload or scan an image of the ID first."); return; }
    setError(""); onSubmit(form);
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
      <FileDrop label="ID image" value={form.file} onChange={(dataUrl) => setForm({ ...form, file: dataUrl })} />
      <p className="text-xs text-slate-400 mb-3">OCR isn't wired up in this prototype — enter fields manually and confirm before saving.</p>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Save document</button>
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
              <td className="px-4 py-2.5 text-slate-500 text-xs whitespace-nowrap">{a.timestamp.slice(0, 16).replace("T", " ")}</td>
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
            {cptCatalog.map(c => <option key={c.code} value={c.code}>{c.code} — {c.desc} ({money(c.charge)})</option>)}
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
                <span className="text-slate-400">{m.date}</span> — {m.text}
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
  const [dos, setDos] = useState("2026-08-24");
  const [cpt, setCpt] = useState(cptCatalog[0].code);
  const [provider, setProvider] = useState(providers[0]);
  const [error, setError] = useState("");

  function submit() {
    if (!dos) { setError("Date of service is required."); return; }
    const entry = cptCatalog.find(c => c.code === cpt);
    setError("");
    onSubmit({ dos, provider, cpt: entry.code, desc: entry.desc, charge: entry.charge });
  }

  return (
    <div>
      <Field label="Date of service"><input type="date" className={inputCls} value={dos} onChange={(e) => setDos(e.target.value)} /></Field>
      <Field label="Provider">
        <select className={inputCls} value={provider} onChange={(e) => setProvider(e.target.value)}>{providers.map(p => <option key={p}>{p}</option>)}</select>
      </Field>
      <Field label="CPT code">
        <select className={inputCls} value={cpt} onChange={(e) => setCpt(e.target.value)}>
          {cptCatalog.map(c => <option key={c.code} value={c.code}>{c.code} — {c.desc} ({money(c.charge)})</option>)}
        </select>
      </Field>
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

function Reports({ revenueByMonth, claimStatusData, charges, patientById, transactions, patients, policies }) {
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
        <ReportCenter charges={charges} patientById={patientById} transactions={transactions} patients={patients} policies={policies} />
      )}
    </div>
  );
}

// ---------- Report center: aging / debit / credit, with CSV / PDF export ----------

function ReportCenter({ charges, patientById, transactions, patients, policies }) {
  const [reportType, setReportType] = useState("aging");
  const [groupBy, setGroupBy] = useState("physician");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  // ----- Aging report -----
  const openCharges = charges.filter(c => balanceOf(c) > 0);

  const agingDetailRows = useMemo(() => {
    if (reportType !== "aging") return [];
    const base = groupBy === "self"
      ? openCharges.filter(c => !currentPrimaryPolicy(c.patientId, policies))
      : openCharges;

    return base.map(c => {
      const p = patientById[c.patientId] || {};
      const primary = currentPrimaryPolicy(c.patientId, policies);
      const lastMemo = c.memos && c.memos.length ? c.memos[c.memos.length - 1] : null;
      const days = daysBetween(c.dos, TODAY);
      return {
        Group: groupBy === "physician" ? c.provider : groupBy === "insurance" ? (primary ? primary.insuranceCompany : "Self-pay") : "Self-pay",
        Patient: p.name || "", Account: p.id || "", DOB: p.dob || "", Phone: p.phone || "",
        SSN: maskSSN(p.ssn), "Insurance name": primary ? primary.insuranceCompany : "Self-pay", "Insurance ID": primary ? primary.memberId : "",
        CPT: c.cpt, DOS: c.dos, Bucket: agingBucket(days), Balance: balanceOf(c),
        Memo: lastMemo ? `${lastMemo.date} — ${lastMemo.text}` : "",
      };
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
      .filter(t => t.type === "charge")
      .filter(t => (!fromDate || t.date >= fromDate) && (!toDate || t.date <= toDate))
      .map(t => {
        const charge = charges.find(c => c.id === t.chargeId);
        return {
          Date: t.date, Patient: patientById[t.patientId]?.name || "", Physician: charge?.provider || "",
          CPT: charge?.cpt || "", Description: charge?.desc || "", Amount: t.amount,
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
          Date: t.date, Patient: patientById[t.patientId]?.name || "", Physician: charge?.provider || "",
          Type: t.type === "payment" ? "Payment" : "Write-off", Source: t.source || "", Reference: t.reference || "", Amount: t.amount,
        };
      })
      .sort((a, b) => b.Date.localeCompare(a.Date));
  }, [reportType, transactions, charges, patientById, fromDate, toDate]);

  const reportTitle = {
    aging: `Aging report — by ${groupBy === "physician" ? "physician" : groupBy === "insurance" ? "insurance type" : "self-pay"}`,
    debit: "Debit report — charges posted",
    credit: "Credit report — payments & write-offs posted",
  }[reportType];

  const exportRows = reportType === "aging" ? agingDetailRows : reportType === "debit" ? debitRows : creditRows;
  const filenameBase = reportType === "aging" ? `aging-report-${groupBy}` : reportType === "debit" ? "debit-report" : "credit-report";

  const grandTotal = reportType === "aging"
    ? agingDetailRows.reduce((s, r) => s + r.Balance, 0)
    : exportRows.reduce((s, r) => s + (r.Amount || 0), 0);

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

      <div className="flex flex-wrap items-end gap-3 mb-4 print:hidden">
        <Field label="Report type">
          <select className={inputCls} value={reportType} onChange={(e) => setReportType(e.target.value)}>
            <option value="aging">Aging report</option>
            <option value="debit">Debit report (charges)</option>
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
          <button onClick={printReport} className="flex items-center gap-1.5 text-xs text-slate-600 border border-slate-200 rounded-lg px-3 py-2 hover:bg-slate-50">
            <Printer size={13} /> PDF
          </button>
        </div>
      </div>

      <div id="printable-report">
        <div className="hidden print:block mb-4">
          <h2 className="text-lg font-semibold">Harborview Clinic — {reportTitle}</h2>
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
                          <td className="py-2 pr-3 text-slate-500 text-xs max-w-[180px] whitespace-normal">{r.Memo || "—"}</td>
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
    </div>
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
                  <td className="px-4 py-2.5 text-slate-600">{p.dob}</td>
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
            <p className="text-xs text-slate-500">DOB {patient.dob} · {patient.id} · {patient.phone}</p>
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
                <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">{v.date}</td>
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
                <span className="text-xs text-slate-400 ml-2">{n.date} · {n.provider}</span>
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
                    <span className="font-medium">Amendment</span> — {a.text} <span className="text-amber-500">({a.by}, {a.at.slice(0, 16).replace("T", " ")})</span>
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
          <p className="text-xs text-slate-400 mb-3">Signed notes are never edited in place — this appends an amendment and keeps the original note intact.</p>
          <Field label="Amendment text"><textarea className={`${inputCls} h-24 resize-none`} value={amendText} onChange={(e) => setAmendText(e.target.value)} /></Field>
          <button onClick={submitAmend} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700">Save amendment</button>
        </Modal>
      )}
    </div>
  );
}

function NoteForm({ onSubmit }) {
  const [form, setForm] = useState({ type: noteTypes[0], date: TODAY, provider: "Dr. S. Reyes", subjective: "", objective: "", assessment: "", plan: "" });
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
          <select className={inputCls} value={form.provider} onChange={set("provider")}>{providers.map(p => <option key={p}>{p}</option>)}</select>
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

      <p className="text-xs text-slate-400 mb-3">Insurance isn't collected here — add it from the patient's Insurance tab after registration, so it's properly versioned and never overwritten.</p>
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
              <div className="text-xs text-slate-500">{d.id} · DOB {d.dob} · {d.phone}</div>
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
  const [form, setForm] = useState({ patientId: patients[0]?.id || "", date: "2026-08-24", time: "09:00", provider: providers[0], type: "Follow-up", cpt: cptCatalog[0].code });
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
        <select className={inputCls} value={form.provider} onChange={set("provider")}>{providers.map(p => <option key={p}>{p}</option>)}</select>
      </Field>
      <Field label="Visit type"><input className={inputCls} value={form.type} onChange={set("type")} /></Field>
      <Field label="Expected CPT code">
        <select className={inputCls} value={form.cpt} onChange={set("cpt")}>{cptCatalog.map(c => <option key={c.code} value={c.code}>{c.code} — {c.desc}</option>)}</select>
      </Field>
      {error && <p className="text-rose-600 text-xs mb-2">{error}</p>}
      <button onClick={submit} className="w-full bg-teal-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-teal-700 mt-2">Schedule appointment</button>
    </div>
  );
}