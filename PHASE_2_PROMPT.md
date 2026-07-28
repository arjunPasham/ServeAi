# Phase 2 — Match: Builder Prompt

> **✅ Phase 2 is BUILT (Tasks 1–4 done; 5–6 pending). Historical build-prompt.**
> Under the **v3 records-only model (2026-07-28)**, the "Phase 3 (Routes)" references
> below are **superseded** — there is no route scheduling. A load that's `matched`
> advances through a slim **Delivery-log** phase (method chosen → `scheduled`/`picked_up`
> → `delivered`), not a route builder. See the v3 boxes in `BUILD_PLAN.md` /
> `analysis/03-transition-plan.md`. The Match design itself (receiver = verified
> 501(c)(3)/business, `institutions`, `allocations`, offer/accept, no-login inbound
> preview) is unchanged and correct under v3.

**Hand this to Opus with the `/FoodLink` codebase. Run each task in order. Follow the repo's SDD discipline: brief → build → self-review → fix → per-task report, one commit per task, `tsc --noEmit` + unit + api green before moving on.**

---

## Context (read first)

Phase 1 is complete and on `origin/main`: scan → itemized `scan_records`/`scan_items` → merchant-confirmed manifest → `declare_load` RPC produces a `loads` row (`status='declared'`) with valuation snapshots on `load_items`. Migrations `018_categories_valuations`, `019_merchants`, `020_scan_inventory` are live in dev Supabase.

**Phase 2 delivers the strategy's headline moment:** a declared load gets matched to a real institution's standing demand, and the institution's kitchen manager sees the *itemized inbound before it arrives* — via a no-login web view. Matching is **ops-driven, not automatic** (the ops person is the algorithm; the console records their decisions so a real matcher can be trained later). No auto-matching in v1.

**Source of truth for scope and schema:** `analysis/03-transition-plan.md` (Phase 2 section + entity sketch) and `PHASE_1_PLAN.md` (house patterns). This prompt refines those into tasks; where they conflict, the transition plan wins and you flag it.

> **Pre-Phase-2 gate (2026-07-20 security review).** A whole-codebase review run at the close of Phase 1 surfaced security findings that must be cleared *before* building new match surfaces on top of them — its own recommended order of attack puts them first. They are **Task 0 below.** Do Task 0 first, as its own commit(s); do not start Task 1 until Task 0 is green. Finding #5 in that review (fold confirm/closeout into the RPC) is already Task 2 here.

### Non-negotiable house patterns (already established — match them exactly)
- **Every state transition is a `SECURITY DEFINER` RPC** with `SET search_path = ''`, fully-qualified `public.*` names, atomic `audit_log` write inside the function, and `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` (see `declare_load` in `020_scan_inventory.sql:126`). Server actions call the RPC; ownership/role is checked in the action *and* re-checked in the RPC.
- **Integer cents, server timestamps, immutable `category_key`s, versioned `valuation_table`, `metro_id` on every new entity** (transition plan "schema decisions that are cheap now").
- **Dev-mode simulation for every external service.** Push (`src/lib/onesignal.ts`) and email (`src/lib/email.ts`) already no-op with a `[DEV]` console log when the API key is absent — reuse them; do not add a new notification dependency.
- **Reads that hit a DB error throw** (so an outage surfaces via the error boundary, never as empty UI) — see `getMerchantContext`/`getCategoriesWithValuations` in `src/actions/manifest.ts`.
- **New tables alongside old.** `institutions` supersedes `consumer_profiles.type='shelter'` — do NOT contort `consumer_profiles`. Reuse only the `receiving_window` JSONB shape (`002_schema.sql:86` → `[{day,start,end}]`), which was right.
- Migrations are SQL files you write; **you cannot run them against dev Supabase** — write `023`/`024`, add them to `supabase/combined_*.sql` if that pattern is in use, and note in your report that the SQL-editor run is a user action. Do not block subsequent tasks assuming they're applied unless a task truly needs live tables (say so explicitly).
- **Migration numbering:** Task 0 hardening already claimed `021_security_hardening.sql`, and the audit #2 cold-chain fix claimed `022_other_tcs_default.sql`, so Phase 2 starts at **023**. The two migrations below were originally drafted as 021/022, then 022/023 — they are now **023 (institutions)** and **024 (allocations)**.

---

## Task 0 — Pre-Phase-2 hardening (from the 2026-07-20 security review)

**Run this first, before any Phase 2 feature work.** These are the review's prioritized fixes; each is small and independently committable. Order matters — do them in this sequence (smallest fix / biggest class-kill first).

### 0.1 Fail-closed production boot (biggest class-kill)
Every external integration currently switches to dev/no-op behavior when its env var is absent: `DEV_MODE = !process.env.X` in `src/lib/twilio.ts`, `src/lib/email.ts`, `src/lib/onesignal.ts`, `src/lib/smarty.ts`, `src/lib/rate-limit.ts`, `src/lib/google-routes.ts`, `src/lib/stripe.ts`, and the `GEMINI_API_KEY` check in `src/services/foodVision.ts`. In production a *missing* key therefore fails **open** — silently disabling rate-limiting (denial-of-wallet), OTP, address validation, etc.
- Add a single boot-time assertion (e.g. `src/lib/env.ts` imported from the root layout / instrumentation) that, when `NODE_ENV === 'production'` (or a `FOODLINK_ENV=prod` flag), asserts every required key is present and **throws to refuse boot** if any is missing. Dev/test keep the simulated paths.
- The per-module `DEV_MODE` consts stay for local dev, but they can no longer be reached in prod because boot fails first. Document the required-in-prod key list in `.env.example`.

### 0.2 Close the unauthenticated Gemini denial-of-wallet (review C1 — the highest-severity finding)
Today `registerAction` creates the auth user (`auth.ts:128`), inserts the `merchants` row (`auth.ts:182`), and signs the user in (`auth.ts:221`) **before the OTP is ever sent** (`auth.ts:228`), and `phone_verified` is enforced only in page middleware — checked **nowhere** in `src/actions/*` or `src/app/api/*`. `/api/scan` gates only on "authenticated + has a merchants row" (`route.ts:35-55`). A script can register with a fake phone, skip OTP, and POST `/api/scan` for real Gemini spend, rotating fresh accounts to defeat the 20/hr cap and polluting the core dataset. **Fix all three:**
1. **Don't provision before OTP.** Do not create the `merchants` row or establish the session until `verifyOTPAction` succeeds (move that work there, or hold the account in an unverified state that grants nothing). 
2. **Enforce `phone_verified = true` at the action/route layer** — in `/api/scan` and every merchant server action (scan, manifest confirm, and the new Phase 2 offer path), not just middleware. Reuse the check shape at `auth.ts:280`.
3. **Rate-limit `registerAction` by IP *before any write*** (the limiter is real in prod now that 0.1 fails closed).
- **Also fix the swallowed write in `verifyOTPAction` (`auth.ts:352-355`).** The `users.update({ phone_verified: true })` and `app_metadata` update run in an unchecked `Promise.all` — if either fails the OTP is already spent but verification never persists, stranding the user. Check both results; on failure return a typed error and don't consume the attempt silently. Add a test for this path.

### 0.3 Observability + timezone/date fixes (all small, all safety- or debuggability-relevant)
- **`confirmManifest` has zero logging** (review I7) and there's no error-reporting tool in the repo — a 2am declare failure leaves no trace anywhere. Add `console.error` at minimum with the same throw-on-error discipline as `getMerchantContext`; stand up Sentry (or equivalent) before pilot. (Logging now; the RPC consolidation is Task 2.)
- **Safety-expiry renders in the server timezone** (review I3 — safety-relevant). `(merchant)/merchant/dashboard/page.tsx:78` shows an 8:00 PM EDT expiry as 12:00 AM on a UTC prod server; a deli manager reads hours of runway that don't exist. Format client-side or with an explicit timezone. It's the dashboard's only timestamp — get it right.
- **Calendar-rollover dates pass validation.** `manifest.ts:96` uses `Date.parse`, which accepts `2026-02-30` (rolls to Mar 2). Validate that the parsed date round-trips to the same `YYYY-MM-DD`, and pin interpretation to a fixed timezone (the admin date inputs share the ambiguity — fix both).

### 0.4 Gate or remove the mothballed write actions + unauthenticated reads (review I6)
Server actions are HTTP endpoints callable by **any authenticated user**, even with the route hidden from nav — and merchants carry `role='donor'`, so they can call the donor writes directly. Still exported and reachable: `createDraftListing`/`publishListing` (`listing.ts`), `acceptDispatch`/`confirmDelivery`/`setCourierAvailability`/etc. (`dispatch.ts`), `claimListing`/`syncDeliveryStatus` (`payment.ts`), `confirmPickup` (`pickup.ts`).
- **Worse: three listing reads use the service client with no auth check at all** — `getLiveListings`/`getLiveListingsWithSignedUrls`/`getSignedImageUrl` (`listing.ts`) let anyone enumerate listings and mint signed image URLs. Gate or remove these too.
- Gate each mothballed **write** behind `NEXT_PUBLIC_CONSUMER_ENABLED` (or delete outright where Phase 3's kill list already covers it — `dispatch.ts` is on it, so gating is a bridge, not a keeper; **consider pulling that Phase 3 deletion forward into this task**). Reads used by the parked demo can stay *if* they carry an auth check. Comment the intent so a future builder doesn't revive a gated action by accident.
- Kill the **two Inngest crons for dead flows** that fire every 5 minutes forever (`claim-expiry`, `dispute-window`) — unschedule them; they burn quota on flows that no longer exist.

### 0.5 Admin editor, user-deletion intent, and Minors
- **Admin price editor is a silent no-op** (review I4): it writes `usda_commodity_prices` (`admin/dashboard/page.tsx:53,87`), which the live flow never reads (valuations come from `valuation_table`). Either repoint it at `valuation_table` (append-only insert) **or** visibly mark the admin page pre-pivot — Phase 2's Task 3 rebuilds it into the ops console anyway, so a "pre-pivot, do not use" banner is the cheap bridge.
- **User deletion breaks once a merchant scans** (review I8): `020` FKs default to `NO ACTION`, so deleting an auth user aborts with a raw FK error. Retention may be intended (IRS records) — make the intent explicit: documented `ON DELETE` behavior or a soft-delete/anonymize path.
- **Minors:** pin `search_path` on legacy `SECURITY DEFINER` RPCs; restrict `basis_per_lb_cents` (merchant-cost data) from general authed reads; add baseline security headers to `next.config.ts` (`headers()` — HSTS, X-Content-Type-Options, Referrer-Policy, frame-ancestors); align the `loads` index with the query's `created_at` sort (`020` indexes `window_date`); set Playwright `reuseExistingServer: false` in CI so the suite can never bind to a dev server holding real keys.

### 0.6 Close the test gaps the review flagged (#9)
- `/api/scan` guard branches are untested — add cases for **401/403/413/415/429**.
- The low-confidence manual-review path ships untested though `test-images/lowconf.jpg` exists unused — add a test that drives it.
- Add the `verifyOTPAction` post-verify-write-failure test from 0.2.

**Task 0 exit gate:** an unauthenticated/unverified caller can no longer reach `/api/scan` (C1 closed — no provisioning before OTP, `phone_verified` enforced at the route/action layer, `registerAction` IP-throttled); prod-boot assertion in place and unit-tested (C2); OTP write-failure handled + tested; safety-expiry renders in the merchant's timezone; date validation rejects `2026-02-30`; mothballed writes + unauthenticated listing reads gated/removed and dead crons off; scan-guard + low-confidence tests added. `tsc --noEmit`, unit, and api suites green. Commit as a small series (one per 0.x), reviewed, before Task 1. Full detail and file:line references live in `CODE_REVIEW_2026-07-20.md`.

---

## Task 1 — Migration 023: `institutions` entity + NPO verification fields

**Build** `supabase/migrations/023_institutions.sql`:
- `institutions`: `id`, `org_name`, `ein`, `npo_verified BOOLEAN DEFAULT FALSE`, `npo_evidence_key TEXT` (private-bucket key for the 501(c)(3) determination letter), `npo_verified_by`/`npo_verified_at`, `signer_name`, `signer_contact` (email + phone), `receiving_windows JSONB` (reuse `[{day,start,end}]`), demand: `demand_category_keys TEXT[]` (FK-validated against `categories` at write time in the RPC, since PG arrays can't FK), `capacity_lbs NUMERIC`, `has_food_budget BOOLEAN`, `dock_notes TEXT`, `address` (+ `geo`, mirror the `donor_location_sync` trigger pattern in `002_schema.sql:129`), `metro_id`, `status TEXT CHECK (status IN ('pending','active','suspended'))`, `user_id UUID REFERENCES users(id)` nullable (institutions may be ops-managed before they ever log in), timestamps.
- RLS: institution rows readable by their own `user_id` and by admins; all writes via RPC/service client only (mirror `003_rls.sql` posture).
- A `public_view_token UUID DEFAULT uuid_generate_v4() UNIQUE` column on `loads` **or** a dedicated `load_preview_tokens` table (your call — justify in report) to power the no-login inbound preview in Task 4 without exposing an authenticated route.

**Verify:** SQL parses clean; idempotent (`IF NOT EXISTS`, guarded triggers — the repo has been bitten by non-idempotent audit/index migrations before, see `progress.md` Backend Step 16). No RLS gaps (no table left world-readable).

**Report:** entity list, the token decision, and that the SQL-editor run is pending user.

---

## Task 2 — Migration 024: `allocations` + `offer_load` / `respond_to_offer` RPCs

**Build** `supabase/migrations/024_allocations.sql`:
- `allocations`: `id`, `load_id REFERENCES loads`, `institution_id REFERENCES institutions`, `lane TEXT CHECK (lane IN ('donation','sale'))` (copied from the load — a load's lane never mixes), `status TEXT CHECK (status IN ('offered','accepted','declined','expired','withdrawn'))`, `offered_at`, `offered_by`, `decided_at`, `decided_by`, `decline_reason`, `expires_at` (offers auto-expire so a load can't sit un-actionable past its safety window). Unique partial index: at most one non-terminal (`offered`/`accepted`) allocation per `load_id`.
- **`offer_load(p_load_id, p_institution_id, p_offered_by, p_expires_at)` RPC** (SECURITY DEFINER): asserts the load is `status='declared'` (or `matched` re-offer after a decline), locks the load `FOR UPDATE`, validates the institution is `status='active'` and `npo_verified=TRUE` **for the donation lane** (a donation to an unverified receiver breaks the Good Samaritan / 170(e)(3) story — this gate is a compliance requirement, not a nicety), inserts the `offered` allocation, flips `loads.status → 'matched'`, writes the `audit_log` row. Raises typed errors: `LOAD_NOT_OFFERABLE`, `INSTITUTION_NOT_ELIGIBLE`, `ALREADY_ALLOCATED`.
- **`respond_to_offer(p_allocation_id, p_decision, p_actor, p_decline_reason)` RPC**: `accepted` → allocation `accepted`, load stays `matched` (route scheduling in Phase 3 moves it to `scheduled`); `declined` → allocation `declined`, load back to `declared` and free to re-offer. Audit row each way. Typed errors: `OFFER_NOT_PENDING`, `OFFER_EXPIRED`.
- `REVOKE EXECUTE` from PUBLIC/anon/authenticated on both.

**Fold in the tracked debt (ledger "Phase 2 follow-ups" + review fix #5):** while you're writing RPCs that consume declared loads, **consolidate `confirmManifest` into a single RPC** (the error-logging half was already done in Task 0.3; this is the transactional consolidation). Today `confirmManifest` (`src/actions/manifest.ts:86`) does write-then-`declare_load` non-transactionally (updates confirmed items, inserts manual items, closes out `not_shipped`, *then* calls `declare_load`). Move that whole sequence into one `confirm_and_declare` RPC so a mid-sequence failure can't leave half-confirmed items with no load. This retires four logged debt items at once: the non-transactional write-then-declare, the valuation-mapping duplication, the dead `EMPTY_LOAD→EMPTY_MANIFEST` mapping, and the `DashboardLoad[]` double-cast. Keep the existing e2e/api specs green (they assert the same end state).

**Verify:** unit-level RPC reasoning documented; add api-spec coverage (Task 5) for offer→accept and offer→decline→re-offer. Concurrency: two ops offering the same load simultaneously → one wins, other gets `ALREADY_ALLOCATED` (mirror the `declare_load` `FOR UPDATE` + count-check idiom).

---

## Task 3 — Ops matching console (server actions + admin surface)

**Build** on top of the existing admin dashboard (`src/app/(admin)/admin/dashboard/page.tsx` — reuse its `checkAdmin`/`requireAdmin` split and the license-review UI pattern verbatim):
- `src/actions/allocations.ts`: `getMatchableLoads()` (tonight's `declared` loads with items, valuations, earliest safety expiry, merchant), `getInstitutions()` (active + verified, with demand profile), `getSuggestedMatches(loadId)` (**ranked SQL suggestions, not ML** — score = demand-category overlap × capacity fit × safety-window slack; ties broken by fewest recent offers, so allocation load spreads), `offerLoad(...)`, `withdrawOffer(...)`. All admin-guarded in the action and re-guarded in the RPC.
- Ops console page (new route under `(admin)`): tonight's loads column, per-load ranked institution suggestions with one-click **Offer**, manual-override institution picker, and current allocation status per load. This is the "ops person is the algorithm" console — every offer/decline is recorded, no auto-matching.
- **Fold in debt:** fix the **dashboard redirect loop for merchantless authed users** and remove the **`getMerchantContext` dead export** if the console work touches those paths.

**Verify:** admin-only (non-admin server action call returns without effect — the endpoints are callable by any authed user, so each must self-check). Suggestions never surface an unverified institution on the donation lane. tsc/lint clean.

---

## Task 4 — Institution inbound preview (no-login web view) + notification

**Build:**
- A public, tokenized, read-only route (e.g. `/inbound/[token]`) that resolves the `public_view_token` from Task 1 to a single load and renders the **itemized inbound**: each item (food name, category, est lbs, safety-expires-at), merchant name, expected window — the thing "no donation pipeline gives the kitchen manager today." No auth, no PII beyond what a receiver needs; token is unguessable and scoped to one load. Rate-limit the route (reuse `src/lib/rate-limit.ts`).
- Accept/decline lands here too **or** via the authed institution app if `user_id` is set — but the no-login path is the default (kitchen managers will not install an app). A minimal accept/decline that calls `respond_to_offer`.
- **Notification on offer:** when `offer_load` succeeds, fire an Inngest event that emails/pushes the institution's `signer_contact` an itemized preview + the `/inbound/[token]` link. Reuse `sendEmail` (`src/lib/email.ts`) and `sendPushToUser` (`src/lib/onesignal.ts`) — both already dev-mode no-op. Add the Inngest function under `src/inngest/functions/` following `feedback-prompt.ts`'s shape; register it in `src/inngest/client.ts` wiring.

**Verify:** the tokenized route leaks nothing when the token is wrong/expired (404, not 500, no data). A dev-mode offer logs `[DEV] Email…` with the preview. e2e: offer → institution opens token URL → sees items → accepts → load is `matched` with `accepted` allocation.

---

## Task 5 — E2E + api spec: match happy path and re-offer

**Build** `e2e/match.api.spec.ts` and a browser spec extending the merchant flow:
- api: declare load → `offer_load` → `respond_to_offer(accept)`; declare → offer → decline → re-offer to a second institution → accept. Assert load status transitions and audit rows at each step.
- ui: ops console offers a load → tokenized inbound view renders the itemized manifest → accept flips status. Reuse `e2e/helpers.ts` and the dev-mode auth bypass already pinned in the suite.
- **Fold in debt:** add the **registration spec covering `merchants`-row creation** (logged as missing after Phase 1's Task 8) and the **safety-window 5-minute boundary unit test** (logged Phase 1 Task 4) if not already added — both are cheap here.

**Verify:** full suite green (`npm run test:unit`, `npx playwright test --project=api`, and the ui project). Report the pass counts, matching the ledger's format.

---

## Task 6 — Docs + progress ledger

- Update `README.md` and `docs/SETUP.md` for the new `institutions` onboarding (ops-invited), the ops matching console, and the `/inbound/[token]` view.
- Append Phase 2 to `.superpowers/sdd/progress.md` in the established format (task → commit → review verdict → triaged minors → follow-ups deferred to Phase 3).
- Mark any pre-pivot docs that Phase 2 further contradicts as superseded (institutions were "consumers" in the old model).

---

## Definition of Done (Phase 2)

0. **Task 0 hardening is merged first:** an unverified account can't reach `/api/scan` (C1), prod fails closed on missing keys (C2), `verifyOTPAction` no longer strands users, safety-expiry renders in the merchant's timezone, calendar-rollover dates are rejected, mothballed writes + unauthenticated listing reads are gated/removed, dead crons are off, and the flagged test gaps are closed.
1. An ops user can see tonight's declared loads, get ranked institution suggestions, and offer a load in one click.
2. An institution receives an **itemized inbound preview via a no-login link** and can accept or decline; acceptance is recorded as an `accepted` allocation and the load reads `matched`.
3. Donation-lane offers are hard-gated on `npo_verified` institutions; the gate lives in the RPC, not just the UI.
4. `confirmManifest` is a single transactional RPC (`confirm_and_declare`); the four folded debt items are retired.
5. All state transitions are guarded RPCs with atomic audit rows; every external call has a dev-mode path.
6. Full test suite green; whole-branch final review run and triaged; pushed to `main`.

**Blocked-by / carry-forward (v3):** the next phase is the slim **Delivery-log** (record the chosen method + handoff timestamps + blown-window flag) — no courier quotes, no route builder. Sale-lane allocation mechanics stay stubbed (`lane` column exists, donation lane only) until the receipt/valuation + Good-Samaritan wording clears CPA/counsel; the sale lane takes **0%**, so there are no Connect transfers to build.
