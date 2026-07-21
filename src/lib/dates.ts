// Strict calendar-date validation (review I3: calendar-rollover dates pass
// validation). `Date.parse('2026-02-30')` and `new Date('2026-02-30')` both
// silently roll over to March 2nd instead of rejecting — JS Date arithmetic
// normalizes out-of-range components rather than erroring. This helper never
// calls Date.parse / the Date string constructor: it parses the components
// itself, re-derives a real date via Date.UTC (fixed-TZ, so the result never
// depends on the server's local timezone), and rejects unless every
// component round-trips exactly.

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidCalendarDate(s: string): boolean {
  const match = SHAPE.exec(s);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Date.UTC normalizes out-of-range components (e.g. month 13 -> next
  // year's January, day 30 of a 28-day February -> March), so a round-trip
  // check catches every rollover case without a hardcoded days-in-month table.
  const ms = Date.UTC(year, month - 1, day);
  const roundTripped = new Date(ms);

  return (
    roundTripped.getUTCFullYear() === year &&
    roundTripped.getUTCMonth() === month - 1 &&
    roundTripped.getUTCDate() === day
  );
}
