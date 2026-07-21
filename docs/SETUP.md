# FoodLink — Local Setup & Demo Guide

Updated 2026-07-06 after the pre-showcase audit/fix pass.

## 1. Prerequisites

- Node 20+
- A **Supabase project** (free tier is fine) — this is the only hard external requirement.
- Two terminals.

## 2. Configure environment

```bash
cp .env.example .env.local
```

Fill in the three Supabase values (Project Settings → API) and your `GEMINI_API_KEY`.
**Everything else can stay unset** — Stripe, Twilio, OneSignal, Google Routes, and
Smarty all have simulated dev modes:

| Service unset | Behavior |
|---|---|
| Stripe | Payment simulated as captured at purchase; payouts logged to console |
| Twilio | OTP code is always `000000` |
| OneSignal | Push notifications logged to server console |
| Google Routes | Straight-line ETA estimate |
| Smarty | Any address accepted (synthetic Detroit coords) |
| Stripe Connect | Onboarding simulated (instant `payouts_enabled`) |
| Resend | Emails logged to console |

> ⚠️ The previous `.env.local` shipped with a real Gemini API key. **Rotate that key** in Google AI Studio.

## 3. Set up the database

In the Supabase SQL editor, run every file in `supabase/migrations/` **in
filename order**, then the seed:

1. `001_extensions.sql` … `008_rpcs.sql`
2. `009_storage.sql` (private listing-photos bucket, SH-3)
3. `010_feedback_guards.sql` (feedback ownership + dispute window)
4. `012_security_hardening.sql` (RPC hardening, role-escalation lock)
5. `013_merge_reconciliation.sql` (consolidates 009/010, re-applies EXECUTE revokes)
6. `014_connect_onboarding.sql` (Stripe Connect Express onboarding — `stripe_account_id`/`payouts_enabled` columns)
7. `015_fix_auth_trigger.sql` (**P0** — pins `search_path` in `handle_new_auth_user` so registration creates the `public.users` mirror row; backfills rows missed while broken. Verify with `node scripts/verify-auth-trigger.cjs`.)
8. `016_feedback_implicit_accept_unique.sql` (partial unique index — makes the dispute-window implicit-accept insert race-proof)
9. `017_delivery_providers.sql` (Uber Direct + self-pickup: `fulfillment_method`, provider tracking columns, `confirm_pickup`/`confirm_provider_delivery` RPCs, `address_validated` flags)
10. `018_categories_valuations.sql` (pivot Phase 1 — category taxonomy + versioned valuation table)
11. `019_merchants.sql` (pivot Phase 1 — merchants entity, backfilled from donor_profiles)
12. `020_scan_inventory.sql` (pivot Phase 1 — scan_records/scan_items/loads/load_items + `declare_load` RPC)
13. `seed.sql` (USDA prices — legacy consumer flow only)

> ⚠️ `supabase/combined_migrations.sql` was generated from 001–013 only — it
> does **not** include `014_connect_onboarding.sql`. If you bootstrapped the
> database from the combined file, run `014` (and any later migrations) on top.

> Note: the numbering jumps from `010` to `012` — **there is no `011`**. Two
> parallel branches each added a migration `009`; the collision was resolved by
> renaming them to `012`/`013` (`012_security_hardening.sql` was originally
> `009_security_hardening.sql`, `013_merge_reconciliation.sql` was originally
> `011_merge_reconciliation.sql`). `013` reconciles the 012/010 overlap, so the
> final state is correct regardless of exact run order between 009–013.

## 4. Run

```bash
# Terminal 1 — the app
npm run dev

# Terminal 2 — background jobs (dispatch loop, dispute window, cold-chain cron)
npx inngest-cli@latest dev
```

Open http://localhost:3000. The Inngest dev UI is at http://localhost:8288.

## 5. Demo script (2 browsers / profiles)

> **Pivot note (Phase 1):** the primary flow is now Merchant → `/merchant/scan` →
> confirm manifest → load declared. The consumer purchase flow below is mothballed —
> set `NEXT_PUBLIC_CONSUMER_ENABLED=true` to re-enable it for reference.

1. **Donor** — register as Donor with a business name + address, verify phone, then
   **Post food** → scan a photo (or manual entry) → accept AI price → attest → publish.
   Tip: use *Prepared Hot Food* at 3+ lbs; very cheap categories (eggs, grain) at small
   quantities can't satisfy the 30%-below-retail floor once fixed fees are added.
2. **Consumer** — register as Consumer with a delivery address, browse, **Buy now** →
   choose **Self-pickup (free)** or **Delivery** (live quoted fee).
   (Dev mode: payment simulated instantly; with Stripe keys you get a card form.)
3. **Pickup path** — the consumer's order page shows a 6-character handoff code; the
   donor's dashboard shows an *Awaiting pickup* card. Enter the code → **Confirm
   handoff** → order flips to *Delivered*.
4. **Delivery path** — with no Uber keys, the SimulatedProvider fakes the courier:
   the reconciler (`delivery-reconcile`, every 5 min via Inngest) advances the status
   (courier assigned → picked up → delivered over ~6 minutes); the order page also
   reconciles on read every 10 s, so you can just watch it progress.
5. **Consumer** — order page shows *Delivered*; the feedback card appears
   (2-hour dispute window). 30 min later the feedback push prompt fires via Inngest.

> There is no courier role in the demo anymore. To resurrect the internal fleet
> (courier registration, dispatch offers, courier payouts) set
> `DELIVERY_MODE=internal`.

### Delivery providers & liability

- **Uber Direct** (set the four `UBER_*` env vars) is white-label
  delivery-as-a-service — FoodLink keeps its own storefront; Uber supplies the
  courier and carries courier employment/insurance liability. Sandbox
  credentials are self-serve; production access requires Uber review + billing.
- **Food-safety liability stays with the platform.** The safety-attestation and
  cold-chain fields remain mandatory for delivery orders; Uber offers no
  temperature guarantee, so temperature-sensitive orders send "insulated bag
  recommended" in the courier handoff instructions, and any delivery still not
  terminal when the listing's safety window closes is auto-canceled and refunded
  by the reconciler.
- **Fallback:** DoorDash Drive implements the same quote/create/webhook shape —
  adding it is roughly a one-file `DeliveryProvider` implementation in
  `src/lib/delivery/`.

## 6. Creating an admin

Admins can't self-register. In Supabase SQL editor:

```sql
UPDATE users SET role = 'admin' WHERE email = 'you@example.com';
```

Then (Dashboard → Authentication → user → edit `app_metadata`):

```json
{ "role": "admin", "phone_verified": true }
```

## 7. Real Stripe mode (optional)

Set the three Stripe env vars, then forward webhooks:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

> ⚠️ **Required when switching from dev mode to real keys:** run
> `scripts/cleanup-dev-stripe-accounts.sql` in the Supabase SQL editor. Dev
> mode mints synthetic `acct_dev_*` Connect accounts with instant
> `payouts_enabled`; against real Stripe they can never receive transfers.
> The script nulls them out so affected donors/couriers re-onboard. (The
> `canReceiveTransfers()` guard also refuses `acct_dev_*` ids outside dev
> mode, so a missed cleanup degrades to audited skipped payouts, not lost
> money.)

Flow changes: Buy now → card checkout (Stripe Elements) → `payment_intent.succeeded`
webhook triggers courier dispatch. Abandoned checkouts release the listing after
15 minutes (claim-expiry watchdog).
