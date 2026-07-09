'use client';

import { useNow } from '@/lib/useNow';

/** Red "expires in X min" line, shown only once under an hour remains. */
export function SafetyWindowNotice({ expiresAt }: { expiresAt: string }) {
  const now = useNow();
  if (!now) return null;

  const minutesLeft = Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 60000));
  if (minutesLeft >= 60) return null;

  return (
    <p className="text-xs text-red-600 font-medium">
      Safety window expires in {minutesLeft} min
    </p>
  );
}
