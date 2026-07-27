// Surplus-intelligence reporting — pure helpers + shared constants (Task 1,
// transition-plan Phase 7). No DB access here; the guarded reads live in
// src/actions/reports.ts and the sweep in src/inngest/functions/disposition-hygiene.ts.
// SCAN/DECLARE-time supply signal only — nothing here touches delivery/receiving.

// How long a scan may sit in 'pending' with no load before the hygiene sweep
// flags it as dangling (an abandoned manifest — the dataset-rot case). Merchants
// declare same-day in the pilot flow, so 3 days is generous slack (weekend
// scans) while still surfacing truly stranded scans. Shared by the sweep and
// the ops-console dangling indicator so they always agree.
export const DANGLE_WINDOW_DAYS = 3;

// ISO weekday (1=Mon … 7=Sun) — matches EXTRACT(ISODOW …) in 028's views.
export const WEEKDAY_LABELS = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
] as const;

export function weekdayLabel(isoDow: number): string {
  return WEEKDAY_LABELS[isoDow - 1] ?? 'Unknown';
}

export interface SurplusPattern {
  categoryLabel: string;
  localDow: number;
  avgEstLbsPerDay: number;
  distinctDays: number;
  totalEstLbs: number;
}

/**
 * The human "surplus intelligence" sentence for one pattern row, e.g.
 * "~22.0 lbs of Bakery & desserts every Monday (6 days seen)". Pure so the
 * phrasing is unit-tested independent of any DB shape.
 */
export function describeSurplusPattern(p: SurplusPattern): string {
  const days = p.distinctDays === 1 ? '1 day seen' : `${p.distinctDays} days seen`;
  return `~${p.avgEstLbsPerDay.toFixed(1)} lbs of ${p.categoryLabel} every ${weekdayLabel(p.localDow)} (${days})`;
}
