# 01 — Audit: What We Have vs. What the New Model Needs

> **⚠️ Historical (2026-07-16 model). See `00`/`03` v3 update boxes.** This audit's
> KEEP/REPURPOSE verdicts about the *platform layer* still hold, but anything scoped to
> the logistics model — routes, custody, courier brokering, a commission sale lane — is
> **out of scope in v3** (records-only delivery, 0% sale). Read it as a point-in-time
> map of the codebase, not a current build target.

Every claim below cites actual files. Verdicts: **KEEP** (works as-is), **REPURPOSE** (exists, wrong user/flow — changes stated), **KILL** (consumer-marketplace baggage), **MISSING** (nothing exists).

The one-line summary: **the platform layer is genuinely good and survives; the entire marketplace layer — which is most of the product surface — was built for the wrong customer.** And the crown jewel of the pivot (the scan dataset) is currently being thrown away at the moment of capture.

---

## 1. Platform & infrastructure

| Component | Files | Verdict | Notes |
|---|---|---|---|
| Next.js app shell, session middleware, role routing | `src/app/layout.tsx`, `src/proxy.ts`, `src/lib/supabase/middleware.ts` | **KEEP** | Role-prefix routing (`/donor`, `/consumer`, `/courier`, `/admin`) maps cleanly onto `/merchant`, `/institution`, `/ops` |
| Supabase clients (anon + service-role split) | `src/lib/supabase/server.ts`, `client.ts` | **KEEP** | Correctly avoids the service-client-with-user-JWT trap |
| Auth: register/login/OTP, app_metadata role storage, privilege-escalation lock | `src/actions/auth.ts`, `src/app/(auth)/*`, `supabase/migrations/002_schema.sql:33-48`, `015_fix_auth_trigger.sql`, `012_security_hardening.sql` (FIX 1) | **REPURPOSE** | Mechanism keeps; roles change (`donor`→merchant, `consumer`→institution, `courier` retired). Bigger change: B2B onboarding is ops-curated, not self-serve — signup becomes invite/approval, and institutions need 501(c)(3) verification (nothing exists for that; see §4) |
| **Append-only audit log, atomic with every state transition** | `002_schema.sql:230-239`, `005_audit.sql`, every RPC in `004/007/008/012/017` | **KEEP** | This is the embryo of the chain-of-custody product. The discipline (no transition without an audit row, no PII in payload, UPDATE/DELETE revoked) is exactly what the trust machine requires |
| Rate limiting (Upstash) | `src/lib/rate-limit.ts` | **KEEP** | |
| Twilio OTP, Resend email, OneSignal push | `src/lib/twilio.ts`, `email.ts`, `onesignal.ts` | **KEEP** | Notification targets change (merchant "courier inbound", institution "load matched") |
| Smarty address validation + `address_validated` gate | `src/lib/smarty.ts`, `017_delivery_providers.sql:27-28` | **KEEP** | Validated addresses matter *more* for routes |
| Google Routes ETA | `src/lib/google-routes.ts` | **REPURPOSE** | Today: point-to-point courier ETA. Needed: multi-stop route sequencing/durations. The Routes API supports waypticized routes; this wrapper only does A→B |
| Inngest client + serve route, error-throwing discipline | `src/inngest/client.ts`, `src/app/api/inngest/route.ts` | **KEEP** | Event catalog changes wholesale (see §4). The "supabase-js never throws — check every error and throw" pattern (`dispute-window.ts`, `delivery/apply.ts`) is house style worth keeping |
| Dev-mode simulation for every paid dependency | `stripe.ts`, `twilio.ts`, `smarty.ts`, `onesignal.ts`, `email.ts`, `delivery/simulated.ts`, `foodVision.ts` (dev bypass) | **KEEP** | The single best process asset in the repo — new integrations (courier company, billing) should follow it |
| Private storage bucket + signed-URL discipline | `009_storage.sql`, `src/app/api/scan/route.ts:88-107`, `src/actions/listing.ts:322-359` | **KEEP** | Chain-of-custody photos (pickup, drop, rejection evidence) reuse this wholesale |
| e2e harness (per-run contexts, cleanup, dev-mode webServer) | `e2e/helpers.ts`, `playwright.config.ts` | **REPURPOSE** | Harness keeps; every spec (`e2e/*.spec.ts`) tests the old flow and will be replaced as flows are replaced |
| n8n webhook layer (signed outbound/inbound) | `src/services/n8n.ts`, `src/app/api/n8n/webhook/route.ts`, `N8N-BUILDER/CLAUDE.md` | **KEEP** (mechanism) | Event names change. The N8N-BUILDER brief describes the old model and needs a rewrite before any workflow is built |
| Demo/simulate mode | `src/app/(demo)/*`, `src/lib/demo/*` | **REPURPOSE (later) or KILL** | It's a polished sales/demo asset — for the wrong model. A merchant-pitch demo of the new loop is worth having eventually; nothing in it blocks the pivot |

## 2. AI scan pipeline — the piece worth the most, currently leaking its value

| Component | Files | Verdict | Notes |
|---|---|---|---|
| Gemini vision scan (multi-item, per-item confidence, servings, conservative policy thresholds) | `src/services/foodVision.ts` | **KEEP** | Already returns an *array* of items per photo with per-item quantity/servings/confidence — the new model's "recognition machine" is closer than expected. Prompt needs re-aiming from "food-rescue marketplace" to catering estimation for valuation (it's already close: "professional catering estimator") |
| Scan API route (auth, rate-limit, photo persisted to private bucket) | `src/app/api/scan/route.ts` | **KEEP** | One structural flaw for the new model: **the scan result is returned to the client and never persisted.** Only the single item a donor taps becomes a listing (`src/components/FoodScanner.tsx:84-93`); the other detected items, the confidences, the notes, and scans that never become listings are all discarded. The strategy's data moat dies right here unless a `scan_records` write is added in the response path |
| Scanner UI | `src/components/FoodScanner.tsx` | **REPURPOSE** | Single-select ("tap the correct item") → batch confirm-all-items with per-item edit. The 3:15pm deli manager confirms a *manifest*, not one item |
| Category taxonomy + temp sensitivity | `src/types/food.ts`, `src/lib/category-map.ts`, `src/lib/temperature-map.ts` | **REPURPOSE** | FDA-based temp map keeps. Categories skew prepared-food; needs the cold-category taxonomy (deli, catering trays, dairy, meat/seafood cuts) and — for prediction — stable category IDs, not display strings |
| lbs conversion heuristics | `src/lib/category-map.ts:38-58` (`estimateLbs`) | **KEEP** | |

## 3. The marketplace layer — built for the wrong customer

| Component | Files | Verdict | Notes |
|---|---|---|---|
| Consumer pricing engine (±25% slider, 30%-below-retail floor, courier fee, platform fee) | `src/lib/pricing.ts`, `src/components/listing/PricingSlider.tsx`, `usda_commodity_prices` seed (`supabase/seed.sql`) | **KILL** (engine) / **REPURPOSE** (price table) | The entire discount-floor/slider apparatus is B2C baggage. The commodity table survives with a different job: **valuation basis for donation receipts** — which needs `cost_basis_per_lb` and `fmv_per_lb`, not `retail_benchmark` alone. `prevent_pricing_update` trigger (`007_fixes.sql:8-30`) is the right *idea* (lock valuations once documented) applied to the wrong columns |
| Listings + status machine (`draft→live→purchased→dispatched→delivered/hidden/disputed`) | `002_schema.sql:151-185`, RPCs in `004/007/008/012` | **KILL** as-is | Structurally wrong for B2B: one `detected_item` per row, six NOT NULL consumer-pricing columns, consumer-visibility states. The new unit is a **Load** (a merchant's evening batch of N items) matched to an institution — not a priced single-item listing racing consumers. The state-machine *discipline* (guarded RPC transitions + audit) is the template for Load/Route/Stop machines |
| Atomic claim (`SELECT FOR UPDATE SKIP LOCKED`) | `claim_listing` in `008_rpcs.sql`/`012` FIX 4, `e2e/concurrency.api.spec.ts` | **KILL** | Institutions don't race-buy at 3:32pm; matching is scheduled and ops-mediated. "Two institutions want the same load" is an allocation decision, not a row lock |
| Consumer browse/checkout/orders UI | `src/app/(consumer)/consumer/browse/page.tsx`, `checkout/[orderId]/page.tsx`, `orders/[id]/page.tsx`, `src/components/listing/ListingCard.tsx` | **KILL** (mothball) | The strategy's consumer layer returns in year 2 on paid-for routes — keep in git history, remove from the product. Note the browse page carries visible legacy-fee patching (`consumer_price_cents - COURIER_FEE_CENTS`, `browse/page.tsx:102,139`) — a preview of what half-repurposing schemas costs |
| Consumer payment: PaymentIntent capture-at-purchase, claim-expiry watchdog, webhook-driven fulfillment | `src/actions/payment.ts`, `src/lib/stripe.ts:32-118`, `src/app/api/stripe/webhook/route.ts`, `src/inngest/functions/claim-expiry.ts` | **KILL** (consumer path) | Stripe itself is repurposed (see §4: merchant billing + institutional invoices). The webhook-signature/idempotency patterns are reusable knowledge |
| Stripe Connect payouts (donor/courier Express accounts, transfers, `canReceiveTransfers` guard) | `src/actions/connect.ts`, `src/lib/stripe.ts:128-263`, `014_connect_onboarding.sql`, `scripts/cleanup-dev-stripe-accounts.sql` | **KILL** (probably) | In the new model *merchants pay us*; nobody needs a payout — **except** possibly the merchant's ~80% share in the sale lane. If sale proceeds flow merchant-ward through us, Connect transfers get resurrected. FOUNDER DECISION on sale-lane money flow before deleting (see 00-understanding Q2) |
| Internal courier fleet (dispatch loop, offers, GPS, accept/decline) | `src/actions/dispatch.ts`, `src/inngest/functions/courier-dispatch.ts`, `src/lib/dispatch-events.ts`, `get_nearest_couriers` (`008_rpcs.sql:140-176`), `src/app/(courier)/*`, `src/components/dispatch/*`, `dispatch_events` table | **KILL** | Already dormant (`DELIVERY_MODE=uber` default; courier registration closed, `src/actions/auth.ts:83-85`). Gig couriers are explicitly rejected by the strategy. Delete rather than carry: it's ~1,000 lines of dead weight and the `DELIVERY_MODE=internal` escape hatch invites backsliding |
| Uber Direct provider + reconciler | `src/lib/delivery/uber.ts`, `initiate.ts`, `apply.ts`, `src/app/api/uber/webhook/route.ts`, `src/inngest/functions/delivery-reconcile.ts`, `017_delivery_providers.sql` | **KILL** (Uber) / **REPURPOSE** (pattern) | Point-to-point on-demand is the old model. But the `DeliveryProvider` abstraction + webhook/poll-reconcile-converge design (`apply.ts` header comment) is exactly how a contracted-courier integration should be built — most refrigerated courier firms have no API, so the "SimulatedProvider" pattern becomes a **ManualCourierProvider** (ops marks stops via console/driver link) |
| Self-pickup handoff codes | `src/actions/pickup.ts`, `confirm_pickup` (`017:89-150`), pickup_code minting (`payment.ts:19-22`) | **REPURPOSE** | The best hidden asset outside the scan: code-verified handoff + atomic confirm + audit is precisely a **route-stop confirmation** primitive. Generalize from consumer-pickup to per-stop custody events |
| Dispute window / feedback (2h window, photo evidence, implicit accept, immutability) | `src/actions/feedback.ts`, `submit_feedback` (`013_merge_reconciliation.sql`), `src/inngest/functions/dispute-window.ts`, `feedback_events` + `016` unique index | **REPURPOSE** | The receiving institution's confirm/reject *is* the new quality gate — but it must become **item-level** (partial rejection) and stop being payment-escrow plumbing. Photo-evidence upload (`getSignedUploadUrl`, `feedback.ts:63-97`) reuses directly |
| Cold-chain expiry sweep | `src/inngest/functions/cold-chain-check.ts`, `hide_expired_listing` (`012` FIX 6), safety-window computation (`src/actions/listing.ts:17-21,175-195`) | **REPURPOSE** | FDA 2h/4h windows and the "never let expired food proceed" invariant survive; the *object* changes from marketplace listing to Load/Stop ("this load must reach the shelter by X; route accordingly"). Enforcement point moves from "hide from feed" to route planning + en-route alerts |
| Admin dashboard (USDA prices, license review, orders) | `src/app/(admin)/admin/dashboard/page.tsx` | **REPURPOSE** | Becomes the ops console seed: valuation table upkeep, partner verification queue. Orders view is consumer-shaped |
| Donor dashboard/listing flow | `src/app/(donor)/*` | **REPURPOSE** | Becomes the merchant app: scan → confirm manifest → done. The pricing/attestation steps are replaced by valuation-confirm + attestation (attestation itself keeps — Good Samaritan good-faith requires it) |

## 4. MISSING — the new model's core has no code at all

Ordered by how much the pilot bleeds without it:

1. **ScanRecord + ScanItem** — itemized, immutable capture of every scan (all items, quantities, confidences, photo key, merchant, timestamp), whether or not it becomes a load. *The prediction dataset.* Currently discarded in `FoodScanner.tsx` after one item is picked.
2. **Load** — a merchant's batch for a given evening: items, earliest safety expiry, disposition (donation | sale), status. Closest existing thing is a listing, which is one item + consumer prices.
3. **Route + Stop** — nothing exists. No entity for "one courier, Tuesday 6–8pm, Bella's → hotel → shelter → senior center", no stop sequencing, no per-stop status/custody events. This is the unit-economics engine and it is 0% built.
4. **TempLog** — no temperature field anywhere in the schema (checked all of `supabase/migrations/`; the only cold-chain data is the boolean `insulated_transport_capable`, `002:96`, and the handling-notes string sent to Uber, `initiate.ts:158-160`). Chain of custody is "core product" per the strategy; today we cannot record a single degree.
5. **Institution (real)** — `consumer_profiles.type='shelter'` + `organization_name` + `receiving_window` (`002:78-87`) is a stub. Missing: 501(c)(3)/EIN verification, standing demand profile (categories, nightly capacity), food-budget flag (sale-lane eligibility), receiving contact.
6. **Merchant (real)** — `donor_profiles` (`002:63-75`) is close (business, license, address, geo) but has no billing relationship, service schedule (pickup days/window), cost-basis defaults, or EIN.
7. **Receipt / Valuation** — nothing computes FMV + cost basis per item, generates a donation receipt, or captures donee acknowledgment (IRC 170(f)(8)). `usda_commodity_prices` is the seed of the valuation table only.
8. **Invoice / merchant billing** — no Stripe Billing/subscription/invoice code anywhere (`src/lib/stripe.ts` is consumer PI + Connect transfers only).
9. **Sale + commission** — no entity for "institution bought load N for $60, our 20% = $12". The consumer checkout is not this and can't be bent into it.
10. **Matching** — no supply↔standing-demand matcher. `getLiveListings` (`listing.ts:267-295`) is a browse feed; matching in the new model is category/quantity/route-position allocation against institutional profiles, initially ops-assisted.
11. **Route scheduling** — no batch assembly, no multi-stop optimization, no courier-company assignment.
12. **Monthly impact/ESG + deduction report** — nothing.
13. **Courier company registry** — contracted fleets, per-route rates, driver contacts: nothing (`courier_profiles` is gig-driver-shaped).
14. **Driver stop-execution surface** — the courier UI (`src/app/(courier)/*`) is gig-dispatch-shaped; a contracted driver needs a dead-simple route manifest: stop list, arrive/confirm/temp/photo per stop. Closest reusable piece is the pickup-code confirm pattern.

## 5. Can the current data model support the eight things the prompt asks about?

| Requirement | Verdict | Evidence |
|---|---|---|
| Itemized scan records | **No** | `listings` holds exactly one `detected_item` (`002:159`); multi-item scan results (`foodVision.ts` returns `items[]`) are never persisted; scans without listings vanish |
| Donation valuation | **No** | Pricing columns are consumer-sale math (`donor_payout_cents`, `consumer_price_cents`, `platform_fee_cents`, `courier_fee_cents`, all NOT NULL, `002:167-172`). No cost basis, no FMV-at-donation, no valuation-method provenance |
| Route/stop entities | **No** | Nothing. `orders.delivery_*` columns (`017:7-16`) track one point-to-point provider delivery |
| Temp + timestamp logging | **Half** | Timestamps: yes, genuinely strong — atomic audit rows on every transition (`004/007/008/017` RPCs), server-side clocks only. Temperature: zero fields |
| Partial rejection at receiving | **No** | `feedback_events` is one row per order with a single `outcome` (`002:218-225`); rejection granularity is all-or-nothing, and rejection reasons live in dispatch UI copy, not data |
| Merchant billing | **No** | No subscription/invoice objects; Stripe layer is charge-consumer + payout-donor |
| Per-sale commission | **No** | `platform_fee_cents` is a consumer-lane margin locked into the listing row; no sale entity, no % computation |
| Feeds the prediction product cleanly | **No, and this is the expensive one** | What prediction needs: per-merchant, per-day, per-item records with **disposition outcomes** (donated / sold / rejected / trashed) and stable category keys. What exists: single-item listings that only capture surplus *someone chose to list*, with outcomes smeared across `listings.status`, `orders.status`, `feedback_events`, and JSONB `audit_log.payload` — reconstructable only by forensic joins. The strategy's "design the scanning flow from day one so the data is clean" is currently violated at the first write |

## 6. Proportions (rough, by line count of `src/` + `supabase/`)

- **KEEP:** ~35% — infra, auth mechanics, audit/RPC discipline, scan service, notifications, dev-mode patterns, storage.
- **REPURPOSE:** ~25% — scanner UI, dashboards, feedback/receiving, cold-chain sweep, pickup-confirm, valuation table, delivery-provider pattern.
- **KILL:** ~40% — consumer browse/checkout/pricing/claim, internal courier fleet, Uber point-to-point, Connect payouts (pending sale-lane decision), old e2e specs.
- **MISSING:** the entire B2B core (14 items above). By *value*, the missing list is most of the company.
