// Merchant dashboard (Phase 1 pivot): declared loads + the scan CTA.
// Matching/routing status arrives in Phases 2–3; for now a load is "declared"
// and ops takes it from there.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getMerchantDashboard } from '@/actions/manifest';
import { LocalDateTime } from '@/components/LocalDateTime';

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  declared:  { label: 'Declared',   color: 'bg-blue-100 text-blue-700' },
  matched:   { label: 'Matched',    color: 'bg-purple-100 text-purple-700' },
  scheduled: { label: 'Scheduled',  color: 'bg-purple-100 text-purple-700' },
  picked_up: { label: 'Picked up',  color: 'bg-amber-100 text-amber-700' },
  delivered: { label: 'Delivered',  color: 'bg-green-100 text-green-800' },
  closed:    { label: 'Closed',     color: 'bg-gray-100 text-gray-600' },
  canceled:  { label: 'Canceled',   color: 'bg-gray-100 text-gray-500' },
};

export default async function MerchantDashboardPage() {
  const dashboard = await getMerchantDashboard();
  if (!dashboard.ok) {
    // 'not_a_merchant' goes to a stable dead end, not /login — redirecting
    // there for an already-authenticated donor just bounces straight back to
    // this page (the redirect-loop debt fix; see getMerchantDashboard).
    redirect(dashboard.authz === 'not_a_merchant' ? '/merchant/no-account' : '/login');
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-10">
        <div className="flex items-center justify-between max-w-lg mx-auto">
          <div>
            <h1 className="text-lg font-bold text-gray-900">{dashboard.businessName}</h1>
            <p className="text-sm text-gray-500">{dashboard.loads.length} recent loads</p>
          </div>
          <Link
            href="/merchant/scan"
            className="min-h-[44px] flex items-center bg-green-600 hover:bg-green-700 text-white font-semibold rounded-full px-5 text-sm transition-colors"
          >
            + Scan surplus
          </Link>
        </div>
      </header>

      <main className="p-4 max-w-lg mx-auto space-y-3">
        {dashboard.loads.length === 0 ? (
          <div className="text-center py-20 space-y-4">
            <p className="text-gray-500 font-medium">No loads declared yet</p>
            <p className="text-sm text-gray-400">Scan tonight&apos;s surplus — it takes about four minutes.</p>
            <Link
              href="/merchant/scan"
              className="inline-flex min-h-[44px] items-center bg-green-600 hover:bg-green-700 text-white font-semibold rounded-full px-6 py-3 text-sm transition-colors"
            >
              Scan your first load
            </Link>
          </div>
        ) : (
          dashboard.loads.map(load => {
            const status = STATUS_LABEL[load.status] ?? { label: load.status, color: 'bg-gray-100 text-gray-600' };
            const totalLbs = load.load_items.reduce((sum, li) => sum + Number(li.est_lbs), 0);
            const totalFmv = load.load_items.reduce(
              (sum, li) => sum + Math.round(li.fmv_per_lb_cents * Number(li.est_lbs)), 0);
            return (
              <div key={load.id} className="bg-white border border-gray-200 rounded-2xl p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold text-gray-900 text-sm">
                      {load.load_items.length} item{load.load_items.length === 1 ? '' : 's'} · {totalLbs.toFixed(1)} lbs
                    </h3>
                    <p className="text-xs text-gray-500 mt-0.5">Window: {load.window_date}</p>
                  </div>
                  <div className="text-right space-y-1">
                    <span className={`text-xs font-medium rounded-full px-2 py-0.5 ${status.color}`}>{status.label}</span>
                    <div className="text-sm font-semibold text-gray-900">{centsToDollars(totalFmv)} FMV</div>
                  </div>
                </div>
                {load.earliest_safety_expires_at && (
                  <p className="text-xs text-amber-700">
                    Earliest safety expiry: <LocalDateTime iso={load.earliest_safety_expires_at} />
                  </p>
                )}
              </div>
            );
          })
        )}
      </main>
    </div>
  );
}
