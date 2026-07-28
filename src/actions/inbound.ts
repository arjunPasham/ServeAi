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
import { inngest } from '@/inngest/client';
import { sendEmail } from '@/lib/email';
import { sendPushToUser } from '@/lib/onesignal';
import { DISPUTE_WINDOW_MS } from '@/lib/deliveries';

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

// ─── v3 recipient confirm + dispute-window flag (Task 2) ────────────────────
// Same token-as-capability model: the caller holds the allocation's
// public_view_token; it is resolved to the allocation id server-side, and the
// 032 RPCs (recipient_confirm_delivery / flag_delivery_discrepancy) re-guard
// the transition under a load lock. p_actor is null (no login in this flow).

export interface InboundDelivery {
  loadStatus: string;                  // matched | scheduled | picked_up | delivered | closed
  method: string | null;               // set once the merchant picks a method
  deliveredAt: string | null;
  signerName: string | null;
  discrepancyReason: string | null;
  disputeWindowExpiresAt: string | null;
  windowOpen: boolean;                 // delivered, window not yet elapsed, not closed
}

interface InboundDeliveryRow {
  status: string;
  loads: { status: string } | null;
  deliveries: {
    method: string;
    delivered_at: string | null;
    signer_name: string | null;
    discrepancy_reason: string | null;
    dispute_window_expires_at: string | null;
  }[];
}

/**
 * The recipient-side delivery state for an ACCEPTED offer's token: the load
 * status + the delivery record (if the merchant has picked a method yet), so
 * the /inbound page can render the right recipient action (confirm receipt /
 * flag / read-only closed). Returns null when the token names no allocation, or
 * one that isn't accepted (the confirm flow only applies post-acceptance).
 * Throws on a genuine DB error.
 */
export async function getInboundDelivery(token: string): Promise<InboundDelivery | null> {
  const service = await createServiceClient();
  const { data, error } = await service
    .from('allocations')
    .select<string, InboundDeliveryRow>(
      `status, loads(status),
       deliveries(method, delivered_at, signer_name, discrepancy_reason, dispute_window_expires_at)`
    )
    .eq('public_view_token', token)
    .maybeSingle();
  if (error) throw new Error(`getInboundDelivery: allocation lookup failed: ${error.message}`);
  if (!data || data.status !== 'accepted') return null;

  const loadStatus = data.loads?.status ?? 'matched';
  const d = data.deliveries[0] ?? null;
  const expiresAt = d?.dispute_window_expires_at ?? null;
  const windowOpen =
    loadStatus === 'delivered' && expiresAt !== null && new Date(expiresAt).getTime() > Date.now();

  return {
    loadStatus,
    method: d?.method ?? null,
    deliveredAt: d?.delivered_at ?? null,
    signerName: d?.signer_name ?? null,
    discrepancyReason: d?.discrepancy_reason ?? null,
    disputeWindowExpiresAt: expiresAt,
    windowOpen,
  };
}

// Best-effort merchant notification on a recipient confirm/flag. Never throws —
// the state transition already committed; a failed notify must not fail the
// action (dev-mode sendEmail/sendPushToUser log to console).
async function notifyMerchantOfDelivery(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  loadId: string,
  kind: 'confirmed' | 'flagged'
): Promise<void> {
  try {
    const { data } = await service
      .from('loads')
      .select('merchants(business_name, user_id)')
      .eq('id', loadId)
      .maybeSingle();
    const merchant = data?.merchants as unknown as { business_name: string; user_id: string } | null;
    if (!merchant?.user_id) return;

    const { data: userRow } = await service
      .from('users')
      .select('email')
      .eq('id', merchant.user_id)
      .maybeSingle();

    const subject = kind === 'confirmed' ? 'Your load was received' : 'A delivery discrepancy was flagged';
    const body =
      kind === 'confirmed'
        ? 'The recipient confirmed receipt of your load.'
        : 'The recipient flagged a discrepancy on your delivered load — check the load details.';

    if (userRow?.email) {
      await sendEmail({ to: userRow.email, subject, text: body });
    }
    await sendPushToUser({
      externalUserId: merchant.user_id,
      title: subject,
      body,
      data: { load_id: loadId, type: `delivery_${kind}` },
    });
  } catch (err) {
    console.warn('[inbound] merchant delivery notify failed:', err);
  }
}

export type ConfirmDeliveryResult =
  | { success: true }
  | { success: false; error: 'NOT_FOUND' | 'SIGNER_REQUIRED' | 'NO_DELIVERY' | 'NOT_CONFIRMABLE' | 'SERVER_ERROR' };

/** Recipient confirms receipt on arrival — signer + acknowledgment, opens the dispute window. */
export async function confirmInboundDelivery(
  token: string,
  signerName: string,
  discrepancyReason?: string
): Promise<ConfirmDeliveryResult> {
  const service = await createServiceClient();
  const { data: alloc, error: lookupError } = await service
    .from('allocations')
    .select('id')
    .eq('public_view_token', token)
    .maybeSingle();
  if (lookupError) throw new Error(`confirmInboundDelivery: allocation lookup failed: ${lookupError.message}`);
  if (!alloc) return { success: false, error: 'NOT_FOUND' };

  const expiresAt = new Date(Date.now() + DISPUTE_WINDOW_MS).toISOString();
  const { data, error } = await service.rpc('recipient_confirm_delivery', {
    p_allocation_id: alloc.id,
    p_signer_name: signerName,
    p_discrepancy_reason: discrepancyReason ?? null,
    p_expires_at: expiresAt,
    p_actor: null,
  });
  if (error || !data) {
    const msg = error?.message ?? '';
    if (msg.includes('SIGNER_REQUIRED')) return { success: false, error: 'SIGNER_REQUIRED' };
    if (msg.includes('NO_DELIVERY')) return { success: false, error: 'NO_DELIVERY' };
    if (msg.includes('NOT_CONFIRMABLE')) return { success: false, error: 'NOT_CONFIRMABLE' };
    return { success: false, error: 'SERVER_ERROR' };
  }

  // Open the dispute window (Inngest sleeps until dispute_window_expires_at,
  // then closes the load) — best-effort, the confirm already committed.
  try {
    await inngest.send({ name: 'load/delivered', data: { load_id: data.load_id } });
  } catch (err) {
    console.warn('[inbound] load/delivered event send failed:', err);
  }
  await notifyMerchantOfDelivery(service, data.load_id, 'confirmed');

  return { success: true };
}

export type FlagDiscrepancyResult =
  | { success: true }
  | { success: false; error: 'NOT_FOUND' | 'REASON_REQUIRED' | 'NO_DELIVERY' | 'WINDOW_CLOSED' | 'SERVER_ERROR' };

/** Recipient flags a discrepancy within the open dispute window — recorded, not refereed. */
export async function flagInboundDiscrepancy(token: string, reason: string): Promise<FlagDiscrepancyResult> {
  const service = await createServiceClient();
  const { data: alloc, error: lookupError } = await service
    .from('allocations')
    .select('id')
    .eq('public_view_token', token)
    .maybeSingle();
  if (lookupError) throw new Error(`flagInboundDiscrepancy: allocation lookup failed: ${lookupError.message}`);
  if (!alloc) return { success: false, error: 'NOT_FOUND' };

  const { data, error } = await service.rpc('flag_delivery_discrepancy', {
    p_allocation_id: alloc.id,
    p_reason: reason,
    p_actor: null,
  });
  if (error || !data) {
    const msg = error?.message ?? '';
    if (msg.includes('REASON_REQUIRED')) return { success: false, error: 'REASON_REQUIRED' };
    if (msg.includes('NO_DELIVERY')) return { success: false, error: 'NO_DELIVERY' };
    if (msg.includes('WINDOW_CLOSED')) return { success: false, error: 'WINDOW_CLOSED' };
    return { success: false, error: 'SERVER_ERROR' };
  }

  await notifyMerchantOfDelivery(service, data.load_id, 'flagged');

  return { success: true };
}
