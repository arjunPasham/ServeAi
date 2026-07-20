// Fail-closed production boot gate (review finding C2).
//
// Every external integration in this codebase degrades to a DEV_MODE
// simulation when its env var is unset — see src/lib/twilio.ts, email.ts,
// onesignal.ts, smarty.ts, rate-limit.ts, google-routes.ts, stripe.ts, and
// the GEMINI_API_KEY check in src/services/foodVision.ts. That fallback is
// exactly what local dev and the Playwright `api` project need. In
// production it is dangerous: a *missing* key silently disables the real
// integration instead of failing loudly (e.g. rate limiting, OTP, address
// validation all "pass" with nothing actually protecting anything).
//
// assertProductionEnv() is the single boot-time gate — wired from
// src/instrumentation.ts — that turns "missing key in prod" into "refuse to
// boot" instead of "quietly run the dev simulation in prod". It does not
// touch any of the per-module DEV_MODE consts; those stay as-is for dev/test.

/**
 * Env vars that MUST be set when NODE_ENV === 'production'. Each comment
 * names the fail-open behavior that happens today if the var is absent.
 */
export const REQUIRED_PROD_ENV = [
  // Rate limiting (Upstash) — missing either var makes every limiter in
  // src/lib/rate-limit.ts report { allowed: true }: no cap on OTP sends,
  // login attempts, or Gemini-quota-spending scans (denial-of-wallet).
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',

  // Twilio Verify — missing TWILIO_VERIFY_SERVICE_SID makes src/lib/twilio.ts
  // accept the hardcoded OTP code "000000" for every phone number. The
  // account credentials are required to construct the client at all.
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_VERIFY_SERVICE_SID',

  // Smarty address validation — missing either var makes src/lib/smarty.ts
  // accept any non-empty address and return synthetic Detroit-area coords.
  'SMARTY_AUTH_ID',
  'SMARTY_AUTH_TOKEN',

  // Stripe — missing STRIPE_SECRET_KEY makes src/lib/stripe.ts simulate
  // PaymentIntents/Transfers/Refunds as instantly-"succeeded" synthetic
  // objects (fake payments captured). Missing STRIPE_WEBHOOK_SECRET means
  // incoming payment webhooks cannot be authenticated.
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',

  // Resend email — missing RESEND_API_KEY makes src/lib/email.ts log emails
  // to the console instead of sending them. EMAIL_FROM must be a verified
  // sending domain in production, not the Resend sandbox default.
  'RESEND_API_KEY',
  'EMAIL_FROM',

  // OneSignal push — missing either var makes src/lib/onesignal.ts log push
  // notifications to the console instead of delivering them.
  'ONESIGNAL_APP_ID',
  'ONESIGNAL_REST_API_KEY',

  // n8n webhooks — missing N8N_WEBHOOK_BASE_URL makes src/services/n8n.ts
  // log outbound automation events instead of sending them. Missing
  // N8N_WEBHOOK_SECRET signs outbound calls with an empty-string HMAC key
  // and makes src/app/api/n8n/webhook/route.ts reject every inbound call.
  'N8N_WEBHOOK_BASE_URL',
  'N8N_WEBHOOK_SECRET',

  // Google Routes — missing GOOGLE_ROUTES_API_KEY makes
  // src/lib/google-routes.ts fall back to a straight-line ETA estimate
  // instead of a real routed one.
  'GOOGLE_ROUTES_API_KEY',

  // Gemini Vision — missing GEMINI_API_KEY makes src/services/foodVision.ts
  // return a synthetic scan result, which then persists as real donor
  // inventory.
  'GEMINI_API_KEY',

  // Inngest — missing INNGEST_SIGNING_KEY means inbound requests to
  // src/app/api/inngest/route.ts are never signature-verified, so anyone who
  // finds the endpoint can trigger dispatch/payment/refund jobs directly.
  'INNGEST_SIGNING_KEY',
] as const;

/**
 * Names from REQUIRED_PROD_ENV that are missing or empty in `env`. Returns
 * ALL missing names, not just the first. Pure function over an injected env
 * record — no process.env reads here — so callers (and tests) don't need to
 * mutate real environment state. Empty string counts as missing: a
 * platform-injected but accidentally-blank var is exactly the silent
 * fail-open case this guards against.
 */
export function missingRequiredEnv(env: Record<string, string | undefined>): string[] {
  return REQUIRED_PROD_ENV.filter((name) => !env[name]);
}

/**
 * Boot gate. No-ops unless NODE_ENV === 'production'. In production, throws
 * a single Error naming every missing var so the process refuses to boot
 * rather than silently falling back to the DEV_MODE simulations above.
 *
 * Defaults to reading `process.env`, so the real boot path
 * (src/instrumentation.ts) can call it with no arguments; tests inject a
 * fake record instead of mutating process.env.
 */
export function assertProductionEnv(env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV !== 'production') return;

  const missing = missingRequiredEnv(env);
  if (missing.length > 0) {
    throw new Error(
      `Refusing to boot in production: missing required env var(s): ${missing.join(', ')}`
    );
  }
}
