-- DEVELOPMENT SEED DATA for the HIM Coding Worklist and Antimicrobial Review.
-- NOT A MIGRATION. NEVER RUN THIS AGAINST PRODUCTION.
--
-- Both modules have complete, tested backends and no data, so their screens render empty on a
-- fresh database. This puts enough realistic work in front of them to be usable and demonstrable.
--
-- Everything it creates has an id beginning SEED, which is what scripts/dev-unseed-clinical.sql
-- matches on. It attaches to whichever patients already exist rather than creating any, so it adds
-- no patient records to a database that has real ones.
--
-- The clinical content is plausible, NOT authoritative. Organisms, susceptibilities and diagnosis
-- codes here are illustrative sample text for a development database. Nothing in this file should
-- ever be read as a real result about a real person.

\echo 'Seeding DEVELOPMENT HIM and Antimicrobial sample data. Do not run against production.'

-- ---------- HIM coding worklist ----------
--
-- Spread across the workflow statuses so every filter and every summary card has something behind
-- it, and with ready_at staggered so "days pending" and the overdue card are meaningful.

INSERT INTO him_worklist (id, patient_id, encounter_ref, dos, admit_date, discharge_date,
                          encounter_type, provider, payer, location,
                          coding_status, query_status, priority,
                          assigned_to, assigned_to_name, ready_at, last_activity_at,
                          completed_at, created_by)
SELECT v.id, p.id, v.enc, v.dos, v.admit, v.disch, v.etype, v.prov, v.payer, v.loc,
       v.cstatus, v.qstatus, v.prio,
       -- The server counts "unassigned" by the id, not the name. Setting only the name made six
       -- assigned encounters read as unassigned.
       CASE WHEN v.coder = '' THEN NULL ELSE 'SEED-CODER-' || replace(v.coder, ' ', '') END,
       v.coder,
       now() - (v.days || ' days')::interval,
       now() - (v.act || ' hours')::interval,
       CASE WHEN v.cstatus = 'COMPLETED' THEN now() - interval '1 hour' END,
       'dev-seed'
FROM (VALUES
  ('SEEDHIM01','ENC-40101', to_char(CURRENT_DATE - 12,'YYYY-MM-DD'), to_char(CURRENT_DATE - 14,'YYYY-MM-DD'), to_char(CURRENT_DATE - 12,'YYYY-MM-DD'), 'Inpatient',  'Dr. A. Reyes',  'Medicare',   'Main Clinic',  'UNASSIGNED',       'NONE',        'HIGH',   '',            12, 30, 0),
  ('SEEDHIM02','ENC-40102', to_char(CURRENT_DATE - 9,'YYYY-MM-DD'),  '', '', 'Outpatient', 'Dr. B. Okafor', 'BCBS',       'Main Clinic',  'READY_FOR_CODING', 'NONE',        'NORMAL', '',            9,  20, 1),
  ('SEEDHIM03','ENC-40103', to_char(CURRENT_DATE - 7,'YYYY-MM-DD'),  '', '', 'Outpatient', 'Dr. A. Reyes',  'Aetna',      'North Branch', 'ASSIGNED',         'NONE',        'NORMAL', 'Mary Jones',  7,  8,  2),
  ('SEEDHIM04','ENC-40104', to_char(CURRENT_DATE - 6,'YYYY-MM-DD'),  to_char(CURRENT_DATE - 8,'YYYY-MM-DD'), to_char(CURRENT_DATE - 6,'YYYY-MM-DD'), 'Inpatient', 'Dr. C. Lindqvist','UnitedHealth','Main Clinic', 'IN_PROGRESS',      'NONE',        'HIGH',   'David Lee',   6,  3,  3),
  ('SEEDHIM05','ENC-40105', to_char(CURRENT_DATE - 5,'YYYY-MM-DD'),  '', '', 'Emergency',  'Dr. B. Okafor', 'Medicaid',   'Main Clinic',  'QUERY_SENT',       'SENT',        'URGENT', 'Mary Jones',  5,  6,  4),
  ('SEEDHIM06','ENC-40106', to_char(CURRENT_DATE - 4,'YYYY-MM-DD'),  '', '', 'Outpatient', 'Dr. A. Reyes',  'Medicare',   'North Branch', 'QUERY_RESPONDED',  'RECEIVED',    'NORMAL', 'David Lee',   4,  2,  5),
  ('SEEDHIM07','ENC-40107', to_char(CURRENT_DATE - 3,'YYYY-MM-DD'),  '', '', 'Outpatient', 'Dr. C. Lindqvist','BCBS',     'Main Clinic',  'FINAL_REVIEW',     'RESOLVED',     'NORMAL', 'Mary Jones',  3,  1,  6),
  ('SEEDHIM08','ENC-40108', to_char(CURRENT_DATE - 2,'YYYY-MM-DD'),  '', '', 'Outpatient', 'Dr. B. Okafor', 'Self-pay',   'Main Clinic',  'ON_HOLD',          'NONE',        'LOW',    'David Lee',   2,  5,  7),
  ('SEEDHIM09','ENC-40109', to_char(CURRENT_DATE - 1,'YYYY-MM-DD'),  '', '', 'Outpatient', 'Dr. A. Reyes',  'Aetna',      'Main Clinic',  'COMPLETED',        'NONE',        'NORMAL', 'Mary Jones',  1,  1,  8),
  ('SEEDHIM10','ENC-40110', to_char(CURRENT_DATE,'YYYY-MM-DD'),      '', '', 'Outpatient', 'Dr. C. Lindqvist','Medicare', 'North Branch', 'READY_FOR_CODING', 'NONE',        'NORMAL', '',            0,  1,  9)
) AS v(id, enc, dos, admit, disch, etype, prov, payer, loc, cstatus, qstatus, prio, coder, days, act, pick)
JOIN LATERAL (
  SELECT id FROM patients ORDER BY id OFFSET (v.pick % GREATEST((SELECT count(*) FROM patients), 1)) LIMIT 1
) p ON TRUE
ON CONFLICT (id) DO NOTHING;

-- Diagnosis and procedure codes on the encounters that are being worked.
-- Illustrative sample codes for a development database, not coding advice.
INSERT INTO him_diagnosis_codes (id, worklist_id, code, description, sequence, is_principal, poa)
VALUES
  ('SEEDDX01','SEEDHIM04','J18.9','Pneumonia, unspecified organism',       1, TRUE,  'Y'),
  ('SEEDDX02','SEEDHIM04','E11.9','Type 2 diabetes mellitus without complications', 2, FALSE, 'Y'),
  ('SEEDDX03','SEEDHIM06','I10',  'Essential (primary) hypertension',      1, TRUE,  'Y'),
  ('SEEDDX04','SEEDHIM07','M54.5','Low back pain',                          1, TRUE,  'Y')
ON CONFLICT (id) DO NOTHING;

INSERT INTO him_procedure_codes (id, worklist_id, code, description, modifiers, units, sequence)
VALUES
  ('SEEDPX01','SEEDHIM04','99223','Initial hospital care, high complexity', '', 1, 1),
  ('SEEDPX02','SEEDHIM06','99214','Office visit, established patient',      '', 1, 1),
  ('SEEDPX03','SEEDHIM07','97110','Therapeutic exercise, 15 minutes',       '', 2, 1)
ON CONFLICT (id) DO NOTHING;

-- A provider query in each meaningful state.
INSERT INTO him_provider_queries (id, worklist_id, query_type, query_reason, query_text,
                                  status, created_by_name, created_at, sent_at,
                                  response_text, responded_at)
VALUES
  ('SEEDQ01','SEEDHIM05','CLINICAL_VALIDATION','Documentation does not support the severity coded',
   'Please clarify whether the documented sepsis meets the criteria recorded for this encounter.',
   'SENT','Mary Jones', now() - interval '5 days', now() - interval '5 days', '', NULL),
  ('SEEDQ02','SEEDHIM06','SPECIFICITY','Laterality not documented',
   'Please specify laterality for the documented procedure.',
   'RECEIVED','David Lee', now() - interval '4 days', now() - interval '4 days',
   'Left side. Documentation amended in the chart.', now() - interval '2 days')
ON CONFLICT (id) DO NOTHING;

-- ---------- antimicrobial review ----------
--
-- review_due is staggered across overdue, due today and upcoming so the worklist's urgency
-- filters and summary cards are exercised.

INSERT INTO antimicrobial_reviews (id, patient_id, antimicrobial, dose, route, frequency,
                                   start_date, stop_date, ordering_provider, indication,
                                   order_status, location, attending, encounter_ref,
                                   review_due, priority, status, assigned_to, assigned_to_name,
                                   last_reviewed_at, created_by)
SELECT v.id, p.id, v.drug, v.dose, v.route, v.freq,
       to_char(CURRENT_DATE - v.startedDaysAgo, 'YYYY-MM-DD'), '',
       v.prov, v.indication, 'ACTIVE', v.loc, v.attending, v.enc,
       now() + (v.dueInHours || ' hours')::interval,
       v.prio, v.status,
       CASE WHEN v.reviewer = '' THEN NULL ELSE 'SEED-REVIEWER-' || replace(v.reviewer, ' ', '') END,
       v.reviewer,
       CASE WHEN v.lastRev IS NULL THEN NULL ELSE now() - (v.lastRev || ' days')::interval END,
       'dev-seed'
FROM (VALUES
  ('SEEDAM01','Vancomycin',              '1 g',     'IV', 'every 12 hours', 4, 'Dr. A. Reyes',   'MRSA bacteraemia',            'Main Clinic 3W','Dr. A. Reyes',   'ENC-50101', -36, 'URGENT', 'PENDING_REVIEW', '',            NULL),
  ('SEEDAM02','Piperacillin-Tazobactam', '4.5 g',   'IV', 'every 6 hours',  3, 'Dr. B. Okafor',  'Intra-abdominal infection',   'Main Clinic 3W','Dr. B. Okafor',  'ENC-50102', -6,  'HIGH',   'PENDING_REVIEW', '',            NULL),
  ('SEEDAM03','Ceftriaxone',             '2 g',     'IV', 'daily',          2, 'Dr. C. Lindqvist','Community-acquired pneumonia','North Branch', 'Dr. C. Lindqvist','ENC-50103', 4,   'NORMAL', 'IN_REVIEW',      'Grace Kim',   1),
  ('SEEDAM04','Meropenem',               '1 g',     'IV', 'every 8 hours',  6, 'Dr. A. Reyes',   'Febrile neutropenia',         'Main Clinic ICU','Dr. A. Reyes',  'ENC-50104', 20,  'HIGH',   'FOLLOW_UP',      'Grace Kim',   2),
  ('SEEDAM05','Azithromycin',            '500 mg',  'PO', 'daily',          5, 'Dr. B. Okafor',  'Atypical pneumonia',          'North Branch',  'Dr. B. Okafor',  'ENC-50105', 48,  'LOW',    'COMPLETED',      'Emma Wilson', 1),
  ('SEEDAM06','Ciprofloxacin',           '500 mg',  'PO', 'every 12 hours', 7, 'Dr. C. Lindqvist','Complicated urinary tract infection','Main Clinic','Dr. C. Lindqvist','ENC-50106', 12, 'NORMAL','PENDING_REVIEW','',          NULL),
  ('SEEDAM07','Metronidazole',           '500 mg',  'IV', 'every 8 hours',  3, 'Dr. A. Reyes',   'Anaerobic coverage',          'Main Clinic 3W','Dr. A. Reyes',   'ENC-50107', 30,  'NORMAL', 'PENDING_REVIEW', '',            NULL),
  ('SEEDAM08','Cefazolin',               '2 g',     'IV', 'every 8 hours',  2, 'Dr. B. Okafor',  'Surgical prophylaxis',        'Main Clinic',   'Dr. B. Okafor',  'ENC-50108', 72,  'LOW',    'PENDING_REVIEW', '',            NULL)
) AS v(id, drug, dose, route, freq, startedDaysAgo, prov, indication, loc, attending, enc, dueInHours, prio, status, reviewer, lastRev)
JOIN LATERAL (
  SELECT id FROM patients ORDER BY id OFFSET (abs(hashtext(v.id)) % GREATEST((SELECT count(*) FROM patients), 1)) LIMIT 1
) p ON TRUE
ON CONFLICT (id) DO NOTHING;

-- Review history on the two that have been looked at. Sample text, not real clinical findings.
INSERT INTO antimicrobial_review_entries (id, review_id, reviewed_at, reviewer_name, assessment,
                                          recommendation_category, recommendation_notes,
                                          provider_contacted, cultures, organism, susceptibility,
                                          labs, renal_function, allergies_noted, clinical_notes)
VALUES
  ('SEEDAMR01','SEEDAM03', now() - interval '1 day', 'Grace Kim',
   'Day 2 of therapy. Clinically improving.', 'REVIEWED_NO_CHANGE',
   'Continue current therapy. Reassess at 72 hours.', 'NO',
   'Blood culture x2', 'Streptococcus pneumoniae', 'Penicillin susceptible',
   'WBC trending down', 'CrCl approximately 80 mL/min', 'No known drug allergies',
   'Sample development data - not a real clinical assessment.'),
  ('SEEDAMR02','SEEDAM04', now() - interval '2 days', 'Grace Kim',
   'Broad-spectrum therapy day 4, cultures negative to date.', 'FOLLOW_UP_REQUIRED',
   'Discuss de-escalation with the treating team once afebrile 48 hours.', 'YES',
   'Blood culture x2, urine culture', 'No growth to date', 'Not applicable',
   'ANC recovering', 'CrCl approximately 65 mL/min', 'Penicillin - rash',
   'Sample development data - not a real clinical assessment.'),
  ('SEEDAMR03','SEEDAM05', now() - interval '1 day', 'Emma Wilson',
   'Course completed as prescribed.', 'COMPLETED',
   'Therapy complete. No further review required.', 'NO',
   '', '', '', '', '', '', 'Sample development data.')
ON CONFLICT (id) DO NOTHING;

\echo 'Done. Open HIM and Antimicrobial Review from the navigation.'
\echo 'To remove: psql -f scripts/dev-unseed-clinical.sql'
