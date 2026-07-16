import { describe, expect, test } from 'vitest';
import { computeSafetyExpiry } from './safety-window';

const HOT = { temperatureSensitive: true, safetyWindowHours: 2 };
const COLD = { temperatureSensitive: true, safetyWindowHours: 4 };
const SHELF = { temperatureSensitive: false, safetyWindowHours: null };
const NOW = Date.parse('2026-07-16T18:00:00Z');

describe('computeSafetyExpiry', () => {
  test('non-TCS category needs no prepared_at and has no expiry', () => {
    expect(computeSafetyExpiry(SHELF, null, NOW)).toEqual({ ok: true, safetyExpiresAt: null });
  });
  test('TCS without prepared_at is rejected', () => {
    expect(computeSafetyExpiry(HOT, null, NOW)).toEqual({ ok: false, error: 'PREPARED_AT_REQUIRED' });
  });
  test('hot window = prepared_at + 2h', () => {
    const r = computeSafetyExpiry(HOT, '2026-07-16T17:00:00Z', NOW);
    expect(r).toEqual({ ok: true, safetyExpiresAt: '2026-07-16T19:00:00.000Z' });
  });
  test('cold window = prepared_at + 4h', () => {
    const r = computeSafetyExpiry(COLD, '2026-07-16T17:00:00Z', NOW);
    expect(r).toEqual({ ok: true, safetyExpiresAt: '2026-07-16T21:00:00.000Z' });
  });
  test('garbage timestamp is rejected', () => {
    expect(computeSafetyExpiry(HOT, 'not-a-date', NOW)).toEqual({ ok: false, error: 'INVALID_PREPARED_AT' });
  });
  test('future prepared_at beyond 5-min skew is rejected', () => {
    const future = new Date(NOW + 10 * 60 * 1000).toISOString();
    expect(computeSafetyExpiry(HOT, future, NOW)).toEqual({ ok: false, error: 'PREPARED_AT_IN_FUTURE' });
  });
  test('already-expired window is rejected', () => {
    const stale = new Date(NOW - 3 * 60 * 60 * 1000).toISOString(); // 3h ago, 2h window
    expect(computeSafetyExpiry(HOT, stale, NOW)).toEqual({ ok: false, error: 'SAFETY_WINDOW_EXPIRED' });
  });
});
