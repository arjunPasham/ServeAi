// Internal staff console (v3 Task 2). Unlisted route — linked from nowhere, and
// noindex'd below. Gated by requireInternalStaff (authenticated + admin + email
// allowlist); a denial 404s rather than redirecting to /login, so a non-staff
// visitor can't even confirm the route exists. Every internal server action
// re-checks the gate itself (assertInternalStaff) — this layout gate is the
// page layer, not the only one.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireInternalStaff } from '@/lib/internal-authz';

// Keep the internal surface out of every crawler index (defense-in-depth on top
// of the real auth gate — never the control).
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default async function InternalLayout({ children }: { children: React.ReactNode }) {
  const staff = await requireInternalStaff();
  if (!staff.ok) notFound();

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="bg-amber-500 text-black text-xs font-semibold text-center py-1">
        INTERNAL · staff only · {staff.email}
      </div>
      {children}
    </div>
  );
}
