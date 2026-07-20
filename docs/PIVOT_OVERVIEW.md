# FoodLink — Product Pivot Overview

*Assembled from `CLAUDE-FIX-PROMPT.md`, git commit history, and the live schema, because the transition doc referenced inside the migrations (`analysis/03-transition-plan.md`) isn't present in this folder. This is the closest thing to a single source of truth on how the model has changed — flag anything below that's wrong or incomplete.*

---

## 1. Where it started: a donation marketplace

The original product (`docs/FoodLink_PRD_v2.md`) was a three-sided marketplace:

- **Donors** (restaurants, verified households) photograph surplus food. AI prices it.
- **Consumers** (shelters, budget-conscious households) browse and buy at ≥30% below retail.
- **Couriers**, employed by the platform, get dispatched only after a sale is confirmed — never before there's a named buyer.
- Money moved donor → platform fee → courier fee at delivery confirmation.

This flow still exists in the code (donor/consumer/courier routes, `donor_profiles`, the original pricing/RLS/RPC migrations 001–013) and is frozen, not deleted.

## 2. Pivot A — drop the in-house courier fleet (`CLAUDE-FIX-PROMPT.md`)

A master fix/refactor brief at the project root (`CLAUDE-FIX-PROMPT.md`, one level above `ServeAi/`) called for:

- **Demo/simulate mode** — a logged-out walkthrough for showcases, fully separated from real data.
- **Correctness fixes** on the payout/dispute-window paths (silent DB failures, stale Stripe flags).
- **Delivery overhaul** — replace the owned courier fleet with **Uber Direct** (delivery-as-a-service, not the Uber Eats marketplace) or **consumer self-pickup**. Courier code stays in the codebase but gated off (`DELIVERY_MODE=uber|internal`), not deleted — "gate, don't delete."

This produced migrations 014–017 (Stripe Connect onboarding, an auth-trigger P0 fix, feedback-race fix, delivery-provider columns) and the `src/lib/delivery/` provider abstraction (`uber.ts`, `simulated.ts`).

**Status:** implemented in the working tree; migrations 014–017 have not yet been run against your Supabase project.

## 3. Pivot B — merchants become the paying customer (current, in progress)

This is the bigger shift, visible in every recent commit tagged `(pivot)`:

```
a888e14 feat(pivot): merchant scan->manifest->load UI + multi-item dev fixture
d8a84f5 fix(pivot): manifest actions — surface DB read errors, pre-check valuations
85838bb feat(pivot): manifest confirm + declare_load actions and RPC contract spec
ee05a36 feat(pivot): persist every scan itemized in scan_records/scan_items
cf8ab73 test(pivot): cover oz conversion and 0.1 floor in estimateLbs
594635b feat(pivot): pure libs for taxonomy, safety windows, valuation + vitest
5755841 feat(pivot): scan_records/scan_items/loads/load_items + declare_load RPC (020)
3848ab1 feat(pivot): merchants entity + donor backfill (019)
d6b4b8e feat(pivot): category taxonomy + versioned valuation table (018)
```

**The shift, in plain terms:** instead of the platform earning a cut of individual food sales to consumers, the business (a restaurant, grocer, caterer) becomes a **subscriber** — the flagship plan is **$99/week** (monthly and per-pickup tiers also modeled) — and pays FoodLink to handle their surplus food end to end.

**The new flow:**

1. **Scan** — a staff member photographs whatever won't sell tonight. AI identifies each item, estimates its weight, and flags anything low-confidence for manual review.
2. **Manifest** — the merchant reviews/edits the AI's read on each item (category, weight, prep time for anything temperature-sensitive) and confirms it.
3. **Declare a load** — confirmed items get grouped into a "load" for a pickup window. At that exact moment, the system snapshots a dollar value per item from a version-controlled price table (fair-market-value and cost-basis, per pound) — this snapshot never changes later, even if prices update, because it may need to hold up as a donation-value record.
4. **Dashboard** — the merchant sees each declared load, its total weight, its total valuation, and its status (declared → matched → scheduled → picked up → delivered).

Two lanes exist per load: **donation** and **sale** — the schema supports both, though only "donation" is exercised in the UI so far.

**Why this shape:** the schema comments call out that every scan is being persisted item-by-item, AI-original values alongside merchant-corrected ones, specifically to build a **prediction dataset** (scan → eventual outcome) for later — this looks like it's meant to feed a future model, not just serve today's transaction.

**Status — what's built:**
- Schema: `merchants`, `categories`, `valuation_table`, `scan_records`, `scan_items`, `loads`, `load_items` (migrations 018–020, not yet run against Supabase).
- Full scan → manifest → declare-load flow, working UI (`/merchant/scan`, `/merchant/dashboard`).
- Existing donors are auto-backfilled into `merchants` so nothing breaks for old accounts.
- Unit tests for the taxonomy/valuation/safety-window logic (vitest).

**Status — explicitly not built yet** (called out directly in code comments):
- **Matching/routing** — how a declared load actually finds its way to a recipient or buyer. The status enum (`matched`, `scheduled`, `picked_up`) exists; the logic to drive it doesn't yet.
- **Billing** — the $99/week charge itself isn't wired up (flagged "Phase 6").
- **Ops console** — a way to edit the price table without touching SQL directly (flagged "Phase 2+").
- **Receiving/reconciliation** — quantity actually picked up vs. accepted vs. rejected (columns exist, unused).

## 4. Open questions worth confirming with you

I inferred the above from code and commit messages, not a business narrative, so a few things are guesses:

- Is the original consumer marketplace (Pivot A world) being sunset, or does it keep running alongside the merchant-subscription model indefinitely?
- What does the **"sale" lane** mean in practice — merchants selling surplus directly through FoodLink, as opposed to donating it for a tax write-off?
- Is this currently a single-market pilot (the schema defaults every merchant to `metro_id = 'atl'`, i.e. Atlanta)?
- Who actually picks up a declared load today — is there a human ops process standing in for the "matching" logic that hasn't been built yet?

If you can fill in the "why" behind any of these — target customer, pricing logic, what a supervisor/investor most needs to understand — that'll make both this doc and the pitch deck sharper.
