> ⚠️ **SUPERSEDED (2026-07): This document describes the pre-pivot consumer-marketplace model.**
> FoodLink pivoted to the institutional-first "operating system for surplus food."
> Source of truth: the Serve AI strategy doc (TGTG / Fix info / Tab 17 sections) and `analysis/` + `PHASE_1_PLAN.md` in this repo.
> Do **not** use this document as a build input.

# FoodLink — UI/UX Design Spec: Consumer / Recipient
**Version:** 1.0
**Initiative:** ServeAI
**Status:** Draft
**Last Revised:** 2026-06-25

---

## Design Principles

**Browsing is the primary job.** Unlike donors, consumers come to find food — not to create something. The marketplace feed must be fast to scan, rich with context, and filter-friendly.

**Urgency is honest.** Listings expire. Delivery windows close. The UI communicates time pressure accurately without manufacturing false urgency.

**Savings feel real.** Every listing shows the dollar and percentage saved vs. retail. The consumer should feel the value of FoodLink every time they open the app.

**Delivery is reassuring.** Once a consumer purchases, the experience shifts to calm confidence — clear status, live ETA, no ambiguity.

---

## Design System

Inherits all tokens from the Donor spec (colors, typography, border radius, spacing). Consumer-specific additions:

| Token | Value |
|---|---|
| **Savings Badge** | `#059669` (Emerald 600) background · `#d1fae5` (Emerald 100) text |
| **Urgency** | `#f59e0b` (Amber 500) — time-limited availability |
| **Tracking Active** | `#16a34a` (Green 600) — completed steps |
| **Tracking Pending** | `#e5e7eb` (Gray 200) — upcoming steps |

### Accessibility Requirements

Same hard constraints as Donor spec: 44×44pt touch targets, WCAG AA contrast, dynamic text support, screen reader labels, reduced motion fallbacks. Additionally:

- Filter chips must be keyboard/switch-accessible with visible focus rings.
- Listing cards in the marketplace feed must have a meaningful `aria-label` that reads the food name, price, savings, and ETA — not just the card border.
- The order tracking stepper must convey status via text labels, not color alone.

---

## Screen Index

1. [Onboarding — Account Creation](#1-onboarding--account-creation)
2. [Onboarding — Receiving Window Setup](#2-onboarding--receiving-window-setup)
3. [Consumer Marketplace](#3-consumer-marketplace)
4. [Marketplace — Empty State](#4-marketplace--empty-state)
5. [Listing Detail](#5-listing-detail)
6. [Purchase Confirmation](#6-purchase-confirmation)
7. [Order Tracking](#7-order-tracking)
8. [Post-Delivery Feedback Prompt](#8-post-delivery-feedback-prompt)
9. [Order History](#9-order-history)

---

## 1. Onboarding — Account Creation

**Purpose:** Create an account with minimum friction. Consumers don't need document verification — just a valid identity.

**Layout:** Single-column. Progress bar at top: Step 1 of 2 · ~20 seconds remaining.

**Components:**
- Header: "Create your account"
- Input: Full name
- Input: Email address
- Input: Phone number → OTP verification step
- Dietary / food restriction preferences (optional, multi-select chips): Vegetarian · Vegan · Halal · Kosher · Gluten-free · Dairy-free · No pork · No beef
- Primary button: "Continue →"

**Note:** Dietary preferences set here pre-filter the marketplace feed. They can be changed in Account Settings at any time.

---

## 2. Onboarding — Receiving Window Setup

**Purpose:** Capture the delivery address and availability window so the marketplace only shows listings that can realistically be delivered.

**Layout:** Single-column. Progress bar: Step 2 of 2 · ~15 seconds remaining.

**Components:**
- Header: "When can we deliver to you?"
- Subtext: "We'll only show listings that fit your schedule."
- Input: Delivery address (with map pin confirmation)
- Multi-select day chips: Mon · Tue · Wed · Thu · Fri · Sat · Sun
- Time range picker: "From [time] to [time]" — native time pickers, defaults to 9am–6pm
- Toggle: "I have flexible hours" — disables the time picker and shows all listings for selected days
- For shelter/institutional accounts: additional field for "Loading dock or receiving area notes"
- Primary button: "Go to marketplace →"

**Constraint:** At least one day must be selected and a valid address must be entered before the button activates.

---

## 3. Consumer Marketplace

**Purpose:** The heart of the consumer experience. Fast, scannable, filtered to what's actually available for this consumer.

**Layout:** Bottom navigation (Marketplace / Orders / Savings / Account). Feed scrolls vertically. Sticky header with search and filters.

**Components:**

*Header:*
- "Good afternoon, [Name]" greeting
- Receiving window chip: "Deliveries open until 5:00 PM today" — tappable to edit receiving window. Amber if < 1 hour remaining in today's window.

*Savings Strip (below header, always visible):*
- Three metrics in a horizontal card:
  - Money saved this month vs. retail (e.g., "$34 saved")
  - Meals received (count)
  - lbs of food rescued through purchases
- Same emotional reinforcement function as the Donor's Impact strip — gives consumers a reason to return beyond hunger.

*Notification Banner (when relevant):*
- "Your delivery is 10 minutes away!" — green banner with live countdown
- "New listings just added near you" — when new listings match the consumer's filters
- Dismissable

*Search Bar + Filter Chips:*
- Search: "Search food..." — filters by food name in real time
- Filter chips (horizontal scroll): All · Hot Food · Produce · Bakery · Packaged · Vegetarian · Halal · Gluten-free
- Active filter chips filled green; inactive outlined

*Listings Feed:*
- Listing cards (see Listing Card Component below)
- "X listings available before [closing time]" urgency label at top of feed
- Infinite scroll with 12 listings per load

**Listing Card Component:**
- Food photo (full width thumbnail, 120px height, rounded top corners)
- Savings badge (top-right of photo): "47% off" — green pill overlaid on image
- Food name + quantity (e.g., "Chicken Tikka Masala · 8 lbs")
- Origin chip: "Restaurant" or "Home kitchen" — never the donor's name or address
- Estimated delivery: "Arrives in ~25 min"
- Price row: ~~$12.00~~ **$7.50** — strikethrough retail, bold consumer price
- "Purchase" button — right-aligned, green, 44pt minimum height
- Freshness indicator: green dot "Fresh" / amber dot "Selling fast" (< 30 min safety window remaining)

**States:**
- Loaded (default)
- Loading skeleton — card placeholders on first load
- Empty (see Screen 4)
- Search no-results: "No listings match '[query]'. Try clearing your filters."
- Receiving window closed: banner at top "Your receiving window is closed today. Next window: tomorrow 9am–6pm."

---

## 4. Marketplace — Empty State

**Purpose:** Retain the consumer when no listings match their window or filters.

**Layout:** Feed area replaced by illustrated empty state. Header and filters remain visible.

**Components:**
- Centered illustration (bowl with steam icon, muted green)
- Headline: "Nothing available right now"
- Subtext: "New listings appear throughout the day. We'll notify you when something matches your preferences."
- Toggle: "Notify me when new listings arrive" — on by default
- Secondary action: "Edit your receiving window" — link to receiving window settings
- Tip: "Listings go fast — most are claimed within 30 minutes of posting."

---

## 5. Listing Detail

**Purpose:** Give the consumer enough information to confidently make a purchase decision.

**Layout:** Scroll view. Full-width food photo at top, details below, sticky purchase bar at bottom.

**Components:**

*Photo:*
- Full-width, 220px height, rounded bottom corners
- Savings badge (top-right): "47% off retail"
- Back navigation (top-left): "← Marketplace"

*Details section:*
- Food name (large, bold)
- Quantity: "8 lbs available"
- Origin: "From a local restaurant" (never donor identity)
- Food category chip + handling notes: "Keep hot · Best delivered within 45 min"
- Safety window bar: green progress bar depleting toward expiry. Label: "Fresh for 1h 20m more." Turns amber under 30 minutes.
- Divider

*Pricing section:*
- Retail price (strikethrough): $12.00
- Your price (large, bold, green): $7.50
- Savings callout: "You save $4.50 (47%)"
- Estimated delivery window: "Arrives between 10:15 – 10:35 AM"

*Sticky bottom bar:*
- Left: Your price ($7.50, bold)
- Right: "Purchase" button (green, full prominence, 44pt height)
- This bar stays fixed as the consumer scrolls — the CTA is always reachable

**States:**
- Default (available)
- Selling fast (< 30 min safety window): amber freshness indicator + "Selling fast" label replaces "Fresh"
- Expired / claimed: "This listing is no longer available" overlay with "Back to marketplace" CTA — can happen if another consumer purchases while this screen is open

---

## 6. Purchase Confirmation

**Purpose:** Confirm the consumer understands what they're buying and capture payment. Fast — no unnecessary steps.

**Layout:** Modal sheet slides up from listing detail. Two steps: review → payment.

**Step 1 — Review:**
- Food name + quantity
- Delivery address (confirm or change link)
- Estimated arrival: "10:15 – 10:35 AM"
- Price: $7.50
- Note: "Payment is captured immediately. Refund available if no courier is found within 20 minutes."
- Primary button: "Confirm & pay →"

**Step 2 — Payment:**
- Apple Pay / Google Pay (primary, one-tap)
- Saved card (secondary)
- "Add payment method" link
- Primary button: "Pay $7.50" — shows spinner while processing, then transitions to Order Tracking

**Payment failure state:**
- Inline error below payment method: "Payment failed. Please check your card or try another method."
- Listing remains available — lock is released if payment fails
- Retry button re-activates immediately

---

## 7. Order Tracking

**Purpose:** After purchase, give the consumer calm confidence that their food is on the way. Modeled on the reassurance of Uber Eats / DoorDash post-order screens.

**Layout:** Full-screen. Status stepper top half, food summary bottom half.

**Components:**

*Headline:*
- "Your food is on the way!" — shown once courier is assigned
- "Finding your courier..." — shown in the < 10 min dispatch window

*ETA Card:*
- Large countdown: "Arriving in ~22 min"
- Estimated time range: "Between 10:15 – 10:35 AM"
- Updates in real time as GPS data arrives

*Status Stepper (4 steps, horizontal):*
- Purchased ✓ → Courier assigned ✓ → En route → Delivered
- Completed steps: green filled circle with checkmark
- Current step: green pulsing ring
- Upcoming steps: gray empty circle
- Step label below each circle (text, not color-only — accessibility requirement)

*Food Summary Card:*
- Thumbnail + food name + quantity
- Origin: "From a local restaurant"
- Handling note: "Keep hot · Deliver within 45 min" (courier-facing note shown for context)

*Contact / Help:*
- "Something wrong?" link — opens support options: "Courier is late" / "I need to cancel" / "Other issue"

*Delivered state:*
- Stepper shows all 4 steps complete
- Headline changes to: "Delivered! Enjoy your meal."
- Subtext: "We'll check in with you in 30 minutes."
- Auto-transition to Post-Delivery Feedback after 30 minutes (push notification)

---

## 8. Post-Delivery Feedback Prompt

**Purpose:** Capture safety and quality data systematically. Two taps maximum.

**Layout:** Push notification → opens to a simple full-screen prompt. Not a buried form.

**Push notification text:** "How was your FoodLink delivery? Tap to share — takes 5 seconds."

**In-app screen:**
- Food thumbnail + name
- Headline: "How was it?"
- Two large tappable cards (equal prominence):
  - Card A: "Safe & good" — green icon (checkmark), green border on tap
  - Card B: "Report an issue" — amber icon (warning), routes to dispute flow
- Subtext: "Your feedback helps keep FoodLink safe for everyone."
- Small link: "Skip" — records no response; payments release after 2-hour window regardless

**After tapping "Safe & good":**
- Brief celebration: checkmark animates, text: "Thanks! Glad it arrived well."
- Show impact update: "You've now received [X] meals through FoodLink · Saved $[Y] vs. retail"
- Auto-dismiss after 2 seconds → returns to marketplace

**After tapping "Report an issue":**
- Photo capture required (in-app camera, same constraint as donor)
- Reason selector: Temperature failure · Wrong item · Condition issue · Other
- Submit → platform mediation queue
- Consumer sees: "We've received your report. We'll resolve this within 24 hours."

---

## 9. Order History

**Purpose:** Let consumers review past orders, track savings, and reorder similar items.

**Layout:** Accessible from bottom nav "Orders" tab. Simple list, newest first.

**Components:**

*Summary strip at top:*
- Total saved vs. retail (lifetime)
- Total meals received
- Member since [date]

*Order list:*
- Each order card: food photo thumbnail + name + date + amount paid + savings amount
- Status pill: Delivered / Disputed / Refunded
- "Find similar" link on each card — filters marketplace by same food category

*Empty state:*
- "Your order history is empty."
- Subtext: "Head to the marketplace to find your first meal."
- CTA: "Browse listings →"

---

*FoodLink UI/UX Spec — Consumer / Recipient · v1.0 · ServeAI Initiative · Confidential*
