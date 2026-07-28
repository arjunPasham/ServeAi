'use server';

// v3 Delivery-log merchant actions (Task 1). A matched load with an ACCEPTED
// allocation advances by RECORDING the handoff: the merchant picks a method +
// responsible party (matched->scheduled), then marks it picked up. The recipient
// confirms delivery in Task 2. Records-only — no routing/dispatch/courier/commission.
//
// All gated on requireVerifiedMerchant; the read throws on DB/authz error (only
// reachable from the middleware-gated /merchant dashboard, same posture as
// getMerchantDashboard); the mutators return a typed { success:false, error }
// union the dashboard renders. The 031 RPCs re-check load ownership + state.

import { createServiceClient } from '@/lib/supabase/server';
import { requireVerifiedMerchant } from '@/lib/authz';
import { isDeliveryMethod, isResponsibleParty } from '@/lib/deliveries';

export interface DeliveryRecord {
  method: string;
  responsibleParty: string;
  scheduledAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  windowBlown: boolean;
}

export interface DeliverableLoad {
  id: string;
  windowDate: string;
  status: string;
  earliestSafetyExpiresAt: string | null;
  totalEstLbs: number;
  acceptedAllocationId: string | null;
  recipientOrgName: string | null;
  delivery: DeliveryRecord | null;
}

interface DeliverableLoadRow {
  id: string;
  window_date: string;
  status: string;
  earliest_safety_expires_at: string | null;
  load_items: { est_lbs: number }[];
  allocations: { id: string; status: string; institutions: { org_name: string } | null }[];
  deliveries: {
    method: string;
    responsible_party: string;
    scheduled_at: string | null;
    picked_up_at: string | null;
    delivered_at: string | null;
    window_blown: boolean;
  }[];
}

/**
 * The merchant's loads that are in (or ready for) delivery — matched through
 * delivered — with the accepted allocation (recipient) and the delivery record
 * folded in. A load 'matched' on a still-open offer shows no accepted
 * allocation (not yet actionable). Throws on DB error or a failed merchant check.
 */
export async function getDeliverableLoads(): Promise<DeliverableLoad[]> {
  const authz = await requireVerifiedMerchant();
  if (!authz.ok) throw new Error(`getDeliverableLoads: not a verified merchant (${authz.error})`);

  const service = await createServiceClient();
  const { data, error } = await service
    .from('loads')
    .select<string, DeliverableLoadRow>(
      `id, window_date, status, earliest_safety_expires_at,
       load_items(est_lbs),
       allocations(id, status, institutions(org_name)),
       deliveries(method, responsible_party, scheduled_at, picked_up_at, delivered_at, window_blown)`
    )
    .eq('merchant_id', authz.merchant.merchantId)
    .in('status', ['matched', 'scheduled', 'picked_up', 'delivered'])
    .order('window_date', { ascending: false });
  if (error) throw new Error(`getDeliverableLoads: loads lookup failed: ${error.message}`);

  return (data ?? []).map(row => {
    // Exactly one accepted allocation per active load (024's unique partial
    // index guarantees <=1 offered/accepted at a time).
    const accepted = row.allocations.find(a => a.status === 'accepted') ?? null;
    const d = row.deliveries[0] ?? null;
    return {
      id: row.id,
      windowDate: row.window_date,
      status: row.status,
      earliestSafetyExpiresAt: row.earliest_safety_expires_at,
      totalEstLbs: row.load_items.reduce((sum, li) => sum + Number(li.est_lbs), 0),
      acceptedAllocationId: accepted?.id ?? null,
      recipientOrgName: accepted?.institutions?.org_name ?? null,
      delivery: d
        ? {
            method: d.method,
            responsibleParty: d.responsible_party,
            scheduledAt: d.scheduled_at,
            pickedUpAt: d.picked_up_at,
            deliveredAt: d.delivered_at,
            windowBlown: d.window_blown,
          }
        : null,
    };
  });
}

export type SetDeliveryMethodResult =
  | { success: true }
  | {
      success: false;
      error:
        | 'NOT_A_MERCHANT'
        | 'INVALID_METHOD'
        | 'INVALID_PARTY'
        | 'LOAD_NOT_FOUND'
        | 'LOAD_NOT_SCHEDULABLE'
        | 'OFFER_NOT_ACCEPTED'
        | 'ALREADY_SCHEDULED'
        | 'SERVER_ERROR';
    };

/** Records the delivery method + responsible party for an accepted load (matched->scheduled). */
export async function setDeliveryMethod(
  loadId: string,
  allocationId: string,
  method: string,
  responsibleParty: string,
  notes?: string
): Promise<SetDeliveryMethodResult> {
  const authz = await requireVerifiedMerchant();
  if (!authz.ok) return { success: false, error: 'NOT_A_MERCHANT' };
  if (!isDeliveryMethod(method)) return { success: false, error: 'INVALID_METHOD' };
  if (!isResponsibleParty(responsibleParty)) return { success: false, error: 'INVALID_PARTY' };

  const service = await createServiceClient();
  const { data, error } = await service.rpc('set_delivery_method', {
    p_load_id: loadId,
    p_merchant_id: authz.merchant.merchantId,
    p_allocation_id: allocationId,
    p_method: method,
    p_responsible_party: responsibleParty,
    p_notes: notes ?? null,
    p_actor: authz.merchant.userId,
  });
  if (error || !data) {
    const msg = error?.message ?? '';
    if (msg.includes('LOAD_NOT_FOUND')) return { success: false, error: 'LOAD_NOT_FOUND' };
    if (msg.includes('LOAD_NOT_SCHEDULABLE')) return { success: false, error: 'LOAD_NOT_SCHEDULABLE' };
    if (msg.includes('OFFER_NOT_ACCEPTED')) return { success: false, error: 'OFFER_NOT_ACCEPTED' };
    if (msg.includes('ALREADY_SCHEDULED')) return { success: false, error: 'ALREADY_SCHEDULED' };
    return { success: false, error: 'SERVER_ERROR' };
  }
  return { success: true };
}

export type MarkPickedUpResult =
  | { success: true; windowBlown: boolean }
  | {
      success: false;
      error: 'NOT_A_MERCHANT' | 'LOAD_NOT_FOUND' | 'LOAD_NOT_PICKUPABLE' | 'NO_DELIVERY' | 'SERVER_ERROR';
    };

/** Marks a scheduled load picked up; surfaces the (recorded, non-blocking) window_blown flag. */
export async function markPickedUp(loadId: string): Promise<MarkPickedUpResult> {
  const authz = await requireVerifiedMerchant();
  if (!authz.ok) return { success: false, error: 'NOT_A_MERCHANT' };

  const service = await createServiceClient();
  const { data, error } = await service.rpc('mark_picked_up', {
    p_load_id: loadId,
    p_merchant_id: authz.merchant.merchantId,
    p_actor: authz.merchant.userId,
  });
  if (error || !data) {
    const msg = error?.message ?? '';
    if (msg.includes('LOAD_NOT_FOUND')) return { success: false, error: 'LOAD_NOT_FOUND' };
    if (msg.includes('LOAD_NOT_PICKUPABLE')) return { success: false, error: 'LOAD_NOT_PICKUPABLE' };
    if (msg.includes('NO_DELIVERY')) return { success: false, error: 'NO_DELIVERY' };
    return { success: false, error: 'SERVER_ERROR' };
  }
  return { success: true, windowBlown: data.window_blown === true };
}
