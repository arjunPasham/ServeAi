'use client';

// Renders an ISO timestamp in the *viewer's* browser locale/timezone
// (review I3 — safety-relevant). The merchant dashboard's safety-expiry line
// used `new Date(...).toLocaleTimeString()` in a Server Component, which
// formats in the SERVER's timezone: an 8:00 PM EDT expiry rendered as
// 12:00 AM on a UTC prod server, so a deli manager could read hours of
// runway that don't exist. The admin dashboard's date columns have the same
// server-TZ ambiguity (lower stakes, same bug), so this component covers
// both via the `variant` prop.
//
// The server has no way to know the eventual viewer's timezone, so it must
// render a timezone-agnostic placeholder (the raw ISO string) until the
// client mounts and can compute the real value. useSyncExternalStore's
// getServerSnapshot is the React-sanctioned way to do exactly this — it's
// used during SSR *and* the client's first render before hydration
// completes, so there's no real mismatch to warn about; render() only picks
// up the localized getSnapshot() value on the client's next tick. This
// avoids the cascading-render lint error that a plain
// `useEffect(() => setState(...))` "compute derived state" pattern would
// trigger. suppressHydrationWarning is kept anyway per the task brief, as a
// defensive backstop.

import { useSyncExternalStore } from 'react';

interface LocalDateTimeProps {
  iso: string;
  /** 'datetime' (default): date + time + short TZ name, e.g. "Jul 20, 8:00 PM EDT".
   *  'date': date only, e.g. "Jul 20, 2026". */
  variant?: 'datetime' | 'date';
}

// No real external store to subscribe to — the formatted value never
// changes on its own after mount, so this never fires onStoreChange.
function subscribe(): () => void {
  return () => {};
}

function formatLocal(iso: string, variant: 'datetime' | 'date'): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  return variant === 'date'
    ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      });
}

export function LocalDateTime({ iso, variant = 'datetime' }: LocalDateTimeProps) {
  const formatted = useSyncExternalStore(
    subscribe,
    () => formatLocal(iso, variant), // client snapshot, post-hydration
    () => iso // server snapshot (and the client's pre-hydration snapshot) — a
    // deliberately timezone-agnostic placeholder, never the wrong-timezone value
  );

  return (
    <time dateTime={iso} suppressHydrationWarning>
      {formatted}
    </time>
  );
}
