# FoodLink — UI/UX Design Spec: Donor
**Version:** 1.0  
**Initiative:** ServeAI  
**Status:** Draft  
**Last Revised:** 2026-06-25

---

## Design Principles

**Speed over completeness.** Donors are kitchen staff under time pressure. Every screen must have one obvious primary action. No screen should require more than 2 taps to reach its goal.

**AI does the work, donor confirms.** The UI never asks donors to type when the AI can fill it in. Inputs are for correction, not data entry.

**Trust through transparency.** Pricing, fees, and payouts are always visible before confirmation. No surprises.

---

## Design System

| Token | Value |
|---|---|
| **Primary** | `#16a34a` (Green 600) — action buttons, highlights |
| **Primary Dark** | `#15803d` (Green 700) — hover/pressed states |
| **Surface** | `#ffffff` |
| **Background** | `#f9fafb` (Gray 50) |
| **Border** | `#e5e7eb` (Gray 200) |
| **Text Primary** | `#111827` (Gray 900) |
| **Text Secondary** | `#6b7280` (Gray 500) |
| **Warning** | `#f59e0b` (Amber 500) |
| **Error** | `#ef4444` (Red 500) |
| **Font** | Inter |
| **Base font size** | 16px |
| **Border radius** | 12px (cards), 8px (inputs), 999px (pills/buttons) |

### Accessibility Requirements

These are hard constraints, not suggestions. All screens must satisfy them before any screen is considered complete.

- **Touch targets:** Minimum 44×44pt on all interactive elements (Apple HIG requirement). Applies to buttons, pills, list items, navigation tabs, and toggle controls.
- **Color contrast:** WCAG AA compliance minimum. Text on background must meet 4.5:1 ratio for normal text, 3:1 for large text (18pt+ or 14pt bold+). Status colors (green, amber, red) must never be the only indicator — pair with an icon or label.
- **Dynamic text:** All layouts must support iOS Dynamic Type and Android font scaling up to 200%. No text may be clipped, truncated, or overflow its container at large text sizes.
- **Screen reader labels:** Every interactive element must have an accessible label. Icon-only buttons (e.g., camera shutter, close button) require `aria-label` or equivalent. Status pills must read their full label, not just color.
- **Reduced motion:** Animations (confirmation checkmark, skeleton loaders) must respect the device's "Reduce Motion" setting. Provide instant-state fallbacks.

---

## Screen Index

1. [Onboarding — Account Type Selection](#1-onboarding--account-type-selection)
2. [Onboarding — Verification](#2-onboarding--verification)
3. [Donor Dashboard](#3-donor-dashboard)
4. [New Listing — Camera Capture](#4-new-listing--camera-capture)
5. [New Listing — AI Processing](#5-new-listing--ai-processing)
6. [New Listing — AI Results (High Confidence)](#6-new-listing--ai-results-high-confidence)
7. [New Listing — AI Results (Low Confidence)](#7-new-listing--ai-results-low-confidence)
8. [New Listing — Perishable Timestamp](#8-new-listing--perishable-timestamp)
9. [New Listing — Pricing](#9-new-listing--pricing)
10. [New Listing — Review & Attestation](#10-new-listing--review--attestation)
11. [New Listing — Confirmation](#11-new-listing--confirmation)
12. [Listing Detail (Active)](#12-listing-detail-active)

---

## 1. Onboarding — Account Type Selection

**Purpose:** Route the user into the correct onboarding path.

**Layout:** Full-screen, centered. FoodLink logo top center. Three large tappable cards stacked vertically.

**Components:**
- Logo + tagline: *"Rescue food. Feed your community."*
- Card: **Donor** — "I have surplus food to list" — icon: storefront
- Card: **Consumer / Recipient** — "I want to buy discounted food" — icon: bag
- Card: **Courier** — "I want to deliver food" — icon: bicycle
- Footer: "Already have an account? Sign in"

**Interaction:** Tapping a card navigates to the relevant verification screen. No animation delay — instant navigation.

---

## 2. Onboarding — Verification

**Purpose:** Verify donor identity before any listing is created.

**Layout:** Single-column form. Progress indicator at top (Step 1 of 2).

**Components — Commercial Donor path:**
- Header: "Verify your business"
- Subtext: "We need your food service permit to activate your account."
- Input: Business name
- Input: Food service permit or business license number
- Input: Business address (used for GPS validation at listing time)
- Primary button: "Continue"

**Components — Residential Donor path:**
- Header: "Verify your identity"
- Input: Phone number
- After submit: 6-digit OTP entry screen
- Input: Home address
- Primary button: "Verify"

**States:**
- Default — empty form
- Error — inline field-level error messages (e.g., "Please enter a valid permit number")
- Loading — button shows spinner, inputs disabled
- Success — navigates to Donor Dashboard

**Key constraint:** Address entered here is stored and used for GPS validation at listing time. It must be accurate.

---

## 3. Donor Dashboard

**Purpose:** Central hub. Entry point for creating listings, tracking activity, and staying emotionally engaged with impact.

**Layout:** Bottom navigation bar (Dashboard / Listings / Payouts / Account). Main content area scrolls vertically.

**Components:**

*Header:*
- "Good morning, [Name]"
- Trust score badge — tappable, expands to show score detail. Display format: label + score + percentile context. Example: "Trusted Donor · 4.9 ⭐ · Top 10%" or "Excellent Reliability · 4.9". The raw number alone is meaningless — always pair it with a label that communicates what the score means in plain language.

*Quick Action (first item in scroll — primary job of the dashboard):*
- Large green button: "+ New Listing"
- Subtext: "Takes under 60 seconds"
- This must appear above the Impact Strip. The dashboard's primary job is getting donors to create listings. Impact reinforces that behavior — it does not lead it.

*Notification Banner (shown when a purchase event has occurred):*
- Green banner, dismissable
- Text: "Someone just purchased your [item]!"
- Action link: "Tap to prepare for pickup →"
- Surfaces inline on the dashboard in addition to push notification — donors in busy kitchens may miss push alerts.

*Today's Impact Strip (below the CTA, reinforces the action just taken or recently taken):*
- Section label: "This week's impact"
- Three metrics in a 3-column grid: Meals rescued · Food saved (lbs) · Total earned ($)
- Positioned here — not at the top — so it rewards and reinforces rather than competes with the primary action.

*Active Listings Section:*
- Section header: "Active Listings"
- Listing cards (see Listing Card component below)
- Empty state: illustrated (not just text). Headline: "Rescue your first meal today." Subtext: "It takes under 60 seconds to list surplus food." CTA button: "+ New Listing". Empty states are the highest-leverage copy on any screen — they address users at the moment of maximum uncertainty about whether the app is worth their time.

**Listing Card Component:**
- Food photo thumbnail (left, 48×48px, rounded corners) — food is visually recognized faster than text
- Food name + expiry (e.g., "Expires 1h 20m")
- Status pill (right): `LISTED` (green) / `PURCHASED` (blue) / `IN TRANSIT` (amber)
- Payout amount (right, below pill)
- Tappable → goes to Listing Detail

**Bottom Navigation Labels:**
- Dashboard · Listings · **Payouts** (not "Earnings" — "Payouts" correctly signals money coming in from sales) · Account

**States:**
- Loaded (default)
- Empty (no listings ever created) — illustrated empty state with "New Listing" CTA
- Loading skeleton — card and metric placeholders while data fetches

---

## 4. New Listing — Camera Capture

**Purpose:** Capture the food photo. Gallery access is blocked.

**Layout:** Full-screen camera view. Overlay UI on top.

**Components:**
- Full-screen camera viewfinder
- Top bar: "X" close button (left) + "New Listing" title (center)
- Framing guide: dashed rounded rectangle in center of viewfinder with label "Frame your food"
- Bottom bar: large circular shutter button (white, centered)
- Tip text above shutter: "Make sure the food is clearly visible and well-lit"

**Behaviors:**
- Gallery button is absent — no access to photo library
- Shutter tap captures photo and immediately transitions to AI Processing screen
- If camera permission is denied: full-screen error state with "Enable Camera Access" button that deep-links to device settings

**Error states:**
- Camera permission denied
- Camera hardware unavailable — "Unable to access camera. Please try again."

---

### New Listing — Progress Bar (Global Component)

Every screen in the New Listing flow (Screens 4–10) displays a persistent progress bar in the top bar. This is a global component, not per-screen.

**Format:** Step indicator + time estimate + filled progress track.

```
Step 2 of 6  ·  ~30 seconds remaining
[████████░░░░░░░░░░░░]
```

**Step mapping:**
| Step | Screen |
|---|---|
| 1 of 6 | Camera Capture |
| 2 of 6 | AI Results / Correction |
| 3 of 6 | Perishable Timestamp (if applicable; skipped if not perishable) |
| 4 of 6 | Pricing |
| 5 of 6 | Review & Attestation |
| 6 of 6 | Confirmation |

**Time estimate logic:** Displayed as "~[N] seconds remaining." Calculated as: remaining steps × average step completion time (camera: 10s, AI: 5s, timestamp: 5s, pricing: 8s, review: 7s). Rounds to nearest 5 seconds. Disappears on the Confirmation screen.

**Why this matters:** Progress indicators reduce form abandonment significantly. The time estimate specifically — not just the step count — gives users a concrete reason to continue rather than tap away.

---

## 5. New Listing — AI Processing

**Purpose:** Show progress while Gemini processes the image. Prevents the user from thinking the app froze.

**Layout:** Full-screen. Captured photo displayed as background (slightly dimmed). Centered card overlay.

**Components:**
- Captured photo as background
- White card, centered:
  - Animated spinner (green)
  - "Analyzing your food..." headline
  - Subtext: "This takes 3–5 seconds"
- No buttons — screen is non-interactive during processing

**Transition:** Automatically navigates to AI Results (High or Low Confidence) when response is received. If API call fails after retry: show error card with "Try Again" and "Enter Manually" options.

---

## 6. New Listing — AI Results (High Confidence)

**Purpose:** Present AI-detected food details for donor confirmation. One-tap to proceed.

**Layout:** Bottom sheet slides up over the captured photo. Photo remains visible in background.

**Components:**

*Bottom sheet:*
- Handle bar at top
- "We found your food" headline
- Detected item row: food name (large, bold) + quantity estimate
- Perishable badge: 🌡 "Temperature sensitive" (amber) or omitted if not perishable
- Safety window chip: "Must be delivered within 2 hours" (if perishable)
- Divider
- "Looks right?" label
- **Primary button:** "Yes, continue →" (full width, green)
- **Secondary link:** "Edit details" (smaller, below button) — expands inline edit fields for food name and quantity

**Interaction:**
- "Yes, continue →" → navigates to Perishable Timestamp screen (if perishable) or Pricing screen (if not)
- "Edit details" → food name and quantity become editable inline; button changes to "Save & continue"

---

## 7. New Listing — AI Results (Low Confidence)

**Purpose:** Let the donor correct an uncertain AI classification quickly without typing.

**Layout:** Bottom sheet (same as Screen 6 but with correction UI).

**Components:**

*Bottom sheet:*
- "We're not sure about this one" headline (amber warning icon)
- Subtext: "Tap the correct item below"
- Three large tappable option pills — top 3 AI alternatives (e.g., "Pasta", "Rice", "Mixed Vegetables")
- Divider
- Secondary option row: 🎤 "Use voice" / ⌨️ "Type it in"
- Dim "Continue" button (disabled until a field is selected)
- No "X" or exit — user cannot leave without resolving

**Interaction:**
- Tapping a pill: highlights it (green border), enables "Continue" button
- "Use voice": activates device microphone, transcribed text fills food name field
- "Type it in": keyboard opens, free-text input field appears
- Once any option is confirmed → "Continue" button activates → same navigation as Screen 6

**Exit behavior:** If donor attempts to close (swipe down / back gesture), show modal: *"Exit listing? No data will be saved."* with "Stay" (primary) and "Exit" (destructive secondary).

---

## 8. New Listing — Perishable Timestamp

**Purpose:** Capture when the food was prepared so the safety window can be calculated.

**Layout:** Single-column. Displayed only when item is flagged temperature-sensitive.

**Components:**
- Header: "When was this prepared?"
- Subtext: "This helps us calculate a safe delivery window."
- Time picker: native device time picker, defaulting to current time
- Safety window preview (updates dynamically as time changes):
  - e.g., "Must be delivered by 3:45 PM" (green if > 1 hour, amber if 30–60 min, red if < 30 min)
- If calculated window is already expired: red banner "This food has passed its safe window and cannot be listed." — Continue button disabled, donor is returned to Dashboard
- **Primary button:** "Set time & continue →"

---

## 9. New Listing — Pricing

**Purpose:** Show the three numbers that matter most, let the donor adjust within the ±25% band, and keep complexity behind a disclosure toggle.

**Layout:** Single-column. Designed for minimum cognitive load — the default view shows only what the donor needs to make a decision.

**Components:**

*Three-metric row (top, always visible):*
- **You receive** — donor payout (highlighted green card)
- **Buyer pays** — consumer price
- **Savings** — percentage below USDA retail benchmark
- All three update in real time as the slider moves. No other numbers are shown by default.

*Slider:*
- Label: "Adjust your payout — suggested $[X]"
- Min = suggested × 0.75, max = dynamically capped to the value that satisfies the 30% consumer discount floor
- Default position = suggested payout (one-tap accept path — donor hits "Confirm pricing" without touching the slider)
- Endpoint labels ($min / $max) shown beneath track

*"See calculation" disclosure link:*
- Collapsed by default. Tap to expand a detail panel showing: payout breakdown, platform fee, courier fee, USDA benchmark basis.
- This satisfies the PRD transparency requirement (Section 7.2) without front-loading complexity.
- Label toggles to "Hide calculation ▴" when open.

*Primary button:* "Confirm pricing →" (full width, green)

**Key behaviors:**
- Slider hard-capped at the maximum value that keeps consumer price ≥ 30% below USDA retail. If the donor reaches the cap, a tooltip appears: "Max payout to maintain consumer discount."
- All three metrics update instantly as the slider moves — no debounce.

---

## 10. New Listing — Review & Attestation

**Purpose:** Final confirmation before the listing goes live. Donor sees everything and checks the food safety attestation.

**Layout:** Single-column summary card + attestation checkbox + confirm button.

**Components:**

*Summary Card:*
- Captured photo (thumbnail, left-aligned)
- Food name + quantity
- Safety window (if perishable): "Expires at [time]"
- Consumer price: $X.XX
- Your payout: $X.XX
- Courier fee: $X.XX

*Attestation:*
- Checkbox (required) + label: *"I confirm this food has been prepared, stored, and handled in compliance with applicable food safety regulations and is safe for consumption."*
- Checkbox is unchecked by default

*Primary button:* **"Post Listing"** — disabled until checkbox is checked; activates (full green) once checked

*Secondary link:* "← Edit" — returns to Pricing screen

**Interaction:**
- "Post Listing" tap → loading state (spinner in button, inputs locked) → on success navigates to Confirmation screen
- On API failure: toast error "Something went wrong. Please try again." — button re-activates

---

## 11. New Listing — Confirmation

**Purpose:** Reward the donor emotionally. A listing posted is a meal potentially rescued — the screen should feel like that.

**Layout:** Full-screen centered. Celebration-first design. Modeled on the post-booking confirmation patterns used by Uber, DoorDash, and Airbnb — all of which use this moment to make the user feel good about what they just did.

**Components:**
- Large animated green checkmark (circle draws in, check follows — 600ms total)
- Headline: **"Listing live!"** — short, confident, present tense
- Subtext: *"Nice work. This meal could feed someone in your community today."* — emotionally resonant without being performative
- Summary chip row: food name · quantity · payout amount
- Safety window countdown (if perishable): "Must be claimed by [time]" — amber, with clock icon
- **Primary button:** "Back to dashboard"
- **Secondary button:** "+ List another item"

**Design note:** The confirmation screen is not an afterthought. It is the moment that determines whether the donor feels good enough about the experience to come back and list again tomorrow. Every word and visual here should reinforce that their action had meaning.

---

## 12. Listing Detail (Active)

**Purpose:** Let the donor see the current status of a live listing.

**Layout:** Single-column. Accessed by tapping a listing card on the Dashboard.

**Components:**
- Back navigation: "← Dashboard"
- Food photo (full width, 200px height)
- Food name + quantity
- Status pill (LISTED / PURCHASED / IN TRANSIT / DELIVERED)
- Safety window bar (progress bar depleting toward expiry, amber < 30 min)
- Price breakdown (same as Review screen)
- Payout status: "Pending delivery" / "Released" / "Held — under review"
- If LISTED: red "Cancel Listing" link at bottom (triggers cancellation penalty warning modal before confirming)
- If PURCHASED or IN TRANSIT: "Cancel Listing" is disabled with tooltip "Cannot cancel after purchase"
- Audit trail strip (collapsed): "View status history ▾" — expands to show timestamped state changes

---

*FoodLink UI/UX Spec — Donor · v1.0 · ServeAI Initiative · Confidential*
