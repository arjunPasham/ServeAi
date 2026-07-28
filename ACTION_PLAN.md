# FoodLink: Ambiguities & Founder Decisions — Action Plan

> **⚠️ Several of these are now RESOLVED by the v3 model (2026-07-28).** Sale lane = **0% take**, money direct between businesses (no commission). Fee model = **tiered subscription** ($49/$99/$199 per week). Courier contract = **none** — delivery is records-only, FoodLink brokers no couriers. Receiver = **verified 501(c)(3) (donation) or verified business (sale)**. Rejected-food disposition, route cadence, and courier-liability questions are **moot** under records-only delivery. Still genuinely open: automatic-matching policy, cost-basis capture at onboarding, and expansion-market sequencing. See the v3 boxes in `analysis/00-understanding.md` and `03-transition-plan.md`.

**Source:** 10 unresolved questions in Tab 17 + findings from analysis/00-understanding.md (Q1–Q10), cross-referenced against analysis/02-vulnerabilities.md (red-team CRITICAL/FIX BEFORE LAUNCH findings).

**Goal:** Consolidate all founder calls and counsel memos needed before Phase 1 starts, so build phases 3–6 don't discover blockers mid-sprint.

---

## CRITICAL — Blocks Phases 3/5/6 (Start Week 1)

### Q10: Courier Contract Structure
**The ambiguity:** "We broker and schedule; don't employ" — but does FoodLink hold the master contract with the courier company, or does each merchant? If FoodLink contracts them, we carry the logistics-arrangement duty under FSMA, the insurance liability, and the "shipper" seat with temperature specs.

**Why it matters:** 
- Liability allocation in a safety breach (temp excursion, dropped load).
- Insurance requirements (contingent cargo, non-owned auto — the courier firm's policy won't cover us).
- Courier firm is owed a clearer contract; merchants need to know who they're paying.

**Next step:**
- **Counsel memo** (Blocks: Phase 3 routing + Phase 5 receipts) answering:
  - Does FoodLink hold the courier contract with the company, or merchant-to-courier direct?
  - What FSMA "shipper" duties fall on us (likely: temperature specs + verification).
  - Insurance stack needed (CGL, contingent cargo, E&O, non-owned auto).
  - Sample contract language for Phase 3 build-out.
- **Founder decision:** Set expectations with the first courier firm (get those quotes early — see Q6).

**Owner:** Counsel + Founder | **Timeline:** Week 1–2 of Phase 0

---

### Q2: Sale-Lane Mechanics & Money Flow
**The ambiguity:** "Church kitchen pays $60 for brisket; we take ~20%" — but:
- Who sets the price? Merchant? Us? Mutual?
- Who is merchant-of-record (tax, liability)? Us or the merchant?
- If merchant gets ~80%, how does money flow? Stripe Connect (FoodLink collects, remits)? Or merchant invoices direct?
- Can one load split donation/sale, or must it be all-or-nothing?

**Why it matters:**
- **Liability shift:** An ordinary food sale (not cost-recovery) is outside Good Samaritan protection. The merchant AND plausibly FoodLink both face product liability for the sold items.
- **Tax classification:** If the merchant is merchant-of-record, they pay sales tax, claim the sale as revenue. If we are, we handle it.
- **Stripe Connect resurrection:** The old code (`src/lib/stripe.ts:128-263`) does merchant-of-record via Connect destination charges. If that model wins, we keep it; if FoodLink collects & remits, same machinery; if the merchant invoices direct, Connect deletion is clean.
- **Revenue recognition:** One load split donation (tax-deductible) / sale (revenue) breaks both the receipt documentation and the disposition dataset.

**Next step:**
- **Counsel memo** (Blocks: Phase 6 billing + Phase 5 receipt templates) answering:
  - Option A: FoodLink is merchant-of-record; institution pays us, we remit merchant share via Stripe Connect (resurrects Connect code).
  - Option B: "Handling-fee" model — institution doesn't buy food, pays us a logistics/coordination fee (stays inside Good Samaritan protection, much simpler legally, may capture most of the value).
  - Liability allocation under each option.
  - Sample contract language for institutional sale agreements.
- **Founder decision:** Which model? Recommendation: Option B (handling-fee) may be the actual answer — charge institutions a logistics fee for expedited matching, stay inside protection, avoid products-liability exposure.

**Owner:** Founder + Counsel + Finance | **Timeline:** Week 2 of Phase 0 (gated by Phase 6)

---

### Q6: Route Cadence — Nightly vs. 2–3x/Week
**The ambiguity:** The pitch is "every night surplus disappears reliably" (Bella's produces ~$250 nightly), which implies 7 route-runs per week. But the math doesn't close:
- 3 merchants × $99/wk = **$297/wk revenue**
- 7 nights × $70/route = **$490/wk courier cost**
- **Underwater by ~$193/wk** before software, ops labor, insurance, or margin.

The model only works if:
- (A) **5–7 merchants per route** from day one (needs dense metro clusters), OR
- (B) **Pickups run 2–3x/wk** (merchants hold product overnight in their walk-in; they have refrigeration).

The strategy doc conflates "one route is profitable" (one night: $70 cost vs. $297 of weekly fees across 3 merchants) with "route economics are profitable" (all 7 nights). And it never states the cadence.

**Why it matters:**
- Entire go-to-market pitch hinges on this (nightly = urgent demand signal; 2–3x/wk = lower-touch).
- Courier firm contract terms depend on it (dedicated vs. part-time).
- Merchant recruiting changes (nightly requires very dense markets; 2–3x/wk is sellable to wider indie base).
- Revenue model changes (if nightly + 3 merchants is underwater, the only fix is 5+ merchants *or* higher fees *or* lower cost).

**Next step:**
- **Courier quotes** (Blocks: Phase 3 sizing + all phases downstream) — **this is the critical-path item**:
  - Call 3 Atlanta refrigerated/medical courier firms.
  - Get a written quote for the exact loop: evening window (4–8pm), one nightly run, 5 stops (~Bella's + hotel + 2 midtown shelters + senior center), ~15 mi roundtrip, refrigerated.
  - Ask: "What if we run this 2x/wk instead? 3x/wk?"
  - This is a week of phone calls and reprices the whole business. Do it first.
  
- **Founder decision:** Based on courier quotes, decide:
  - Nightly (needs 5–7 merchants/route from pilot start) or 2–3x/wk (easier recruit, lower promise)?
  - Build one route P&L showing: pickups/merchant/week, merchants per route, courier cost, fee revenue, margin.
  
- **Pilot recruiting** flows from this (oversample dense-surplus merchants if nightly; broader indie base if 2–3x/wk).

**Owner:** Founder + Operations (courier calls) | **Timeline:** Week 1 of Phase 0 (parallel with counsel memos)

---

### Q5: Fee Model — Per-Pickup vs. Weekly vs. Monthly
**The ambiguity:** "Per pickup **or** monthly" — these incentivize completely differently:
- **Per pickup:** Discourages merchants from batching small loads; encourages high-volume players only.
- **Weekly/Monthly:** Flat fee; merchants can batch or not, no penalty.

The example uses ~$99/wk but never states which model is the intended default.

**Why it matters:**
- For a "make surplus disappear reliably" pitch, per-pickup penalizes merchants for small nights (they still get picked up, but the fee-per-lb gets worse on low-volume nights).
- For the ICP (long-tail independents with irregular surplus), weekly is more defensible.
- Revenue predictability: monthly is bookable; per-pickup is lumpy.

**Next step:**
- **Founder decision** (Blocks: Phase 3 P&L + Phase 6 billing logic):
  - Default to **weekly (~$99/wk) as the flagship offer**, with a **monthly tier ($350/mo) as the discount option** for low-volume merchants (less than 10 pickups/wk).
  - State this clearly so dev doesn't build multi-model pricing logic until it's proven necessary.
  
- **Phase 6 Stripe Billing** will model both, but billing starts simple: weekly recurring charge, monthly as a manually negotiated tier.

**Owner:** Founder + Finance | **Timeline:** Week 1–2 of Phase 0 (must inform Phase 6)

---

## FIX BEFORE LAUNCH (Week 2–3 of Phase 0)

### Q3: Receipt Legal Authority — Who Signs?
**The ambiguity:** IRC 170(f)(8) requires the **donee (the institution) to issue a written acknowledgment**, not FoodLink. The strategy says we auto-generate the merchant's donation receipt at 6:47pm, but legally:
- The receipt is the **institution's written statement** acknowledging receipt of the gift.
- FoodLink can generate it, but it must be signed by an authorized institution representative.
- The valuation (FMV + cost basis) can be worksheet, but the acknowledgment must be from the donee.

**Why it matters:**
- If our PDF is FoodLink-branded and unsigned by the institution, the IRS may reject it as the required contemporaneous written acknowledgment (CWA).
- The merchant's tax deduction hangs on this; an invalid CWA = no deduction = we failed to deliver the core promise.
- This is quasi-tax-advice territory; we need E&O insurance and a "documentation, not tax advice" disclaimer.

**Next step:**
- **CPA + Counsel review** (Blocks: Phase 5 receipt template) of:
  - The receipt template and signing flow (must capture authorized signer name, title, signature, date during receiving).
  - The signer should be the institution's representative, not FoodLink (they're signing the donee's CWA).
  - Valuation methodology review (how cost basis and FMV are computed, whether we use a commodity table or merchant-supplied numbers).
  - E&O insurance disclaimers ("FoodLink provides valuation estimates for documentation; this is not tax advice").
  
- **Product change** (Phase 4–5 boundary): The "per-item accept" flow when the institution receives must capture signer name, title, and timestamp. The receipt UI at Phase 5 auto-populates this; the signer is not FoodLink.

- **Test with pilot merchant** before scaling: take the first signed receipt to a local tax preparer and validate it would pass audit.

**Owner:** CPA + Counsel + Product | **Timeline:** Week 2 of Phase 0 (input to Phase 5)

---

### Q4: Rejected-Food Disposition — What Happens to the Tray?
**The ambiguity:** An institution rejects a tray mid-route (6:47pm, on the truck). The strategy logs the rejection and stops. Then what?
- Return to the originating merchant? (Cleanest legally — merchant keeps title.)
- Offer it to the next institutional stop? (More value-preserving.)
- Courier disposes? (Courier firms often refuse — not their job.)
- FoodLink takes it? (Worst option: we become a food business / waste hauler with a permit problem; "we never take title" dies.)

**Why it matters:**
- **Title and liability:** If we take possession of rejected food, we're holding food we don't own; that's a regulatory and liability trap.
- **SOP clarity:** Without a rule, drivers wing it at 7pm, sometimes escalating into disputes.
- **Merchant agreement:** Merchants need to know: "rejected items return to you" — it's part of the value prop (we handle the curation, institution is the quality gate).

**Next step:**
- **SOP + Founder decision** (Blocks: Phase 4 driver-app logic):
  - Rule: rejected items auto-offer to downstream stops on the same route (keeper for institution B if B also wants protein).
  - Anything unclaimed at route end returns to the originating merchant.
  - Never FoodLink or courier disposal.
  - Merchant agreement language: "Rejected items return to you at route end."
  
- **Counsel input** (for B2/B4 liability memo): confirm return-to-merchant is cleanest for Good Samaritan and liability purposes.

- **Phase 4 product task:** Driver app shows "item was rejected; auto-offer to next stop" + tracking of returns.

**Owner:** Founder + Operations + Counsel + Product (Phase 4) | **Timeline:** Week 2 of Phase 0

---

### Q9: 501(c)(3) Verification — How Do We Verify Nonprofits?
**The ambiguity:** Good Samaritan protection + the enhanced food deduction (IRC 170(e)(3)) both require the receiver to be a **501(c)(3) nonprofit using food for the ill/needy/infants**. The current codebase has zero verification:
- `consumer_profiles.type='shelter'` is a self-declared enum.
- No EIN verification.
- No Form 990 or 501(c)(3) letter upload.
- No "cares-of-needy" confirmation.

**Why it matters:**
- If FoodLink knowingly ships food to a non-qualifying entity claiming to be a shelter, Good Samaritan protection may not hold.
- The merchant's tax deduction and our compliance both hinge on the receiver being bona-fide.
- Regulatory risk: a donor food bank verifies; we should too.

**Next step:**
- **Operations task** (Phase 0, before pilot):
  - Set up a manual verification queue in the admin dashboard (reuse the license-review pattern already in the code, `src/app/(admin)/admin/dashboard/page.tsx`).
  - Verification inputs: institution name, EIN, upload 501(c)(3) letter + care-of-needy statement (e.g., "We serve 120+ individuals nightly").
  - Ops staff review & upload evidence to private bucket.
  - Institution `npo_verified` boolean + evidence key in the schema (see 03-transition Phase 2).
  - Gate institutional signup: must pass verification queue before receiving access.
  
- **Phase 2 schema** includes this; Phase 0 ops queue is the early setup.

- **Counsel guidance:** What documentation is sufficient? (A 501(c)(3) letter + recent IRS Form 990 should suffice; some may need a site visit.)

**Owner:** Operations + Product (admin UI) + Counsel | **Timeline:** Week 2–3 of Phase 0 (manual but lightweight)

---

### Related: Tax-Benefit Pitch Fails for Pass-Throughs
**The issue:** The strategy example says "Bella's is *up* money by paying us" because of the enhanced deduction. But this assumes taxable income to use the deduction. Pass-through entities (LLCs, S-corps, restaurant groups) are capped at 15% of aggregate net income. A thin-margin or loss-year deli gets little or nothing from the tax story.

**Why it matters:**
- The honest pitch for thin-margin independents is: waste-hauling cost recovery + staff time + ESG + guaranteed pickup — not "you're up money."
- Narrows the ICP (ideal customer profile) to profitable C-corps if the pitch leans on tax benefits.

**Next step:**
- **Finance + Sales decision** (Phase 0):
  - Model merchant value at deduction-cash-value = $0.
  - Confirm the $99/wk fee clears on waste-hauling + convenience value alone.
  - If it doesn't, acknowledge: the ICP is profitable C-corps and well-run groups, not all independents.
  - Pitch the after-tax number in the deck ($0 deduction → merchants still save waste-hauling costs; $800/mo deduction at 21% rate → the full ROI).
  
- **Recruiting:** Oversample merchants with hot bars and prepared-food programs (higher markup → more room for the deduction to matter).

**Owner:** Founder + Finance + Sales | **Timeline:** Week 1–2 of Phase 0

---

## CLARIFY FIRST (Low-Effort Fixes, Week 3 of Phase 0)

### Q1: Tab 17 Typo? "Merchants (food bank/discounted food servicer)"
**The issue:** The Tab 17 section says "Merchants **(food bank/discounted food servicer)** pay us" — but everywhere else:
- **Merchants** = grocers, caterers, hotels (suppliers of surplus).
- **Institutions** = food banks, shelters, senior centers (receivers).

This parenthetical contradicts the entire model.

**Next step:**
- **Founder clarifies:** Is this a typo? (Most likely.)
  - If typo: one sentence fixes the Serve AI doc. Done.
  - If intended: does the model include food banks as a second supply line? (Food banks often have older stock they'd donate-forward to other nonprofits.) Interesting but not in the pitch.
  
- **Recommendation:** It's a typo. Confirm it, update the doc to say "Merchants (grocers, caterers, hotels with prepared-food programs) pay us."

**Owner:** Founder | **Timeline:** Week 1 (30 minutes)

---

### Q7: Consumer Product Fate — Mothball or Delete?
**The issue:** A working consumer app exists (current demo asset). The pivot says "consumer layer **last or deleted**." Should it be mothballed behind a flag (like the internal courier fleet was) or deleted outright?

**Why it matters:**
- Deleting: clean break, less debt.
- Mothballing: keeps the code, the git history, and the component library for when the consumer layer returns in year 2 (the strategy does plan for this).

**Next step:**
- **Founder decision (low stakes):** Mothball.
  - Hide `/consumer/*` routes from nav in Phase 1.
  - Keep `/demo` mode untouched (it's a harmless sales asset).
  - Delete consumer-specific code (checkout, claim, pricing engine) opportunistically as phases replace their dependencies.
  - The component library will be reusable for year-2 consumer UI.
  
- **Phase 1 task:** Remove consumer nav links, set `CONSUMER_ROUTES_HIDDEN=true` or similar flag. No code deletion yet.

**Owner:** Product / DevOps | **Timeline:** Phase 1 (integration work)

---

### Q8: Stale Contradictory Guidance in Serve AI Doc
**The issue:** The Serve AI doc's "Issues" section still says "route through Uber Eats ... which allows you more certainty on your food arriving" — but the newer TGTG/Fix info/Tab 17 sections explicitly reject gig couriers ("Not Uber. Gig couriers can't do verified cold chain").

A future developer or AI reading the whole doc could follow the wrong lane.

**Why it matters:**
- The analysis phase flagged this; the strategy must be internally coherent before handoff to dev.
- Similar issue: the old PRD v2/TRD/AppFlow/UIUX docs describe the dead consumer-marketplace model and shouldn't be used as build inputs.

**Next step:**
- **Phase 0 doc cleanup:**
  - Prune the "Issues" section from Serve AI doc or mark it superseded.
  - Add a header comment to PRD v2/TRD/AppFlow/UIUX files: "⚠️ This document describes the pre-pivot model and is superseded by the Serve AI strategy (TGTG/Fix info/Tab 17 sections). Do not use as build input."
  - Keep the files (git history) but flag them clearly.
  
- **Goal:** No ambiguity about source of truth when a dev (or AI) reads the strategy.

**Owner:** Founder + Knowledge Mgmt | **Timeline:** Week 3 of Phase 0 (before handing to dev)

---

## Summary: Critical Path (Phase 0)

| Week | Owner | Blockers For | Deliverable |
|---|---|---|---|
| **1** | Founder + Operations | Phases 3–6 | 3 written courier quotes (nightly + 2x/wk pricing); founder decides: route cadence, fee model (weekly/monthly), Q1 Tab 17 typo clarification |
| **2** | Counsel + CPA + Founder | Phases 3–6 | Counsel memo (Q10 courier contract, Q2 sale-lane, Q4 rejected-food SOP, B1/B2/B4 liability); CPA review (Q3 receipt, basis handling); founder decides Q2 sale model + Q5 fee model |
| **3** | Operations + Product | Phases 2–4 | Ops verification queue for 501(c)(3) (Q9); doc cleanup (Q8); consumer-route hiding (Q7) |
| **Ongoing** | Finance + Sales | Phases 1–2 | Tax-benefit pitch scope (pass-through cap implications) + ICP refinement |

**After Phase 0 complete:** Build phases 1–6 have solid ground truth; no mid-sprint discovery of revenue-model or legal blockers.

---

## Mapping to Transition Plan Phases

From `03-transition-plan.md`:

| Phase | What it builds | Blocked by Phase 0 item(s) | Status |
|---|---|---|---|
| **Phase 1** | Scan persistence + merchant app | None (goes immediately) | ✅ Unblocked |
| **Phase 2** | Load/allocation + ops console | None (goes immediately) | ✅ Unblocked |
| **Phase 3** | Route scheduling + driver UI | Courier quotes + route cadence (Q6) | 🚫 Blocked until Week 1 |
| **Phase 4** | Chain-of-custody flow | Rejected-food SOP (Q4) + receipt legal review (Q3) | 🟡 Partially blocked |
| **Phase 5** | Receipts + reports | CPA/Counsel receipt template (Q3) + Sale-lane structure (Q2) | 🟡 Partially blocked |
| **Phase 6** | Billing | Fee model (Q5) + Sale-lane money-flow (Q2) | 🚫 Blocked until Week 2 |

**Recommendation:** Start phases 1–2 immediately (no blockers). Phase 0 field work (weeks 1–2) unblocks phases 3–6. Phase 4–5 can proceed with Phase 0 partial results (e.g., receipt template draft) and polish once counsel memos are final.
