# FoodLink — Application Flow

**Version:** 1.0  
**Initiative:** ServeAI  
**Status:** Draft  
**Last Revised:** 2026-06-25

---

## Overview

FoodLink has three distinct user journeys — Donor, Consumer/Recipient, and Courier — plus a set of system-triggered background flows. The journeys are independent until they intersect at two critical handoff points: **purchase confirmation** (Consumer → triggers Courier dispatch) and **delivery confirmation** (Courier → triggers Donor payout release).

---

## Global Architectural Constraint: Audit Log

> **Every state change must write an `audit_log` record as part of the same atomic transaction that updates the listing status. This is non-negotiable and applies to every flow in this document without exception.**

When a listing status changes (e.g., `LISTED → PURCHASED`, `PURCHASED → IN_TRANSIT`, `IN_TRANSIT → DELIVERED`), the atomic transaction must include an `audit_log` insert capturing:

- `listing_id` — which batch changed
- `from_status` / `to_status` — the transition
- `actor_id` + `actor_role` — who triggered it (consumer, courier, donor, or system)
- `triggered_by` — the specific action (e.g., `CONSUMER_PURCHASE`, `COURIER_PICKUP`, `SYSTEM_EXPIRY_JOB`)
- `occurred_at` — server-side timestamp only; client timestamps are never used

If the `audit_log` insert fails, the entire transaction rolls back and the status update does not persist. A status change with no corresponding audit record must be treated as a system error, not a silent success.

---

## Journey 1: Donor

### 1.1 Onboarding

```
Land on FoodLink
      │
      ▼
Select account type: Donor
      │
      ▼
Commercial donor?
  ├── YES → Enter business license / food service permit number
  └── NO  → Phone OTP verification + address validation
      │
      ▼
Verification approved?
  ├── NO  → Error state: "We couldn't verify your account. Contact support."
  └── YES → Account created → Donor Dashboard
```

### 1.2 Create a Listing

```
Donor Dashboard
      │
      ▼
Tap "New Listing"
      │
      ▼
In-app camera opens (gallery access blocked)
      │
      ▼
Donor captures photo
      │
      ▼
System calls Gemini API (server-side)
      │
      ▼
AI returns: food_name, quantity, perishable flag
      │
      ▼
Confidence ≥ 80%?
  ├── YES → Pre-fill listing fields with AI result
  └── NO  → Show top 3 alternative classifications (tap to select)
              │
              ├── Donor taps an alternative → field confirmed
              ├── Voice input → field confirmed
              └── Keyboard input → field confirmed
                    │
                    ▼
              Field confirmed? 
              ├── NO (donor exits) → Session cleared, no data saved
              └── YES → Continue
      │
      ▼
Item flagged as perishable?
  ├── YES → Require "Prepared At" timestamp entry before continuing
  └── NO  → Continue
      │
      ▼
Pricing screen
  - AI-suggested donor_payout displayed (pre-filled default)
  - Slider shown: donor can adjust ±25% from suggestion
  - consumer_price, courier_fee, platform_fee update in real time
  - Slider upper bound dynamically capped to enforce 30% consumer discount floor
      │
      ▼
consumer_price satisfies 30% discount floor?
  ├── NO  → Listing blocked: "Price doesn't meet discount requirement"
  └── YES → Continue
      │
      ▼
Review summary screen
  - Item, quantity, donor payout, consumer price, courier fee
  - Food safety attestation checkbox (required)
      │
      ▼
Donor checks attestation + taps "Confirm Listing"
      │
      ▼
Listing written to DB (atomic RPC)
n8n webhook triggered → consumer marketplace updated
      │
      ▼
Listing goes live → Donor Dashboard (active listings view)
```

### 1.3 Donor Dashboard States

```
Donor Dashboard
  ├── Active Listings   → listing cards with status (Listed / Purchased / In Transit)
  ├── Past Listings     → completed and expired listings
  ├── Earnings          → payout history (released / held / pending)
  └── Account Settings  → profile, verification status, ToS
```

---

## Journey 2: Consumer / Recipient

### 2.1 Onboarding

```
Land on FoodLink
      │
      ▼
Select account type: Consumer or Shelter
      │
      ▼
Create account (email + phone OTP)
      │
      ▼
Set up receiving window profile
  - Delivery address
  - Available days and time ranges
  - Dietary restrictions / food category filters (optional)
      │
      ▼
Profile saved → Consumer Marketplace
```

### 2.2 Browse & Purchase

```
Consumer Marketplace
  - Feed filtered by: receiving window match + dietary filters
  - Each card shows: item, quantity, origin type, consumer_price, estimated delivery window
      │
      ▼
Consumer taps a listing
      │
      ▼
Listing detail view
  - Item info, food handling notes (e.g., "Refrigerated — keep cold")
  - Estimated delivery window
  - Price breakdown
      │
      ▼
Tap "Purchase"
      │
      ▼
Payment confirmation screen
  - Consumer price, delivery address, estimated window
      │
      ▼
Confirm purchase
      │
      ▼
Atomic DB lock (SELECT FOR UPDATE SKIP LOCKED)
      │
      ▼
Lock successful?
  ├── NO (concurrent purchase conflict) → "This listing was just claimed.
  │                                        Here's what's available now." → Back to marketplace
  └── YES → Payment capture attempted
              │
              ▼
           Payment successful?
           ├── NO → Transaction rolls back · DB lock released · listing returns to LISTED
           │         Consumer sees: "Payment failed. Please check your card and try again."
           │         Consumer offered: retry with same card / update payment method
           │         Listing remains available for purchase (no hold placed)
           └── YES → Listing status → PURCHASED
                      Platform dispatches nearest eligible courier
                      Consumer receives ETA notification within 60 seconds
              │
              ▼
           Consumer Order Tracking screen (see 2.3)
```

### 2.3 Order Tracking & Delivery

```
Consumer Order Tracking screen
  - Status: Courier dispatched / En route / Arriving
  - Estimated arrival time (updated as courier moves)
      │
      ▼
Delivery arrives
      │
      ▼
Consumer receives food
      │
      ▼
Optional: Acknowledge delivery in-app
      │
      ▼
2-hour dispute window opens
  ├── No dispute filed → Payments auto-release after 2 hours
  └── Dispute filed (see 2.4)
```

### 2.4 Post-Delivery Feedback Prompt

```
30 minutes after delivery confirmed
      │
      ▼
System sends push notification: "How was your FoodLink delivery?"
      │
      ▼
Consumer responds?
  ├── "Confirm Safe & Good" → positive feedback_event logged
  │                           feeds food safety incident rate metric
  │                           feeds donor trust score
  │
  ├── "Report an Issue"    → routes into dispute flow (see 2.5)
  │
  └── No response within 2-hour window → delivery implicitly accepted
                                          payments auto-release
```

### 2.5 Quality Dispute

```
Consumer taps "Report an Issue" (within 2-hour window)
      │
      ▼
Required: capture photo of disputed food
      │
      ▼
Select reason: Temperature failure / Condition mismatch / Wrong item
      │
      ▼
Dispute submitted → Platform mediation queue
  - Donor payout held
  - Courier fee paid regardless
  - Consumer provisional refund hold
  - Resolution SLA: 24 hours
      │
      ▼
Platform resolves → Consumer notified of outcome
```

---

## Journey 3: Courier

### 3.1 Onboarding

```
Land on FoodLink
      │
      ▼
Select account type: Courier
      │
      ▼
Background check consent + submission
      │
      ▼
Vehicle information
  - Do you have insulated transport capability?
    ├── YES → insulated_transport_capable flag set on profile
    └── NO  → flag not set (excluded from cold-chain dispatches)
      │
      ▼
Background check approved?
  ├── NO  → "We'll notify you when your application is reviewed"
  └── YES → Courier Dashboard
```

### 3.2 Receive & Accept Dispatch

```
Courier sets status: Available (on Courier Dashboard)
      │
      ▼
Consumer purchases a listing (Journey 2 triggers this)
      │
      ▼
Platform selects nearest eligible courier
  - Cold-chain listing? → only couriers with insulated_transport_capable flag
      │
      ▼
Courier receives dispatch notification
  - Pickup address (donor)
  - Delivery address (consumer)
  - Item summary + food safety handling notes
  - Confirmed courier_fee
  - 5-minute acceptance window countdown
      │
      ▼
Courier responds within 5 minutes?
  ├── NO  → System re-dispatches to next nearest eligible courier
  │          (repeat until accepted or 20-minute threshold reached)
  └── YES → Courier accepts → Navigation to donor pickup begins
```

### 3.3 Pickup

```
Courier navigates to donor pickup address
      │
      ▼
Courier arrives + confirms pickup in-app
      │
      ▼
Listing status → IN_TRANSIT
Recipient notified: courier is on the way + live ETA
```

### 3.4 Delivery

```
Courier arrives at consumer delivery address
      │
      ▼
Courier taps "Confirm Delivery"
      │
      ▼
Optional: Consumer acknowledges in-app
      │
      ▼
Delivery accepted?
  ├── YES → Listing status → DELIVERED
  │          Donor payout released from escrow
  │          Courier fee paid
  │          Consumer 2-hour dispute window opens (Journey 2.4)
  │
  └── NO (shelter/consumer rejects delivery)
          │
          ▼
       Courier logs rejection reason in-app
       (Temperature failure / Condition mismatch / Window violation)
          │
          ▼
       Courier fee paid regardless
       Donor payout held → Platform mediation
       Consumer refund hold → Resolution SLA: 24 hours
```

---

## System Background Flows

These flows run automatically with no user trigger.

### Food Safety Expiry Monitor (runs every 5 minutes)

```
n8n scheduled workflow fires
      │
      ▼
Query: active listings where perishable = true
      │
      ▼
For each listing:
  (prepared_at + max_safe_transit_window) − now < 30 minutes?
  ├── NO  → No action
  └── YES → Listing hidden from consumer marketplace
              Donor notified
              Listing NOT discounted — unsafe food is not incentivized to sell faster
              If already purchased but not dispatched → consumer refunded automatically
```

### No Courier Acceptance (20-minute threshold)

```
20 minutes elapsed since purchase with no courier acceptance
      │
      ▼
Consumer notified: revised ETA + full refund option
      │
      ▼
Listing temperature-sensitive AND safety window < 30 min away?
  ├── YES → Listing hidden from marketplace
  │          Consumer auto-refunded
  │          Donor notified
  └── NO  → Re-dispatch continues in background
              Listing remains active
              Donor notified of delay
```

### Donor Post-Purchase Cancellation

```
Donor cancels after consumer purchase confirmed
      │
      ▼
Consumer fully refunded
Courier receives partial cancellation fee (if already dispatched)
Donor payout forfeited for this transaction
Cancellation penalty applied to donor account standing
      │
      ▼
3rd post-purchase cancellation on account?
  ├── YES → Account flagged for review
  └── NO  → Donor Dashboard updated
```

---

## Cross-Flow Intersection Map

| Event | Triggered By | Effect On |
|---|---|---|
| Listing goes live | Donor confirms listing | Consumer marketplace updated |
| Consumer purchase confirmed | Consumer payment captured | Courier dispatch triggered; Donor listing locked |
| Courier accepts dispatch | Courier taps accept | Consumer receives ETA notification |
| Courier confirms pickup | Courier arrives at donor | Consumer notified courier is en route |
| Delivery confirmed | Courier taps confirm | Donor payout released; Courier paid; Consumer dispute window opens |
| Dispute filed | Consumer within 2 hrs | Donor payout held; Platform mediation triggered |
| Safety expiry | System (n8n, every 5 min) | Listing hidden; Consumer refunded if purchased |
| No courier in 20 min | System timer | Consumer notified; possible auto-refund |

---

*FoodLink AppFlow v1.0 · ServeAI Initiative · Confidential*
