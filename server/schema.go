package main

// Collection registry.
//
// The React app talks to a document store: it reads whole "collections" of JSON documents keyed
// by string id. This file is the single place that maps that document model onto the real SQL
// schema - collection name to table, camelCase JSON field to snake_case column, and the column's
// type so values marshal back to the app exactly as Firestore delivered them.
//
// Anything a document carries that is NOT listed here is preserved verbatim in the table's
// `extra` JSONB column and merged back in on read, so an unmapped or newly added field can never
// be silently dropped.
//
// Fields deliberately absent from the registry are never selected and therefore never leave the
// server - that is how users.password_hash / password_salt / password_algo stay private.

type Kind int

const (
	KText Kind = iota // TEXT  -> JSON string (or null when the column is NULL)
	KNum              // NUMERIC/BIGINT -> JSON number
	KBool             // BOOLEAN -> JSON bool
	KJSON             // JSONB -> nested object/array, passed through untouched
)

type Field struct {
	Name string // camelCase key as the app sees it
	Col  string // SQL column
	Kind Kind
}

type Collection struct {
	Name   string
	Table  string
	Fields []Field
}

func f(name, col string, k Kind) Field { return Field{Name: name, Col: col, Kind: k} }

// text/num/bool/json shorthands for fields whose column is just the snake_case of the name.
func t(name, col string) Field { return f(name, col, KText) }
func n(name, col string) Field { return f(name, col, KNum) }
func b(name, col string) Field { return f(name, col, KBool) }
func j(name, col string) Field { return f(name, col, KJSON) }

var collections = map[string]*Collection{}

func register(c *Collection) { collections[c.Name] = c }

func init() {
	register(&Collection{Name: "users", Table: "users", Fields: []Field{
		t("id", "id"), t("email", "email"), t("name", "name"), t("role", "role"),
		b("disabled", "disabled"), t("createdBy", "created_by"), t("createdAt", "created_at"),
	}})

	register(&Collection{Name: "loginAudit", Table: "login_audit", Fields: []Field{
		t("id", "id"), t("user", `"user"`), t("role", "role"), t("action", "action"),
		t("timestamp", "timestamp"),
	}})

	register(&Collection{Name: "auditLogs", Table: "audit_logs", Fields: []Field{
		t("id", "id"), t("patientId", "patient_id"), t("user", `"user"`), t("action", "action"),
		t("entityType", "entity_type"), t("entityId", "entity_id"),
		t("oldValues", "old_values"), t("newValues", "new_values"), t("timestamp", "timestamp"),
	}})

	register(&Collection{Name: "patients", Table: "patients", Fields: []Field{
		t("id", "id"), t("name", "name"), t("dob", "dob"), t("phone", "phone"), t("email", "email"),
		t("ssn", "ssn"), t("address", "address"), t("city", "city"), t("state", "state"), t("zip", "zip"),
		j("emergencyContact", "emergency_contact"), j("guarantor", "guarantor"),
	}})

	register(&Collection{Name: "appointments", Table: "appointments", Fields: []Field{
		t("id", "id"), t("patientId", "patient_id"), t("date", "date"), t("time", "time"),
		t("provider", "provider"), t("type", "type"), t("status", "status"), t("cpt", "cpt"),
	}})

	register(&Collection{Name: "patientMemos", Table: "patient_memos", Fields: []Field{
		t("id", "id"), t("patientId", "patient_id"), t("text", "text"), t("user", `"user"`),
		t("date", "date"),
	}})

	register(&Collection{Name: "idDocuments", Table: "id_documents", Fields: []Field{
		t("id", "id"), t("patientId", "patient_id"), t("idType", "id_type"), t("idNumber", "id_number"),
		t("issuingState", "issuing_state"), t("issueDate", "issue_date"),
		t("expirationDate", "expiration_date"), t("file", "file"), t("fileName", "file_name"),
		t("fileType", "file_type"), n("fileSize", "file_size"), t("status", "status"),
		t("uploadedBy", "uploaded_by"), t("uploadedAt", "uploaded_at"),
	}})

	register(&Collection{Name: "insurancePolicies", Table: "insurance_policies", Fields: []Field{
		t("id", "id"), t("patientId", "patient_id"), t("insuranceCompany", "insurance_company"),
		t("planName", "plan_name"), t("insuranceType", "insurance_type"), t("memberId", "member_id"),
		t("subscriberId", "subscriber_id"), t("groupNumber", "group_number"), t("payerId", "payer_id"),
		t("effectiveDate", "effective_date"), t("terminationDate", "termination_date"),
		t("status", "status"), t("priority", "priority"), t("subscriberName", "subscriber_name"),
		t("subscriberDob", "subscriber_dob"), t("subscriberRelationship", "subscriber_relationship"),
		t("copay", "copay"), t("deductible", "deductible"), t("coinsurance", "coinsurance"),
		b("authRequired", "auth_required"), b("referralRequired", "referral_required"),
		t("notes", "notes"), t("cardFront", "card_front"), t("cardBack", "card_back"),
		j("fieldHistory", "field_history"), t("createdBy", "created_by"),
		t("createdAt", "created_at"), t("updatedAt", "updated_at"),
	}})

	register(&Collection{Name: "cptCatalog", Table: "cpt_catalog", Fields: []Field{
		t("id", "id"), t("code", "code"), t("desc", `"desc"`), n("charge", "charge"),
		t("category", "category"), b("active", "active"),
	}})

	register(&Collection{Name: "charges", Table: "charges", Fields: []Field{
		t("id", "id"), t("patientId", "patient_id"), t("dos", "dos"), t("provider", "provider"),
		t("referralPhysician", "referral_physician"), t("cpt", "cpt"), t("desc", `"desc"`),
		n("charge", "charge"), n("paid", "paid"), n("writeoff", "writeoff"), n("credits", "credits"),
		j("memos", "memos"), j("postings", "postings"),
		t("chargeInsuranceId", "charge_insurance_id"), t("payerOverride", "payer_override"),
		t("facilityName", "facility_name"), t("facilityAddress", "facility_address"),
		t("taxId", "tax_id"), t("npi", "npi"), j("diagnosisCodes", "diagnosis_codes"),
		t("ndc", "ndc"), n("units", "units"), t("time", "time"),
		t("postedBy", "posted_by"), t("postedAt", "posted_at"), t("batchId", "batch_id"),
	}})

	register(&Collection{Name: "claims", Table: "claims", Fields: []Field{
		t("id", "id"), t("patientId", "patient_id"), t("chargeId", "charge_id"), t("payer", "payer"),
		t("cpt", "cpt"), t("dx", "dx"), n("amount", "amount"), t("submitted", "submitted"),
		t("status", "status"), j("diagnosisCodes", "diagnosis_codes"),
		t("facilityName", "facility_name"), t("npi", "npi"), n("units", "units"), t("taxId", "tax_id"),
	}})

	register(&Collection{Name: "transactions", Table: "transactions", Fields: []Field{
		t("id", "id"), t("chargeId", "charge_id"), t("patientId", "patient_id"), t("type", "type"),
		n("amount", "amount"), t("date", "date"), t("source", "source"), t("reference", "reference"),
		t("postingId", "posting_id"), t("batchId", "batch_id"),
		t("postedBy", "posted_by"), t("postedAt", "posted_at"),
	}})

	register(&Collection{Name: "batches", Table: "batches", Fields: []Field{
		t("id", "id"), t("batchNumber", "batch_number"), t("userId", "user_id"),
		t("userName", "user_name"), t("batchDate", "batch_date"), t("status", "status"),
		t("openedAt", "opened_at"), t("closedAt", "closed_at"),
	}})

	register(&Collection{Name: "patientCreditBalances", Table: "patient_credit_balances", Fields: []Field{
		t("id", "id"), t("patientId", "patient_id"), n("amount", "amount"), n("remaining", "remaining"),
		t("reason", "reason"), t("date", "date"), t("sourceChargeId", "source_charge_id"),
		t("sourcePostingId", "source_posting_id"), t("createdBy", "created_by"), t("createdAt", "created_at"),
	}})

	register(&Collection{Name: "insuranceCreditBalances", Table: "insurance_credit_balances", Fields: []Field{
		t("id", "id"), t("patientId", "patient_id"), t("insuranceName", "insurance_name"),
		n("amount", "amount"), n("remaining", "remaining"), t("reason", "reason"), t("date", "date"),
		t("sourceChargeId", "source_charge_id"), t("sourcePostingId", "source_posting_id"),
		t("createdBy", "created_by"), t("createdAt", "created_at"),
	}})

	register(&Collection{Name: "vitals", Table: "vitals", Fields: []Field{
		t("id", "id"), t("patientId", "patient_id"), t("date", "date"), t("height", "height"),
		t("weight", "weight"), t("bmi", "bmi"), t("bp", "bp"), t("pulse", "pulse"), t("resp", "resp"),
		t("temp", "temp"), t("spo2", "spo2"), t("pain", "pain"), t("recordedBy", "recorded_by"),
	}})

	register(&Collection{Name: "allergies", Table: "allergies", Fields: []Field{
		t("id", "id"), t("patientId", "patient_id"), t("substance", "substance"),
		t("reaction", "reaction"), t("severity", "severity"), t("status", "status"),
		t("notes", "notes"), t("recordedDate", "recorded_date"), t("recordedBy", "recorded_by"),
	}})

	register(&Collection{Name: "medications", Table: "medications", Fields: []Field{
		t("id", "id"), t("patientId", "patient_id"), t("name", "name"), t("dose", "dose"),
		t("route", "route"), t("frequency", "frequency"), t("quantity", "quantity"),
		t("refills", "refills"), t("startDate", "start_date"), t("endDate", "end_date"),
		t("status", "status"), t("prescriber", "prescriber"), t("instructions", "instructions"),
	}})

	register(&Collection{Name: "problems", Table: "problems", Fields: []Field{
		t("id", "id"), t("patientId", "patient_id"), t("diagnosis", "diagnosis"), t("icd10", "icd10"),
		t("description", "description"), t("onsetDate", "onset_date"), t("status", "status"),
		t("notes", "notes"),
	}})

	register(&Collection{Name: "clinicalNotes", Table: "clinical_notes", Fields: []Field{
		t("id", "id"), t("patientId", "patient_id"), t("type", "type"), t("date", "date"),
		t("provider", "provider"), t("subjective", "subjective"), t("objective", "objective"),
		t("assessment", "assessment"), t("plan", "plan"), t("status", "status"),
		t("signedBy", "signed_by"), t("signedAt", "signed_at"), j("amendments", "amendments"),
	}})

	register(&Collection{Name: "ticklers", Table: "ticklers", Fields: []Field{
		t("id", "id"), t("title", "title"), t("description", "description"),
		t("patientId", "patient_id"), t("patientName", "patient_name"), t("claimId", "claim_id"),
		t("cpt", "cpt"), t("dos", "dos"), t("priority", "priority"), t("status", "status"),
		t("reminderDate", "reminder_date"), t("reminderTime", "reminder_time"),
		t("assignedToUid", "assigned_to_uid"), t("assignedToName", "assigned_to_name"),
		t("createdByUid", "created_by_uid"), t("createdByName", "created_by_name"),
		t("createdAt", "created_at"), t("completedAt", "completed_at"),
	}})

	register(&Collection{Name: "supportTickets", Table: "support_tickets", Fields: []Field{
		t("id", "id"), t("subject", "subject"), t("description", "description"),
		t("priority", "priority"), t("status", "status"), t("attachment", "attachment"),
		t("attachmentName", "attachment_name"), j("notes", "notes"),
		t("createdByUid", "created_by_uid"), t("createdByName", "created_by_name"),
		t("createdAt", "created_at"),
	}})
}

// byName indexes a collection's fields for quick lookup when splitting an incoming document
// into typed columns versus the `extra` catch-all.
func (c *Collection) byName() map[string]Field {
	m := make(map[string]Field, len(c.Fields))
	for _, fl := range c.Fields {
		m[fl.Name] = fl
	}
	return m
}
