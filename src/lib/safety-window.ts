// Pure FDA safety-window computation, ported from the old listing flow
// (src/actions/listing.ts:17-21,175-195). Window hours now come from the
// categories table (018) instead of a hardcoded category set — counsel can
// tune them in data (old TRD blocking decision #3 is still pending).

const CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface CategorySafety {
  temperatureSensitive: boolean;
  safetyWindowHours: number | null;
}

export type SafetyResult =
  | { ok: true; safetyExpiresAt: string | null }
  | { ok: false; error: 'PREPARED_AT_REQUIRED' | 'INVALID_PREPARED_AT' | 'PREPARED_AT_IN_FUTURE' | 'SAFETY_WINDOW_EXPIRED' };

export function computeSafetyExpiry(
  cat: CategorySafety,
  preparedAt: string | null | undefined,
  nowMs: number = Date.now()
): SafetyResult {
  if (!cat.temperatureSensitive || cat.safetyWindowHours == null) {
    return { ok: true, safetyExpiresAt: null };
  }
  if (!preparedAt) return { ok: false, error: 'PREPARED_AT_REQUIRED' };

  const preparedMs = new Date(preparedAt).getTime();
  if (Number.isNaN(preparedMs)) return { ok: false, error: 'INVALID_PREPARED_AT' };
  if (preparedMs > nowMs + CLOCK_SKEW_MS) return { ok: false, error: 'PREPARED_AT_IN_FUTURE' };

  const expiresMs = preparedMs + cat.safetyWindowHours * 60 * 60 * 1000;
  if (expiresMs <= nowMs) return { ok: false, error: 'SAFETY_WINDOW_EXPIRED' };

  return { ok: true, safetyExpiresAt: new Date(expiresMs).toISOString() };
}
