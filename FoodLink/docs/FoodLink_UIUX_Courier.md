# FoodLink — UI/UX Design Spec: Courier
**Version:** 1.0
**Initiative:** ServeAI
**Status:** Draft
**Last Revised:** 2026-06-25

---

## Design Principles

**Task-first, always.** Couriers are executing a physical job, often while on a vehicle. Every screen must have one unmistakable action. No clutter, no decisions that don't need to happen right now.

**All the information upfront, none of it later.** The courier must know the pickup address, drop-off address, handling notes, and confirmed fee before accepting a dispatch. No surprises after commitment.

**Time is real.** The 5-minute acceptance window is a hard constraint. The countdown must be visible and honest — not hidden behind a vague "respond soon" message.

**Safety notes are prominent, not buried.** Food handling instructions (keep hot, refrigerated, fragile) are displayed at the top of every active delivery screen. A courier who forgets a handling note because the UI buried it is the platform's failure.

---

## Design System

Inherits all tokens from Donor and Consumer specs. Courier-specific additions:

| Token | Value |
|---|---|
| **Online** | `#16a34a` (Green 600) — courier is active and receiving dispatches |
| **Offline** | `#6b7280` (Gray 500) — courier is unavailable |
| **Urgent** | `#ef4444` (Red 500) — countdown < 60 seconds |
| **Cold-chain badge** | `#0284c7` (Sky 600) — insulated transport eligible |
| **Step active** | `#16a34a` — current delivery step |
| **Step complete** | `#16a34a` with checkmark |
| **Step pending** | `#e5e7eb` — upcoming steps |

### Accessibility Requirements

Same hard constraints as Donor and Consumer specs. Courier-specific additions:

- The acceptance countdown timer must be readable at arm's length (minimum 28px). It must not rely on color alone — "2:14 remaining" in text, not just a color-shifting ring.
- All action buttons (Accept, Confirm Pickup, Confirm Delivery) must be minimum 56px height — larger than the standard 44pt — because couriers may be wearing gloves or operating in difficult physical conditions.
- Handling notes must use iconography alongside text (e.g., flame icon for hot food, snowflake for refrigerated) for rapid recognition without reading.

---

## Screen Index

1. [Onboarding — Account & Background Check](#1-onboarding--account--background-check)
2. [Courier Dashboard — Offline](#2-courier-dashboard--offline)
3. [Courier Dashboard — Online (No Active Delivery)](#3-courier-dashboard--online-no-active-delivery)
4. [Dispatch Notification](#4-dispatch-notification)
5. [Active Delivery — En Route to Pickup](#5-active-delivery--en-route-to-pickup)
6. [Active Delivery — Pickup Confirmation](#6-active-delivery--pickup-confirmation)
7. [Active Delivery — En Route to Drop-off](#7-active-delivery--en-route-to-drop-off)
8. [Active Delivery — Drop-off Confirmation](#8-active-delivery--drop-off-confirmation)
9. [Delivery Rejected — Log Reason](#9-delivery-rejected--log-reason)
10. [Delivery Complete — Celebration](#10-delivery-complete--celebration)

---

## 1. Onboarding — Account & Background Check

**Purpose:** Set up the courier account, capture vehicle info, and flag cold-chain capability.

**Layout:** Two-step flow with progress bar. Step 1 of 2 · ~30 seconds remaining.

**Step 1 — Personal & Vehicle Info:**
- Full name, phone (OTP), email
- Vehicle type: Bicycle · Scooter · Car · Van/Truck (chip selector)
- Cold-chain question: "Do you have insulated bags or a cooler for temperature-sensitive food?"
  - YES → `insulated_transport_capable` flag set. Shows: "You'll be eligible for refrigerated and hot food deliveries."
  - NO → flag not set. Shows: "No problem — you'll receive packaged and bakery deliveries."
- This is a self-report in MVP. Frame it neutrally so couriers don't feel pressure to lie.

**Step 2 — Background Check Consent:**
- Explanation: "FoodLink requires a background check to protect our community. This takes 2–5 business days."
- Checkbox: "I consent to a background check"
- Primary button: "Submit application"
- Post-submit: "Application received. We'll notify you when approved." — no access to the app until approved.

---

## 2. Courier Dashboard — Offline

**Purpose:** Default state when the courier has not toggled on. Shows earnings and a clear path to going online.

**Layout:** Large centered availability toggle dominates the screen. Earnings data below.

**Components:**

*Header:*
- "Hey, [Name]" greeting
- Reliability score badge: "Reliable Courier · 4.8 ⭐ · Top 15%" — same format as Donor trust score, with contextual label
- Cold-chain badge (if eligible): blue "❄ Cold-chain certified" pill

*Availability Toggle (center of screen, prominent):*
- Large circular toggle button (80px diameter)
- Offline state: gray background, "Go Online" label below
- Subtext: "You're not receiving dispatches"
- Designed like Uber Driver's availability toggle — the single most important interaction on this screen

*Earnings Strip (below toggle):*
- Three metrics:
  - Today: $0.00 (or today's running total)
  - This week: $[X]
  - Deliveries completed: [count]
- Same emotional function as Donor/Consumer impact strips

*Recent Deliveries:*
- Last 3 delivery cards: food name · payout · date
- "View all →" link to full history

---

## 3. Courier Dashboard — Online (No Active Delivery)

**Purpose:** Courier is live and waiting for a dispatch. Must feel active, not idle.

**Components:**
- Same header as offline state
- Availability Toggle: green, "Online" label, pulsing ring animation (indicates active listening)
- Subtext: "Looking for deliveries near you..."
- Animated waiting indicator (subtle, not distracting — three dots or a soft pulse)
- Earnings strip (same as offline, now updating live as dispatches complete)
- "Nearby activity" strip: "2 listings posted within 1 mile of you" — gives the courier confidence that dispatches may be coming without promising anything

**Important:** This screen must not feel like a blank waiting room. The pulse animation and nearby activity strip make it feel like the system is actively working on the courier's behalf.

---

## 4. Dispatch Notification

**Purpose:** Present a new delivery job for acceptance. The most critical screen in the courier flow — all information needed to make a decision, plus a hard time limit.

**Layout:** Full-screen modal slides up over the dashboard. Cannot be dismissed without an explicit Accept or Decline tap.

**Components:**

*Countdown timer (top, unmissable):*
- Large circular countdown ring: "4:52" in the center (minutes:seconds)
- Ring depletes clockwise as time runs out
- Turns amber at 60 seconds, red at 20 seconds
- Text below ring: "This offer expires in [time]"

*Confirmed Fee (immediately below timer):*
- Large, bold: "$6.50" — the courier sees their money first
- Label: "Your delivery fee — guaranteed"
- This is deliberate. Fee is the most important information for a courier deciding whether to accept.

*Job Details Card:*
- Food name + quantity
- Handling requirement (icon + text): 🔥 Keep hot · ❄ Refrigerated · 📦 Packaged
- Pickup: "[Donor address]" with estimated distance and drive time (e.g., "0.4 mi · 3 min")
- Drop-off: "[Consumer address]" with estimated distance and drive time (e.g., "1.2 mi · 8 min")
- Total estimated job time: "~18 min total"

*Cold-chain indicator (if applicable):*
- "❄ Cold-chain delivery — insulated transport required"
- Only shown to eligible couriers (non-eligible are not dispatched for these jobs)

*Action buttons:*
- **Accept** — full-width green, 56px height, prominent
- **Decline** — text link below, smaller, red — "Decline this job"
- No accidental decline: tapping Decline shows a one-tap confirmation: "Decline this delivery? Your reliability score may be affected." with "Yes, decline" and "Go back" options.

**If timer expires with no response:** Modal auto-closes, dispatch moves to next courier. Dashboard shows brief toast: "Offer expired — looking for more nearby deliveries."

---

## 5. Active Delivery — En Route to Pickup

**Purpose:** Guide the courier to the pickup location. Handling instructions visible at all times.

**Layout:** Full-screen. Top: handling banner. Middle: step progress + address. Bottom: action button.

**Components:**

*Handling banner (pinned at top, always visible):*
- Background color matches food type: amber for hot food, blue for refrigerated, gray for packaged
- Icon + text: "🔥 Keep hot — deliver within 45 min of pickup"
- This banner stays visible on every active delivery screen. It cannot be dismissed.

*Step progress bar:*
- "Step 1 of 2 — Pickup"
- Two-step horizontal stepper: [Pickup (active)] → [Drop-off (pending)]

*Address card:*
- "Pickup from" label
- Full donor address (now visible to courier since they accepted)
- "Open in Maps" button — deep-links to native mapping app (Google Maps / Apple Maps)
- Estimated arrival: "~3 min away"

*Fee reminder:*
- Small strip: "Confirmed fee: $6.50 — paid on delivery"

*Primary action (bottom, 56px):*
- "I've arrived at pickup" — activates only when tapped, not GPS-triggered in MVP
- Tapping navigates to Pickup Confirmation screen

---

## 6. Active Delivery — Pickup Confirmation

**Purpose:** Confirm the courier has collected the food from the donor.

**Layout:** Single-column. Checklist + confirm button.

**Components:**
- "Confirm pickup" headline
- Food summary: name + quantity
- Handling reminder (same banner as Screen 5)
- Simple checklist (visual only, not a form):
  - Food matches listing ✓
  - Quantity looks correct ✓
  - Handling conditions met ✓ (e.g., food is hot / container sealed)
- Primary button (56px): "Confirm pickup — start delivery"
- Tapping transitions listing status to `IN_TRANSIT` and navigates to En Route to Drop-off

---

## 7. Active Delivery — En Route to Drop-off

**Purpose:** Guide the courier to the consumer. Handling instructions still visible.

**Layout:** Identical structure to Screen 5 but for the drop-off leg.

**Components:**
- Handling banner (same, persistent)
- Step progress bar: "Step 2 of 2 — Drop-off" — pickup step shown as complete (green checkmark)
- Address card:
  - "Deliver to" label
  - Full consumer address (now visible since pickup confirmed)
  - "Open in Maps" button
  - Estimated arrival: "~8 min away"
  - Time remaining in safety window: "Food safe for 38 more min" — amber if < 20 min
- Primary action (bottom, 56px): "I've arrived at drop-off"

---

## 8. Active Delivery — Drop-off Confirmation

**Purpose:** Complete the delivery. Capture the consumer's acknowledgment if possible.

**Layout:** Single-column confirmation screen.

**Components:**
- "Confirm delivery" headline
- Food summary + address
- Optional consumer acknowledgment: "Ask the recipient to confirm on your screen" — shows a large "Confirm receipt" button sized for the recipient to tap on the courier's phone
  - If recipient taps: their confirmation is logged alongside the courier's
  - If recipient is unavailable: courier can proceed without it
- Primary button (56px): "Mark as delivered"
- Tapping this transitions listing to `DELIVERED`, releases all payouts, and navigates to Delivery Complete

**Rejection flow:** If the recipient refuses the delivery, the "Mark as delivered" button is replaced with "Recipient refused delivery →" which leads to Screen 9.

---

## 9. Delivery Rejected — Log Reason

**Purpose:** Capture the rejection reason before the courier leaves. Required before the courier fee is released.

**Layout:** Single-column. Reason selector + optional notes.

**Components:**
- "Log rejection reason" headline
- Subtext: "Your fee is still paid — this helps us resolve the issue."
- Reason chips (tap to select, required):
  - Temperature failure
  - Condition mismatch
  - Wrong item
  - Consumer window violation
  - Other
- Optional free-text notes field: "Any additional details?" (keyboard, not required)
- Primary button: "Submit & complete delivery"
- On submit: courier fee is released. Platform mediation begins. Courier navigates to a simplified Delivery Complete screen (no celebration, just confirmation that the fee is paid).

---

## 10. Delivery Complete — Celebration

**Purpose:** Close the loop. Make the courier feel good about the delivery and motivated to stay online.

**Layout:** Full-screen centered. Mirrors the Donor confirmation screen in emotional tone.

**Components:**
- Large animated green checkmark (same animation as Donor confirmation)
- Headline: "Delivery complete!"
- Subtext: "Nice work. You helped get food to someone who needed it."
- Earnings update card:
  - "You earned: $6.50" (bold, prominent)
  - "Today's total: $[running total]"
- Delivery summary chips: food name · distance · time taken
- Reliability note (if delivery was on time): "On-time delivery — great work."
- Primary button: "Back to dashboard" — returns to Online dashboard, ready for next dispatch
- If courier wants to go offline: secondary link "Go offline" below the button

---

*FoodLink UI/UX Spec — Courier · v1.0 · ServeAI Initiative · Confidential*
