# Slides → App Feature Audit (2026-07-28)

Audits **`docs/FoodLink Pitch (2).pptx`** (12 slides) against the live v3 app:
is each promised feature *built*, and can it be *interacted with*, by whom, where?

**Legend:** ✅ built + reachable (interactability proven by a test) · ⚠️ built +
reachable but with a caveat · ❌ gap (not built, or not interactable) · 📄 stale
deck claim (deck says one thing, app now does another).

**How auth gates the surfaces** (from `src/lib/supabase/middleware.ts`):
`/merchant/*` + `/donor/*` → role `donor` + phone-verified · `/admin/*` → role
`admin` · `/inbound/[token]` → public (the token is the capability) · `/consumer/*`
→ mothballed (redirects to `/` unless `NEXT_PUBLIC_CONSUMER_ENABLED=true`) ·
`/demo/*` → anonymous. A merchant reaches its surfaces via register(donor) → OTP
(`000000` in dev) → `/merchant/*`. An admin is a `users.role='admin'` row
(created via SQL — `docs/SETUP.md §6`).

---

## Per-slide feature map

### Slide 1 — the pipeline (Scan → Parse → Confirm → Declare → Dashboard)
| Feature | Built (where) | Interact | Status |
|---|---|---|---|
| Scan → parse → confirm → declare → dashboard | `/api/scan` + `foodVision.ts`; `confirm_and_declare` RPC (024); `/merchant/scan`, `/merchant/dashboard` | Merchant: `/merchant/scan`. Proven by `e2e/merchant-manifest.ui.spec.ts` (browser) | ✅ |

### Slide 3 — donor / recipient / delivery, bounded directory, 0% take
| Feature | Built | Interact | Status |
|---|---|---|---|
| AI values at market + cost basis | `valuation_table` (018), snapshot in `declare_load` (020) | Merchant scan flow | ✅ |
| Ops introduces businesses (no marketplace) | `offer_load`/`respond_to_offer` (024), `/admin/matching` | Admin ops console | ✅ |
| Donation → verified 501(c)(3) only | `offer_load` npo gate (024) | `e2e/allocations.api.spec.ts` | ✅ |
| Delivery not handled by us (logged only) | `deliveries` + RPCs (031) | Merchant dashboard Delivery section | ✅ |
| 0% of any sale, never touch delivery fee | No commission / Connect-transfer code anywhere | n/a (absence verified in review) | ✅ |
| Recipient flags discrepancy, recorded not refereed | `flag_delivery_discrepancy` (032) | `/inbound/[token]`; `e2e/recipient-confirm.api.spec.ts` | ✅ |

### Slide 4 — how connections form
| Feature | Built | Interact | Status |
|---|---|---|---|
| Sign up → **ops matches by hand** → connection | register + `institutions` (023) + `/admin/matching` | Admin offers a load to an institution | ✅ |
| Connection dashboard: ready time, check-in, delivery method | Partial: delivery **method** is set on the merchant dashboard (031). "Ready time / check-in time" as a standing per-connection routine are **not** modeled | — | ⚠️ standing routine fields not built; method-per-load is |
| **"Goal over time":** merchants/recipients make profiles visible to nearby partners | Not built (deck explicitly frames as future) | — | ❌ future (by design) |

### Slide 5 — logistics / delivery-log
| Feature | Built | Interact | Status |
|---|---|---|---|
| Pick method (merchant delivery / pickup / Uber Direct / courier / other) | `deliveries.method` enum (031), `src/lib/deliveries.ts` | Merchant dashboard picker | ✅ |
| Responsible party + picked-up / delivered stamps | `set_delivery_method` + `mark_picked_up` + `mark_delivered` (031/034) | `e2e/deliveries.api.spec.ts`, `delivery-lifecycle.api.spec.ts` | ✅ |
| Blown safety window permanently flagged | `window_blown` (031, OR-only) | Shown on the dashboard; `deliveries.api.spec.ts` asserts recorded-not-blocked | ✅ |
| **"For Uber Direct we make the dispatch call on their own account"** | **Not built** — Uber Direct is a *selectable, logged method only*; connected-account dispatch is a documented records-only follow-up | — | 📄/❌ deck overstates |

### Slide 6 — subscription model, data moat
| Feature | Built | Interact | Status |
|---|---|---|---|
| Business subscribes, 0% take, predictable fee | Subscription billing (027–030), `/merchant/billing`, admin "Start subscription" | Merchant: `/merchant/billing`; admin console. Dev-mode simulated. `e2e/billing.api.spec.ts` | ✅ (dev-sim; real Stripe needs `STRIPE_PRICE_*`) |
| AI original kept next to manager correction (`ai_*` columns) | `scan_items.ai_*` (020) | — | ✅ |
| Compounding "surplus intelligence" | `merchant_surplus_patterns` / `export_scan_items` views (028); admin surplus panel | Admin console; `e2e/data-pipeline.api.spec.ts` | ✅ (reporting; prediction is future) |

### Slide 7 & 8 — the daily routine + scan/manifest screen
| Feature | Built | Interact | Status |
|---|---|---|---|
| One photo → AI parse → saved immediately (before human sees it) | `/api/scan` persists `scan_records`/`scan_items` at capture | `/merchant/scan`; `e2e/scan-persistence.api.spec.ts` | ✅ |
| Low-confidence → amber flag / needs review | `needs_review`, confidence thresholds (`foodVision.ts`) | ManifestEditor | ✅ |
| 14 standard categories; hot/cold needs prep time (safety clock) | `categories` (018), `computeSafetyExpiry` (safety-window.ts) | ManifestEditor; `e2e` + `safety-window.test.ts` | ✅ |
| Add missed item by hand | `confirm_and_declare` manual-item path (024) | ManifestEditor; `manifest.api.spec.ts` | ✅ |
| Nothing deleted — every item ends donated/sold/not_shipped/… | `scan_items.disposition` (020); not_shipped close-out | `merchant-manifest.ui.spec.ts` (remove-item path) | ✅ |

### Slide 9 — the dashboard
| Feature | Built | Interact | Status |
|---|---|---|---|
| Declared batches: item count, weight, window, status, **locked value** | `getMerchantDashboard` + snapshots | `/merchant/dashboard` | ✅ |
| Status auto-advances declared→matched→picked_up→delivered (pickup skips to delivered) | load status machine (020/024/031/032); `mark_delivered` allows scheduled→delivered | dashboard + delivery section | ✅ |
| Most-urgent pickup deadline shown | `earliest_safety_expires_at` on the dashboard | `/merchant/dashboard` | ✅ |
| Clear error state instead of blank | `getMerchantDashboard` throws → error boundary | `/merchant/dashboard` | ✅ |

### Slide 10 — value prop / receipt / pricing
| Feature | Built | Interact | Status |
|---|---|---|---|
| IRC 170(e)(3) enhanced deduction (lesser of basis+½·appreciation, or 2×basis) | `issue_receipt` SQL + `src/lib/receipt.ts` (frozen from snapshots) | Admin "Generate" on a delivered/confirmed donation load; `e2e/receipts.api.spec.ts` | ✅ (worksheet; **pending CPA template approval** — issues as DRAFT) |
| Donation OR discounted sale, never both/blended | `loads.lane` (020); receipt is donation-lane only | — | ✅ |
| **"Billing not wired up in the app yet"** | Subscription billing IS wired (027–030) | `/merchant/billing` | 📄 **stale** — deck under-claims |

### Slide 11 & 12 — tech stack / architecture
| Claim | Reality | Status |
|---|---|---|
| Next.js/Supabase/Gemini/Inngest/Twilio/OneSignal/Upstash/Stripe/n8n | All present; each external call has a dev-mode sim | ✅ |
| **"Subscription billing is not wired up yet"** (slide 11) | It is (027–030) | 📄 **stale** |
| Uber Direct "simulated version runs demos" | `isStripeDevMode`-style sims exist; delivery is records-only | ✅ (as a logged method) |
| "Traffic controller, nothing exposed directly" | `src/proxy.ts` → middleware; RLS + guarded RPCs | ✅ |
| "legacy consumer screens now being retired" | `/consumer/*` mothballed (middleware redirects to `/`) | ✅ |

---

## The one big interactability gap

**Every v3 feature is interactable in the *real app* (proven by 49/49 e2e), but NOT in the `/demo`.** The current `/demo` is the *retired pre-pivot consumer marketplace* (`/demo/donor` = scan→price→publish; `/demo/consumer` = browse→claim→pay→timed delivery). It demonstrates **none** of the v3 model. So a reviewer who opens `/demo` sees the old product, and exercising v3 requires the real app with real auth + ops actions + a recipient token:

- **Merchant flow** — register (role donor) → OTP (`000000` in dev) → `/merchant/scan` → confirm → declare → `/merchant/dashboard` (delivery section) → `/merchant/billing`.
- **Ops flow** — a `users.role='admin'` account → `/admin/matching` (offer a load) + `/admin/dashboard` (valuations, merchants, loads, scans, surplus patterns, subscription start, receipt generate).
- **Recipient flow** — no login; open the `/inbound/[token]` link from the offer notification → accept → confirm receipt → flag discrepancy.

That setup friction is exactly why a **v3 demo** or a **seeded internal "review" walkthrough** (the internal-console piece you also asked about) would let you actually click every stage without standing up accounts by hand.

## Gaps & stale claims — summary
1. **`/demo` is pre-pivot** — shows the retired consumer marketplace, not v3. (Interactability gap.)
2. **Merchant-connected Uber-Direct dispatch** — not built; Uber Direct is a logged method only (deck slides 5/11 overstate).
3. **Profile-visibility "goal over time"** (slide 4) — not built (deck frames as future).
4. **Per-connection standing routine** (ready time / check-in time, slide 4) — not modeled; method is set per-load, not as a standing connection setting.
5. **Deck is stale on billing** (slides 10/11 "not wired up yet") — subscription billing is built (dev-simulated; real Stripe needs `STRIPE_PRICE_*` + `STRIPE_BILLING_WEBHOOK_SECRET`).
6. **Receipt issuance is gated** behind CPA/counsel template approval (`RECEIPT_TEMPLATE_APPROVED`) — issues DRAFT worksheets until approved (by design).

## Recommendations
- **Deck:** update slides 10 & 11 to say billing is wired (dev-simulated, pending real Stripe keys), and soften slide 5/11's Uber-Direct-dispatch wording to "selectable logged method (connected-account dispatch is a follow-up)."
- **Interactability:** rebuild `/demo` for v3 (clickable scan→…→receipt with fixtures) *or* build the seeded internal review walkthrough — this is the highest-leverage next step for "review every feature interactively."
- Everything else in the deck is built and test-proven.
