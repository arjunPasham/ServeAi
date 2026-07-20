// Central error-reporting shim for server-side failures (review I7:
// confirmManifest had zero logging/tracing, so a failed declare_load left no
// trace anywhere — a 2am failure was invisible until a merchant complained).
//
// Every call site gets an unconditional console.error PLUS a best-effort
// forward to Sentry for genuine infra failures only (see INFRA_ERROR_CODES
// below; review finding I8 — forwarding every failure, including a merchant
// typing a blank food name, made Sentry indistinguishable noise). Forwarding
// only happens when SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN is configured AND the
// error code is an infra code — with no DSN set (every dev/test environment
// today; see .env.example), @sentry/nextjs is never imported, dynamically or
// otherwise, so this module is fully inert: no warnings, no network, and the
// unit/e2e suites stay green exactly as they do for every other
// DEV_MODE-gated integration in this codebase (src/lib/env.ts's boot-gate
// comment enumerates the pattern). Mirrors instrumentation.ts's dynamic
// `await import('@sentry/nextjs')` discipline — the SDK (and its
// OpenTelemetry tree) must not load into every process that imports
// manifest.ts just because this module exists.
//
// Sentry itself is wired for real (src/sentry.server.config.ts,
// src/sentry.edge.config.ts, src/instrumentation.ts's onRequestError) — this
// module is not the "fallback" path, it's the one call site every failure
// exit in confirmManifest goes through, so logging behavior is identical
// whether or not Sentry ends up configured for a given deployment.

const dsnConfigured = Boolean(process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN);

// Error codes that represent a genuine infra failure (DB error, downstream
// RPC rejection, missing pricing data, a lookup miss that should never
// happen for a merchant confirming their own scan) as opposed to a routine
// client-validation or pre-authz failure. Only these page Sentry; every
// other code below still gets the unconditional console.error above, so
// nothing goes unlogged — this only decides what's worth waking someone up
// for. Sourced from every code confirmManifest's fail() helper can reach
// (src/actions/manifest.ts):
//   - SERVER_ERROR         unhandled DB/thrown error (requireVerifiedMerchant
//                           throwing, or any Supabase call returning `error`)
//   - ITEMS_NOT_DECLARABLE  declare_load RPC rejected the confirmed items
//   - VALUATION_MISSING     valuation_table has no current row for a category
//                           the pre-flight check already should have caught
//   - SCAN_NOT_FOUND        scan_records lookup missed for merchant+id
// Deliberately excluded: client-validation codes (UNKNOWN_CATEGORY,
// FOOD_NAME_REQUIRED, INVALID_QUANTITY, EMPTY_MANIFEST, ITEM_NOT_IN_SCAN,
// INVALID_WINDOW_DATE, and computeSafetyExpiry's PREPARED_AT_* /
// SAFETY_WINDOW_EXPIRED codes) and pre-authz passthrough codes
// (NOT_AUTHENTICATED, PHONE_NOT_VERIFIED, NOT_A_MERCHANT) — all merchant- or
// caller-caused, not infra. auth.ts's PROVISIONING_FAILED /
// VERIFY_PERSIST_FAILED are NOT included: that action doesn't call
// reportError at all, so they never reach this filter.
const INFRA_ERROR_CODES: ReadonlySet<string> = new Set([
  'SERVER_ERROR',
  'ITEMS_NOT_DECLARABLE',
  'VALUATION_MISSING',
  'SCAN_NOT_FOUND',
]);

/**
 * Log a server-side failure with structured context. Always logs via
 * console.error (same style as the existing src/app/api/scan/route.ts
 * persist-failure log), synchronously and unconditionally. Forwards to
 * Sentry only when a DSN is configured AND `context.error` is one of
 * INFRA_ERROR_CODES above; the forward is fire-and-forget (this function
 * stays synchronous — callers must not depend on Sentry delivery completing
 * before they return) and any capture failure is swallowed so observability
 * itself can never crash the request path the failure occurred on.
 */
export function reportError(message: string, context: Record<string, unknown>): void {
  console.error(message, context);

  if (!dsnConfigured) return;

  const code = context.error;
  if (typeof code !== 'string' || !INFRA_ERROR_CODES.has(code)) return;

  forwardToSentry(message, context).catch(() => {
    // Never let observability itself throw — the console.error above already
    // preserved the failure.
  });
}

// Split out so the dynamic import only ever executes once we've already
// decided (DSN configured + infra code) that Sentry is worth loading —
// @sentry/nextjs must not be touched, even to begin loading it, on any other
// path through reportError.
async function forwardToSentry(message: string, context: Record<string, unknown>): Promise<void> {
  const Sentry = await import('@sentry/nextjs');
  Sentry.captureException(new Error(message), { extra: context });
}
