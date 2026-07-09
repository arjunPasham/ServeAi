'use client';

// Lightweight step-driver for the demo tutorial: spotlight the target element
// (identified by its data-demo-tour attribute), show a tooltip, offer
// "Got it" / "Skip tour". Each flow phase mounts its own CoachMark, so the
// tour advances naturally as the visitor moves through the scripted path.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDemoState } from '@/lib/demo/demo-state';

interface CoachMarkProps {
  /** Unique id persisted once dismissed (sessionStorage). */
  id: string;
  /** Matches an element's data-demo-tour attribute. */
  targetId: string;
  title: string;
  body: string;
  step: number;
  totalSteps: number;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function CoachMark({ id, targetId, title, body, step, totalSteps }: CoachMarkProps) {
  const { isMarkDismissed, dismissMark, skipTour } = useDemoState();
  const [rect, setRect] = useState<Rect | null>(null);
  const dismissed = isMarkDismissed(id);

  useEffect(() => {
    if (dismissed) return;

    let raf = 0;
    const measure = () => {
      const el = document.querySelector<HTMLElement>(`[data-demo-tour="${targetId}"]`);
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setRect(prev =>
        prev &&
        prev.top === r.top &&
        prev.left === r.left &&
        prev.width === r.width &&
        prev.height === r.height
          ? prev
          : { top: r.top, left: r.left, width: r.width, height: r.height }
      );
    };

    // Poll: targets mount/move as the flow progresses (cheap at 250ms).
    measure();
    const interval = setInterval(() => {
      raf = requestAnimationFrame(measure);
    }, 250);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      clearInterval(interval);
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [dismissed, targetId]);

  if (dismissed || !rect) return null;

  const pad = 8;
  const tooltipBelow = rect.top + rect.height + 190 < window.innerHeight;

  return createPortal(
    // pointer-events-none on the wrapper so the spotlighted target (and the
    // rest of the page) stays clickable; only the tooltip captures clicks.
    <div className="fixed inset-0 z-50 pointer-events-none" role="dialog" aria-label={title}>
      {/* Dim everything except the spotlighted target */}
      <div
        className="absolute rounded-2xl transition-all duration-300"
        style={{
          top: rect.top - pad,
          left: rect.left - pad,
          width: rect.width + pad * 2,
          height: rect.height + pad * 2,
          boxShadow: '0 0 0 9999px rgba(20, 12, 5, 0.55)',
          border: '2px solid var(--color-accent)',
        }}
      />
      <div
        className="absolute w-[min(22rem,calc(100vw-2rem))] bg-card border border-border rounded-2xl shadow-xl p-4 transition-all duration-300 pointer-events-auto"
        style={{
          top: tooltipBelow ? rect.top + rect.height + pad + 12 : undefined,
          bottom: tooltipBelow ? undefined : window.innerHeight - rect.top + pad + 12,
          left: Math.max(16, Math.min(rect.left, window.innerWidth - 372)),
        }}
      >
        <div className="text-[11px] font-semibold text-accent uppercase tracking-wide mb-1">
          Tour · step {step} of {totalSteps}
        </div>
        <h3 className="font-semibold text-foreground text-sm mb-1">{title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed mb-3">{body}</p>
        <div className="flex items-center justify-between">
          <button
            onClick={skipTour}
            className="text-xs text-muted-foreground hover:text-foreground font-medium transition-colors"
          >
            Skip tour
          </button>
          <button
            onClick={() => dismissMark(id)}
            className="bg-accent hover:bg-accent-hover text-accent-foreground text-xs font-semibold px-4 py-2 rounded-full transition-colors"
          >
            Got it →
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
