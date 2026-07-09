---
name: verify
description: Build/launch/drive recipe for verifying FoodLink changes at runtime
---

# Verifying FoodLink

## Launch

```bash
npm run dev          # Next.js on http://localhost:3000 (takes ~10s to first compile)
```

Background jobs (dispatch loop, dispute window) need a second terminal:
`npx inngest-cli@latest dev` — only required when verifying Inngest functions.

Env comes from `.env.local`. Most integrations (Twilio, Stripe, Resend,
OneSignal, Smarty) have dev-bypass simulations that activate when their env
vars are absent — check the table in `docs/SETUP.md`.

## Drive

Playwright is installed (`playwright` resolves from `node_modules`); drive
headless with a plain node script importing
`node_modules/playwright/index.mjs`. Viewport 1280×900 renders everything.

Flows worth driving:
- **Demo mode** (no auth): `/demo` → donor flow (scan → pricing → publish) and
  consumer flow (browse → claim → pay → timed delivery ~16s to "Delivered!").
  Coach-mark tooltips must be dismissed via "Got it →" or they cover targets
  visually (but do NOT block clicks — wrapper is pointer-events-none).
- **Auth-protected routes**: `/consumer/browse` etc. redirect to `/login`
  when logged out — verifies the proxy (src/proxy.ts → lib/supabase/middleware.ts).
- **Real registration**: `node scripts/verify-auth-trigger.cjs` creates a real
  auth user on the dev Supabase project and asserts the public.users mirror
  row appears (the handle_new_auth_user trigger).

## Gotchas

- CoachMark measures its target on a 250ms poll — assertions immediately after
  navigation race it; click/waitFor instead of isVisible.
- The dev Supabase project is shared state: clean up any auth users you create
  (`auth.admin.deleteUser`).
- No SQL access from this machine (no supabase CLI login, no psql) — schema
  changes must be applied via the Supabase SQL editor by the user.
