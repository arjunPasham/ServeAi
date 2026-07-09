import type { ReactNode } from 'react';
import { DemoProvider } from '@/lib/demo/demo-state';
import { DemoBanner } from './DemoBanner';

// Isolated demo shell: everything under /demo runs on fixture data with
// client-side state only. No auth, no Supabase writes, no Stripe, no Inngest.
export default function DemoLayout({ children }: { children: ReactNode }) {
  return (
    <DemoProvider>
      <div className="min-h-screen flex flex-col">
        <DemoBanner />
        <div className="flex-1">{children}</div>
      </div>
    </DemoProvider>
  );
}
