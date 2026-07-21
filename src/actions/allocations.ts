'use server';

// Ops matching console actions (Phase 2 Task 3). "Ops is the algorithm" —
// there is no auto-matching; every offer/withdraw is a deliberate admin
// action, recorded by the RPCs' own audit_log inserts.
//
// Admin guard: requireAdmin() below is copied VERBATIM from
// src/app/(admin)/admin/dashboard/page.tsx. checkAdmin() gates the
// /admin/matching PAGE; requireAdmin() gates every action exported from
// THIS file, because every export in a 'use server' module is independently
// reachable as its own HTTP endpoint — the page-level guard never covers
// it (same reasoning as updateCommodityPrice/verifyDonorLicense on that
// page). Reads throw on both DB error and a failed admin check (house
// rule for a guarded read only reachable from an already-gated surface —
// see getCategoriesWithValuations in manifest.ts). Mutating actions
// (offerLoad, withdrawOffer) instead return a typed
// `{ success:false, error }` union: a rejected offer/withdraw is an
// expected outcome the ops UI renders, not an infra failure.
//
// The RPCs (offer_load/withdraw_offer, 024/025_*.sql) re-guard every state
// transition themselves and are the actual source of truth; this file maps
// their typed (message-as-code) errors the same way
// src/actions/manifest.ts's confirmManifest does for confirm_and_declare.
// offer_load does NOT itself validate expires_at against now() — it trusts
// the caller — so the folded requirement-3 clamp (computeOfferExpiry, in
// src/lib/match-score.ts) MUST run here, before the RPC is ever called.

import { createClient, createServiceClient } from '@/lib/supabase/server';
import {
  scoreMatch,
  isEligibleInstitution,
  rankByScoreThenFewestOffers,
  computeOfferExpiry,
} from '@/lib/match-score';

// Server actions are HTTP endpoints callable by any authenticated user — each
// one must verify the admin role itself; the page-level check doesn't cover them.
async function requireAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const service = await createServiceClient();
  const { data } = await service
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single();

  return data?.role === 'admin';
}

async function assertAdmin(actionName: string): Promise<void> {
  if (!(await requireAdmin())) {
    throw new Error(`${actionName}: not an admin`);
  }
}

// Standard offer time-to-live: how long an institution has to accept/decline
// before the stale-offer sweep (src/inngest/functions/expire-offers.ts)
// reclaims the load. 4 hours gives a same-evening window to check email and
// confirm receiving capacity, without letting an ignored offer strand a load
// indefinitely. Almost always clamped tighter by the load's own
// earliest_safety_expires_at below — some TCS safety windows are as short as
// 2h (see src/lib/safety-window.ts), well under this TTL.
const DEFAULT_OFFER_TTL_MS = 4 * 60 * 60 * 1000;

// Recent-offer lookback for the tie-break signal (fewest recent offers wins)
// — "recent" is intentionally short: it's meant to spread TONIGHT's
// allocation load across the roster, not to penalize an institution for
// offers from last week.
const RECENT_OFFERS_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export type Lane = 'donation' | 'sale';

export interface MatchableLoadItem {
  scanItemId: string;
  foodName: string;
  categoryKey: string;
  estLbs: number;
  safetyExpiresAt: string | null;
}

export interface ActiveAllocation {
  id: string;
  status: string; // 'offered' | 'accepted'
  institutionId: string;
  institutionOrgName: string;
  expiresAt: string;
}

export interface MatchableLoad {
  id: string;
  windowDate: string;
  lane: Lane;
  earliestSafetyExpiresAt: string | null;
  merchantBusinessName: string;
  items: MatchableLoadItem[];
  totalEstLbs: number;
  activeAllocation: ActiveAllocation | null;
}

interface MatchableLoadRow {
  id: string;
  window_date: string;
  lane: string;
  earliest_safety_expires_at: string | null;
  merchants: { business_name: string } | null;
  scan_items: { id: string; food_name: string; category_key: string; est_lbs: number; safety_expires_at: string | null }[];
  allocations: {
    id: string;
    status: string;
    institution_id: string;
    expires_at: string;
    institutions: { org_name: string } | null;
  }[];
}

/**
 * The ops matching queue: every load still awaiting a match decision —
 * never-yet-offered ('declared') and offered-but-unresolved ('matched',
 * which covers both an active 'offered' allocation and an 'accepted' one
 * pending Phase-3 route scheduling) — with its items and current active
 * allocation (if any) folded in, so the console needs no second round trip
 * per load for allocation status. Ordered soonest-safety-expiry first
 * (Postgres's default NULLS LAST on ASC puts shelf-stable loads last, which
 * is the right urgency order). Throws on DB error or a failed admin check.
 */
export async function getMatchableLoads(): Promise<MatchableLoad[]> {
  await assertAdmin('getMatchableLoads');

  const service = await createServiceClient();
  const { data, error } = await service
    .from('loads')
    .select<string, MatchableLoadRow>(
      `id, window_date, lane, earliest_safety_expires_at,
       merchants(business_name),
       scan_items(id, food_name, category_key, est_lbs, safety_expires_at),
       allocations(id, status, institution_id, expires_at, institutions(org_name))`
    )
    .in('status', ['declared', 'matched'])
    .order('earliest_safety_expires_at', { ascending: true });
  if (error) throw new Error(`getMatchableLoads: loads lookup failed: ${error.message}`);

  return (data ?? []).map(row => {
    const active = row.allocations.find(a => a.status === 'offered' || a.status === 'accepted') ?? null;
    const totalEstLbs = row.scan_items.reduce((sum, item) => sum + Number(item.est_lbs), 0);

    return {
      id: row.id,
      windowDate: row.window_date,
      lane: row.lane as Lane,
      earliestSafetyExpiresAt: row.earliest_safety_expires_at,
      merchantBusinessName: row.merchants?.business_name ?? '—',
      items: row.scan_items.map(item => ({
        scanItemId: item.id,
        foodName: item.food_name,
        categoryKey: item.category_key,
        estLbs: Number(item.est_lbs),
        safetyExpiresAt: item.safety_expires_at,
      })),
      totalEstLbs,
      activeAllocation: active
        ? {
            id: active.id,
            status: active.status,
            institutionId: active.institution_id,
            institutionOrgName: active.institutions?.org_name ?? '—',
            expiresAt: active.expires_at,
          }
        : null,
    };
  });
}

export interface InstitutionSummary {
  id: string;
  orgName: string;
  npoVerified: boolean;
  demandCategoryKeys: string[];
  capacityLbs: number | null;
  receivingWindows: unknown; // JSONB: [{ day, start, end }]
}

/** Active institutions with their standing demand profile. Throws on DB error or a failed admin check. */
export async function getInstitutions(): Promise<InstitutionSummary[]> {
  await assertAdmin('getInstitutions');

  const service = await createServiceClient();
  const { data, error } = await service
    .from('institutions')
    .select('id, org_name, npo_verified, demand_category_keys, capacity_lbs, receiving_windows')
    .eq('status', 'active')
    .order('org_name');
  if (error) throw new Error(`getInstitutions: institutions lookup failed: ${error.message}`);

  return (data ?? []).map(i => ({
    id: i.id,
    orgName: i.org_name,
    npoVerified: i.npo_verified,
    demandCategoryKeys: i.demand_category_keys ?? [],
    capacityLbs: i.capacity_lbs,
    receivingWindows: i.receiving_windows,
  }));
}

export interface SuggestedMatch {
  institutionId: string;
  orgName: string;
  score: number;
  recentOfferCount: number;
}

/**
 * Ranked, rule-based (NOT ML) offer suggestions for one load — see
 * src/lib/match-score.ts for the scoring formula and tie-break. Hard-filters
 * to active + lane-eligible institutions first (isEligibleInstitution): on
 * the donation lane, only npo_verified institutions can appear, full stop —
 * this is the same gate offer_load enforces DB-side, applied here so the UI
 * never even suggests an offer the RPC would reject. Throws on DB error or a
 * failed admin check; returns [] for a load that no longer exists (the
 * console only ever calls this with an id from getMatchableLoads, so that
 * should not happen in practice).
 */
export async function getSuggestedMatches(loadId: string): Promise<SuggestedMatch[]> {
  await assertAdmin('getSuggestedMatches');

  const service = await createServiceClient();

  const [{ data: load, error: loadError }, { data: items, error: itemsError }] = await Promise.all([
    service.from('loads').select('id, lane, earliest_safety_expires_at').eq('id', loadId).maybeSingle(),
    service.from('scan_items').select('category_key, est_lbs').eq('load_id', loadId),
  ]);
  if (loadError) throw new Error(`getSuggestedMatches: load lookup failed: ${loadError.message}`);
  if (itemsError) throw new Error(`getSuggestedMatches: items lookup failed: ${itemsError.message}`);
  if (!load) return [];

  const totalEstLbs = (items ?? []).reduce((sum, i) => sum + Number(i.est_lbs), 0);
  const categoryKeys = (items ?? []).map(i => i.category_key as string);

  const { data: institutions, error: instError } = await service
    .from('institutions')
    .select('id, org_name, npo_verified, demand_category_keys, capacity_lbs, status')
    .eq('status', 'active');
  if (instError) throw new Error(`getSuggestedMatches: institutions lookup failed: ${instError.message}`);

  const eligible = (institutions ?? []).filter(inst =>
    isEligibleInstitution({ status: inst.status, npoVerified: inst.npo_verified, lane: load.lane as Lane })
  );
  if (eligible.length === 0) return [];

  const cutoff = new Date(Date.now() - RECENT_OFFERS_LOOKBACK_MS).toISOString();
  const eligibleIds = eligible.map(i => i.id as string);
  const { data: recent, error: recentError } = await service
    .from('allocations')
    .select('institution_id')
    .in('institution_id', eligibleIds)
    .gte('offered_at', cutoff);
  if (recentError) throw new Error(`getSuggestedMatches: recent-offers lookup failed: ${recentError.message}`);

  const recentCounts = new Map<string, number>();
  for (const row of recent ?? []) {
    const id = row.institution_id as string;
    recentCounts.set(id, (recentCounts.get(id) ?? 0) + 1);
  }

  const candidates = eligible.map(inst => ({
    institutionId: inst.id as string,
    orgName: inst.org_name as string,
    score: scoreMatch(
      { totalEstLbs, categoryKeys, earliestSafetyExpiresAt: load.earliest_safety_expires_at },
      { demandCategoryKeys: inst.demand_category_keys ?? [], capacityLbs: inst.capacity_lbs }
    ),
    recentOfferCount: recentCounts.get(inst.id as string) ?? 0,
  }));

  return rankByScoreThenFewestOffers(candidates);
}

export type OfferLoadResult =
  | { success: true; allocationId: string; expiresAt: string }
  | {
      success: false;
      error:
        | 'NOT_ADMIN'
        | 'LOAD_NOT_OFFERABLE'
        | 'INSTITUTION_NOT_ELIGIBLE'
        | 'ALREADY_ALLOCATED'
        | 'SAFETY_WINDOW_PASSED'
        | 'SERVER_ERROR';
    };

/**
 * Offers a declared load to an institution. requireAdmin first. Clamps
 * expires_at to whichever is sooner — the standard TTL, or the load's
 * earliest_safety_expires_at — via computeOfferExpiry (folded requirement
 * 3); if the safety window has already passed, returns SAFETY_WINDOW_PASSED
 * WITHOUT ever calling offer_load. Otherwise calls offer_load and maps its
 * typed errors the way confirmManifest maps confirm_and_declare's.
 */
export async function offerLoad(loadId: string, institutionId: string): Promise<OfferLoadResult> {
  if (!(await requireAdmin())) return { success: false, error: 'NOT_ADMIN' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_ADMIN' }; // defensive; requireAdmin already implies this

  const service = await createServiceClient();

  const { data: load, error: loadError } = await service
    .from('loads')
    .select('id, earliest_safety_expires_at')
    .eq('id', loadId)
    .maybeSingle();
  if (loadError) return { success: false, error: 'SERVER_ERROR' };
  if (!load) return { success: false, error: 'LOAD_NOT_OFFERABLE' };

  const clamp = computeOfferExpiry({
    nowMs: Date.now(),
    ttlMs: DEFAULT_OFFER_TTL_MS,
    earliestSafetyExpiresAt: load.earliest_safety_expires_at,
  });
  if (!clamp.ok) return { success: false, error: clamp.error };

  const { data: alloc, error } = await service.rpc('offer_load', {
    p_load_id: loadId,
    p_institution_id: institutionId,
    p_offered_by: user.id,
    p_expires_at: clamp.expiresAt,
  });
  if (error || !alloc) {
    const msg = error?.message ?? '';
    if (msg.includes('LOAD_NOT_OFFERABLE')) return { success: false, error: 'LOAD_NOT_OFFERABLE' };
    if (msg.includes('INSTITUTION_NOT_ELIGIBLE')) return { success: false, error: 'INSTITUTION_NOT_ELIGIBLE' };
    if (msg.includes('ALREADY_ALLOCATED')) return { success: false, error: 'ALREADY_ALLOCATED' };
    return { success: false, error: 'SERVER_ERROR' };
  }

  return { success: true, allocationId: alloc.id, expiresAt: alloc.expires_at };
}

export type WithdrawOfferResult =
  | { success: true; loadId: string }
  | { success: false; error: 'NOT_ADMIN' | 'OFFER_NOT_ACTIVE' | 'SERVER_ERROR' };

/** Manually withdraws an active offer (ops escape hatch). requireAdmin first, then withdraw_offer; maps OFFER_NOT_ACTIVE. */
export async function withdrawOffer(allocationId: string): Promise<WithdrawOfferResult> {
  if (!(await requireAdmin())) return { success: false, error: 'NOT_ADMIN' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_ADMIN' };

  const service = await createServiceClient();
  const { data: load, error } = await service.rpc('withdraw_offer', {
    p_allocation_id: allocationId,
    p_actor: user.id,
  });
  if (error || !load) {
    const msg = error?.message ?? '';
    if (msg.includes('OFFER_NOT_ACTIVE')) return { success: false, error: 'OFFER_NOT_ACTIVE' };
    return { success: false, error: 'SERVER_ERROR' };
  }

  return { success: true, loadId: load.id };
}
