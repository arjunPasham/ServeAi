// Internal staff gate (v3 internal console). Layers an email ALLOWLIST on top of
// the existing Supabase-auth + users.role='admin' check — it does NOT fork auth
// and it is NOT a hidden backdoor: access requires a real authenticated session,
// the admin role, AND the session's server-verified email in
// INTERNAL_STAFF_ALLOWLIST. Fail-closed: an empty/unset allowlist denies everyone.
// Obscurity (unlisted route, noindex) is defense-in-depth in Task 2, never the
// control. Re-checked server-side on every internal action, not just the page.

import { createClient, createServiceClient } from '@/lib/supabase/server';

/** Normalize a comma-separated allowlist env value → lowercased, trimmed, non-empty emails. Pure. */
export function parseAllowlist(csv: string): string[] {
  return csv
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(e => e.length > 0);
}

/** Is this email on the allowlist? Case-insensitive. Fail-closed: false for a
 *  missing email OR an empty allowlist (so an unset env locks everyone out). Pure. */
export function isAllowlisted(email: string | null | undefined, allowlist: string[]): boolean {
  if (!email || allowlist.length === 0) return false;
  return allowlist.includes(email.trim().toLowerCase());
}

export type InternalStaffResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; error: 'NOT_AUTHENTICATED' | 'NOT_ADMIN' | 'NOT_ALLOWLISTED' };

/**
 * The single internal-staff gate: authenticated + admin role + email on the
 * INTERNAL_STAFF_ALLOWLIST. Same auth mechanism as requireAdmin (getUser +
 * users.role via the service client) plus the allowlist. FAIL-CLOSED throughout:
 * the three "not allowed" outcomes are typed, and a DB error on the role read is
 * NOT surfaced — the discarded error leaves `data` null, which collapses to a
 * NOT_ADMIN denial. For a security gate, denying on a DB blip is the safer
 * default than throwing, and it matches requireAdmin's posture.
 */
export async function requireInternalStaff(): Promise<InternalStaffResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'NOT_AUTHENTICATED' };

  const service = await createServiceClient();
  const { data } = await service.from('users').select('role').eq('id', user.id).single();
  if (data?.role !== 'admin') return { ok: false, error: 'NOT_ADMIN' };

  const allowlist = parseAllowlist(process.env.INTERNAL_STAFF_ALLOWLIST ?? '');
  if (!isAllowlisted(user.email, allowlist)) return { ok: false, error: 'NOT_ALLOWLISTED' };

  return { ok: true, userId: user.id, email: user.email ?? '' };
}

/**
 * Gate a server action. Every internal action calls this itself — the page-level
 * check never covers a 'use server' export (each is its own HTTP endpoint).
 * Throws on any denial (the internal UI is only reachable by staff, so a thrown
 * error surfacing via the error boundary is acceptable — same posture as the
 * other guarded reads). Returns the staff identity for audit actor ids.
 */
export async function assertInternalStaff(actionName: string): Promise<{ userId: string; email: string }> {
  const result = await requireInternalStaff();
  if (!result.ok) {
    throw new Error(`${actionName}: internal staff access denied (${result.error})`);
  }
  return { userId: result.userId, email: result.email };
}
