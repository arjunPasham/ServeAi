'use client';

import { useSyncExternalStore } from 'react';

// A single shared clock: one interval drives every countdown on the page,
// instead of each card spinning up its own timer.
let current = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (!timer) {
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      listeners.forEach(fn => fn());
    }, 60000);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/**
 * Current epoch milliseconds, refreshed once a minute. Returns 0 during server
 * render and first paint so hydration matches — keeps `Date.now()` out of the
 * render path. Treat 0 as "not ready yet".
 */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => current, () => 0);
}
