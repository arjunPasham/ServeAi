'use server';

// Phase 2 Task 4 — no-login inbound offer view. Every export here is keyed
// by the allocation's public_view_token (024_allocations.sql) — the token
// IS the capability, since there is no login for this actor. Callers NEVER
// supply an allocationId; resolving token -> allocation happens here,
// server-side, so there is no path for a client to act on (or read) an
// allocation it doesn't hold the token for. That is the exact IDOR the
// token model exists to close. See src/app/inbound/[token]/page.tsx for how
// the route consumes these.

import { createServiceClient } from '@/lib/supabase/server';

export interface InboundOfferItem {
  foodName: string;
  categoryLabel: string;
  estLbs: number;
  safetyExpiresAt: string | null;
}

export interface InboundOffer {
  /** 'viewable': an active offer (status 'offered', not yet expired) — the
   *  page shows the preview + accept/decline. 'accepted': the receiver
   *  already accepted this same offer — the page shows a read-only
   *  confirmation (not a leak; they did this themselves). */
  status: 'viewable' | 'accepted';
  merchantBusinessName: string;
  windowDate: string;
  items: InboundOfferItem[];
}

interface AllocationPreviewRow {
  status: string;
  expires_at: string;
  loads: {
    window_date: string;
    merchants: { business_name: string } | null;
    scan_items: {
      food_name: string;
      est_lbs: number;
      safety_expires_at: string | null;
      categories: { label: string } | null;
    }[];
  } | null;
}

/**
 * Resolves a public_view_token to its receiver-safe preview, or `null` when
 * the token should render as not-found: unknown, OR a row whose offer is no
 * longer viewable-actionable — status other than 'offered'/'accepted'
 * (declined/expired/withdrawn), or a still-'offered' row whose expires_at
 * has already passed but hasn't been swept yet by expire_stale_offers. A
 * wrong or dead token must leak NOTHING; the caller (the page) turns a null
 * return into notFound(). 'accepted' is the one non-'offered' terminal state
 * that DOES resolve, since the receiver legitimately accepted it themselves
 * — rendering that is a confirmation, not a leak.
 *
 * Selects ONLY what a receiver needs to decide: the merchant's business
 * name, the load's window date, and each item's food name / category label /
 * est_lbs / safety_expires_at. Deliberately does NOT select signer contact
 * info, merchant address, or any valuation/$$ column — none of that belongs
 * on a page an anonymous link-holder can open.
 *
 * Throws on a genuine DB/infra error — the null-return (404) path is for
 * not-found/expired tokens only, never for our own failure to reach the DB.
 */
export async function getInboundOffer(token: string): Promise<InboundOffer | null> {
  const service = await createServiceClient();
  const { data, error } = await service
    .from('allocations')
    .select<string, AllocationPreviewRow>(
      `status, expires_at,
       loads (
         window_date,
         merchants ( business_name ),
         scan_items ( food_name, est_lbs, safety_expires_at, categories!scan_items_category_key_fkey ( label ) )
       )`
    )
    .eq('public_view_token', token)
    .maybeSingle();
  if (error) throw new Error(`getInboundOffer: allocation lookup failed: ${error.message}`);
  if (!data) return null;

  const isExpired = new Date(data.expires_at).getTime() <= Date.now();
  const isAccepted = data.status === 'accepted';
  const isViewable = data.status === 'offered' && !isExpired;
  if (!isViewable && !isAccepted) return null;

  return {
    status: isAccepted ? 'accepted' : 'viewable',
    merchantBusinessName: data.loads?.merchants?.business_name ?? '—',
    windowDate: data.loads?.window_date ?? '',
    items: (data.loads?.scan_items ?? []).map(item => ({
      foodName: item.food_name,
      categoryLabel: item.categories?.label ?? '—',
      estLbs: Number(item.est_lbs),
      safetyExpiresAt: item.safety_expires_at,
    })),
  };
}

export type RespondToOfferResult =
  | { success: true }
  | { success: false; error: 'NOT_FOUND' | 'OFFER_NOT_PENDING' | 'OFFER_EXPIRED' | 'SERVER_ERROR' };

/**
 * Accept/decline a no-login offer. `token` is the capability the caller
 * holds — NOT an allocationId; it is resolved to the allocation id
 * server-side right here. respond_to_offer is then called with
 * p_actor = null (there is no logged-in user in this flow).
 * respond_to_offer itself re-guards the transition (OFFER_NOT_PENDING /
 * OFFER_EXPIRED under a row lock), so a stale double-submit is rejected
 * there too — this token resolution is the FIRST guard, not the only one.
 */
export async function respondToOffer(
  token: string,
  decision: 'accepted' | 'declined'
): Promise<RespondToOfferResult> {
  const service = await createServiceClient();

  const { data: alloc, error: lookupError } = await service
    .from('allocations')
    .select('id')
    .eq('public_view_token', token)
    .maybeSingle();
  if (lookupError) throw new Error(`respondToOffer: allocation lookup failed: ${lookupError.message}`);
  if (!alloc) return { success: false, error: 'NOT_FOUND' };

  const { error } = await service.rpc('respond_to_offer', {
    p_allocation_id: alloc.id,
    p_decision: decision,
    p_actor: null,
    p_decline_reason: null,
  });
  if (error) {
    const msg = error.message ?? '';
    if (msg.includes('OFFER_NOT_PENDING')) return { success: false, error: 'OFFER_NOT_PENDING' };
    if (msg.includes('OFFER_EXPIRED')) return { success: false, error: 'OFFER_EXPIRED' };
    return { success: false, error: 'SERVER_ERROR' };
  }

  return { success: true };
}
