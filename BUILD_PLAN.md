# FoodLink — Build Plan & Timetable to Full Pilot Software

*Written 2026-07-20. Companion to `analysis/03-transition-plan.md` and `PHASE_2_PROMPT.md`.*

---

> ## ⚠️ MODEL UPDATE — v3 (2026-07-28): read this before the timetable below
>
> The pitch settled on a **records-only** model, and it changes the back half of this
> plan. **Phases 3–5 as written below (Routes → Custody → Paperwork) are superseded.**
> Corrected go-forward:
>
> - **Delivery is records-only.** FoodLink owns no fleet, dispatches nothing, brokers no
>   couriers. **Phase 3 "Routes" is CUT** — no `routes`/`stops`/`courier_companies`/
>   `stop_loads`, no route builder, no Google Routes multi-leg, no driver magic-link
>   route sheet. It collapses to **"Delivery-log":** the two businesses pick a method,
>   FoodLink records the method + responsible party + pickup/delivery timestamps + a
>   blown-safety-window flag. Days, not weeks.
> - **Phase 4 "Custody" is mostly CUT** — no `custody_events` subsystem, no per-item
>   temperature/excursion hard-stop, no receiving accept/reject engine. Replaced by a
>   lightweight **recipient confirm + dispute-window flag** ("recorded, not refereed").
> - **Phase 5 "Paperwork" stays but slims** — a donation receipt (market value + cost
>   basis, donee acknowledgment) generated from the recipient's confirm, not from a
>   heavy custody pipeline. Monthly impact report optional.
> - **Receiver = verified 501(c)(3) (donation) or verified business (sale)**, one lane
>   per load. This is the `institutions` entity already built — no rework.
> - **Sale lane takes 0%**; money moves directly between businesses. No Stripe Connect
>   transfers, no ~20% commission.
> - **Phase 0 field work: courier quotes are NO LONGER needed** (FoodLink contracts no
>   couriers). Still real: CPA/counsel review of the receipt/valuation + Good-Samaritan
>   wording, and the NPO-verification process (already built).
>
> Net effect: the remaining build is **smaller** than the timetable below implies. The
> Phase 3/4 "Routes/Custody" rows should be read as the single, much lighter
> "Delivery-log + recipient-confirm" phase. Everything from "Where you actually are"
> through Phase 2 is still accurate.

---

## Where you actually are

**Phase 1 is done and on `main`.** Scan → itemized inventory → merchant-confirmed manifest → declared load with snapshotted valuations. Migrations 018–020 live in dev. Final whole-branch review triaged clean; model bumped to Gemini 3.5-flash with retry logic. The data moat starts filling from the first real scan.

**One caveat from a fresh security review (2026-07-20 — full writeup in `CODE_REVIEW_2026-07-20.md`).** The core posture is sound: no cross-tenant leak, RLS on every table, `declare_load` called *"a textbook hardened SECURITY DEFINER RPC,"* migrations clean, 19/19 unit tests green. But the pass found two **Critical** issues to clear before building new surfaces on top:
- **C1 — unauthenticated Gemini denial-of-wallet.** Registration provisions the account and signs the user in *before* OTP is sent, and `phone_verified` is never checked in the API/action layer — so a script can skip OTP and burn real Gemini spend while polluting the core dataset. Works in a correct production.
- **C2 — systemic fail-open.** Every integration silently drops to permissive dev behavior when its env var is missing (Twilio accepts `000000`, rate-limiters return `allowed`, Gemini returns synthetic inventory), with no startup guard anywhere.

Plus six **Important** items (server-TZ safety-expiry, dead admin editor, the non-transactional confirm being worse than triaged, live mothballed endpoints, zero observability on `confirmManifest`, and user-deletion FK breakage). All are packaged as **Task 0 of Phase 2** and cost ~1.5 days up front. They're built into the timetable below.

So "finish the whole application" = **Phase 2 (done) + a slim Delivery-log/recipient-confirm phase + a donation-receipt phase.** Under the v3 model that makes a real handoff honest end-to-end: a merchant declares a load, the recipient (verified nonprofit or business) accepts it, the two pick and execute a delivery method that FoodLink *logs* (method + timestamps + blown-window flag), the recipient confirms on arrival, and a donation receipt (market value + cost basis) is generated. No routes, no courier brokering, no custody subsystem — see the v3 update box above.

---

## The honest timetable framing

Your transition plan budgets **~9 person-weeks** for Phases 2–5 (1.5 + 2 + 2 + 2, plus slack). You want ~2 weeks. Two things make that gap smaller than it looks — and one thing makes it real:

- **Demonstrated velocity.** Phase 1 was 10 SDD tasks shipped in days with the brief→build→review→fix loop. At that cadence, 2–3 weeks of calendar time for Phases 2–5 is aggressive but not fantasy — *for the code.*
- **Semi-manual is allowed.** The MVP explicitly lets humans push buttons behind the curtain (ops matches by text, sequences stops by hand, calls the courier). You're not building full automation; you're building the *data spine* so every step's record lands in the new tables.
- **The real critical path is not code — it's Phase 0 field work.** Routes (Phase 3), receipts (Phase 5), and billing all depend on things software can't manufacture: **three written courier quotes + a route P&L, a counsel memo on sale-lane/Good-Samaritan/insurance, and a CPA review of the receipt template.** These run *in parallel* and gate the phases below. If you start them today, they won't block a 2-week software sprint. If you start them in week two, they become the reason the pilot slips — not the code.

**Bottom line:** you can plausibly have Phases 2–5 software built and green in ~2 weeks of focused AI-assisted work. A real *pilot that bills and issues valid receipts* also needs the Phase 0 items to land — so kick those off in parallel now.

---

## Sequenced plan (what depends on what)

```
Phase 0 (non-code, PARALLEL, starts today) ──── gates ───► Phase 3, Phase 5
   courier quotes + P&L, counsel memo, CPA template review, NPO-verify process

Phase 2  Match ──────────► Phase 3  Routes ──────────► Phase 4  Custody ──────────► Phase 5  Paperwork
 (no external blocker)     (blocked by courier         (needs Routes)               (blocked by CPA/counsel
                            quotes/contract)                                          template review)
```

- **Phase 2 (Match)** has no external dependency — start it now (`PHASE_2_PROMPT.md` is ready).
- **Phase 3 (Routes)** can be *built* against a simulated courier provider without quotes, but you can't *price or contract* a route without Phase 0's quotes. Build the `ManualCourierProvider` + magic-link driver flow; plug real numbers when quotes land.
- **Phase 4 (Custody)** depends only on Phase 3 (stops must exist to attach custody events to). No external blocker — this is where "the pilot can run."
- **Phase 5 (Paperwork)** the *code* can be built in parallel with Phase 4, but the receipt/valuation template must clear CPA/counsel review (Phase 0) before it issues a real document. Build the generator; gate the "issue" button on template sign-off.

---

## Two-week aggressive timetable (software track)

Assumes the Phase 1 SDD loop, one focused builder, migrations applied to dev promptly (that was the one thing that blocked you mid-Phase-1 — keep a Supabase SQL-editor session open). Days are working days.

| Days | Phase | Deliverable | Exit gate |
|---|---|---|---|
| **1–2** | **0 — Hardening** *(from the security review)* | **C1:** stop provisioning/sign-in before OTP, enforce `phone_verified` in `/api/scan` + merchant actions, IP-throttle `registerAction`. **C2:** fail-closed prod env boot. Then: `verifyOTPAction` write-failure fix; `confirmManifest` logging + Sentry; server-TZ safety-expiry + calendar-date fixes; gate/remove mothballed writes + unauthenticated listing reads; disable dead crons; admin-editor banner; security headers; close scan-guard / low-confidence test gaps. | Unverified account can't hit `/api/scan`; prod refuses to boot on a missing key; OTP verify no longer strands users; safety-expiry shows the merchant's timezone; `2026-02-30` rejected; mothballed surface unreachable; suites green. |
| **2–5** | **2 — Match** | `institutions` + `allocations` (migrations 021/022), `offer_load`/`respond_to_offer`/`confirm_and_declare` RPCs, ops matching console, no-login `/inbound/[token]` preview, offer notification. Folds the tracked confirmManifest/RPC debt into the RPC work. | Ops offers a load; institution accepts via link; load reads `matched`. Suite green, reviewed, pushed. |
| **6–8** | **3 — Routes** | `routes`/`stops`/`courier_companies` + `stop_loads`; ops route builder (drag loads, order stops, Google Routes multi-leg ETAs, safety-window refusal); driver **magic-link** stop page; printable route-sheet fallback. `ManualCourierProvider` behind the existing provider interface. **Deletes** the internal gig-courier fleet (`dispatch.ts`, `courier-dispatch.ts`, `(courier)/*`, `dispatch_events`, `DELIVERY_MODE`, Uber provider) — keep the provider-interface pattern only. | A planned route with sequenced stops and real ETAs exists; driver opens a texted link and sees the stop list. |
| **9–12** | **4 — Custody** | Driver stop flow (arrive → load-out counts → temp → photo → depart); receiver **per-item accept/reject** with reason + signer name; `custody_events` append-only; excursion hard-stop (temp breach flags downstream, flips to reject-with-informed-accept); rejected-item disposition (offer downstream else `rejected_returned`). Repurpose the pickup-code handoff + dispute-photo paths. | A route completes end-to-end with a full custody record — temps, timestamps, photos, per-item confirms at both ends. **This is the moment the pilot can run.** |
| **11–14** | **5 — Paperwork** *(overlaps Phase 4)* | `receipts` + valuation snapshots from **receiver-confirmed quantities** (values frozen at issue), donee-acknowledgment capture in the receiving confirm, PDF to private bucket; monthly impact report per merchant (lbs, meals, CO₂ via versioned EPA WARM factors, deduction *documented*). "Issue" gated on Phase 0 template sign-off. | The 6:47pm receipt and month-end report exist from real route data. |
| **14** | **Verification** | Whole-branch review of 2–5; full e2e green; docs + progress ledger updated. | Ready-to-merge verdict; pushed. |

**If you're solo and want the truest "couple weeks":** compress by treating Phase 5 as ops-triggered/semi-automatic (a template the ops person fills from a query for month one, per the MVP), which pulls the real deadline back to the end of Phase 4 (~day 12). Full auto-billing (Phase 6) and the prediction pipeline (Phase 7) are explicitly *after* this window.

---

## Phase 0 checklist — start these today, in parallel (they gate the above)

These are not code and won't get faster by waiting. Kicking them off now is the single highest-leverage thing for hitting the timetable:

1. **Three written refrigerated-courier quotes + a route P&L** with an explicit nightly/weekly cadence (medical/pharma couriers or catering fleets — *not* gig). Gates Phase 3 pricing and every fee decision. *(red-team A1/A2)*
2. **Counsel memo:** sale-lane structure (handling-fee vs. food-sale), Good Samaritan boundaries, courier-contract duties (FSMA STF, GA/county health codes), insurance stack. Gates Phase 5 templates and the sale lane. *(B1/B2/B4)*
3. **CPA review** of the receipt/valuation template (donee statement, cost-basis handling). Gates Phase 5's "issue" button. *(B3)*
4. **NPO-verification process** for institutions (501(c)(3) determination-letter capture + ops review queue). The Phase 2 donation-lane gate needs a real process behind it. *(00-Q9)*
5. **Founder decisions** still open: fee model (per-pickup vs. weekly/monthly), paid-pilot pricing, sale-lane money flow, courier-contract structure. These unblock Phases 3/5/6. *(00-Q2/Q5/Q10)*

---

## Risks to the two-week goal (ranked)

1. **Skipping Task 0 to "get to features faster."** The security review's findings (fail-open prod integrations, denial-of-wallet via disabled rate-limiting, callable mothballed writes) get *worse* once Phase 2 adds a public no-login route and an offer/accept money-adjacent flow on top of them. The 1–1.5 days is non-negotiable and comes first — treat it as part of Phase 2, not optional polish.
2. **Migrations not applied to dev promptly.** This is exactly what blocked Phase 1's Tasks 5–9. Keep a Supabase SQL-editor session live; apply 021/022 the moment they're written.
2. **Phase 0 starting late.** The code can be done in two weeks; a *billable, receipt-issuing pilot* cannot exist without the counsel/CPA/courier items. Parallelize from day one.
3. **Scope creep into automation.** Auto-matching, auto-billing, prediction — all explicitly deferred. Resist; the MVP is semi-manual on purpose.
4. **Custody edge cases (Phase 4) are the hardest code.** Excursion hard-stop and rejected-item disposition have real branching. Budget the full 4 days; don't let Phase 3 slippage eat them.
5. **Solo review bandwidth.** The brief→build→review→fix loop is what kept Phase 1 clean. Don't drop the self-review step to save a day — it's cheaper than the bug.

---

## What "done" looks like at day 14

A real merchant scans at 3:30; ops matches and the shelter sees itemized inbound by 3:45; a contracted refrigerated driver opens a magic link at 6:15; at 6:47 the kitchen manager confirms 14 chickens and rejects one tray with a photo; the merchant's receipt exists by 7:00 — **and every step's data is in the new tables.** Billing and monthly reports may still be semi-manual for the first month (deliberately). That's the pilot. Phases 6–7 (auto-billing, surplus-prediction) come after it's proven.
