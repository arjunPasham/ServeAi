# 03 — Transition Plan: From Consumer Marketplace to Surplus OS

> ## ⚠️ MODEL UPDATE — v3 (2026-07-28): Phases 3–6 below are superseded
>
> **Phases 1 and 2 are built and still accurate.** The back half of this plan assumed
> FoodLink owns logistics; the v3 model is **records-only**, which cuts most of it:
>
> | This plan says | v3 reality |
> |---|---|
> | **Phase 3 — Route scheduling** (`routes`, `stops`, `courier_companies`, `stop_loads`, route builder, Google Routes multi-leg, driver magic-link) | **CUT.** Replaced by a slim **Delivery-log**: the two businesses pick a method, FoodLink records method + responsible party + pickup/delivery timestamps + a blown-window flag. No routing, no dispatch, no courier entity. |
> | **Phase 4 — Chain of custody** (`custody_events`, per-item accept/reject engine, temperature/excursion hard-stop) | **Mostly CUT.** Replaced by a lightweight **recipient confirm + dispute-window flag** ("recorded, not refereed"). No custody subsystem, no temperature tracking by FoodLink. |
> | **Phase 5 — Paperwork** (receipts from receiver-confirmed *custody* quantities, monthly impact report) | **Kept, slimmed.** Donation receipt (market value + cost basis, donee acknowledgment) generated from the recipient's *confirm*. Monthly report optional. |
> | **Phase 6 — Billing** (subscription **+ ~20% sale commission + Connect transfers**) | **Subscription only** — built. **Sale lane takes 0%**; money moves directly between businesses. No commission, no Connect transfers. |
> | **Phase 0 field work** — 3 courier quotes + route P&L | **Courier quotes CUT** (no couriers contracted). CPA/counsel on the receipt/valuation + Good-Samaritan wording, and the NPO-verify process (built), still real. |
>
> **Receiver = verified 501(c)(3) (donation) or verified business (sale)** — the
> `institutions` entity already built, no rework. The schema sketch and the entities
> `routes`/`stops`/`custody_events`/`courier_companies`/`sales`(commission) below are
> **not being built**; treat `loads`, `allocations`, `institutions`, `scan_*`,
> `valuation_table`, `invoices` (subscription) as the live set. Everything below is the
> original reasoning trail — read it as history past Phase 2.

Effort units = person-weeks for one competent developer working the way this repo was built (heavy AI assistance; the existing ~15k lines shipped in roughly three weeks, so these are aggressive-but-demonstrated velocities). Non-code work (counsel, quotes, recruiting) runs in parallel and is listed where it blocks.

**Migration posture:** build the new B2B core in **new tables alongside** the old schema — do not contort `listings`/`orders` into Loads and Routes (the audit shows the fit is bad and the browse page's `- COURIER_FEE_CENTS` patching is the warning of what half-reuse costs). Old tables freeze read-only; consumer routes come off the nav in week one; dead code is deleted opportunistically as each phase replaces it. Git history is the archive.

---

## Phase 0 — Decisions & field work (parallel, non-code, starts now)

Not a build phase, but four of the red-team CRITICALs are resolvable only here, and two of them block build phases:

| Item | Blocks | From 02-vulnerabilities |
|---|---|---|
| 3 written quotes from Atlanta refrigerated courier firms; route P&L with explicit cadence | Phase 3 sizing, all pricing | A1, A2 |
| Counsel memo: sale-lane structure (handling-fee vs. food-sale), Good Samaritan boundaries, courier-contract duties (FSMA STF, GA/county health codes), insurance stack | Phase 5 templates, Phase 6 sale lane | B1, B2, B4 |
| CPA review of receipt/valuation template (donee statement, basis handling) | Phase 5 | B3 |
| Goodr/Copia/Replate/Careit teardown + 30-merchant surplus survey | Recruiting, possibly metro choice | E1, E2 |
| FOUNDER DECISIONS: fee model, paid-pilot pricing, allocation policy, sale-lane money flow, courier contract structure | Phases 3/5/6 | A1, B1, C3, E3, 00-Q2/Q5/Q10 |

---

## Phase 1 — Scan → structured inventory (2.5 wks)

The pivot's foundation and the data moat's birthplace. Everything else consumes what this produces.

**Build**
- `scan_records` + `scan_items` persistence inside `POST /api/scan` (`src/app/api/scan/route.ts`) — every scan stored server-side at capture time: all items, quantities, confidences, photo key, raw model JSON. This closes the audit's worst finding (results currently discarded client-side in `src/components/FoodScanner.tsx`).
- Merchant manifest UI: FoodScanner reworked from pick-one-item to **confirm-the-manifest** (per-item edit/remove/add, one confirm tap). Target: 4 minutes for a 5-item case walk, matching the strategy's Bella's scene.
- `merchants` entity (migrate/extend `donor_profiles`): EIN, service days, contact, billing-ready fields. Merchant onboarding becomes ops-invited (self-serve registration off).
- Category taxonomy table (stable keys) + valuation table v1 (`fmv_per_lb`, `basis_per_lb`, versioned) — seeded from `usda_commodity_prices` + real Atlanta retail/wholesale references.
- Load declaration: confirming a manifest creates a **Load** (`declared` status) with earliest safety expiry computed via the existing FDA-window logic (`src/actions/listing.ts:17-21`).

**Kill in this phase:** pricing engine + slider (`src/lib/pricing.ts`, `PricingSlider.tsx`), consumer browse/checkout off the nav, listing-creation flow.
**Repurpose:** donor dashboard → merchant dashboard; admin price editor → valuation-table editor; scan service prompt re-aimed at valuation estimation (`src/services/foodVision.ts`).

**Milestone unlocked:** a real deli manager produces a structured, stored, valued manifest in under five minutes. The dataset starts accumulating from the first scan — even before anything moves.

## Phase 2 — Match (1.5 wks)

**Build**
- `institutions` entity (supersedes `consumer_profiles.type='shelter'`): 501(c)(3)/EIN verification status (ops queue in admin — reuse the license-review pattern, `src/app/(admin)/admin/dashboard/page.tsx`), standing demand profile (category keys, nightly capacity lbs, food-budget flag), receiving windows (keep the existing `receiving_window` JSONB shape — it was right), authorized-signer contact.
- `allocations`: tonight's declared loads × standing demand, surfaced in an **ops matching console** — ranked suggestions, one-click offer, manual override. No auto-matching in v1; the ops person is the algorithm and the console records their decisions (which trains the eventual real matcher).
- Institution notification: itemized inbound preview via push/email + a no-login web view (kitchen managers will not install an app).

**Milestone unlocked:** the strategy's headline moment — the shelter knows at 3:32 what's arriving at 6:45, itemized.

## Phase 3 — Route scheduling (2 wks) — *blocked by courier quotes/contract (Phase 0)*

**Build**
- `routes` + `stops` + `courier_companies`: ops route builder — drag loads into an evening route, order the stops manually, Google Routes (`src/lib/google-routes.ts`, extended to multi-leg) for ETAs and total duration; safety-window check refuses a plan that delivers any load past expiry (the cold-chain invariant from `cold-chain-check.ts`, re-aimed).
- Driver surface: a **magic-link mobile web page** per route (no account, no app): stop list, addresses, nav links, per-stop actions. Contracted firms won't onboard into our auth; a link texted to tonight's driver will actually get used.
- Route sheet fallback (printable/PDF) because the first courier firm may want paper.

**Kill in this phase:** internal courier fleet end-to-end — `src/actions/dispatch.ts`, `courier-dispatch.ts`, `dispatch-events.ts`, `(courier)/*` pages, `dispatch_events` usage, `get_nearest_couriers`, the `DELIVERY_MODE` flag and Uber provider (`src/lib/delivery/uber.ts`, `api/uber/webhook`). Keep the provider-interface + reconcile-on-read *pattern* (`src/lib/delivery/apply.ts` philosophy) as the shape of a future courier-API integration.

**Milestone unlocked:** a planned Tuesday route exists in software with a real courier company and real stop times.

## Phase 4 — Chain of custody (2 wks)

**Build**
- Driver stop flow on the magic-link page: *arrive → confirm load-out (counts) → temp reading → photo → depart*, per stop. Receiver flow at institutional stops: **per-item accept/reject** with reason codes + signer name — this is the partial-rejection gap (audit §5) closed, and the receiver-confirmed counts become the authoritative quantities for receipts (red-team C1).
- `custody_events` (append-only, same discipline as `audit_log`): typed events — `load_out`, `temp_reading`, `handoff_confirmed`, `item_rejected`, `photo` — with actor, source, server timestamp. Temperature lives here as typed rows (sensor feeds slot in later without schema change).
- Excursion hard-stop: a logged temp breach flags all downstream stops, notifies receivers, flips default to reject-with-informed-accept (red-team C4). Encoded, not SOP.
- Rejected-item disposition: auto-offer to downstream stops, else `rejected_returned` to merchant at route end (red-team C2).
- **Repurpose directly:** the pickup-code handoff pattern (`confirm_pickup`, `017_delivery_providers.sql:89-150`) becomes stop-confirmation; the dispute photo-upload path (`src/actions/feedback.ts:63-97`) becomes rejection evidence.

**Milestone unlocked:** *the pilot can run.* A real Tuesday route completes end-to-end with a full custody record — temps, timestamps, photos, per-item confirmations at both ends. **First paid pilot (3–5 merchants + 1–2 institutions) requires Phases 1–4 at working quality + Phase 5 at least semi-manual** — matching the business sequence: don't sign week-one merchants until the receipt exists in some form, because paperwork is the retention hook (red-team C5).

## Phase 5 — Paperwork: receipts, valuations, reports (2 wks) — *blocked by CPA/counsel template review (Phase 0)*

**Build**
- `receipts` + valuation snapshots: generated from **receiver-confirmed quantities**, per-lb FMV/basis values copied onto the receipt rows at issuance (never referencing the mutable valuation table), donee-acknowledgment capture as part of the receiving confirm (the signer is signing the donee's written statement — B3), PDF artifact in the private bucket.
- Monthly impact report per merchant: lbs diverted, meals (stated convention), CO₂ (versioned EPA WARM factors), **deduction documented** (not "claimed"), fee comparison. Emailed to the CFO contact; this is the anti-churn artifact.

**Milestone unlocked:** the 6:47pm receipt and the month-end report — the full Bella's promise. Pilot conversion/renewal conversations become possible.

## Phase 6 — Billing (1 wk) — *blocked by fee-model + sale-lane FOUNDER DECISIONS*

**Build**
- Merchant billing via **Stripe Billing** (subscription for weekly/monthly plans; usage-based invoice items if per-pickup wins): `stripe_customer_id` on merchants, `invoices` mirror table, dunning states. Until this ships, ops sends Stripe payment links by hand — acceptable for the first 5 merchants; say so, do it, move on.
- Sale lane per the counsel-approved structure: if "handling-fee" framing wins (B1), it's an invoice line to the institution; if genuine food sale, `sales` + commission and possibly resurrected Connect transfers (`src/lib/stripe.ts:128-263` — the one reason not to delete Connect yet).

**Milestone unlocked:** revenue arrives without a human copying numbers; sale lane is legally shaped before its first dollar.

## Phase 7 — Data pipeline for prediction (1 wk + ongoing)

Mostly *guaranteed by Phase 1's schema* rather than built here:
- Disposition close-out job: every `scan_item` ends in a terminal disposition (`donated` / `sold` / `rejected_returned` / `not_shipped` / `disposed`) — an Inngest nightly sweep flags dangling items so the dataset never rots.
- The "dumb reports": weekly per-merchant surplus patterns ("22 lbs of unsold salmon every Thursday for six weeks") — SQL, not ML, exactly as the strategy prescribes.
- A flat export/warehouse view (per-merchant/day/item grain) so future modeling never queries production shapes.

**Milestone unlocked:** the first surplus-intelligence email to a merchant — the prediction product's proof-of-concept, sold as *surplus intelligence*, not demand forecasting (red-team D1).

## Consumer layer — LAST, and parked now

Off the nav in Phase 1; `(consumer)`, checkout, claim/pricing code deleted as phases replace their dependencies; demo mode (`src/app/(demo)`) parked untouched (harmless, occasionally useful for showing the old prototype) until a merchant-pitch demo replaces it. The year-2 consumer lane will be a **new build on Load/Route rails** (excess capacity on paid routes, cold categories only) — nothing in the current consumer code presumes routes, so there is nothing worth preserving for it beyond the components library.

**Total: ~12 person-weeks of build** to full pilot capability (Phases 1–5), ~14 to billing + data pipeline, with Phase 0's field work as the true critical path (counsel + courier quotes gate Phases 3/5/6).

---

## MVP: the smallest real Tuesday-night route (5 merchants / 2 institutions)

**Software (must exist, because it *is* the product's evidence):**
1. Scan → confirmed manifest → declared Load (Phase 1)
2. Institution inbound preview (no-login web view) (Phase 2, minimal)
3. Driver magic-link stop flow + receiver per-item confirm — temps, photos, timestamps (Phase 4)
4. Receipt generated from receiver-confirmed data (Phase 5 — template may be ops-triggered rather than automatic)

**Manual behind the scenes (deliberately):**
- **Matching:** ops looks at the console (or a spreadsheet) and texts the kitchen manager. The allocation record still gets entered.
- **Route building:** ops sequences stops by hand; Google Maps for timing.
- **Courier dispatch:** a phone call to the contracted firm each afternoon; the driver gets the magic link by SMS.
- **Billing:** Stripe payment links / manual invoices.
- **Monthly report:** assembled from queries into a template by hand for month one.
- **Sale lane:** not in the MVP at all — donation lane only until the counsel memo lands.

The bar: at 3:30pm the deli manager scans; at 3:45 ops matches and texts; at 6:15 a real refrigerated driver opens a link on their phone; at 6:47 the shelter's kitchen manager taps confirm on 14 chickens and rejects one tray with a photo; the merchant's receipt exists by 7:00. If every step's *data* lands in the new tables, the MVP is honest even though three humans pushed buttons behind the curtain.

---

## Target architecture & schema sketch

**Architecture:** the platform layer survives unchanged — Next.js server actions + Supabase (RLS + SECURITY DEFINER RPCs for every state transition, atomic audit writes), Inngest for all timers/sweeps, private storage + signed URLs, dev-mode simulation for each external service (courier firm gets a `ManualCourierProvider`, following `src/lib/delivery/simulated.ts`). New surfaces: merchant app (scan/manifest/history/reports), institution web view (inbound + confirm), driver magic-link flow, ops console (matching, routes, partners, valuations — grows out of the admin dashboard).

**Entities** (names per the brief; ownership of state transitions stays in guarded RPCs like today):

```
merchants            id, business_name, ein, address(+geo, validated), contact,
                     service_days jsonb, plan(per_pickup|weekly|monthly), fee_cents,
                     stripe_customer_id, status, metro_id
institutions         id, org_name, ein, npo_verified(bool + evidence key), signer contact,
                     receiving_windows jsonb, demand: category_keys[], capacity_lbs,
                     has_food_budget, dock_notes, metro_id
courier_companies    id, name, contact, rate structure, refrigerated, insurance_expiry, metro_id

scan_records         id, merchant_id, scanned_by, photo_key, scanned_at, model_id,
                     overall_confidence, raw_response jsonb, needs_review
scan_items           id, scan_record_id, category_key → categories, food_name,
                     qty_value, qty_unit, est_lbs, est_servings, ai_confidence,
                     ai_count, merchant_confirmed_count, temperature_sensitive,
                     prepared_at, safety_expires_at,
                     disposition(donated|sold|rejected_returned|not_shipped|disposed), disposition_at

loads                id, merchant_id, window_date, lane(donation|sale), status
                     (declared→matched→scheduled→picked_up→delivered→closed | canceled),
                     earliest_safety_expires_at
load_items           id, load_id, scan_item_id, qty_at_pickup, qty_accepted, qty_rejected,
                     reject_reason, fmv_per_lb_cents, basis_per_lb_cents (snapshotted)
allocations          id, load_id, institution_id, lane, status(offered→accepted|declined),
                     offered_at, decided_at, decided_by

routes               id, route_date, window, courier_company_id, driver_name, driver_phone,
                     status(planned→dispatched→in_progress→completed|aborted),
                     quoted_cost_cents, actual_cost_cents, metro_id
stops                id, route_id, seq, kind(pickup|dropoff), merchant_id|institution_id,
                     planned_at, arrived_at, completed_at, status
stop_loads           stop_id, load_id                     -- a stop carries multiple loads
custody_events       id, stop_id, load_id?, load_item_id?, event_type(load_out|temp_reading|
                     handoff_confirmed|item_rejected|photo|excursion_flag), temp_f?, photo_key?,
                     actor, source(driver|receiver|sensor), created_at   -- APPEND-ONLY
                     (TempLog = custody_events where event_type='temp_reading')

receipts             id, load_id, merchant_id, institution_id, issued_at, signer_name,
                     acknowledged_at, fmv_total_cents, basis_total_cents,
                     enhanced_deduction_cents, method_version, pdf_key   -- values frozen at issue
sales                id, load_id, institution_id, subtotal_cents, commission_rate,
                     commission_cents, stripe_ref, status
invoices             id, party(merchant|institution), party_id, period, lines jsonb,
                     total_cents, stripe_invoice_id, status
impact_reports       id, merchant_id, month, metrics jsonb, factors_version, pdf_key
categories           category_key (immutable), label, temperature_sensitive, sort
valuation_table      category_key, fmv_per_lb_cents, basis_per_lb_cents, effective_from  -- versioned rows
```

**Schema decisions that are cheap now and expensive later** (the ones to get right even where the feature waits):
1. **`disposition` on `scan_items` from day one.** The prediction dataset is scan → outcome; bolting outcomes on later means forensic joins across four tables forever (that's exactly the state the audit found the old schema in).
2. **Immutable `category_key`s in a referenced table**, never display strings. Renaming "Deli — sliced" must not fork the time series.
3. **Snapshot valuations onto `load_items`/`receipts` at issuance.** An IRS-facing document that references a mutable price table is an audit finding waiting to happen; versioned `valuation_table` rows + copied values = both current and reproducible.
4. **Four quantity fields, not one** (AI count, merchant-confirmed, at-pickup, accepted-at-receiving). Collapsing them destroys the fraud-detection delta (C1) and the shrinkage signal (itself prediction-grade data).
5. **`lane` on the Load, not the item.** Donation and sale paperwork must never mix within a document trail (B3's poisoning risk); a mixed evening at one merchant = two loads.
6. **`metro_id` everywhere from day one.** One column now; a partition-key retrofit later.
7. **`custody_events` append-only with a `source` column.** When Bluetooth temp loggers arrive, sensor rows land beside driver rows with no migration — and driver-vs-sensor discrepancies become their own honesty dataset.
8. **Keep `raw_response` JSONB on scans.** Model outputs re-parse as taxonomies improve; the photo + raw JSON is the ground truth the future ML team will beg for.
9. **Integer cents, server timestamps, guarded-RPC transitions with atomic audit rows** — already house style (`004/007/012` migrations); carry it into every new table.

---

## Final summary

**Top 5 vulnerabilities** (full list in `02-vulnerabilities.md`):
1. **Route economics don't close at the implied nightly cadence** — $297/wk of fees vs. ~$490/wk of nightly courier cost per 3-merchant route; cadence and real courier quotes decide the business (A1/A2).
2. **The sale lane sits outside Good Samaritan protection** — a revenue-priced sale is ordinary products-liability; the handling-fee restructuring may capture the value inside the protection (B1/B2).
3. **The tax paperwork has teeth the docs skip** — donee-issued statement, merchant cost basis, sale-poisoning of donation status, pass-through caps; our receipt generator makes us quasi-tax-advisors (B3/A3).
4. **Goodr** — an Atlanta-based incumbent selling surplus logistics + tax docs + ESG reports, unmentioned in the strategy docs, in the launch metro (E1).
5. **Disintermediation is easiest at exactly pilot scale** — 5 merchants/2 institutions is handshake territory; the retention hook (paperwork) must ship *with* the pilot, not after (C5).

**Top 5 things to build first:**
1. Scan persistence (`scan_records`/`scan_items`) + manifest-confirm UI — stops the daily destruction of the data moat.
2. Load/allocation + the ops matching console with the institution's no-login inbound preview.
3. Route/Stop + the driver magic-link flow.
4. Custody events with per-item receiving confirmation and the excursion hard-stop.
5. The receipt + monthly report — the retention artifact that makes the fee defensible.

**Top 5 things to delete:**
1. Consumer browse/checkout/claim + the pricing engine and slider (`(consumer)/*`, `src/lib/pricing.ts`, `PricingSlider`, `claim_listing` path).
2. The internal gig-courier fleet (`courier-dispatch.ts`, `dispatch.ts`, `(courier)/*`, `dispatch_events`, `get_nearest_couriers`, `DELIVERY_MODE`).
3. Uber Direct point-to-point (`uber.ts`, uber webhook, delivery-reconcile's Uber path) — keep the provider-interface pattern only.
4. Stripe consumer-payment path (PaymentIntents at claim, claim-expiry watchdog, checkout page); hold Connect deletion until the sale-lane money-flow decision.
5. The pre-pivot docs as build inputs — PRD v2/TRD/AppFlow/UIUX and `N8N-BUILDER/CLAUDE.md` all describe the dead model; mark superseded so no future builder (human or AI) follows them, and prune the Serve AI doc's stale "route through Uber Eats" note.

**Open questions carried from Phase 1** (detail in `00-understanding.md`): the Tab 17 "merchants (food bank…)" parenthetical; sale-lane mechanics (price-setter, merchant-of-record, 80% flow); receipt legal authority (donee acknowledgment design); rejected-food disposition; fee model (per-pickup vs. weekly/monthly); route cadence; fate of the consumer code (parked — recommended above); pruning stale contradictory guidance in the Serve AI doc; institution 501(c)(3) verification process; who holds the courier contract. The FOUNDER DECISIONS among these are consolidated in Phase 0's table.
