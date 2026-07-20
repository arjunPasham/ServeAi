// Next.js instrumentation hook — runs once when a new server instance starts,
// before it serves any requests. This is the single wiring point for the
// fail-closed production boot gate (review finding C2, src/lib/env.ts):
// production refuses to boot if any required integration key is missing,
// instead of silently falling back to a DEV_MODE simulation.
import { assertProductionEnv } from '@/lib/env';

export async function register() {
  assertProductionEnv();
}
