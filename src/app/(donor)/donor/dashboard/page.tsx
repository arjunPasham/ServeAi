import { getDonorListings } from '@/actions/listing';
import { getDonorPendingPickups } from '@/actions/pickup';
import { centsToDisplay } from '@/lib/pricing';
import { SafetyWindowNotice } from '@/components/listing/SafetyWindowNotice';
import { PickupConfirmCard } from '@/components/pickup/PickupConfirmCard';
import Link from 'next/link';

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  draft:      { label: 'Draft',      color: 'bg-gray-100 text-gray-600' },
  live:       { label: 'Live',       color: 'bg-green-100 text-green-700' },
  purchased:  { label: 'Purchased',  color: 'bg-blue-100 text-blue-700' },
  dispatched: { label: 'Dispatched', color: 'bg-purple-100 text-purple-700' },
  delivered:  { label: 'Delivered',  color: 'bg-green-100 text-green-800' },
  hidden:     { label: 'Expired',    color: 'bg-red-100 text-red-600' },
  cancelled:  { label: 'Cancelled',  color: 'bg-gray-100 text-gray-500' },
  disputed:   { label: 'Disputed',   color: 'bg-orange-100 text-orange-700' },
};

export default async function DonorDashboardPage() {
  const [listings, pendingPickups] = await Promise.all([
    getDonorListings(),
    getDonorPendingPickups(),
  ]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-10">
        <div className="flex items-center justify-between max-w-lg mx-auto">
          <div>
            <h1 className="text-lg font-bold text-gray-900">My listings</h1>
            <p className="text-sm text-gray-500">{listings.length} total</p>
          </div>
          <Link
            href="/donor/listings/new"
            className="min-h-[44px] flex items-center bg-green-600 hover:bg-green-700 text-white font-semibold rounded-full px-5 text-sm transition-colors"
          >
            + Post food
          </Link>
        </div>
      </header>

      <main className="p-4 max-w-lg mx-auto space-y-3">
        {pendingPickups.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-700">Awaiting pickup</h2>
            {pendingPickups.map(pickup => (
              <PickupConfirmCard key={pickup.orderId} pickup={pickup} />
            ))}
          </section>
        )}

        {listings.length === 0 ? (
          <div className="text-center py-20 space-y-4">
            <p className="text-gray-500 font-medium">You haven&apos;t posted any food yet</p>
            <Link
              href="/donor/listings/new"
              className="inline-flex min-h-[44px] items-center bg-green-600 hover:bg-green-700 text-white font-semibold rounded-full px-6 py-3 text-sm transition-colors"
            >
              Post your first listing
            </Link>
          </div>
        ) : (
          listings.map(listing => {
            const statusInfo = STATUS_LABEL[listing.status] ?? { label: listing.status, color: 'bg-gray-100 text-gray-600' };

            return (
              <div key={listing.id} className="bg-white border border-gray-200 rounded-2xl p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold text-gray-900 text-sm">{listing.detected_item}</h3>
                    <p className="text-xs text-gray-500 mt-0.5">{listing.estimated_quantity_lbs} lbs</p>
                  </div>
                  <div className="text-right space-y-1">
                    <span className={`text-xs font-medium rounded-full px-2 py-0.5 ${statusInfo.color}`}>
                      {statusInfo.label}
                    </span>
                    <div className="text-sm font-semibold text-gray-900">
                      {centsToDisplay(listing.donor_payout_cents)}
                    </div>
                  </div>
                </div>

                {listing.safety_expires_at && listing.status === 'live' && (
                  <SafetyWindowNotice expiresAt={listing.safety_expires_at} />
                )}

                <div className="text-xs text-gray-400">
                  Posted {listing.published_at
                    ? new Date(listing.published_at).toLocaleDateString()
                    : 'Not yet published'}
                </div>
              </div>
            );
          })
        )}
      </main>
    </div>
  );
}
