# 00 — Understanding: What FoodLink Is Becoming

*Source material: the "Serve AI" strategy doc (sections "TGTG", "Fix info", "Tab 17" — read in full), the pivot brief, and the complete existing codebase + docs. Written 2026-07-16.*

> ## ⚠️ MODEL UPDATE — v3 (2026-07-28): this supersedes the logistics thesis below
>
> The model narrowed from "operating system for surplus food that **owns** the logistics"
> to a **records + introductions SaaS**. The sections below are preserved as the
> reasoning trail, but where they describe FoodLink owning or brokering delivery, they
> are **superseded**. Current model:
>
> - **Merchant is the customer.** Subscribes ($49 small / $99 standard / $199 high-volume
>   per week). FoodLink scans, values (market price **and** cost basis), and keeps the record.
> - **Receiver = a partner FoodLink introduces.** **Donations go only to a verified
>   501(c)(3)** (hard-gated on `npo_verified`); **discounted sales can go to a verified
>   business.** No households/consumers. One lane per load — donation *or* sale, never blended.
> - **FoodLink takes 0% of any sale** and never touches the delivery fee. Money moves
>   directly between the two businesses. (The old ~20% sale commission is **cut**.)
> - **Delivery is records-only.** FoodLink owns no fleet, dispatches nothing, brokers no
>   couriers, guarantees no cold chain. The two businesses pick the method (merchant
>   delivery, pickup, Uber Direct on the merchant's own account, a local courier, …);
>   FoodLink logs method + responsible party + pickup/delivery timestamps + a
>   **blown-safety-window flag**. The recipient confirms quality on arrival and may flag
>   a discrepancy in the dispute window — **recorded, not refereed.**
> - **Matching is manual** (a bounded directory; ops makes the first match by hand).
>   Auto-matching and visible profiles with request caps are future.
> - **Value prop = the enhanced federal deduction (IRC 170(e)(3))**, normally ~25 min/night
>   to document, made to cost ~60 seconds; plus the contemporaneous record that makes a
>   Good-Samaritan good-faith claim hold up. **Data moat unchanged** (scan → correction →
>   outcome → surplus prediction).
>
> **Cut from the original thesis below:** owning/brokering refrigerated couriers, route
> density as the unit-economics engine, batched cold-chain routes, taking title as the
> quality gate, and the ~20% sale take. Open questions #2 (sale mechanics), #5 (fee model),
> #10 (courier contract) are resolved by v3 (0% sale, tiered subscription, no courier contract).

## The model, restated in my own words

FoodLink stops being a consumer marketplace and becomes **the operating system for surplus food** — a B2B software-and-logistics layer that moves high-value cold perishables (meat, seafood, deli, prepared/catered food) from businesses that would trash them to institutions that can use them, on a schedule, with the paperwork done.

**Who pays whom:**
- **Merchants pay FoodLink** (per pickup or ~$99/wk / ~$400/mo) to make surplus disappear reliably. What they're buying is not charity — it's waste removal that beats the dumpster on cost, plus the enhanced federal tax deduction (IRC 170(e)(3): roughly cost basis + half the forgone margin) that most mid-size businesses never claim because the valuation paperwork is painful, plus a monthly ESG/impact report their sustainability team and CFO both want.
- **Institutions receive food free** in the donation lane (Good Samaritan-protected). When an institution with a food budget *buys* a load at a steep discount instead, **FoodLink takes ~20% of that sale** — a second revenue stream on the same route.
- **FoodLink never takes title to the food.** The receiving institution is the quality gate: they confirm or reject items, item-by-item, on arrival in-app. FoodLink owns the operations — scheduling, cold logistics brokerage, chain of custody, compliance — which is precisely what makes it un-droppable (the anti-disintermediation moat is owning the annoying parts).

**The daily loop (the product):** ~3pm, a deli manager spends four minutes photographing what won't sell. The AI turns photos into structured inventory lines (item, quantity, valuation ~retail and cost basis). The system matches the load to standing institutional demand — the shelter's kitchen manager sees the itemized inbound *before it arrives*, which no donation pipeline gives him today — and slots it into that evening's batched route. A **contracted refrigerated courier** (medical/pharma courier firms, catering fleets — explicitly *not* gig drivers, *not* on-demand) runs a loop: e.g. three merchant pickups → two institutional drops, paid per route (~$70 for four stops), amortized across the merchants on it. Temps, timestamps, photos, and confirmations are logged at both ends. Paperwork generates itself: donation receipt with IRS-ready valuation at handoff, monthly report (lbs diverted, meals, CO₂, deduction dollars) at month end.

**Route density is the unit-economics engine.** Individual drops never pencil; a dense batched evening loop does. Hence: one metro (Atlanta), 10–15 supply partners + 3–5 institutional receivers, routes to breakeven — *then* a consumer layer riding on routes that already pay for themselves, in cold categories only. The cheap bakery/surprise-bag segment is deliberately ceded to Too Good To Go, whose $1.79-fixed-fee, asset-light architecture structurally cannot fund couriers, cold chain, or guarantees — that's the gap FoodLink lives in.

**The quiet second business:** every scan is a record nobody in the industry captures — what went unsold, where, on what day. The schema must be designed for this from day one (near-free now, painful to retrofit). Year 1 ships "dumb reports" ("22 lbs of unsold salmon every Thursday for six weeks"); real surplus-*prediction* SaaS is the year-2/3 product that falls out of running year 1 well. No ML is built now.

**What this kills from the current build:** purchase-triggered on-demand dispatch, the consumer checkout/browse flow as the core loop, AI dynamic *pricing* for B2C (AI *valuation* for tax docs survives — same vision tech, different output), the internal courier marketplace (already dormant behind `DELIVERY_MODE=internal`), and the Uber Direct point-to-point integration as the primary fulfillment path.

## Open questions (ambiguities in the strategy docs — flagged, not guessed)

1. **Tab 17 typo or intent?** "Merchants **(food bank/discounted food servicer)** pay us" — the parenthetical contradicts every other section, where merchants are grocers/caterers/hotels and food banks are *receivers*. I proceed on the latter reading; confirm.
2. **Sale-lane mechanics are undefined.** When a church kitchen pays $60 for brisket: who sets the price? Who is merchant of record? Does the merchant get the other ~80%, and do they understand a *sold* load forfeits its donation deduction? Can one load be split donation/sale? The docs specify the 20% take and nothing else. **FOUNDER DECISION territory.**
3. **Receipt authority.** The docs say FoodLink auto-generates the merchant's donation receipt, but a contemporaneous written acknowledgment under IRC 170(f)(8) must come from the **donee** (the institution). Is FoodLink generating paperwork *on behalf of* the institution (needs their sign-off flow) or merely a valuation worksheet? The docs don't distinguish.
4. **Rejected-food disposition.** The institution rejects a tray mid-route — logged, yes, but where does the food physically go? Back on the truck to the next stop? Returned to merchant? Disposed by courier? The docs log the rejection and stop there.
5. **Fee model not chosen.** "Per pickup **or** monthly" appears throughout; the worked example uses ~$99/wk. These produce different merchant incentives (per-pickup discourages small loads). **FOUNDER DECISION.**
6. **Route cadence assumption.** The $70 route "covered across the three merchants on it" only works if fee revenue ≥ route cost at actual pickup frequency. 3 merchants × $99/wk = $297/wk vs. $70/night × 7 = $490/wk if nightly. The docs never state how many nights a week a route runs. (Full stress-test in 02-vulnerabilities.)
7. **Fate of the existing consumer product.** "Consumer layer last or deleted" — but a working consumer app exists and is the current demo asset. Mothball behind a flag (like the courier fleet) or delete outright? Affects the transition plan's shape.
8. **Stale contradictory guidance in the same doc.** The "Issues" section of the Serve AI doc still contains old-model direction ("route through Uber Eats... which allows you more certainty on your food arriving") that the newer strategy sections explicitly reverse ("Not Uber. Gig couriers can't do verified cold chain"). I treat TGTG/Fix info/Tab 17 as authoritative; the Issues section should be pruned to avoid a future builder following the wrong lane.
9. **"Institutions" verification.** Good Samaritan protection and 170(e)(3) both hinge on the receiver being a qualifying nonprofit. Nothing in the docs describes how FoodLink verifies 501(c)(3) status / care-of-needy use. Needed for the compliance story to be real.
10. **Who contracts the courier.** "You broker and schedule them; you don't employ them" — is the courier contract FoodLink↔courier-company (FoodLink carries the logistics contract and re-bills) or merchant↔courier with FoodLink scheduling? Liability and insurance both turn on this. **FOUNDER DECISION with counsel.**
