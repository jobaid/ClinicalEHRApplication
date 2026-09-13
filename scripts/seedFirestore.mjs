// Seeds Firestore (and Firebase Auth) with the same demo data the app used to ship as hardcoded
// arrays in src/app.jsx. By default this targets the Firebase Local Emulator Suite — no real
// project or credentials needed. Pass --prod to target a real project instead (reads
// GOOGLE_APPLICATION_CREDENTIALS + VITE_FIREBASE_PROJECT_ID from .env).
//
// Usage:
//   firebase emulators:start --only auth,firestore,storage   (in one terminal)
//   node scripts/seedFirestore.mjs                            (in another)
//   node scripts/seedFirestore.mjs --prod                     (against a real project)

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.argv.includes("--prod");

function loadDotEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}
const env = loadDotEnv();

if (isProd) {
  const projectId = env.VITE_FIREBASE_PROJECT_ID;
  const keyPath = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!projectId || !keyPath) {
    console.error("Missing VITE_FIREBASE_PROJECT_ID or GOOGLE_APPLICATION_CREDENTIALS in .env — see .env.example.");
    process.exit(1);
  }
  initializeApp({ credential: keyPath ? cert(path.resolve(process.cwd(), keyPath)) : applicationDefault(), projectId });
  console.log(`Seeding REAL project "${projectId}" — this writes real data.`);
} else {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
  initializeApp({ projectId: env.VITE_FIREBASE_PROJECT_ID || "demo-billing" });
  console.log("Seeding the Firebase Local Emulator Suite (no real project touched).");
}

const auth = getAuth();
const db = getFirestore();

async function setDoc(collection, id, data) {
  await db.collection(collection).doc(id).set(data);
}

function uid(prefix) {
  return `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;
}

const TODAY = "2026-08-24";
const providers = ["Dr. S. Reyes", "Dr. A. Okafor", "Dr. M. Lin"];
const PRACTICE_INFO = { name: "Jobaid Clinic", address: "400 Harbor Way, Bellerose, NY 11426", taxId: "13-5551234" };
const providerNPI = { "Dr. S. Reyes": "1912345678", "Dr. A. Okafor": "1923456789", "Dr. M. Lin": "1934567890" };
const emptyDx = () => Array(10).fill("");

// ---------- Demo users (Firebase Auth + users/{uid} Firestore profile) ----------
const demoUsers = [
  { email: "admin@medbill.local", password: "Admin@12345", name: "Obaidul", role: "SUPER_ADMIN" },
  { email: "manager@medbill.local", password: "Manager@12345", name: "Anowara", role: "MANAGER" },
  { email: "nurse@medbill.local", password: "Nurse@12345", name: "Dana Ruiz", role: "NURSE" },
  { email: "reception@medbill.local", password: "Reception@12345", name: "Leah Ford", role: "RECEPTIONIST" },
  { email: "biller@medbill.local", password: "Biller@12345", name: "Marcus Webb", role: "BILLER" },
];

async function seedUsers() {
  for (const u of demoUsers) {
    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(u.email);
    } catch {
      userRecord = await auth.createUser({ email: u.email, password: u.password, displayName: u.name });
    }
    await setDoc("users", userRecord.uid, { email: u.email, name: u.name, role: u.role });
    console.log(`  user  ${u.email}  (${u.role})  uid=${userRecord.uid}`);
  }
}

// ---------- Patients ----------
const patients = [
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

// ---------- Physician directory ----------
// Mirrors migrations/003_physicians.sql. Editable at runtime from Settings > Practice catalog,
// so this is a starting roster, not a fixed list.
const physicians = [
  { id: "PHY-1001", name: "Dr. S. Reyes", npi: "1912345678", specialty: "Internal Medicine", active: true },
  { id: "PHY-1002", name: "Dr. A. Okafor", npi: "1923456789", specialty: "Family Medicine", active: true },
  { id: "PHY-1003", name: "Dr. M. Lin", npi: "1934567890", specialty: "Cardiology", active: true },
];

// ---------- CPT catalog ----------
const cptCatalog = [
  { code: "99213", desc: "Office visit, established patient (low complexity)", charge: 110, category: "Office Visit" },
  { code: "99214", desc: "Office visit, established patient (moderate complexity)", charge: 165, category: "Office Visit" },
  { code: "99385", desc: "Preventive visit, new patient (18-39y)", charge: 190, category: "Preventive" },
  { code: "90471", desc: "Immunization administration", charge: 35, category: "Immunization" },
  { code: "80053", desc: "Comprehensive metabolic panel", charge: 48, category: "Laboratory" },
  { code: "93000", desc: "Electrocardiogram, complete", charge: 72, category: "Diagnostic" },
];

// ---------- Insurance policies ----------
const insurancePolicies = [
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

// ---------- Audit logs, memos ----------
const auditLogs = [
  { id: "AUD-1001", patientId: "P1001", user: "System (seed)", action: "Patient created", entityType: "patient", entityId: "P1001", oldValues: null, newValues: "Maria Alvarez registered", timestamp: "2025-01-01T09:00:00" },
  { id: "AUD-1002", patientId: "P1001", user: "System (seed)", action: "Insurance added", entityType: "insurance", entityId: "POL-1001", oldValues: null, newValues: "Aetna Choice POS II, Member AET-88213, Primary, effective 2025-01-01", timestamp: "2025-01-01T09:00:00" },
  { id: "AUD-1003", patientId: "P1001", user: "System (seed)", action: "Insurance terminated", entityType: "insurance", entityId: "POL-1001", oldValues: "Active", newValues: "Terminated 2025-12-31 (superseded by UnitedHealthcare)", timestamp: "2026-01-01T09:05:00" },
  { id: "AUD-1004", patientId: "P1001", user: "System (seed)", action: "Insurance added", entityType: "insurance", entityId: "POL-1002", oldValues: null, newValues: "UnitedHealthcare Choice Plus, Member UHC-40217, Primary, effective 2026-01-01", timestamp: "2026-01-01T09:05:00" },
];
const patientMemos = [
  { id: "PMEMO-1001", patientId: "P1004", text: "Patient requested itemized statement for tax purposes.", user: "Marcus Webb", date: "2026-08-12" },
];

// ---------- Clinical ----------
const vitals = [
  { id: "VIT-1001", patientId: "P1001", date: "2026-08-10", height: "165 cm", weight: "68 kg", bmi: "25.0", bp: "118/76", pulse: "72", resp: "16", temp: "98.4°F", spo2: "99%", pain: "0", recordedBy: "Dr. S. Reyes" },
  { id: "VIT-1002", patientId: "P1004", date: "2026-08-05", height: "178 cm", weight: "92 kg", bmi: "29.0", bp: "138/88", pulse: "80", resp: "18", temp: "98.6°F", spo2: "97%", pain: "2", recordedBy: "Dr. M. Lin" },
];
const allergies = [
  { id: "ALG-1001", patientId: "P1001", substance: "Penicillin", reaction: "Hives, difficulty breathing", severity: "Severe", status: "Active", notes: "Confirmed on prior admission.", recordedDate: "2025-02-10", recordedBy: "Dr. S. Reyes" },
  { id: "ALG-1002", patientId: "P1004", substance: "Sulfa drugs", reaction: "Rash", severity: "Moderate", status: "Active", notes: "", recordedDate: "2025-03-05", recordedBy: "Dr. M. Lin" },
];
const medications = [
  { id: "MED-1001", patientId: "P1001", name: "Lisinopril", dose: "10mg", route: "Oral", frequency: "Once daily", quantity: "30", refills: "3", startDate: "2026-01-05", endDate: "", status: "Active", prescriber: "Dr. S. Reyes", instructions: "Take in the morning with water." },
  { id: "MED-1002", patientId: "P1004", name: "Metformin", dose: "500mg", route: "Oral", frequency: "Twice daily", quantity: "60", refills: "5", startDate: "2025-03-10", endDate: "", status: "Active", prescriber: "Dr. M. Lin", instructions: "Take with meals." },
];
const problems = [
  { id: "PRB-1001", patientId: "P1001", diagnosis: "Essential hypertension", icd10: "I10", description: "Diagnosed 2026, well controlled on Lisinopril.", onsetDate: "2026-01-05", status: "Active", notes: "" },
  { id: "PRB-1002", patientId: "P1004", diagnosis: "Type 2 diabetes mellitus", icd10: "E11.9", description: "Diet and Metformin controlled.", onsetDate: "2025-03-10", status: "Active", notes: "Recheck A1c in 3 months." },
];
const clinicalNotes = [
  { id: "NOTE-1001", patientId: "P1001", type: "SOAP Note", date: "2026-08-10", provider: "Dr. S. Reyes",
    subjective: "Patient reports occasional mild headaches, otherwise feeling well.", objective: "BP 118/76, HR 72. No acute distress.",
    assessment: "Hypertension, well controlled.", plan: "Continue Lisinopril 10mg daily. Follow up in 3 months.",
    status: "Signed", signedBy: "Dr. S. Reyes", signedAt: "2026-08-10T11:20:00", amendments: [] },
];

// ---------- Appointments ----------
const appointments = [
  { id: "A1", patientId: "P1001", date: "2026-08-24", time: "09:00", provider: providers[0], type: "Follow-up", status: "Checked out", cpt: "99213" },
  { id: "A2", patientId: "P1002", date: "2026-08-24", time: "09:30", provider: providers[1], type: "Annual physical", status: "In progress", cpt: "99385" },
  { id: "A3", patientId: "P1003", date: "2026-08-24", time: "10:15", provider: providers[0], type: "New complaint", status: "Scheduled", cpt: "99214" },
  { id: "A4", patientId: "P1004", date: "2026-08-24", time: "11:00", provider: providers[2], type: "Lab review", status: "Scheduled", cpt: "80053" },
  { id: "A5", patientId: "P1005", date: "2026-08-25", time: "09:00", provider: providers[0], type: "Follow-up", status: "Scheduled", cpt: "99213" },
  { id: "A6", patientId: "P1006", date: "2026-08-25", time: "13:30", provider: providers[1], type: "Vaccination", status: "Scheduled", cpt: "90471" },
];

// ---------- Charges (the patient ledger) + claims ----------
const charges = [
  { id: "C5001", patientId: "P1001", dos: "2026-08-10", provider: providers[0], referralPhysician: "", cpt: "99213", desc: "Office visit, established patient (low complexity)", charge: 110, paid: 0, writeoff: 0, credits: 0, memos: [], postings: [], chargeInsuranceId: null, payerOverride: null, facilityName: PRACTICE_INFO.name, facilityAddress: PRACTICE_INFO.address, taxId: PRACTICE_INFO.taxId, npi: providerNPI[providers[0]], diagnosisCodes: ["M54.5", "", "", "", "", "", "", "", "", ""], ndc: "", units: 1, time: "" },
  { id: "C5002", patientId: "P1004", dos: "2026-08-05", provider: providers[2], referralPhysician: "Dr. K. Nunez", cpt: "99214", desc: "Office visit, established patient (moderate complexity)", charge: 165, paid: 0, writeoff: 0, credits: 0, memos: [{ date: "2026-08-06", text: "Claim denied for missing modifier. Follow up with Aetna.", user: "System (seed)", type: "Note", status: "Open", nextFollowUpDate: "2026-08-13" }], postings: [], chargeInsuranceId: null, payerOverride: null, facilityName: PRACTICE_INFO.name, facilityAddress: PRACTICE_INFO.address, taxId: PRACTICE_INFO.taxId, npi: providerNPI[providers[2]], diagnosisCodes: ["E11.9", "", "", "", "", "", "", "", "", ""], ndc: "", units: 1, time: "" },
  { id: "C5003", patientId: "P1004", dos: "2026-08-05", provider: providers[2], referralPhysician: "Dr. K. Nunez", cpt: "80053", desc: "Comprehensive metabolic panel", charge: 48, paid: 0, writeoff: 0, credits: 0, memos: [], postings: [], chargeInsuranceId: null, payerOverride: null, facilityName: PRACTICE_INFO.name, facilityAddress: PRACTICE_INFO.address, taxId: PRACTICE_INFO.taxId, npi: providerNPI[providers[2]], diagnosisCodes: ["E11.9", "", "", "", "", "", "", "", "", ""], ndc: "", units: 1, time: "" },
  { id: "C5004", patientId: "P1003", dos: "2026-08-15", provider: providers[0], referralPhysician: "", cpt: "99213", desc: "Office visit, established patient (low complexity)", charge: 110, paid: 65, writeoff: 0, credits: 0, memos: [], postings: [{ id: "PST-9001", field: "paid", type: "Patient Credit", amount: 65, debited: 0, date: "2026-08-15", method: "Credit Card", reference: "TXN-88213", notes: "", postedBy: "Front Desk User", postedAt: "2026-08-15T10:00:00" }], chargeInsuranceId: null, payerOverride: null, facilityName: PRACTICE_INFO.name, facilityAddress: PRACTICE_INFO.address, taxId: PRACTICE_INFO.taxId, npi: providerNPI[providers[0]], diagnosisCodes: ["J06.9", "", "", "", "", "", "", "", "", ""], ndc: "", units: 1, time: "" },
  { id: "C5005", patientId: "P1002", dos: "2026-08-01", provider: providers[1], referralPhysician: "", cpt: "99385", desc: "Preventive visit, new patient (18-39y)", charge: 190, paid: 190, writeoff: 0, credits: 0, memos: [], postings: [{ id: "PST-9002", field: "paid", type: "Insurance Credit", amount: 190, debited: 0, date: "2026-08-02", insuranceName: "UnitedHealthcare", checkNumber: "", depositDate: "2026-08-03", reference: "EFT00293841", copay: "0", coinsurance: "0", deductible: "0", allowedAmount: "190", notes: "", postedBy: "System (seed)", postedAt: "2026-08-02T09:00:00" }], chargeInsuranceId: null, payerOverride: null, facilityName: PRACTICE_INFO.name, facilityAddress: PRACTICE_INFO.address, taxId: PRACTICE_INFO.taxId, npi: providerNPI[providers[1]], diagnosisCodes: ["Z00.00", "", "", "", "", "", "", "", "", ""], ndc: "", units: 1, time: "" },
  { id: "C5006", patientId: "P1006", dos: "2026-08-18", provider: providers[1], referralPhysician: "", cpt: "90471", desc: "Immunization administration", charge: 35, paid: 0, writeoff: 0, credits: 0, memos: [{ date: "2026-08-19", text: "Call patient re: self-pay balance next visit.", user: "System (seed)", type: "Call", status: "Open", nextFollowUpDate: "2026-08-26" }], postings: [], chargeInsuranceId: null, payerOverride: "self", facilityName: PRACTICE_INFO.name, facilityAddress: PRACTICE_INFO.address, taxId: PRACTICE_INFO.taxId, npi: providerNPI[providers[1]], diagnosisCodes: ["Z23", "", "", "", "", "", "", "", "", ""], ndc: "", units: 1, time: "" },
];
const claims = [
  { id: "CLM-7001", patientId: "P1001", chargeId: "C5001", payer: "Aetna", cpt: "99213", dx: "M54.5", amount: 110, submitted: "2026-08-11", status: "Submitted" },
  { id: "CLM-7002", patientId: "P1004", chargeId: "C5002", payer: "Aetna", cpt: "99214", dx: "E11.9", amount: 165, submitted: "2026-08-06", status: "Denied" },
  { id: "CLM-7003", patientId: "P1003", chargeId: "C5004", payer: "Cigna", cpt: "99213", dx: "J06.9", amount: 110, submitted: "2026-08-16", status: "Paid" },
  { id: "CLM-7004", patientId: "P1002", chargeId: "C5005", payer: "UnitedHealthcare", cpt: "99385", dx: "Z00.00", amount: 190, submitted: "2026-08-02", status: "Paid" },
];

// Mirrors the charges' paid/writeoff amounts, same as the old client-side buildSeedTransactions().
function buildSeedTransactions() {
  const txns = [];
  charges.forEach(c => {
    txns.push({ id: uid("TXN"), chargeId: c.id, patientId: c.patientId, type: "charge", amount: c.charge, date: c.dos, source: "", reference: "" });
    if (c.paid > 0) txns.push({ id: uid("TXN"), chargeId: c.id, patientId: c.patientId, type: "payment", amount: c.paid, date: c.dos, source: "Insurance", reference: "" });
    if (c.writeoff > 0) txns.push({ id: uid("TXN"), chargeId: c.id, patientId: c.patientId, type: "writeoff", amount: c.writeoff, date: c.dos, source: "Contractual adjustment", reference: "" });
  });
  return txns;
}

async function seedCollection(name, rows) {
  for (const row of rows) await setDoc(name, row.id, row);
  console.log(`  ${name}: ${rows.length} document${rows.length === 1 ? "" : "s"}`);
}

async function main() {
  console.log("Seeding users (Firebase Auth + Firestore profiles)...");
  await seedUsers();

  console.log("Seeding Firestore collections...");
  await seedCollection("patients", patients);
  await seedCollection("cptCatalog", cptCatalog.map(c => ({ ...c, id: c.code, active: true })));
  await seedCollection("physicians", physicians);
  await seedCollection("insurancePolicies", insurancePolicies);
  await seedCollection("auditLogs", auditLogs);
  await seedCollection("patientMemos", patientMemos);
  await seedCollection("vitals", vitals);
  await seedCollection("allergies", allergies);
  await seedCollection("medications", medications);
  await seedCollection("problems", problems);
  await seedCollection("clinicalNotes", clinicalNotes);
  await seedCollection("appointments", appointments);
  await seedCollection("charges", charges);
  await seedCollection("claims", claims);
  await seedCollection("transactions", buildSeedTransactions());
  // idDocuments, patientCreditBalances, insuranceCreditBalances, loginAudit start empty —
  // they're populated by the app at runtime (uploads, debits, logins).

  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
