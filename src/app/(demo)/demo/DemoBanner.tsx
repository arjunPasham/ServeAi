'use client';

import Link from 'next/link';
import { FlaskConical, X } from 'lucide-react';

export function DemoBanner() {
  function exitDemo() {
    // Clear the middleware-bypass cookie, then leave with a full navigation so
    // no demo state survives.
    document.cookie = 'demo_mode=; path=/; max-age=0';
    window.location.assign('/');
  }

  return (
    <div className="sticky top-0 z-40 bg-amber-100 border-b border-amber-300 text-amber-900">
      <div className="max-w-5xl mx-auto px-4 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs sm:text-sm font-medium">
          <FlaskConical className="w-4 h-4 shrink-0" />
          <span>
            <strong>Demo mode</strong> — sample data only. Nothing is saved, charged, or delivered.
          </span>
        </div>
        <button
          onClick={exitDemo}
          className="flex items-center gap-1.5 text-xs font-semibold bg-amber-200 hover:bg-amber-300 rounded-full px-3 py-1.5 transition-colors shrink-0"
        >
          <X className="w-3.5 h-3.5" />
          Exit demo
        </button>
      </div>
      <DemoNav />
    </div>
  );
}

function DemoNav() {
  return (
    <div className="bg-card/80 border-b border-border">
      <div className="max-w-5xl mx-auto px-4 py-2 flex items-center gap-4 text-xs font-medium">
        <Link href="/demo" className="text-muted-foreground hover:text-foreground transition-colors">
          Choose role
        </Link>
        <Link href="/demo/donor" className="text-primary hover:text-primary-hover transition-colors">
          Donor flow
        </Link>
        <Link href="/demo/consumer" className="text-accent hover:text-accent-hover transition-colors">
          Consumer flow
        </Link>
      </div>
    </div>
  );
}
