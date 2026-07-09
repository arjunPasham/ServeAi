'use client';

// All demo state lives here, in memory, seeded from fixtures.ts.
// No Supabase, no Stripe, no Inngest — a page refresh resets everything
// except tutorial progress, which is mirrored to sessionStorage.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  DEMO_DELIVERY_SCRIPT,
  DEMO_LISTINGS,
  type DemoDeliveryStatus,
  type DemoListing,
} from '@/lib/demo/fixtures';

interface DemoOrder {
  listing: DemoListing;
  paidAt: number;
  status: DemoDeliveryStatus;
}

interface DemoStateValue {
  /** Session epoch (ms) — safety-window offsets are materialized against this. */
  seededAt: number;
  /** Fixture listings plus anything published in the donor flow this session. */
  listings: DemoListing[];
  publishListing: (listing: DemoListing) => void;
  order: DemoOrder | null;
  placeOrder: (listing: DemoListing) => void;
  resetOrder: () => void;
  /** Coach-mark ids the visitor has dismissed (mirrored to sessionStorage). */
  isMarkDismissed: (id: string) => boolean;
  dismissMark: (id: string) => void;
  tourSkipped: boolean;
  skipTour: () => void;
}

const DemoStateContext = createContext<DemoStateValue | null>(null);

const STORAGE_KEY = 'foodlink-demo-tour';

function loadTourProgress(): { dismissed: string[]; skipped: boolean } {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore — sessionStorage unavailable or corrupted; start the tour fresh
  }
  return { dismissed: [], skipped: false };
}

export function DemoProvider({ children }: { children: ReactNode }) {
  const [seededAt] = useState(() => Date.now());
  const [published, setPublished] = useState<DemoListing[]>([]);
  const [order, setOrder] = useState<DemoOrder | null>(null);
  // Lazy init: sessionStorage isn't available during SSR, but these values
  // never affect the first-paint DOM (CoachMark renders nothing until it has
  // measured its target), so there is no hydration mismatch.
  const [dismissed, setDismissed] = useState<string[]>(() =>
    typeof window === 'undefined' ? [] : loadTourProgress().dismissed
  );
  const [tourSkipped, setTourSkipped] = useState(() =>
    typeof window === 'undefined' ? false : loadTourProgress().skipped
  );
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // demo_mode cookie lets the proxy skip the Supabase auth round-trip for
  // /demo/* — and marks the visit so nothing ever redirects to /login here.
  useEffect(() => {
    document.cookie = 'demo_mode=1; path=/; max-age=86400; samesite=lax';
    const timers = timersRef.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  const persistTour = useCallback((nextDismissed: string[], skipped: boolean) => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ dismissed: nextDismissed, skipped }));
    } catch {
      // ignore
    }
  }, []);

  const publishListing = useCallback((listing: DemoListing) => {
    setPublished(prev => (prev.some(l => l.id === listing.id) ? prev : [listing, ...prev]));
  }, []);

  const placeOrder = useCallback((listing: DemoListing) => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    const paidAt = Date.now();
    setOrder({ listing, paidAt, status: 'finding_courier' });
    for (const step of DEMO_DELIVERY_SCRIPT.slice(1)) {
      timersRef.current.push(
        setTimeout(() => {
          setOrder(prev => (prev && prev.paidAt === paidAt ? { ...prev, status: step.status } : prev));
        }, step.atMs)
      );
    }
  }, []);

  const resetOrder = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    setOrder(null);
  }, []);

  const isMarkDismissed = useCallback(
    (id: string) => tourSkipped || dismissed.includes(id),
    [dismissed, tourSkipped]
  );

  const dismissMark = useCallback(
    (id: string) => {
      setDismissed(prev => {
        if (prev.includes(id)) return prev;
        const next = [...prev, id];
        persistTour(next, false);
        return next;
      });
    },
    [persistTour]
  );

  const skipTour = useCallback(() => {
    setTourSkipped(true);
    setDismissed(prev => {
      persistTour(prev, true);
      return prev;
    });
  }, [persistTour]);

  return (
    <DemoStateContext.Provider
      value={{
        seededAt,
        listings: [...published, ...DEMO_LISTINGS],
        publishListing,
        order,
        placeOrder,
        resetOrder,
        isMarkDismissed,
        dismissMark,
        tourSkipped,
        skipTour,
      }}
    >
      {children}
    </DemoStateContext.Provider>
  );
}

export function useDemoState(): DemoStateValue {
  const ctx = useContext(DemoStateContext);
  if (!ctx) throw new Error('useDemoState must be used inside <DemoProvider> (demo routes only)');
  return ctx;
}
