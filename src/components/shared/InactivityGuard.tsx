'use client';

import { useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

const INACTIVITY_MS = 60 * 60 * 1000; // 60 minutes — TRD §2.16 SH-8

export function InactivityGuard() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();

  useEffect(() => {
    const reset = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        const supabase = createClient();
        await supabase.auth.signOut();
        router.push('/login?reason=inactivity');
      }, INACTIVITY_MS);
    };

    const events = ['mousemove', 'keydown', 'pointerdown', 'touchstart', 'scroll'] as const;
    events.forEach(e => window.addEventListener(e, reset, { passive: true }));
    reset();

    return () => {
      if (timer.current) clearTimeout(timer.current);
      events.forEach(e => window.removeEventListener(e, reset));
    };
  }, [router]);

  return null;
}
