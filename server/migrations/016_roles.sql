-- Roles for HIM and Human Resources, and tab grants for the modules that now have screens.
--
-- Forward-only and idempotent. Nothing is deleted: no role is removed, no permission is revoked,
-- and existing role rows only ever gain tabs.
--
-- ABOUT DOCTOR AND PHYSICIAN (section 15)
--
-- They are the SAME role, and the canonical code is DOCTOR.
--
-- The application already had a DOCTOR role, a DOCTOR_* permission group and a doctor clinical
-- workspace before "Physician" was asked for. Adding a second PHYSICIAN role would have produced
-- exactly what section 15 warns against: two authorization systems for one clinical concept, with
-- every future permission having to be granted twice and any disagreement between them becoming a
-- security question. So DOCTOR stays as the stored code and "Physician" is how it is labelled in
-- the interface - a display decision, not a second model.

INSERT INTO role_permissions (id, tabs) VALUES
  -- No "reports" tab for HIM: that tab is the practice's revenue and billing reports, and would
  -- hand a coder every charge and payment. HIM reporting lives inside the HIM module.
  ('HIM',            '["dashboard","him"]'::jsonb),
  ('HUMAN_RESOURCE', '["dashboard","hr"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Tabs for the modules whose screens now exist. Each UPDATE is scoped and guarded, so re-running
-- changes nothing and a practice that has removed a tab by hand does not have it forced back.

-- HIM worklist: the HIM role, and the two administrative roles.
UPDATE role_permissions SET tabs = tabs || '["him"]'::jsonb
 WHERE id IN ('HIM', 'MANAGER', 'SUPER_ADMIN') AND NOT (tabs @> '["him"]'::jsonb);

-- Antimicrobial review is a clinical screen, so it goes to the clinical roles as well.
UPDATE role_permissions SET tabs = tabs || '["antimicrobial"]'::jsonb
 WHERE id IN ('DOCTOR', 'NURSE', 'MANAGER', 'SUPER_ADMIN')
   AND NOT (tabs @> '["antimicrobial"]'::jsonb);

-- Seeing a tab is not the same as seeing the screen: both are additionally gated on the per-user
-- grants (HIM_WORKLIST_VIEW, ANTIMICROBIAL_VIEW), which is why adding a tab here exposes nothing
-- on its own.
