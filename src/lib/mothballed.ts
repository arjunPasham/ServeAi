// Pre-pivot consumer marketplace + courier fleet flows (browse/claim, dispatch
// acceptance, delivery/pickup confirmation) were mothballed by the July 2026
// B2B pivot, but their server actions remain exported — and thus reachable as
// HTTP endpoints by any authenticated user, since Next.js server actions are
// callable regardless of whether a route links to them. Merchants carry
// role='donor', so they can otherwise invoke the donor-side writes directly.
//
// These actions are GATED here, not deleted — deletion is Phase 3 scope (the
// (consumer)/(courier) pages still import them). Do not "fix" a broken caller
// by removing a guard call; re-enable the surface via
// NEXT_PUBLIC_CONSUMER_ENABLED=true instead if the flow is intentionally back.

/** Matches the flag check in src/lib/supabase/middleware.ts:36. */
export function consumerSurfaceEnabled(): boolean {
  return process.env.NEXT_PUBLIC_CONSUMER_ENABLED === 'true';
}

/**
 * For actions that return a typed `{ success: false; error: string }` result
 * shape. Callers return this directly — it satisfies any action's result
 * union without changing that union's shape.
 */
export function consumerDisabledResult(): { success: false; error: string } {
  return { success: false, error: 'CONSUMER_DISABLED' };
}

/**
 * For actions that return `void` (or a bare value with no typed error slot).
 * Throws so the mothballed state can't be mistaken for a silent no-op.
 */
export function assertConsumerSurfaceEnabled(actionName: string): void {
  if (!consumerSurfaceEnabled()) {
    throw new Error(`CONSUMER_DISABLED: ${actionName} is a mothballed pre-pivot surface`);
  }
}
