-- Report file MIME type on lab_orders, so the stored file can be served with the correct
-- Content-Type. Additive and idempotent. Default empty means "unknown / assume PDF" for old rows.
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS report_pdf_mime TEXT NOT NULL DEFAULT '';
