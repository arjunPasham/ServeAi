// Central error-reporting shim for server-side failures (review I7:
// confirmManifest had zero logging/tracing, so a failed declare_load left no
// trace anywhere — a 2am failure was invisible until a merchant complained).
//
// Every call site gets an unconditional console.error PLUS a best-effort
// forward to Sentry. Forwarding only happens when SENTRY_DSN /
// NEXT_PUBLIC_SENTRY_DSN is configured — with neither set (every dev/test
// environment today; see .env.example), this module never touches
// @sentry/nextjs at all, so it is fully inert: no warnings, no network, and
// the unit/e2e suites stay green exactly as they do for every other
// DEV_MODE-gated integration in this codebase (src/lib/env.ts's boot-gate
// comment enumerates the pattern).
//
// Sentry itself is wired for real (src/sentry.server.config.ts,
// src/sentry.edge.config.ts, src/instrumentation.ts's onRequestError) — this
// module is not the "fallback" path, it's the one call site every failure
// exit in confirmManifest goes through, so logging behavior is identical
// whether or not Sentry ends up configured for a given deployment.

import * as Sentry from '@sentry/nextjs';

const dsnConfigured = Boolean(process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN);

/**
 * Log a server-side failure with structured context. Always logs via
 * console.error (same style as the existing src/app/api/scan/route.ts
 * persist-failure log). Forwards to Sentry only when a DSN is configured;
 * a capture failure is swallowed so observability itself can never crash
 * the request path the failure occurred on.
 */
export function reportError(message: string, context: Record<string, unknown>): void {
  console.error(message, context);

  if (!dsnConfigured) return;

  try {
    Sentry.captureException(new Error(message), { extra: context });
  } catch {
    // Never let observability itself throw — the console.error above already
    // preserved the failure.
  }
}
