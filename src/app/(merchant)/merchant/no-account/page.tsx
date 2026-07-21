// Stable landing for an authenticated, phone-verified donor-role user with no
// merchants row (tracked-debt fix — see getMerchantDashboard in
// src/actions/manifest.ts for the redirect-loop this replaces).
//
// getMerchantDashboard used to return null for BOTH "unauthenticated" and
// "authenticated but not a merchant", and the dashboard page did
// `if (!dashboard) redirect('/login')` for either. For the latter case,
// /login's own post-auth redirect sends an already-authenticated donor
// straight back to /merchant/dashboard — an infinite loop.
//
// This page is provably not part of any loop:
//  - It passes middleware (src/lib/supabase/middleware.ts): /merchant/* only
//    requires phone_verified + role==='donor', which this user already has —
//    no merchants row is required to reach it.
//  - It performs NO data read and calls redirect() NOWHERE in its render
//    path, so there is no code path here that could send the user anywhere
//    else, let alone back to /merchant/dashboard. It's a dead end by
//    construction, not by convention.
export default function MerchantNoAccountPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-sm text-center space-y-3">
        <h1 className="text-lg font-bold text-gray-900">No merchant profile linked</h1>
        <p className="text-sm text-gray-600">
          This account isn&apos;t linked to a merchant profile, so there&apos;s nothing to show here.
          If you believe this is a mistake, contact support.
        </p>
      </div>
    </div>
  );
}
