// Sentry Node.js runtime init (Task 0.3). Only ever imported from
// src/instrumentation.ts, and only when a DSN is configured — see that
// file's comment for why this keeps the SDK fully inert in dev/test.
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Error capture only for pilot — no perf tracing budget spent yet.
  tracesSampleRate: 0,
});
