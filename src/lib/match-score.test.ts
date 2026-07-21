import { describe, expect, test } from 'vitest';
import {
  scoreMatch,
  isEligibleInstitution,
  rankByScoreThenFewestOffers,
  computeOfferExpiry,
  type MatchLoadInput,
  type MatchInstitutionInput,
} from './match-score';

const NOW = Date.parse('2026-07-20T18:00:00Z');

const BASE_LOAD: MatchLoadInput = {
  totalEstLbs: 10,
  categoryKeys: ['BAKERY', 'DELI'],
  earliestSafetyExpiresAt: null,
};

const BASE_INSTITUTION: MatchInstitutionInput = {
  demandCategoryKeys: ['BAKERY', 'DELI'],
  capacityLbs: 10,
};

describe('scoreMatch — overlap', () => {
  test('full category overlap outscores partial overlap, other factors held equal', () => {
    const full = scoreMatch(BASE_LOAD, { ...BASE_INSTITUTION, demandCategoryKeys: ['BAKERY', 'DELI'] }, NOW);
    const partial = scoreMatch(BASE_LOAD, { ...BASE_INSTITUTION, demandCategoryKeys: ['BAKERY'] }, NOW);
    expect(full).toBeGreaterThan(partial);
  });

  test('zero overlap zeroes the whole score (multiplicative)', () => {
    const none = scoreMatch(BASE_LOAD, { ...BASE_INSTITUTION, demandCategoryKeys: ['SEAFOOD'] }, NOW);
    expect(none).toBe(0);
  });

  test('an institution with no declared demand at all scores 0, not a free pass', () => {
    const noDemand = scoreMatch(BASE_LOAD, { ...BASE_INSTITUTION, demandCategoryKeys: [] }, NOW);
    expect(noDemand).toBe(0);
  });
});

describe('scoreMatch — capacity fit', () => {
  test('comfortable capacity outscores tight/insufficient capacity, other factors held equal', () => {
    const comfortable = scoreMatch(BASE_LOAD, { ...BASE_INSTITUTION, capacityLbs: 100 }, NOW);
    const tight = scoreMatch(BASE_LOAD, { ...BASE_INSTITUTION, capacityLbs: 2 }, NOW);
    expect(comfortable).toBeGreaterThan(tight);
  });

  test('null capacity is neutral: between a comfortable fit and a poor one', () => {
    const comfortable = scoreMatch(BASE_LOAD, { ...BASE_INSTITUTION, capacityLbs: 100 }, NOW);
    const neutral = scoreMatch(BASE_LOAD, { ...BASE_INSTITUTION, capacityLbs: null }, NOW);
    const poor = scoreMatch(BASE_LOAD, { ...BASE_INSTITUTION, capacityLbs: 1 }, NOW);
    expect(neutral).toBeLessThan(comfortable);
    expect(neutral).toBeGreaterThan(poor);
  });

  test('capacity exactly covering the load caps the fit at 1 (no bonus for excess)', () => {
    const exact = scoreMatch(BASE_LOAD, { ...BASE_INSTITUTION, capacityLbs: 10 }, NOW);
    const excess = scoreMatch(BASE_LOAD, { ...BASE_INSTITUTION, capacityLbs: 1000 }, NOW);
    expect(exact).toBe(excess);
  });
});

describe('scoreMatch — safety-window slack', () => {
  test('more runway until earliest_safety_expires_at outscores less runway, institution held equal', () => {
    const farExpiry = new Date(NOW + 20 * 60 * 60 * 1000).toISOString(); // 20h out
    const nearExpiry = new Date(NOW + 1 * 60 * 60 * 1000).toISOString(); // 1h out
    const farScore = scoreMatch({ ...BASE_LOAD, earliestSafetyExpiresAt: farExpiry }, BASE_INSTITUTION, NOW);
    const nearScore = scoreMatch({ ...BASE_LOAD, earliestSafetyExpiresAt: nearExpiry }, BASE_INSTITUTION, NOW);
    expect(farScore).toBeGreaterThan(nearScore);
  });

  test('no safety expiry (shelf-stable load) scores the same as the max-slack ceiling', () => {
    const atCeiling = new Date(NOW + 24 * 60 * 60 * 1000).toISOString();
    const noExpiry = scoreMatch({ ...BASE_LOAD, earliestSafetyExpiresAt: null }, BASE_INSTITUTION, NOW);
    const ceiling = scoreMatch({ ...BASE_LOAD, earliestSafetyExpiresAt: atCeiling }, BASE_INSTITUTION, NOW);
    expect(noExpiry).toBe(ceiling);
  });

  test('an already-passed safety expiry zeroes the whole score (multiplicative)', () => {
    const past = new Date(NOW - 60 * 1000).toISOString();
    const score = scoreMatch({ ...BASE_LOAD, earliestSafetyExpiresAt: past }, BASE_INSTITUTION, NOW);
    expect(score).toBe(0);
  });
});

describe('isEligibleInstitution — unverified institutions excluded on the donation lane', () => {
  test('unverified + donation lane is never eligible', () => {
    expect(isEligibleInstitution({ status: 'active', npoVerified: false, lane: 'donation' })).toBe(false);
  });

  test('verified + active + donation lane is eligible', () => {
    expect(isEligibleInstitution({ status: 'active', npoVerified: true, lane: 'donation' })).toBe(true);
  });

  test('unverified is still eligible on the sale lane (npo_verified is a donation-only gate)', () => {
    expect(isEligibleInstitution({ status: 'active', npoVerified: false, lane: 'sale' })).toBe(true);
  });

  test('a non-active institution is never eligible, verified or not', () => {
    expect(isEligibleInstitution({ status: 'pending', npoVerified: true, lane: 'donation' })).toBe(false);
    expect(isEligibleInstitution({ status: 'suspended', npoVerified: true, lane: 'sale' })).toBe(false);
  });
});

describe('rankByScoreThenFewestOffers', () => {
  test('sorts by score descending', () => {
    const ranked = rankByScoreThenFewestOffers([
      { id: 'low', score: 0.2, recentOfferCount: 0 },
      { id: 'high', score: 0.9, recentOfferCount: 0 },
      { id: 'mid', score: 0.5, recentOfferCount: 0 },
    ]);
    expect(ranked.map(r => r.id)).toEqual(['high', 'mid', 'low']);
  });

  test('ties on score are broken by fewest recent offers, ascending', () => {
    const ranked = rankByScoreThenFewestOffers([
      { id: 'busy', score: 0.7, recentOfferCount: 5 },
      { id: 'quiet', score: 0.7, recentOfferCount: 0 },
      { id: 'medium', score: 0.7, recentOfferCount: 2 },
    ]);
    expect(ranked.map(r => r.id)).toEqual(['quiet', 'medium', 'busy']);
  });

  test('does not mutate the input array', () => {
    const input = [
      { id: 'a', score: 0.1, recentOfferCount: 0 },
      { id: 'b', score: 0.9, recentOfferCount: 0 },
    ];
    const inputCopy = [...input];
    rankByScoreThenFewestOffers(input);
    expect(input).toEqual(inputCopy);
  });
});

describe('computeOfferExpiry', () => {
  const ttlMs = 4 * 60 * 60 * 1000; // 4h, mirrors DEFAULT_OFFER_TTL_MS

  test('uses the TTL when the load has no safety expiry', () => {
    const result = computeOfferExpiry({ nowMs: NOW, ttlMs, earliestSafetyExpiresAt: null });
    expect(result).toEqual({ ok: true, expiresAt: new Date(NOW + ttlMs).toISOString() });
  });

  test('uses the TTL when the safety expiry is farther out than the TTL', () => {
    const farSafety = new Date(NOW + 10 * 60 * 60 * 1000).toISOString(); // 10h out
    const result = computeOfferExpiry({ nowMs: NOW, ttlMs, earliestSafetyExpiresAt: farSafety });
    expect(result).toEqual({ ok: true, expiresAt: new Date(NOW + ttlMs).toISOString() });
  });

  test('clamps to the safety expiry when it is sooner than the TTL', () => {
    const nearSafety = new Date(NOW + 30 * 60 * 1000).toISOString(); // 30min out
    const result = computeOfferExpiry({ nowMs: NOW, ttlMs, earliestSafetyExpiresAt: nearSafety });
    expect(result).toEqual({ ok: true, expiresAt: nearSafety });
  });

  test('rejects with SAFETY_WINDOW_PASSED when the safety expiry has already elapsed', () => {
    const pastSafety = new Date(NOW - 60 * 1000).toISOString(); // 1min ago
    const result = computeOfferExpiry({ nowMs: NOW, ttlMs, earliestSafetyExpiresAt: pastSafety });
    expect(result).toEqual({ ok: false, error: 'SAFETY_WINDOW_PASSED' });
  });

  test('rejects a safety expiry exactly at now (zero-duration offer)', () => {
    const result = computeOfferExpiry({ nowMs: NOW, ttlMs, earliestSafetyExpiresAt: new Date(NOW).toISOString() });
    expect(result).toEqual({ ok: false, error: 'SAFETY_WINDOW_PASSED' });
  });
});
