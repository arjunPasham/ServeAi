> ⚠️ **SUPERSEDED (2026-07): This document describes the pre-pivot consumer-marketplace model.**
> FoodLink pivoted to the institutional-first "operating system for surplus food."
> Source of truth: the Serve AI strategy doc (TGTG / Fix info / Tab 17 sections) and `analysis/` + `PHASE_1_PLAN.md` in this repo.
> Do **not** use this document as a build input.

# FoodLink — Technical Requirements Document (TRD)

**Version:** 1.1 (Post-Review Fixes Applied)
**Project:** ServeAI / FoodLink
**Status:** Draft for Review
**Prepared:** 2026-06-25
**Last Revised:** 2026-06-25

> **Fixes applied in this file vs. original v1.1:**
> - `feedback_events` table: added `photo_url TEXT` column (required for dispute photo capture per PRD §8.3)
> - STEP 5 acceptance criteria: expanded ±25% pricing band specification with dynamic cap logic
> - State naming: `dispatched` used consistently throughout (AppFlow and PRD updated to match)

---

> ⚠ **DUAL-AUDIENCE DOCUMENT**
>
> This TRD is written in two layers:
> - **Layer 1 — Human Brief:** Plain English. No coding background required.
> - **Layer 2 — Agent-Executable Spec:** Precise build specification for a coding agent. Includes version pins, schemas, API contracts, environment variables, and a dependency-aware build sequence with acceptance criteria.

---

## BUILDER AI — READ THIS BEFORE WRITING ANY CODE

```
═══════════════════════════════════════════════════════════════════
🤖 BUILDER AI — READ THIS BEFORE WRITING ANY CODE
═══════════════════════════════════════════════════════════════════
1. Source of truth = LAYER 2. Layer 1 is plain-English context for
   humans; build from Layer 2's schemas, RPCs, API contracts, env
   vars, and the numbered build sequence (Steps 1–16).
2. Build in order. Execute numbered steps in sequence. Each step has
   an Acceptance Criteria checklist — verify EVERY box before moving
   to the next step.
3. Respect BLOCKED steps. Any step marked ⛔ BLOCKED BY decision #N
   must NOT be built until that decision has a confirmed value from a
   human. If a required value is missing, STOP and ask.
4. Version pins are authoritative EXCEPT those marked ⚠ UNVERIFIED.
5. Security is non-negotiable. No secret/API key may appear in the
   client bundle. Section 2.16 is a build requirement, not optional.
6. Do not change architecture decisions without flagging the deviation.
7. Begin at Step 1 only after confirming blocking decisions for
   Steps 3, 5, and 7 are resolved.
═══════════════════════════════════════════════════════════════════
```

---

## LAYER 1 — HUMAN BRIEF

### What is FoodLink?

FoodLink is a website that connects three groups of people: donors (restaurants and households with leftover food), consumers (shelters, food banks, and budget families), and couriers (independent delivery workers). The platform does three things automatically:

1. A restaurant staff member takes a photo of leftover lasagna. FoodLink's AI instantly identifies what it is, estimates how much there is, and suggests a fair price.
2. A shelter browsing the app sees the listing and buys it with one tap. Money is captured immediately.
3. FoodLink sends the nearest available courier to pick up the food and deliver it — only after someone has paid for it. No courier ever shows up to a pickup that doesn't have a confirmed buyer.

The whole loop — photo to delivery — is designed to complete faster than food spoils.

### The Recommended Tech Stack

| What it does | Tool chosen | Why |
|---|---|---|
| The website itself | Next.js 16 | Most popular modern web framework; runs on any device; handles camera, forms, and live marketplace in one |
| Background jobs & safety timers | n8n (webhooks) + Inngest (timers) | n8n wires pieces together; Inngest guarantees timer execution even if the server crashes |
| Database | Supabase (PostgreSQL) | SELECT FOR UPDATE SKIP LOCKED ensures two people can never buy the same listing simultaneously |
| AI food recognition | Gemini 2.5 Flash | Identifies food from a photo, estimates weight, returns structured answer in under 5 seconds |
| Payments | Stripe Connect (Separate Charges + Transfers) | The only Stripe pattern supporting splits to two connected accounts (donor + courier) from one payment |
| Mapping & ETA | Google Routes API | Finds nearest courier and computes delivery ETA |
| Push notifications | OneSignal (free tier) + FCM/APNs | Sends courier dispatch and delivery pings within 60 seconds |
| Phone verification | Twilio Verify | Industry standard OTP verification |
| Address validation | Smarty (SmartyStreets) | USPS CASS certified address validation |
| USDA commodity prices | USDA MARS API | Free US government API for food commodity prices |
| Audit log | PostgreSQL (append-only table) | Every food safety attestation, purchase, and delivery is recorded forever |

### The Three Biggest Technical Decisions

**Decision 1: Why not use n8n for everything?**

n8n's schedule timer has a known reliability problem: if the server has a hiccup, it can skip a scheduled task entirely. For FoodLink, a missed 5-minute expiry check means temperature-sensitive food might stay listed after it's no longer safe. Inngest guarantees the job runs, retries if it fails, and gives full execution logs.

Architecture rule: n8n handles webhooks. Inngest handles all timers.

**Decision 2: Why Stripe Connect "Separate Charges and Transfers"?**

Every consumer payment must split to two separate people: the donor and the courier. Destination Charges only support transferring to one connected account per transaction. Separate Charges and Transfers is the Stripe pattern designed for exactly this: the full consumer payment lands in FoodLink's platform account first (full escrow control), then two explicit transfers are created — one to the donor, one to the courier — after delivery is confirmed.

**Decision 3: Why doesn't AI detect "temperature sensitive" directly?**

Gemini identifies what the food is and gives a confidence score. It does not have a built-in temperature sensitive flag. Our system maps the detected food category to a lookup table of known temperature-sensitive categories. This is more reliable than asking an AI to make a safety call.

### Key Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Gemini misclassifies food with <80% confidence | Medium | PRD forces donor correction flow; listing cannot publish with unresolved low-confidence |
| iOS Safari web push doesn't deliver in 60s | Medium | Email fallback for critical notifications; FCM supported since Safari 16.4 |
| Inngest Hobby tier (5 concurrent) gets saturated | Low at MVP | $75/month Pro upgrade; monitor on day 1 |
| USDA MARS API has no real-time endpoint | Low | PRD §7.2.1 accounts for manual table; Phase 2 automates it |
| Stripe dispute on perishable delivery | Medium | Courier fee is unconditional; donor payout held pending dispute SLA; 2hr window |
| Business license validation has no public API | High (process) | MVP = manual review queue; automated verification is Phase 2 |

---

## LAYER 2 — AGENT-EXECUTABLE SPECIFICATION

---

## ⛔ BLOCKING DECISIONS REQUIRED BEFORE BUILD

| Decision | Blocks Steps | Topic |
|---|---|---|
| #1 — Legal structure (dual-track vs single-track) | STEP 3, STEP 5 | Good Samaritan / discounted sale model per state |
| #2 — Stripe Connect account type (Express vs Custom) | STEP 3, STEP 10 | Donor onboarding UX & Stripe approval |
| #3 — Safety window constants | STEP 6, STEP 9 | FDA 2-hr hot / 4-hr cold values require counsel sign-off |
| #4 — Courier IC classification per state | STEP 8 | AB5 CA risk; blocks CA launch |
| #5 — Inngest vs Trigger.dev (data residency) | STEP 9 | Cloud-only vs self-hosted durable timers |
| #6 — platform_fee value | STEP 5 | Required to compute consumer_price |
| #7 — donor_recovery_rate confirmation | STEP 5 | Currently assumed 40%; finance must confirm |
| #8 — Residential donor transaction cap | STEP 3 | Required for Stripe risk management |
| #9 — Money-transmitter licensing | STEP 7, STEP 10 | Holding consumer funds in escrow may trigger state MTL/MSB registration |

---

## 2.1 Version Pins

```
next@latest                         # ⚠ UNVERIFIED exact patch — pin to 16.x stable
react@19.2.0                        # ✅ confirmed
react-dom@19.2.0                    # ✅ confirmed
typescript@5.7.x
tailwindcss@4.x
zod@3.x
@supabase/supabase-js@2.x           # ✅ confirmed
@supabase/ssr@0.x
stripe@22.x                         # ✅ CORRECTED from @17.x
inngest@3.x
@google/generative-ai@latest        # ⚠ UNVERIFIED exact minor
twilio@5.x
web-push@3.x
@onesignal/node-onesignal@1.x
pg@8.x

Node version: >=20.x LTS
Package manager: pnpm@9.x
PostgreSQL version: 17 (Supabase managed default as of June 2026) ✅ CORRECTED from 15.x
Stripe API version: 2026-06-24.dahlia ✅ CORRECTED from 2024-12-18.acacia
```

---

## 2.2 Required Environment Variables

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=         # Never in client bundle

# Stripe Connect
STRIPE_SECRET_KEY=                 # sk_live_ or sk_test_
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=

# Gemini
GEMINI_API_KEY=                    # Never in client bundle

# Twilio Verify
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_VERIFY_SERVICE_SID=

# Google Routes API
GOOGLE_ROUTES_API_KEY=             # Server-side only; not NEXT_PUBLIC_

# OneSignal
ONESIGNAL_APP_ID=
ONESIGNAL_REST_API_KEY=

# Smarty (address validation)
SMARTY_AUTH_ID=
SMARTY_AUTH_TOKEN=

# USDA MARS API
USDA_MARS_API_KEY=

# Inngest
INNGEST_SIGNING_KEY=
INNGEST_EVENT_KEY=

# n8n webhook secrets
N8N_WEBHOOK_SECRET=

# App
NEXTAUTH_SECRET=                   # >=32 byte random string
NEXTAUTH_URL=
NODE_ENV=production
```

> **Security rule:** Any variable without `NEXT_PUBLIC_` prefix MUST be used only in Next.js Server Actions, Route Handlers, or API Routes. Violation = P0 security bug.

---

## 2.3 Project File and Module Structure

```
foodlink/
├── AGENTS.md
├── .env.local
├── next.config.ts
├── tailwind.config.ts
├── package.json
│
├── app/
│   ├── layout.tsx
│   ├── page.tsx
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   ├── register/page.tsx
│   │   └── verify-phone/page.tsx
│   ├── (donor)/
│   │   ├── dashboard/page.tsx
│   │   ├── listings/new/page.tsx
│   │   └── listings/[id]/page.tsx
│   ├── (consumer)/
│   │   ├── browse/page.tsx
│   │   └── orders/[id]/page.tsx
│   ├── (courier)/
│   │   ├── dashboard/page.tsx
│   │   └── dispatch/[id]/page.tsx
│   ├── (admin)/
│   │   └── dashboard/page.tsx
│   └── api/
│       ├── inngest/route.ts
│       ├── stripe/webhook/route.ts
│       ├── push/subscribe/route.ts
│       └── n8n/webhook/route.ts
│
├── actions/
│   ├── auth.ts
│   ├── listing.ts
│   ├── ai-scan.ts
│   ├── payment.ts
│   ├── dispatch.ts
│   └── feedback.ts
│
├── lib/
│   ├── supabase/
│   │   ├── client.ts
│   │   ├── server.ts
│   │   └── middleware.ts
│   ├── stripe.ts
│   ├── gemini.ts
│   ├── twilio.ts
│   ├── smarty.ts
│   ├── usda.ts
│   ├── onesignal.ts
│   ├── google-routes.ts
│   └── temperature-map.ts
│
├── inngest/
│   ├── client.ts
│   └── functions/
│       ├── cold-chain-check.ts
│       ├── dispute-window.ts
│       ├── feedback-prompt.ts
│       └── payout-release.ts
│
├── supabase/
│   ├── migrations/
│   │   ├── 001_extensions.sql
│   │   ├── 002_schema.sql
│   │   ├── 003_rls.sql
│   │   ├── 004_rpc.sql
│   │   ├── 005_audit.sql
│   │   └── 006_indexes.sql
│   └── seed.sql
│
├── components/
│   ├── ui/
│   ├── listing/
│   │   ├── AIScanUploader.tsx
│   │   ├── PricingSlider.tsx
│   │   ├── ListingCard.tsx
│   │   └── ConfidenceCorrector.tsx
│   ├── dispatch/
│   │   ├── DispatchCard.tsx
│   │   └── DeliveryConfirm.tsx
│   └── shared/
│       ├── AddressObfuscated.tsx
│       └── ETABadge.tsx
│
└── types/
    ├── database.ts
    └── api.ts
```

---

## 2.4 Database Schema (PostgreSQL 17 / Supabase)

### Extensions Required

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pg_cron";
```

### Core Tables

```sql
-- USERS / ACCOUNTS
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email          TEXT UNIQUE NOT NULL,
  phone          TEXT UNIQUE,
  phone_verified BOOLEAN DEFAULT FALSE,
  role           TEXT NOT NULL CHECK (role IN ('donor','consumer','courier','admin')),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- DONOR PROFILES
CREATE TABLE donor_profiles (
  user_id            UUID PRIMARY KEY REFERENCES users(id),
  type               TEXT NOT NULL CHECK (type IN ('commercial','residential')),
  business_name      TEXT,
  license_number     TEXT,
  license_verified   BOOLEAN DEFAULT FALSE,
  address            TEXT NOT NULL,
  address_lat        FLOAT8,
  address_lng        FLOAT8,
  location           GEOGRAPHY(POINT,4326),
  cancellation_count INTEGER DEFAULT 0,
  account_review     BOOLEAN DEFAULT FALSE
);

-- CONSUMER PROFILES
CREATE TABLE consumer_profiles (
  user_id           UUID PRIMARY KEY REFERENCES users(id),
  type              TEXT NOT NULL CHECK (type IN ('shelter','household')),
  organization_name TEXT,
  delivery_address  TEXT NOT NULL,
  delivery_lat      FLOAT8,
  delivery_lng      FLOAT8,
  location          GEOGRAPHY(POINT,4326),
  receiving_window  JSONB NOT NULL   -- [{day:"Mon",start:"09:00",end:"17:00"}]
);

-- COURIER PROFILES
CREATE TABLE courier_profiles (
  user_id                     UUID PRIMARY KEY REFERENCES users(id),
  is_available                BOOLEAN DEFAULT FALSE,
  current_lat                 FLOAT8,
  current_lng                 FLOAT8,
  current_location            GEOGRAPHY(POINT,4326),
  insulated_transport_capable BOOLEAN DEFAULT FALSE,
  stripe_account_id           TEXT,
  location_updated_at         TIMESTAMPTZ
);

-- USDA COMMODITY PRICE TABLE
CREATE TABLE usda_commodity_prices (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category                TEXT NOT NULL UNIQUE,
  price_per_lb            NUMERIC(10,4) NOT NULL,
  retail_benchmark_per_lb NUMERIC(10,4) NOT NULL,
  updated_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_by              UUID REFERENCES users(id),
  CONSTRAINT stale_flag CHECK (TRUE)
);

-- LISTINGS
CREATE TABLE listings (
  id                           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  donor_id                     UUID NOT NULL REFERENCES users(id),
  status                       TEXT NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft','live','purchased',
                                                 'dispatched','delivered',
                                                 'disputed','hidden','cancelled')),
  -- AI scan results
  detected_item                TEXT NOT NULL,
  estimated_quantity_lbs       NUMERIC(8,2) NOT NULL,
  confidence_score             NUMERIC(4,3) NOT NULL,
  temperature_sensitive        BOOLEAN NOT NULL DEFAULT FALSE,
  usda_category                TEXT REFERENCES usda_commodity_prices(category),
  prepared_at                  TIMESTAMPTZ,
  safety_expires_at            TIMESTAMPTZ,
  -- pricing (USD cents)
  base_commodity_price_cents   INTEGER NOT NULL,
  suggested_donor_payout_cents INTEGER NOT NULL,
  donor_payout_cents           INTEGER NOT NULL,
  consumer_price_cents         INTEGER NOT NULL,
  platform_fee_cents           INTEGER NOT NULL,
  courier_fee_cents            INTEGER NOT NULL,
  -- legal
  safety_attested              BOOLEAN NOT NULL DEFAULT FALSE,
  safety_attested_at           TIMESTAMPTZ,
  -- logistics
  image_url                    TEXT NOT NULL,
  handling_notes               TEXT,
  -- timestamps
  created_at                   TIMESTAMPTZ DEFAULT NOW(),
  published_at                 TIMESTAMPTZ,
  purchased_at                 TIMESTAMPTZ,
  dispatched_at                TIMESTAMPTZ,
  delivered_at                 TIMESTAMPTZ
);

-- ORDERS
CREATE TABLE orders (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id                UUID NOT NULL REFERENCES listings(id),
  consumer_id               UUID NOT NULL REFERENCES users(id),
  courier_id                UUID REFERENCES users(id),
  stripe_payment_intent_id  TEXT NOT NULL,
  stripe_charge_id          TEXT,
  donor_transfer_id         TEXT,
  courier_transfer_id       TEXT,
  status                    TEXT NOT NULL DEFAULT 'pending_dispatch'
                            CHECK (status IN ('pending_dispatch','dispatched',
                                              'delivered','refunded','disputed')),
  dispatch_attempts         INTEGER DEFAULT 0,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  delivered_at              TIMESTAMPTZ,
  dispute_window_expires_at TIMESTAMPTZ
);

-- DISPATCH EVENTS
CREATE TABLE dispatch_events (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id     UUID NOT NULL REFERENCES orders(id),
  courier_id   UUID NOT NULL REFERENCES users(id),
  offered_at   TIMESTAMPTZ DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  response     TEXT CHECK (response IN ('accepted','declined','timeout'))
);

-- FEEDBACK EVENTS
-- FIX APPLIED: photo_url added (required when outcome = 'issue_reported', per PRD §8.3)
CREATE TABLE feedback_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID NOT NULL REFERENCES orders(id),
  consumer_id UUID NOT NULL REFERENCES users(id),
  outcome     TEXT NOT NULL CHECK (outcome IN ('positive','issue_reported','implicit_accept')),
  photo_url   TEXT,              -- required when outcome = 'issue_reported'; null otherwise
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- AUDIT LOG (append-only — no UPDATE/DELETE by app user)
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   UUID NOT NULL,
  event_type  TEXT NOT NULL,
  actor_id    UUID,
  actor_role  TEXT,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Revoke UPDATE and DELETE on audit_log from app role
REVOKE UPDATE, DELETE ON audit_log FROM authenticated;
REVOKE UPDATE, DELETE ON audit_log FROM anon;
```

### Temperature Sensitivity Lookup (`lib/temperature-map.ts`)

```typescript
// Maps USDA commodity category to temperature_sensitive flag
// Based on FDA Food Code hazardous food definitions
export const TEMPERATURE_SENSITIVE_CATEGORIES = new Set([
  'POULTRY', 'BEEF', 'PORK', 'SEAFOOD', 'EGGS',
  'DAIRY', 'COOKED_RICE', 'COOKED_BEANS', 'PREPARED_HOT_FOOD',
  'CUT_PRODUCE', 'SPROUTS'
]);

export function isTemperatureSensitive(usdaCategory: string): boolean {
  return TEMPERATURE_SENSITIVE_CATEGORIES.has(usdaCategory);
}
```

---

## 2.5 Key RPC Functions

### Atomic Listing Claim

```sql
CREATE OR REPLACE FUNCTION claim_listing(
  p_listing_id UUID,
  p_consumer_id UUID,
  p_stripe_payment_intent_id TEXT
) RETURNS orders AS $$
DECLARE
  v_listing listings;
  v_order   orders;
BEGIN
  SELECT * INTO v_listing
  FROM listings
  WHERE id = p_listing_id AND status = 'live'
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LISTING_UNAVAILABLE'
      USING HINT = 'Listing already purchased or unavailable';
  END IF;

  UPDATE listings
  SET status = 'purchased', purchased_at = NOW()
  WHERE id = p_listing_id;

  INSERT INTO orders (
    listing_id, consumer_id, stripe_payment_intent_id,
    status, dispute_window_expires_at
  )
  VALUES (
    p_listing_id, p_consumer_id, p_stripe_payment_intent_id,
    'pending_dispatch', NULL
  )
  RETURNING * INTO v_order;

  INSERT INTO audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('listing', p_listing_id, 'purchased', p_consumer_id, 'consumer',
          jsonb_build_object('order_id', v_order.id,
                             'payment_intent', p_stripe_payment_intent_id));

  RETURN v_order;
END;
$$ LANGUAGE plpgsql;
```

### Delivery Confirmation

```sql
CREATE OR REPLACE FUNCTION confirm_delivery(
  p_order_id UUID,
  p_courier_id UUID
) RETURNS VOID AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
BEGIN
  UPDATE orders
  SET status = 'delivered',
      delivered_at = v_now,
      dispute_window_expires_at = v_now + INTERVAL '2 hours'
  WHERE id = p_order_id
    AND courier_id = p_courier_id
    AND status = 'dispatched';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND_OR_INVALID_STATE';
  END IF;

  UPDATE listings
  SET status = 'delivered', delivered_at = v_now
  WHERE id = (SELECT listing_id FROM orders WHERE id = p_order_id);

  INSERT INTO audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('order', p_order_id, 'delivered', p_courier_id, 'courier',
          jsonb_build_object('delivered_at', v_now));
END;
$$ LANGUAGE plpgsql;
```

---

## 2.6 API Contracts

### A. AI Scan (`POST /actions/ai-scan`)

**Input (Server Action, FormData):**
```json
{
  "imageFile": "File (JPEG/PNG, max 10MB)",
  "listingId": "string (optional — if editing existing draft)"
}
```

**Output:**
```json
{
  "success": true,
  "data": {
    "detected_item": "string",
    "estimated_quantity_lbs": 8.0,
    "confidence_score": 0.94,
    "temperature_sensitive": true,
    "usda_category": "POULTRY",
    "suggested_donor_payout_cents": 420,
    "consumer_price_cents": 750,
    "alternatives": []
  },
  "error": "LOW_CONFIDENCE | GEMINI_TIMEOUT | INVALID_IMAGE | SERVER_ERROR"
}
```

**Gemini prompt template (`lib/gemini.ts`):**
```typescript
const SYSTEM_PROMPT = `You are a food inventory assistant for a food redistribution marketplace.
Analyze the provided food image and return ONLY valid JSON matching this schema:
{
  "detected_item": "string (specific food name, e.g. 'Roasted Chicken Thighs')",
  "estimated_quantity_lbs": number,
  "confidence_score": number (0.0 to 1.0),
  "usda_category": "string (one of: POULTRY|BEEF|PORK|SEAFOOD|EGGS|DAIRY|COOKED_RICE|COOKED_BEANS|PREPARED_HOT_FOOD|CUT_PRODUCE|SPROUTS|PRODUCE_LEAFY|PRODUCE_ROOT|GRAIN|BAKED_GOOD|OTHER)",
  "alternatives": ["string", "string", "string"]
}`;
```

### B. Claim Listing (`POST /actions/listing — claimListing`)

```typescript
// Input
{ listingId: string }

// Output
{
  success: boolean
  orderId?: string
  checkoutUrl?: string
  error?: 'LISTING_UNAVAILABLE' | 'PAYMENT_ERROR' | 'SERVER_ERROR'
}
```

### C. Stripe Webhook Handler (`POST /api/stripe/webhook`)

Events handled:
- `payment_intent.succeeded` → trigger Inngest `dispatch.initiated` event
- `payment_intent.payment_failed` → revert listing to `live`, notify consumer
- `transfer.created` → log to `audit_log`

```typescript
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-06-24.dahlia',
});

export async function POST(req: Request) {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature')!;
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    return Response.json({ error: 'Invalid signature' }, { status: 400 });
  }
  // process event...
}
```

### D. Inngest Functions

**cold-chain-check (every 5 minutes)**
```typescript
export const coldChainCheck = inngest.createFunction(
  { id: 'cold-chain-check', retries: 3 },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    const expiring = await step.run('fetch-expiring', async () => {
      // Query: temperature_sensitive=true AND status IN ('live','dispatched')
      // AND safety_expires_at - NOW() < 30 minutes
    });
    for (const listing of expiring) {
      await step.run(`hide-listing-${listing.id}`, async () => {
        // UPDATE listings SET status='hidden'
        // INSERT audit_log event_type='safety_expired'
        // If purchased+dispatched: trigger consumer refund + notify donor
      });
    }
  }
);
```

**dispute-window (triggered on `delivery/confirmed`)**
```typescript
export const disputeWindow = inngest.createFunction(
  { id: 'dispute-window', retries: 3 },
  { event: 'delivery/confirmed' },
  async ({ event, step }) => {
    await step.sleep('wait-dispute-window', '2h');
    await step.run('check-dispute-status', async () => {
      // If order still status='delivered' (not 'disputed'), release payouts
    });
    await step.run('release-donor-payout', async () => {
      // stripe.transfers.create({ destination: donor_stripe_account_id, ... })
    });
    await step.run('release-courier-payout', async () => {
      // stripe.transfers.create({ destination: courier_stripe_account_id, ... })
    });
  }
);
```

**feedback-prompt (triggered on `delivery/confirmed`)**
```typescript
export const feedbackPrompt = inngest.createFunction(
  { id: 'feedback-prompt', retries: 3 },
  { event: 'delivery/confirmed' },
  async ({ event, step }) => {
    await step.sleep('wait-feedback-delay', '30m');
    await step.run('send-feedback-push', async () => {
      // OneSignal: send to consumer's push subscription
      // Message: "How was your FoodLink delivery?" [Confirm Safe] [Report Issue]
    });
  }
);
```

---

## 2.7 Row-Level Security Policies

```sql
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "consumers_see_live_listings" ON listings
  FOR SELECT TO authenticated
  USING (status = 'live' AND auth.jwt() ->> 'role' = 'consumer');

CREATE POLICY "donors_see_own_listings" ON listings
  FOR SELECT TO authenticated
  USING (donor_id = auth.uid());

CREATE POLICY "courier_location_service_only" ON courier_profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
```

---

## 2.8 Geospatial Privacy Implementation

```sql
-- Consumer-facing view: obfuscate to ~500m neighborhood grid
SELECT
  id,
  detected_item,
  consumer_price_cents,
  ST_X(ST_SnapToGrid(location::geometry, 0.005)) AS approx_lng,
  ST_Y(ST_SnapToGrid(location::geometry, 0.005)) AS approx_lat
FROM listings
WHERE status = 'live';
```

Full address revealed only to assigned courier AFTER dispatch acceptance, verified in Server Action with `courier_id = auth.uid()` and `order.status = 'dispatched'`.

---

## 2.9 Nearest Courier Query (PostGIS)

```sql
SELECT
  cp.user_id,
  cp.current_location,
  ST_Distance(
    cp.current_location,
    ST_MakePoint($donor_lng, $donor_lat)::geography
  ) AS distance_meters
FROM courier_profiles cp
JOIN users u ON u.id = cp.user_id
WHERE
  cp.is_available = TRUE
  AND ($requires_cold_chain = FALSE OR cp.insulated_transport_capable = TRUE)
  AND ST_DWithin(
    cp.current_location,
    ST_MakePoint($donor_lng, $donor_lat)::geography,
    10000
  )
ORDER BY distance_meters ASC
LIMIT 5;
```

---

## 2.10 Stripe Connect Money Flow

**Charge model: Separate Charges + Transfers**

Separate Charges and Transfers is the only Stripe Connect pattern supporting splits to multiple connected accounts from one payment — required for donor + courier dual payouts.

```typescript
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-06-24.dahlia',
});

// Step 1: Capture payment from consumer (at purchase)
const paymentIntent = await stripe.paymentIntents.create({
  amount: consumer_price_cents,
  currency: 'usd',
  payment_method_types: ['card'],
  capture_method: 'automatic',
  metadata: {
    listing_id,
    order_id,
    donor_payout_cents: String(donor_payout_cents),
    courier_fee_cents: String(courier_fee_cents),
    platform_fee_cents: String(platform_fee_cents),
  }
});

// Step 2 (after delivery confirmed — unconditional): Transfer to courier
const courierTransfer = await stripe.transfers.create({
  amount: courier_fee_cents,
  currency: 'usd',
  destination: courier_stripe_account_id,
  source_transaction: charge_id,
  metadata: { order_id, reason: 'courier_fee' }
});

// Step 3 (after delivery + 2hr dispute window via Inngest): Transfer to donor
const donorTransfer = await stripe.transfers.create({
  amount: donor_payout_cents,
  currency: 'usd',
  destination: donor_stripe_account_id,
  source_transaction: charge_id,
  metadata: { order_id, reason: 'donor_payout' }
});
```

---

## 2.11 Ordered Build Sequence

### STEP 1 — Project Scaffold

**Action:** `pnpm create next-app@latest foodlink --typescript --tailwind --app --no-src-dir` + shadcn/ui, zod, @supabase/supabase-js, @supabase/ssr

**Acceptance Criteria:**
- [ ] `next --version` returns a 16.x version
- [ ] `pnpm dev` starts without errors
- [ ] `app/layout.tsx` exists with `<html lang="en">`
- [ ] No `NEXT_PUBLIC_*` secrets present in any `.ts` file

---

### STEP 2 — Supabase Project + Database Schema

**Action:** Run migrations `001_extensions.sql` → `006_indexes.sql` in order against Supabase project (PostgreSQL 17)

**Acceptance Criteria:**
- [ ] `SELECT PostGIS_version();` returns a version string
- [ ] `SELECT version();` confirms PostgreSQL 17.x
- [ ] `\dt` shows all 10 tables: `users`, `donor_profiles`, `consumer_profiles`, `courier_profiles`, `usda_commodity_prices`, `listings`, `orders`, `dispatch_events`, `feedback_events`, `audit_log`
- [ ] `UPDATE audit_log SET event_type='modified' WHERE entity_type='test';` must raise `ERROR: permission denied`
- [ ] `SELECT * FROM listings WHERE status='live' FOR UPDATE SKIP LOCKED;` executes without syntax error
- [ ] `feedback_events` table includes `photo_url TEXT` column

---

### STEP 3 — Authentication ⛔ BLOCKED BY decisions #1, #2, #8

**Action:** Implement `(auth)/register`, `(auth)/login`, `(auth)/verify-phone` routes + `actions/auth.ts`

**Acceptance Criteria:**
- [ ] New user can register with email + password + role selection
- [ ] Phone OTP flow calls Twilio Verify — no credentials in client bundle (`grep -r "TWILIO" ./app` returns no results)
- [ ] Supabase session cookie set on successful login
- [ ] Unauthenticated GET to `/donor/dashboard` redirects to `/login`
- [ ] OTP endpoint rate-limited

---

### STEP 4 — AI Scan Module

**Action:** Implement `actions/ai-scan.ts` + `components/listing/AIScanUploader.tsx` + `lib/gemini.ts`

**Acceptance Criteria:**
- [ ] `grep -r "GEMINI_API_KEY" ./app ./components` returns no results
- [ ] Upload a test food image → response arrives in <8s
- [ ] Response contains all required fields: `detected_item`, `estimated_quantity_lbs`, `confidence_score`, `temperature_sensitive`, `usda_category`
- [ ] Mock a response with `confidence_score: 0.72` → UI shows top-3 alternatives as tappable buttons, not a free-text field
- [ ] Attempting to submit listing without resolving low-confidence state → blocked with "Please verify the item type before posting."
- [ ] `temperature_sensitive: true` triggers `prepared_at` timestamp input requirement

---

### STEP 5 — Pricing Engine ⛔ BLOCKED BY decisions #6, #7

**Action:** Implement pricing calculator in `actions/listing.ts` + `components/listing/PricingSlider.tsx`

**Acceptance Criteria:**
- [ ] `suggested_donor_payout = base_commodity_price × donor_recovery_rate` (rate from confirmed decision #7)
- [ ] Slider allows adjustment within `[suggested × 0.75, suggested × 1.25]` — a ±25% band around the AI suggestion
- [ ] Slider upper bound is dynamically capped: if `suggested × 1.25` would push `consumer_price` above `0.70 × retail_benchmark` (i.e., less than 30% below USDA retail), the cap is lowered to the maximum value that satisfies the discount floor. The donor cannot set a price that violates the consumer discount requirement — the slider physically stops.
- [ ] If the AI-suggested price itself would violate the 30% discount floor (e.g., stale USDA table data), listing creation is blocked entirely with an explanation message before the donor reaches the slider
- [ ] `consumer_price = donor_payout + platform_fee + courier_fee` (platform_fee from confirmed decision #6)
- [ ] Slider default position = `suggested_donor_payout` (one-tap accept path — donor can confirm without touching the slider)
- [ ] If USDA category `updated_at` > 60 days ago, listing creation is blocked with explanation message
- [ ] Pricing values update in real-time as slider moves (no form submit required)

---

### STEP 6 — Listing Publication + State Machine ⛔ BLOCKED BY decision #3

**Action:** Implement listing create/publish flow + safety attestation in `actions/listing.ts`

**Acceptance Criteria:**
- [ ] Safety attestation checkbox is required before submission (HTML required + server-side validation)
- [ ] Attestation timestamp stored in `listings.safety_attested_at` and in `audit_log`
- [ ] On confirm: single Supabase RPC call atomically sets `status='live'`, locks `donor_payout_cents` and `consumer_price_cents`
- [ ] Temperature-sensitive listing without `prepared_at` → blocked, not published
- [ ] `safety_expires_at` computed at publish time using counsel-confirmed constants (decision #3)

---

### STEP 7 — Consumer Marketplace + Purchase Flow ⛔ BLOCKED BY decision #9

**Action:** Implement `(consumer)/browse` feed + claim flow + Stripe checkout

**Acceptance Criteria:**
- [ ] Feed query uses PostGIS to filter listings where estimated delivery time fits consumer's `receiving_window`
- [ ] Listing card shows: item name, quantity, origin type ("Restaurant" or "Household" — never donor name/address), price, ETA window
- [ ] Purchase calls `claim_listing()` RPC — verify via concurrent test: two simultaneous purchases of same listing → one succeeds, one gets `LISTING_UNAVAILABLE` error
- [ ] Stripe `paymentIntents.create` called server-side; `client_secret` returned to client for Stripe.js confirmation
- [ ] On payment success: listing `status = purchased`, order created, Inngest `dispatch.initiated` event fired
- [ ] `grep -r "STRIPE_SECRET" ./app ./components` returns no results

---

### STEP 8 — Courier Dispatch Module ⛔ BLOCKED BY decision #4

**Action:** Implement PostGIS nearest-courier query + dispatch flow + 5-min acceptance window

**Acceptance Criteria:**
- [ ] Nearest eligible courier query executes in <200ms (GIST index on `courier_profiles.current_location`)
- [ ] Dispatch sends push notification to courier within 60 seconds of purchase confirmed
- [ ] Courier has 5-minute window to accept (`step.sleep('5m')` + re-dispatch logic)
- [ ] Cold-chain items: dispatch query filters `insulated_transport_capable = TRUE`
- [ ] After 20 minutes with no acceptance: consumer notified, refund option offered
- [ ] Courier acceptance sets `orders.courier_id`, transitions listing to `dispatched`, reveals pickup address to courier only

---

### STEP 9 — Inngest Durable Functions ⛔ BLOCKED BY decisions #3, #5

**Action:** Implement all 4 Inngest functions + register at `/api/inngest`

**Acceptance Criteria:**
- [ ] `cold-chain-check` runs every 5 minutes; verify via Inngest dashboard run history
- [ ] Simulate: insert listing with `temperature_sensitive=true` and `safety_expires_at = NOW() + 4 minutes` → after next cron tick, `status = hidden`
- [ ] `dispute-window` function: after `delivery/confirmed` event, `step.sleep('2h')` executes, then payouts released
- [ ] `feedback-prompt` function: push notification sent 30 minutes after delivery event
- [ ] All functions have `retries: 3` configured
- [ ] Inngest dashboard shows function registrations at `/api/inngest` endpoint

---

### STEP 10 — Delivery Confirmation + Post-Delivery ⛔ BLOCKED BY decisions #2, #9

**Action:** Implement `(courier)/dispatch/[id]` delivery confirm UI + `actions/dispatch.ts`

**Acceptance Criteria:**
- [ ] Courier delivery confirm calls `confirm_delivery()` RPC
- [ ] `dispute_window_expires_at = delivered_at + 2 hours` set atomically
- [ ] `delivery/confirmed` Inngest event fired with `order_id`, `donor_stripe_account_id`, `courier_stripe_account_id`, `donor_payout_cents`, `courier_fee_cents`
- [ ] Courier payout (unconditional): Stripe transfer to courier within 30s of delivery confirmation
- [ ] Donor payout: held by Inngest until 2-hour dispute window expires
- [ ] Audit log entry created for delivery confirmation

---

### STEP 11 — Feedback + Dispute Flow

**Action:** Implement feedback submission + dispute routing

**Acceptance Criteria:**
- [ ] Consumer "Confirm Safe & Good" tap: inserts `feedback_events` record with `outcome='positive'`, `photo_url=NULL`
- [ ] Consumer "Report an Issue" tap: requires in-app photo capture; inserts with `outcome='issue_reported'` and `photo_url` set to Supabase Storage path; sets `orders.status='disputed'`; halts donor payout Inngest step
- [ ] No response within 2 hours: Inngest proceeds with `outcome='implicit_accept'` logged; releases donor payout
- [ ] `feedback_events` cannot be updated or deleted (verify via `UPDATE feedback_events SET outcome='positive' WHERE id=...` → permission error)

---

### STEP 12 — Notifications

**Acceptance Criteria:**
- [ ] Push subscription prompt appears after login (not on first page load)
- [ ] VAPID keys stored server-side only
- [ ] Test push notification delivered to Chrome desktop in <5s of trigger
- [ ] Courier dispatch notification fires within 60s of `dispatch.initiated` event

---

### STEP 13 — Address Validation + Geospatial Privacy

**Acceptance Criteria:**
- [ ] Invalid address at registration → blocked with Smarty error message
- [ ] Consumer marketplace: donor address shown as neighborhood-level point (`ST_SnapToGrid(location, 0.005)`) — never street address
- [ ] After courier accepts dispatch: full pickup address revealed only to that courier's session
- [ ] Consumer delivery address revealed to courier only after dispatch acceptance

---

### STEP 14 — Admin Dashboard

**Acceptance Criteria:**
- [ ] USDA commodity price table: admin can update `price_per_lb` and `retail_benchmark_per_lb`
- [ ] Categories with `updated_at` > 60 days flagged in red with "STALE — listings blocked"
- [ ] Manual license review queue: admin can set `donor_profiles.license_verified = true`
- [ ] Admin dashboard accessible only to users with `role = 'admin'`

---

### STEP 15 — End-to-End Test Suite

**Acceptance Criteria:**
- [ ] Happy path: donor uploads image → AI classifies → pricing set → listing live → consumer purchases → courier dispatched → delivery confirmed → payouts released
- [ ] Concurrency test: two consumers simultaneously purchase same listing → exactly one succeeds
- [ ] Cold-chain expiry: listing expires → hidden automatically
- [ ] Low-confidence AI: donor cannot submit without resolving correction
- [ ] All tests pass in CI with `pnpm test:e2e`

---

### STEP 16 — Security & Auth Hardening

**Action:** Implement all items in §2.16

**Acceptance Criteria:** See §2.16 per-item acceptance criteria.

---

## 2.12 Listing State Machine

```
draft → live           (confirm_listing RPC)
live → purchased       (claim_listing RPC, SELECT FOR UPDATE SKIP LOCKED)
live → hidden          (Inngest cold-chain)
purchased → dispatched (courier accept)
dispatched → delivered (confirm_delivery RPC)
delivered → disputed   (consumer Report Issue, within 2hr)
```

State name `dispatched` is used consistently throughout the codebase, AppFlow, and PRD.

---

## 2.13 Reference Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FOODLINK PLATFORM                              │
│                                                                          │
│  BROWSER / PWA (Next.js 16 App Router, Tailwind v4)                     │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐                  │
│  │ Donor Flow  │  │ Consumer Feed│  │ Courier Dispatch│                  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘                  │
│         ▼                 ▼                   ▼                          │
│  ┌─────────────────────────────────────────────────────┐                │
│  │           NEXT.JS SERVER ACTIONS / ROUTE HANDLERS    │                │
│  │  ai-scan.ts  listing.ts  payment.ts  dispatch.ts     │                │
│  └──┬──────────────┬──────────────┬────────────────────┘                │
│     │              │              │                                       │
│     ▼              ▼              ▼                                       │
│  ┌──────┐    ┌──────────┐  ┌──────────────────────────────────────┐    │
│  │Gemini│    │ Supabase │  │     STRIPE CONNECT (Sep. Charges)     │    │
│  │2.5   │    │PostgreSQL│  │  paymentIntents.create (capture now)  │    │
│  │Flash │    │17+PostGIS│  │  transfers.create x2 (after delivery) │    │
│  └──────┘    │+ RLS     │  └──────────────────────────────────────┘    │
│              │          │                                               │
│              │ RPCs:    │  ┌────────────────────────────────────────┐  │
│              │ claim_   │  │              INNGEST (Durable)          │  │
│              │ listing  │  │  cold-chain-check (cron */5 * * * *)   │  │
│              │ confirm_ │  │  dispute-window (sleep 2h after event) │  │
│              │ delivery │  │  feedback-prompt (sleep 30m)           │  │
│              └──────────┘  │  payout-release (after dispute window) │  │
│                            └────────────────────────────────────────┘  │
│                                                                          │
│  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────────┐  │
│  │  TWILIO VERIFY │  │ GOOGLE ROUTES│  │  ONESIGNAL + FCM/APNs      │  │
│  └────────────────┘  └──────────────┘  └────────────────────────────┘  │
│                                                                          │
│  ┌────────────────┐  ┌────────────────────────────────────────────┐    │
│  │  SMARTY API    │  │  n8n (self-hosted, webhooks only)           │    │
│  └────────────────┘  └────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘

MONEY FLOW (Separate Charges + Transfers):
Consumer → Stripe Platform Account (captured at purchase)
         → Platform holds in balance (escrow)
         → On delivery confirmed:
             Stripe Transfer → Courier Express Account (courier_fee_cents) [IMMEDIATE]
         → After 2hr dispute window (Inngest):
             Stripe Transfer → Donor Express Account (donor_payout_cents)
             platform_fee_cents remains in FoodLink balance
```

---

## 2.14 Open Questions for Human Decision

| # | Question | Blocks | Risk if Deferred |
|---|---|---|---|
| 1 | Dual-track legal structure? Counsel must confirm: single discounted-sale model viable in target states? | STEP 3, STEP 5 | Legal exposure on food safety liability |
| 2 | Stripe Connect account type for donors? Express vs Custom. | STEP 3, STEP 10 | Donor friction at onboarding |
| 3 | `max_safe_transit_window` constants? Legal/food-safety counsel must sign off on the specific values. | STEP 6, STEP 9 | Safety incident if wrong |
| 4 | Courier IC classification per state? AB5 in CA may reclassify couriers as employees. | STEP 8 | Regulatory/employment liability |
| 5 | Inngest vs Trigger.dev? Cloud-only vs open-source self-hostable. | STEP 9 | Vendor lock-in / data residency |
| 6 | What is the `platform_fee` value (in cents)? | STEP 5 | Pricing engine blocked |
| 7 | `donor_recovery_rate` confirmed at 40%? Finance must formally confirm. | STEP 5 | Affects every listing's suggested price |
| 8 | Residential donor transaction cap? | STEP 3 | Stripe risk management |
| 9 | Money-transmitter licensing: holding consumer funds in FoodLink's Stripe balance may constitute money transmission under state law. Counsel must assess before any live transaction. | STEP 7, STEP 10 | State enforcement, fines, cease-and-desist |

---

## 2.16 Security & Auth Hardening

### SH-1: OTP / SMS-Abuse Protection

- Enable Twilio Fraud Guard (ON by default on new Verify Services — confirm in Console)
- Set Protection Level to "High" for MVP
- Geo Permissions: restrict to US (and target states) only
- Application-layer rate limiting:

```typescript
const OTP_RATE_LIMIT = {
  perPhone: { max: 5, windowMs: 60 * 60 * 1000 },
  perIP:    { max: 10, windowMs: 60 * 60 * 1000 },
};
```

**Acceptance Criteria (STEP 16):**
- [ ] Twilio Console confirms Fraud Guard is ON
- [ ] Geo Permissions locked to US only
- [ ] >5 OTP requests to same phone within 1 hour → HTTP 429
- [ ] >10 OTP requests from same IP within 1 hour → HTTP 429
- [ ] `grep -r "TWILIO_AUTH_TOKEN" ./app ./components` returns no results

---

### SH-2: Auth Brute-Force Protection

- IP-level rate limiting via Next.js middleware
- Exponential backoff: after 5 failed login attempts from same IP, enforce 15-minute lockout with `Retry-After` header

**Acceptance Criteria (STEP 16):**
- [ ] 6 consecutive failed login attempts from same IP → 7th attempt returns HTTP 429 with `Retry-After` header
- [ ] Rate-limit counter stored externally (Redis), not in-memory

---

### SH-3: Image Storage Security (Supabase Storage)

- `listing-photos` bucket set to private (not public)
- Upload via server-side signed upload URL (service role key, server-side only)
- Consumer browse: signed read URLs generated server-side, expire in 1 hour
- `image_url` column stores storage path, not a public CDN URL

```typescript
// Generate signed upload URL (server-side only)
const { data } = await supabase.storage
  .from('listing-photos')
  .createSignedUploadUrl(`${listingId}/${filename}`);

// Generate signed read URL for consumer browse (server-side)
const { data } = await supabase.storage
  .from('listing-photos')
  .createSignedUrl(listing.image_url, 3600);
```

**Acceptance Criteria (STEP 16):**
- [ ] `listing-photos` bucket created with `public: false`
- [ ] Direct unauthenticated GET to storage object URL returns 400/403
- [ ] `image_url` column stores storage path, not a public CDN URL
- [ ] Consumer browse page renders photos via server-generated signed URLs only

---

### SH-4: PII Handling vs Audit Immutability

- `audit_log.payload` must NEVER contain raw addresses, names, or contact details
- Store only: status values, price cents, entity IDs, timestamps, boolean flags
- On deletion request: zero out PII fields in profile tables; audit log retains UUID references (anonymous tokens after profile deletion)

> ⛔ **BLOCKING DECISION — SH-4:** Whether pseudonymisation approach satisfies GDPR/CCPA is a legal determination. Counsel must confirm before launch in any jurisdiction with GDPR-equivalent or CCPA rights.

---

### SH-5: PCI Scope Statement

FoodLink never touches raw card data. All card collection is handled by Stripe Checkout / Stripe.js. FoodLink's servers receive only Stripe PaymentIntent IDs and charge IDs.

**Acceptance Criteria (STEP 16):**
- [ ] No server-side log contains card number patterns
- [ ] Stripe Checkout or Stripe Elements used for card collection
- [ ] `grep -r "sk_live" ./public` returns nothing

---

### SH-6: Money-Transmitter Risk ⛔ BLOCKING DECISION #9

Holding consumer funds in FoodLink's Stripe platform balance between purchase and payout may constitute money transmission under state law. Most US states require a Money Transmitter License (MTL) and FinCEN MSB registration. Counsel must assess before any live transaction.

---

### SH-7: Webhook Signature Verification

All inbound webhooks must verify their signature before processing.

```typescript
// Stripe
event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!);

// n8n
const sig = req.headers.get('x-n8n-signature');
const expectedSig = crypto
  .createHmac('sha256', process.env.N8N_WEBHOOK_SECRET!)
  .update(rawBody)
  .digest('hex');
if (sig !== `sha256=${expectedSig}`) {
  return Response.json({ error: 'Invalid signature' }, { status: 401 });
}
```

**Acceptance Criteria (STEP 16):**
- [ ] Stripe webhook without `Stripe-Signature` header → 400 response; event not processed
- [ ] n8n webhook without valid `x-n8n-signature` → 401 response; event not processed
- [ ] Inngest signing key configured; SDK verifies all inbound requests
- [ ] All three webhook handlers return non-2xx on signature failure before any DB write

---

### SH-8: Session Expiry and Rotation

- Access token expiry: 1 hour
- Refresh token expiry: 7 days
- On logout: `supabase.auth.signOut()` invalidates the refresh token server-side
- Kitchen-tablet consideration: inactivity timeout of 60 minutes on donor flow

**Acceptance Criteria (STEP 16):**
- [ ] Supabase dashboard shows JWT expiry set to ≤3600s
- [ ] After logout, re-use of previous refresh token returns 401
- [ ] Inactivity >60 minutes on donor flow → session invalidated, redirect to login

---

## 2.17 Revision Log

| Version | Date | Changes |
|---|---|---|
| v1.0 | 2026-06-25 | Initial TRD — all 13 domains, Layer 1 + Layer 2, 15 build steps |
| v1.1 | 2026-06-25 | Stripe corrected to @22.x; Stripe API version corrected to 2026-06-24.dahlia; PostgreSQL corrected to 17; Next.js exact patch flagged ⚠ UNVERIFIED; React 19.2.0 and Gemini 2.5 Flash confirmed. Section 2.16 Security & Auth Hardening added. Blocking decisions table added at top of Layer 2. |
| v1.1 (fixes) | 2026-06-25 | **FIX 1:** `feedback_events` table: added `photo_url TEXT` column, required when `outcome = 'issue_reported'` (PRD §8.3 — dispute photo capture). **FIX 2:** STEP 5 acceptance criteria: expanded ±25% pricing band specification with dynamic slider cap logic and discount floor enforcement detail. **FIX 3:** State naming `dispatched` confirmed as the canonical term throughout; AppFlow and PRD updated to match. |

---

*FoodLink TRD v1.1 (fixes applied) · ServeAI Initiative · Confidential*
