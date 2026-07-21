// Shared server-side authorization guard for merchant-only surfaces.
//
// Every merchant action and the /api/scan route was previously gating on
// "authenticated + has a merchants row" while phone_verified was enforced only
// in page middleware — so a script that skipped OTP could still reach real
// Gemini spend (review finding C1). This is the single place that asserts the
// full invariant: authenticated + phone-verified + owns a merchants row.

import { createClient, createServiceClient } from '@/lib/supabase/server';

export type MerchantAuthzError = 'NOT_AUTHENTICATED' | 'PHONE_NOT_VERIFIED' | 'NOT_A_MERCHANT';

export interface VerifiedMerchant {
  userId: string;
  merchantId: string;
  businessName: string;
}

export type RequireVerifiedMerchantResult =
  | { ok: true; merchant: VerifiedMerchant }
  | { ok: false; error: MerchantAuthzError };

/**
 * Gate a merchant-only server action or route. Returns a typed authorization
 * failure for the three "not allowed" outcomes, and THROWS on an infra error
 * (a DB outage must surface via the error boundary, never masquerade as
 * "not a merchant" — same posture as getMerchantDashboard).
 */
export async function requireVerifiedMerchant(): Promise<RequireVerifiedMerchantResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'NOT_AUTHENTICATED' };

  // phone_verified lives in app_metadata, which is server-managed and trusted
  // for exactly the same reason the middleware trusts it: the
  // prevent_user_privilege_change trigger (012_security_hardening) blocks any
  // client write to users.phone_verified, and app_metadata is only writable via
  // the service-role admin API. So we can gate on it without an extra DB read.
  if (user.app_metadata?.phone_verified !== true) {
    return { ok: false, error: 'PHONE_NOT_VERIFIED' };
  }

  const service = await createServiceClient();
  const { data: merchant, error } = await service
    .from('merchants')
    .select('id, business_name')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw new Error(`requireVerifiedMerchant: merchants lookup failed: ${error.message}`);
  if (!merchant) return { ok: false, error: 'NOT_A_MERCHANT' };

  return {
    ok: true,
    merchant: { userId: user.id, merchantId: merchant.id, businessName: merchant.business_name },
  };
}
