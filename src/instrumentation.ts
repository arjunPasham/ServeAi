// Next.js instrumentation hook — runs once when a new server instance starts,
// before it serves any requests. This is the single wiring point for:
//
// 1. The fail-closed production boot gate (review finding C2, src/lib/env.ts):
//    production refuses to boot if any required integration key is missing,
//    instead of silently falling back to a DEV_MODE simulation.
// 2. Sentry server/edge init (Task 0.3, review I7) — gated on SENTRY_DSN /
//    NEXT_PUBLIC_SENTRY_DSN so the SDK is never touched (no warnings, no
//    network) when unset, which is every dev/test environment today. The
//    DSN is deliberately NOT in src/lib/env.ts's REQUIRED_PROD_ENV list:
//    observability must not block boot.
import { assertProductionEnv } from '@/lib/env';

const sentryDsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

export async function register() {
  assertProductionEnv();

  if (!sentryDsn) return;

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Next.js App Router global error hook: reports otherwise-unhandled
// framework-level request errors (e.g. thrown from a Server Component or
// route handler) to Sentry. No-ops when no DSN is configured, matching
// register() above — captureRequestError itself would likely no-op with no
// client initialized, but this avoids relying on that and keeps the
// "inert when unset" guarantee explicit and easy to verify.
export async function onRequestError(
  ...args: Parameters<typeof import('@sentry/nextjs').captureRequestError>
) {
  if (!sentryDsn) return;
  const Sentry = await import('@sentry/nextjs');
  await Sentry.captureRequestError(...args);
}
