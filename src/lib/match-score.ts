// Pure, rule-based (NOT ML) math for the ops matching console (Phase 2 Task
// 3). Split out of src/actions/allocations.ts so it's unit-testable with no
// DB/Supabase/Next dependency — every export here is a plain function over
// plain data.
//
// ─── scoreMatch ──────────────────────────────────────────────────────────
// score = overlap × capacityFit × safetySlack, each normalized to [0, 1]:
//
//  - overlap: fraction of the load's DISTINCT item category_keys that the
//    institution lists in its demand_category_keys. 0 when either side has
//    no categories to compare — no signal means the load looks unmatched
//    for that institution, which is exactly what should suppress it.
//  - capacityFit: how well the institution's standing capacity_lbs covers
//    the load's total est_lbs — min(1, capacity_lbs / totalEstLbs). A NULL
//    capacity_lbs (institution hasn't set a standing capacity) scores
//    NEUTRAL_CAPACITY_SCORE rather than 0 or 1: 0 would bury every
//    not-yet-configured institution behind ones with a merely-adequate
//    number; 1 would let an unconfigured institution always outrank one
//    with a real, tight-but-sufficient capacity. 0.5 sits between "known
//    good fit" (1) and "known poor fit" (a small ratio).
//  - safetySlack: how much runway is left until the load's
//    earliest_safety_expires_at, normalized against
//    SAFETY_SLACK_CEILING_HOURS (more slack = more plausible the
//    institution can receive in time). A load with no safety expiry
//    (shelf-stable items only) scores max slack (1) — no safety clock is
//    working against the match. NOTE: this factor is a property of the
//    LOAD only, so within one getSuggestedMatches(loadId) call it's
//    identical across every institution being scored — it doesn't
//    discriminate institutions for a single load, by design. It exists so
//    a load running out of runway is visibly de-prioritized in general
//    (e.g. relative to how it would score earlier), which is why the unit
//    tests below vary it against a FIXED institution rather than expecting
//    it to break ties between two institutions for the same load.
//
// Eligibility (npo_verified on the donation lane, status='active') is a
// HARD FILTER applied before scoring (isEligibleInstitution), never a
// factor folded into the score — an ineligible institution must not appear
// as a suggestion at any score, not just a low one.
//
// Ties in the score above are broken by fewest recent offers to that
// institution (rankByScoreThenFewestOffers) — spreads allocation load
// across the roster instead of always suggesting the same top scorer.
//
// ─── computeOfferExpiry ──────────────────────────────────────────────────
// offerLoad's expires_at clamp (folded requirement 3): offer_load (024)
// trusts whatever expires_at its caller passes and never itself checks it
// against now(), so this is the only thing standing between an ops-issued
// offer and one that outlives the food's safety window.

export interface MatchLoadInput {
  totalEstLbs: number;
  categoryKeys: string[];
  earliestSafetyExpiresAt: string | null;
}

export interface MatchInstitutionInput {
  demandCategoryKeys: string[];
  capacityLbs: number | null;
}

const NEUTRAL_CAPACITY_SCORE = 0.5;
const SAFETY_SLACK_CEILING_HOURS = 24;

function categoryOverlap(loadCategoryKeys: string[], demandCategoryKeys: string[]): number {
  const loadKeys = new Set(loadCategoryKeys);
  if (loadKeys.size === 0 || demandCategoryKeys.length === 0) return 0;

  const demand = new Set(demandCategoryKeys);
  let matched = 0;
  for (const key of loadKeys) {
    if (demand.has(key)) matched += 1;
  }
  return matched / loadKeys.size;
}

function capacityFitScore(totalEstLbs: number, capacityLbs: number | null): number {
  if (capacityLbs == null) return NEUTRAL_CAPACITY_SCORE;
  if (totalEstLbs <= 0) return 1; // degenerate (no items) — nothing to not-fit
  return Math.min(1, capacityLbs / totalEstLbs);
}

function safetySlackScore(earliestSafetyExpiresAt: string | null, nowMs: number): number {
  if (!earliestSafetyExpiresAt) return 1;
  const expiryMs = new Date(earliestSafetyExpiresAt).getTime();
  if (Number.isNaN(expiryMs)) return 1;

  const hoursLeft = (expiryMs - nowMs) / (60 * 60 * 1000);
  if (hoursLeft <= 0) return 0;
  return Math.min(1, hoursLeft / SAFETY_SLACK_CEILING_HOURS);
}

/** Rule-based match score in [0, 1] for one (load, institution) pair. See the file header for the formula. */
export function scoreMatch(load: MatchLoadInput, institution: MatchInstitutionInput, nowMs: number = Date.now()): number {
  const overlap = categoryOverlap(load.categoryKeys, institution.demandCategoryKeys);
  const capacityFit = capacityFitScore(load.totalEstLbs, institution.capacityLbs);
  const safetySlack = safetySlackScore(load.earliestSafetyExpiresAt, nowMs);
  return overlap * capacityFit * safetySlack;
}

export interface EligibilityInput {
  status: string;
  npoVerified: boolean;
  lane: 'donation' | 'sale';
}

/**
 * Hard eligibility filter for offer suggestions/manual overrides — mirrors
 * offer_load's own DB-side gate (024_allocations.sql) so the ops UI never
 * even suggests an institution the RPC would reject. status must be
 * 'active'; the donation lane additionally requires npo_verified (Good
 * Samaritan / IRC 170(e)(3) compliance — a donation to an unverified
 * receiver breaks the story). An unverified institution must NEVER be
 * eligible on the donation lane, regardless of any other field.
 */
export function isEligibleInstitution(input: EligibilityInput): boolean {
  if (input.status !== 'active') return false;
  if (input.lane === 'donation' && !input.npoVerified) return false;
  return true;
}

export interface RankableCandidate {
  score: number;
  recentOfferCount: number;
}

/**
 * Sorts candidates by score descending; ties broken by fewest recent offers
 * to that institution, ascending — so allocation load spreads across the
 * roster instead of always landing on the same top scorer. Returns a new
 * array (does not mutate the input). Array.prototype.sort is stable per
 * spec, so candidates equal on both keys keep their input order.
 */
export function rankByScoreThenFewestOffers<T extends RankableCandidate>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.recentOfferCount - b.recentOfferCount;
  });
}

export interface OfferExpiryInput {
  nowMs: number;
  ttlMs: number;
  earliestSafetyExpiresAt: string | null;
}

export type OfferExpiryResult =
  | { ok: true; expiresAt: string }
  | { ok: false; error: 'SAFETY_WINDOW_PASSED' };

/**
 * Clamps an offer's expires_at to whichever is SOONER: the standard TTL
 * from now, or the load's earliest_safety_expires_at (when the load has any
 * temperature-sensitive items). Returns SAFETY_WINDOW_PASSED — instead of a
 * past timestamp — when the safety expiry has already elapsed, so the
 * caller (offerLoad) can refuse to call offer_load at all rather than
 * create an offer that's dead on arrival.
 */
export function computeOfferExpiry(input: OfferExpiryInput): OfferExpiryResult {
  const ttlExpiryMs = input.nowMs + input.ttlMs;
  const safetyExpiryMs = input.earliestSafetyExpiresAt ? new Date(input.earliestSafetyExpiresAt).getTime() : null;
  const expiresAtMs =
    safetyExpiryMs !== null && !Number.isNaN(safetyExpiryMs) ? Math.min(ttlExpiryMs, safetyExpiryMs) : ttlExpiryMs;

  if (expiresAtMs <= input.nowMs) {
    return { ok: false, error: 'SAFETY_WINDOW_PASSED' };
  }
  return { ok: true, expiresAt: new Date(expiresAtMs).toISOString() };
}
