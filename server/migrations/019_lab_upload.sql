-- Storing the uploaded lab report PDF alongside the extracted lab_orders row.
--
-- Additive and idempotent: two nullable text columns on lab_orders. Nothing existing changes.
-- The PDF is stored as a base64 data URL, the same shape medical_records and id_documents already
-- use, so backups already include it and no new storage system is introduced.

ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS report_pdf TEXT NOT NULL DEFAULT '';
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS report_pdf_name TEXT NOT NULL DEFAULT '';
