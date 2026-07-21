-- 022_other_tcs_default.sql
-- Audit #2 (2026-07-21, pilot-blocking) follow-up: flip the OTHER category
-- to TCS-by-default so ambiguous scans never land with NO food-safety window.
--
-- The AI→category_key mapping (src/lib/food-taxonomy.ts) routes Gemini's
-- 'Other' category, and any unrecognized category via the `?? 'OTHER'`
-- fallback, to this row. A merchant manually picking "Other" in the
-- manifest editor (ManifestEditor.tsx new-item default, categoryKey:
-- 'OTHER') hits the same row. OTHER was seeded non-TCS in 018, so any of
-- those paths silently skipped the prepared-at prompt and safety-expiry
-- gate. Flipping it TCS/4h makes the pipeline conservative-by-default for
-- the unknown case; a merchant who knows the item is shelf-stable can
-- still re-pick a specific non-TCS category in the editor.
--
-- Idempotent/re-runnable: a plain UPDATE naturally is (repeat runs are a
-- no-op once the row already matches).
--
-- Numbering note: this migration claims 022, so Phase 2's planned
-- `institutions` (022) and `allocations` (023) migrations shift to 023 and
-- 024 respectively — see PHASE_2_PROMPT.md, updated in the same commit.
--
-- Effect is FUTURE scans only: existing scan_items snapshotted their own
-- temperature_sensitive flag at confirm time (src/actions/manifest.ts
-- confirmManifest), and declared load_items keep their own snapshot. No
-- historical row changes when this runs.

UPDATE categories
SET temperature_sensitive = TRUE, safety_window_hours = 4
WHERE category_key = 'OTHER';
