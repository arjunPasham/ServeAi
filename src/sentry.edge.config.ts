// Sentry Edge runtime init (Task 0.3). Only ever imported from
// src/instrumentation.ts, and only when a DSN is configured. Nothing in this
// app currently opts into the edge runtime, but the Next.js instrumentation
// hook runs for both runtimes, so this keeps that path covered without
// forcing a route to actually reach it.
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0,
});
