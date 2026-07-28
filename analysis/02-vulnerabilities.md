# 02 — Red Team: Where the New Model Cracks

> **⚠️ Historical (2026-07-16 model). See `00`/`03` v3 update boxes.** Several of the
> sharpest findings here red-team a model FoodLink **no longer runs**: route-density
> economics, courier cost vs. fee, and cold-chain liability all assumed FoodLink owned
> logistics — v3 is records-only, so those are moot. What **still applies** and is worth
> re-reading: the tax-paperwork findings (donee statement, cost basis, sale poisoning of
> donation status), NPO verification, disintermediation risk (now sharper — FoodLink is
> lighter-touch), and Goodr as an Atlanta competitor. Treat the logistics-economics
> findings as archived.

Severity: **CRITICAL** (model-threatening; resolve before committing the build) · **FIX BEFORE LAUNCH** (survivable, but not with real food/money/tax docs moving) · **WATCH** (real, monitor or word carefully). Each finding ends with what would resolve it.

---

## A. Unit economics

**A1. CRITICAL — The worked example is underwater at the implied cadence, and the strategy doc never states the cadence.**
The pitch to merchants is "surplus disappears *on schedule*" — Bella's trashes ~$250 *every night*. Nightly service means ~7 route-runs/week. At the doc's own numbers: 3 merchants × $99/wk = **$297/wk revenue** vs. 7 × $70 = **$490/wk courier cost**. Underwater by ~$193/wk per route before software, ops labor, or insurance. The model only pencils if (a) ≥5 merchants share each nightly route (M × $99 ≥ N × $70 → M ≥ 0.71 N), or (b) pickups run 2–3×/wk, which contradicts the "disappears on schedule, cheaper than the dumpster" promise for a deli producing surplus daily. The doc's example quietly conflates "route is profitable" (one night: $70 cost vs. $297 of weekly fees) with "route *economics* are profitable" (all the nights).
*Also note: the Tab 17 example doesn't agree with itself — it describes a route of Bella's + a hotel + two institutions (2 merchants, 4 stops) but says costs are "covered across the three merchants on it."*
**Resolve:** a one-page route P&L with explicit assumptions: pickups/merchant/week, merchants/route, runs/week. Decide the promise: nightly service (needs 5–7 merchants/route from day one) or scheduled 2–3×/wk (merchants hold product in their walk-in between pickups — most have refrigeration, so this is sellable). FOUNDER DECISION.

**A2. FIX BEFORE LAUNCH — $70/route is an unquoted number and probably low.**
A 3-pickup/2-drop evening loop across an Atlanta metro spread (Sandy Springs → Midtown shelters) is realistically 2.5–3.5 hours including load/unload/dwell. Medical and catering courier firms bill $45–90+/hr or per-stop rates that put this run at **$110–250**, not $70. Every downstream number inherits this input.
**Resolve:** three written quotes from Atlanta refrigerated/medical courier companies for the exact loop (evening window, refrigerated, ~15 mi, 5 stops). This is a week of phone calls and it reprices the whole business.

**A3. FIX BEFORE LAUNCH — the merchant value story leans on a tax benefit many target merchants can't fully use.**
"Bella's is *up* money by paying us" assumes the enhanced deduction converts to cash. It converts at the merchant's marginal rate *only if* they have taxable income. The long-tail wedge (independents, restaurant groups) is heavily pass-through entities, where the enhanced food deduction is capped at 15% of the aggregate net income from the business — a thin-margin or loss-year deli gets **little or nothing** from the tax story. For them the honest pitch is: waste-hauling offset + staff time + ESG story + "someone reliably takes it." That's a weaker pitch than "you're up money."
**Resolve:** segment the pitch. Model merchant value at deduction-cash-value = $0 and confirm $99/wk still clears; if it only clears with the deduction, the ICP narrows to profitable C-corps and well-run groups — say so in the sales plan.

**A4. WATCH — the sale lane is seasoning, not economics.**
20% of a $60 sale is $12. Route cost is $70+. Even an implausible 50 institutional sales/week/metro is ~$600/wk. Institutional food budgets are real but small and grant-cycled. Keep the lane (it's strategically important as the future consumer-lane's legal/billing dress rehearsal) but no plan should depend on its revenue in year 1.
**Resolve:** track it as a metric, exclude it from breakeven math.

**A5. FIX BEFORE LAUNCH — low-volume nights, holidays, and no-shows are the same failure: route fixed-cost meets variable supply.**
A scheduled route with 2-of-4 merchants empty still costs full freight. Holidays cut both sides at once (merchants closed, institutions closed, but catering surplus *spikes* around events). A courier no-show on a perishables route doesn't cost a refund — it costs the core promise ("reliably") with every merchant on the route simultaneously.
**Resolve:** (1) day-before load declaration by merchants (the 3pm scan doubles as this) with a route-run/no-run decision rule; (2) a second contracted courier firm as standby from day one; (3) fallback SOP: merchant holds cold product overnight → morning re-route, or institution self-haul (some food banks run trucks — the strategy doc itself notes self-haul partners are *better* for us).

---

## B. Legal / compliance edges

**B1. CRITICAL — the sale lane is outside Good Samaritan protection, and the doc's framing blurs how sharp that edge is.**
The Bill Emerson Act (as expanded in 2023 by the Food Donation Improvement Act) protects donors and nonprofit donees for good-faith donation of apparently wholesome food — and the 2023 expansion's "reduced price" lane covers only a **"good Samaritan reduced price": at or below the cost of handling, administering, processing, transporting, etc.** $60 for brisket "instead of $220 wholesale" is revenue, not cost-recovery — that transaction is an ordinary food *sale* carrying ordinary products-liability exposure for the merchant **and plausibly for us** as the arranging platform (several states extend strict liability to marketplace facilitators; the old PRD §6.2 already knew this). Same cooler, same night: the donated tray is federally shielded; the sold tray next to it is a lawsuit surface.
**Resolve:** counsel memo *before the first sale* answering: who is seller-of-record; contract allocation of product liability; whether pricing sales at documented cost-of-handling (which the 2023 amendment protects) captures most of the lane's value with none of its exposure — that may be the actual answer: charge institutions a **handling fee, not a food price**, stay inside the protection, and take the margin as a logistics fee. FOUNDER DECISION with counsel.

**B2. CRITICAL — FoodLink itself is not clearly a protected party even in the donation lane.**
The Act protects donors and nonprofit distributors. A for-profit logistics coordinator in the middle is not an enumerated protected class. "We never take title" helps against product claims, but our own conduct — routing that let TCS food ride 3 hours, a driver we vetted, a temp log we designed — is *our* negligence exposure, not the donor's. And our chain-of-custody records are discoverable: they prove diligence when clean and prove knowledge when not (an excursion logged at stop 2 and delivered anyway at stop 3 is a plaintiff's exhibit).
**Resolve:** insurance stack before first route: CGL, contingent cargo + non-owned auto (courier firm's policy will not cover us), E&O for the coordination service; plus an operational rule that logged excursions *hard-stop* downstream delivery (build this into the product, not the SOP — see C4).

**B3. FIX BEFORE LAUNCH — the enhanced-deduction paperwork has four teeth the docs skip.**
For IRC 170(e)(3): (1) the donee must be a 501(c)(3) using the food for the ill/needy/infants and **may not transfer it for money or services** — so a load the institution *buys* is not deduction-eligible, and donation/sale lanes must be segregated at the data and paperwork level or sold loads poison donation documentation; (2) the donor needs a **written statement from the donee** — our "automatic receipt at 6:47pm" is legally the *institution's* acknowledgment, so the receiving confirmation flow must be designed as the donee's signed statement (authorized signer, their name on it), not a FoodLink-branded PDF; (3) deduction = basis + half the appreciation, capped at 2× basis — which requires the merchant's **actual cost basis**, a number we don't have and currently have no field for; a commodity-table estimate of basis on an IRS document is how we become a co-defendant in a merchant's audit; (4) full enhanced treatment differs for C-corps vs. pass-throughs (15% income cap). Also: generating IRS-facing valuations makes us quasi-tax-advisors — E&O insurance and a "documentation, not tax advice" disclaimer are mandatory.
**Resolve:** one CPA/tax-counsel review of the receipt template + valuation methodology; add `cost_basis` as merchant-supplied (with our estimate as default clearly labeled); receipts issue from **receiver-confirmed quantities**, not merchant scans (also kills valuation-inflation gaming, C1).

**B4. FIX BEFORE LAUNCH — food-transport law is unaddressed in the strategy docs.**
Two regimes apply and neither is mentioned: (1) **FSMA Sanitary Transportation rule** — shippers/loaders/carriers/receivers of food by motor vehicle have specified duties (temperature specs, vehicle sanitation, records); as the party *arranging* transport we likely sit in the "shipper" seat with the duty to specify and verify temperature control (small-carrier exemptions exist — the contracted firm may be exempt; the duty-holder analysis still has to be done); (2) **Georgia/county health codes** — transporting TCS food (≤41°F / ≥135°F holding) and county-level requirements in Fulton/DeKalb for handling prepared food may require permits for somebody in the chain. Good Samaritan protection does not waive health-code compliance.
**Resolve:** a compliance memo (GA food-law attorney or even the county environmental health office directly) answering: what permits, whose duty, what the courier contract must certify. Cheap, fast, and the answer shapes the courier contract.

**B5. WATCH — the temp log as designed doesn't meet any recognized standard, so don't market it as one.**
A driver hand-entering "38°F" at pickup is a *trust artifact*, not a validated cold chain: no calibrated instrument, no continuous logging, unmonitored gaps between stops, self-reported by the party with an incentive to type a clean number. Fine for the pilot; false if marketed as "verified cold chain."
**Resolve:** word it as "documented handoff temperatures" until Bluetooth data loggers (~$40–80/cooler, continuous curves) ship in phase 2 of custody — which also becomes a genuine differentiator and a nicer dataset.

**B6. WATCH — sale-lane money handling re-opens the money-transmission question.**
If we collect the institution's $60 and remit ~80% to the merchant, we're holding third-party funds — the old TRD's blocking decision #9 (MTL/MSB) returns. Stripe Connect destination charges (merchant as merchant-of-record) mostly sidestep it, and conveniently the Connect code we'd otherwise delete (`src/actions/connect.ts`, `src/lib/stripe.ts`) is exactly this machinery.
**Resolve:** decide sale-lane money flow (B1's memo covers it); if merchant-of-record via Connect, keep that code path alive.

---

## C. Product / flow edge cases

**C1. FIX BEFORE LAUNCH — merchant inflates the scan (quantity or value).**
Our receipt certifies numbers a merchant self-reported into a system we run. Fraud here is *our* credibility problem at IRS-document quality.
**Resolve:** three cheap controls that also close other holes: (1) receipts issue from **receiver-confirmed** counts (the institution has zero incentive to inflate); (2) photo is mandatory per scan and the AI count is stored beside the human count — deltas flagged; (3) valuation comes from our table, never merchant-typed. Merchant sees "estimated at scan, finalized at delivery confirmation."

**C2. FIX BEFORE LAUNCH — partial rejection mid-route has no defined food-disposition path.**
The doc logs the rejection and stops. The tray is now on a truck at 6:47pm. Options ranked: offer to the next institutional stop (needs item-level re-allocation in the driver flow); return-to-merchant at route end (merchant's dumpster, merchant's title — cleanest legally); courier disposal (courier firms will refuse or charge). Never: FoodLink takes it (the moment we take possession of rejected food we're a food business/waste hauler with a permit problem, and "we never take title" dies).
**Resolve:** SOP + one product decision: rejected items auto-offer to downstream stops; anything unclaimed returns to the originating merchant. Write it into the merchant agreement ("rejected items return to you") so the promise stays honest.

**C3. FOUNDER DECISION (frame before launch) — allocation when two institutions want the same load, and its ugly twin: donation vs. sale.**
The moment a paying church kitchen and a non-paying shelter both want Thursday's brisket, "matching" becomes policy. Preferring the sale is revenue; preferring the shelter is the mission; either choice, unstated, will eventually be a reputational story ("startup sells donated-quality food away from shelters").
**Resolve:** an explicit, publishable allocation rule (e.g., standing donation commitments fill first; sales take true overflow only). This is 30 minutes of founder decision now vs. a news cycle later.

**C4. FIX BEFORE LAUNCH — temp excursion mid-route needs a hard-stop rule in software.**
If stop-2 logging shows a breach, delivering stops 3–4 anyway converts a logged accident into documented knowledge (see B2). The receiving institution being "the quality gate" doesn't absolve us — we knew first.
**Resolve:** excursion → downstream stops flagged, receiving parties notified in-app, item-level accept requires explicit "informed accept," and the default is reject. Encode it; don't leave it to a driver's judgment at 7pm.

**C5. CRITICAL (strategic) — disintermediation is *most* dangerous at exactly the pilot's scale.**
5 merchants / 2 institutions is the one configuration where a handshake beats us: one shelter van, one deli, month four, no more $99/wk. The strategy's real answers — route density (a shelter can't run 3-merchant loops), paperwork (they can't self-generate 170(e)(3) documentation), and reports — are all *scale* answers; the pilot doesn't have scale yet.
**Resolve:** contractually: 6-month initial merchant terms; product-wise: front-load the paperwork value (the receipt/report is the retention hook, ship it in the pilot, not after); relationally: FoodLink introduces merchants and institutions *through the app*, and the monthly report lands on the CFO's desk with our name on the deduction math. Accept some leakage as marketing ("they met through us" still seeds the metro).

**C6. WATCH — supply/demand mismatch nights.**
No institution matches tonight's 200 lbs (over-supply), or capacity exists but categories don't (shelter needs protein, tonight is 40 lbs of cut fruit). If we pick up unmatched food anyway, we become its owner (see C2). If we skip pickup, "make it disappear reliably" needs an asterisk.
**Resolve:** contract wording: service = scheduled pickup of *matched* loads + best-effort matching; recruit a wide-mouth fallback receiver (a food bank warehouse with a dock takes almost anything) as every route's terminal stop. That single partnership converts most "no match" nights into "matched, lower-value" nights.

**C7. WATCH — the institution side has failure modes the docs treat as solved.**
Evening receiving assumes staffed docks at 6:45pm: shelters yes, senior centers often closed by 5. Kitchen manager churn breaks the "he knows at 3:30 what he's serving at 7" habit loop. And an institution that confirms sloppily (accepts everything, confirms nothing) quietly corrupts both custody records and receipts.
**Resolve:** receiving-window data per institution (the schema already has `receiving_window` on profiles — one thing the old model got right); a confirm-rate metric per institution; route-building respects windows.

---

## D. Data honesty

**D1. FIX BEFORE LAUNCH (wording) — the year-1 "data moat" is a spreadsheet, and it's biased.**
10–15 merchants × ~4 scans/wk × ~5 items ≈ **~15k item-rows in year one**. That's valuable *operational* data and zero ML moat. Worse, it's censored: we observe only surplus that survived to 3pm and was worth scanning — never what sold (no POS access), never what was trashed unscanned. The strategy doc is honest about sequencing ("don't build prediction yet, ship dumb reports") — but its pitch line "every scan builds the dataset that *becomes the prediction product*" oversells what this data can predict. Surplus-pattern reports ("22 lbs of salmon every Thursday") are fully supported; demand forecasting ("you *will* over-order salmon") requires sell-through data we have no path to until merchants grant POS access — a year-2 ask that should be in the plan explicitly.
**Resolve:** promise "surplus intelligence," not "demand prediction," until a POS integration exists. Design the schema now (disposition outcomes, stable category keys, per-merchant/per-day grain — see 03) so the data is *clean*; that part of the strategy is right and cheap.

**D2. WATCH — impact-report numbers need a methodology or they're greenwash bait.**
"CO₂ avoided" requires a cited factor set (EPA WARM is the standard); "meals created" needs a stated lbs-per-meal convention (USDA's 1.2 lbs is common); "tax dollars claimed" is unknowable to us — we know what we *documented*, not what they filed.
**Resolve:** versioned conversion factors in data, methodology footnote on every report, and the phrase "deduction documented" everywhere "claimed" appears.

**D3. WATCH — the doc's own example math is directionally fine but conflates deduction with cash.**
"~$3,800 in enhanced deductions documented" against a ~$400/mo fee reads as 9.5× ROI; the *cash* value of that deduction at a 21% rate is ~$800/mo — still >2× the fee, still a good pitch, but the merchant's accountant will do this math even if our deck doesn't.
**Resolve:** pitch the after-tax number. It survives scrutiny; the headline number invites it.

---

## E. Market assumptions

**E1. CRITICAL (for Atlanta specifically) — the strategy docs never mention Goodr.**
Goodr is an **Atlanta-founded, Atlanta-based** company whose pitch is nearly word-for-word ours: surplus food pickup with logistics, tax-deduction documentation, and sustainability/ESG reporting. The docs name-check Careit and Food Rescue Hero and correctly cede Publix — and miss the incumbent headquartered in the launch metro. Atlanta merchants who've heard any pitch in this category heard it from Goodr. Differentiation is arguable — Goodr skews enterprise/events/airports; our wedge is long-tail independents, itemized scan-level data, standing institutional matching, and the sale lane — but it must be *argued*, and "nobody has built the commercial hybrid well" needs to become "nobody has built it self-serve for the long tail."
**Resolve:** a one-day competitive teardown (Goodr, Copia, Replate, Careit, Too Good To Go Platform): pricing, minimums, who they won't serve. If Goodr's minimums exclude a 2-location grocer — that's our opening sentence in every Atlanta pitch. Consider whether launch-metro choice should be revisited at all. FOUNDER DECISION.

**E2. FIX BEFORE LAUNCH — validate that the long tail's surplus is dense enough.**
Bella's ($250/night, every night) is a top-decile independent. Many small delis produce irregular, small, or mostly-ambient surplus. The 10–15-merchant pilot *is* the test, but recruiting should oversample to find the density: target merchants with hot bars, rotisserie programs, full-service delis, and catering ops — not "any independent grocer."
**Resolve:** a two-week field survey (walk 30 Atlanta candidates, ask what they trash nightly) before signing courier contracts sized to an assumption.

**E3. WATCH — paid-from-day-one vs. free pilot.**
A free pilot tests logistics but not the only assumption that kills the company (willingness to pay). A full-price pilot suppresses recruitment.
**Resolve:** FOUNDER DECISION; recommendation: discounted-but-paid ($49/wk pilot pricing, founding-member framing), because a merchant who won't pay anything is data too.

---

## Severity roll-up

| # | Finding | Severity |
|---|---|---|
| A1 | Route math underwater at implied nightly cadence; cadence never stated | CRITICAL |
| B1 | Sale lane outside Good Samaritan; consider handling-fee structure instead | CRITICAL |
| B2 | FoodLink itself unprotected; custody logs cut both ways | CRITICAL |
| C5 | Disintermediation easiest at exactly pilot scale | CRITICAL (strategic) |
| E1 | Goodr — unmentioned Atlanta incumbent with the same pitch | CRITICAL (go-to-market) |
| A2 | $70 route cost unquoted, likely low | FIX BEFORE LAUNCH |
| A3 | Tax-benefit pitch fails for thin-margin pass-throughs | FIX BEFORE LAUNCH |
| A5 | Low-volume nights / holidays / courier no-show SOPs | FIX BEFORE LAUNCH |
| B3 | 170(e)(3) teeth: donee statement, basis, sale-poisoning, entity caps | FIX BEFORE LAUNCH |
| B4 | FSMA sanitary-transport + GA county health codes unexamined | FIX BEFORE LAUNCH |
| C1 | Merchant inflation → receipts from receiver-confirmed counts | FIX BEFORE LAUNCH |
| C2 | Rejected-food disposition undefined | FIX BEFORE LAUNCH |
| C4 | Temp-excursion hard-stop must be in software | FIX BEFORE LAUNCH |
| D1 | Year-1 data ≈ 15k biased rows; pitch surplus-intelligence, not prediction | FIX BEFORE LAUNCH (wording) |
| E2 | Long-tail surplus density unvalidated | FIX BEFORE LAUNCH |
| A4 | Sale-lane revenue is immaterial in year 1 | WATCH |
| B5 | Manual temp entry ≠ any recognized standard | WATCH |
| B6 | Sale-lane money flow re-opens MTL question | WATCH |
| C3 | Allocation policy: donation vs. sale (publishable rule) | FOUNDER DECISION |
| C6 | No-match nights; recruit a terminal fallback receiver | WATCH |
| C7 | Institution-side receiving windows, churn, sloppy confirms | WATCH |
| D2 | Impact-report methodology (WARM factors, "documented" not "claimed") | WATCH |
| D3 | Deduction vs. cash-value conflation in pitch math | WATCH |
| E3 | Paid vs. free pilot | FOUNDER DECISION |
