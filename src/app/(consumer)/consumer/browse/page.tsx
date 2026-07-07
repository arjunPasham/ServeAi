'use client';

import { useEffect, useState, useTransition } from 'react';
import { getLiveListingsWithSignedUrls } from '@/actions/listing';
import { claimListing } from '@/actions/payment';
import { ListingCard } from '@/components/listing/ListingCard';

type LiveListing = Awaited<ReturnType<typeof getLiveListingsWithSignedUrls>>[number];

export default function BrowsePage() {
  const [listings, setListings] = useState<LiveListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    getLiveListingsWithSignedUrls().then(data => {
      setListings(data);
      setLoading(false);
    });
  }, []);

  async function handleClaim(listingId: string) {
    setClaimingId(listingId);
    setError(null);

    startTransition(async () => {
      const result = await claimListing(listingId);

      if (!result.success) {
        setError(
          result.error === 'LISTING_UNAVAILABLE'
            ? 'Sorry, this listing was just claimed by someone else.'
            : 'Something went wrong. Please try again.'
        );
        setClaimingId(null);
        return;
      }

      if (result.checkout && result.clientSecret) {
        // Real Stripe mode: collect card details before dispatch happens
        sessionStorage.setItem(`checkout:${result.orderId}`, result.clientSecret);
        window.location.href = `/consumer/checkout/${result.orderId}`;
      } else {
        // Dev mode: payment simulated, dispatch already underway
        window.location.href = `/consumer/orders/${result.orderId}`;
      }
    });
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-10">
        <h1 className="text-lg font-bold text-gray-900">Browse food near you</h1>
        <p className="text-sm text-gray-500">Surplus food, deeply discounted</p>
      </header>

      <main className="p-4 max-w-lg mx-auto space-y-3">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="bg-white border border-gray-200 rounded-2xl h-52 animate-pulse" />
            ))}
          </div>
        ) : listings.length === 0 ? (
          <div className="text-center py-20 space-y-2">
            <p className="text-gray-500 font-medium">No listings available right now</p>
            <p className="text-sm text-gray-400">Check back soon — donors post daily</p>
          </div>
        ) : (
          listings.map(listing => (
            <ListingCard
              key={listing.id}
              id={listing.id}
              detectedItem={listing.detected_item}
              estimatedQuantityLbs={Number(listing.estimated_quantity_lbs)}
              consumerPriceCents={listing.consumer_price_cents}
              temperatureSensitive={listing.temperature_sensitive}
              imageUrl={listing.signedImageUrl}
              donorType={(listing.donor_type ?? 'commercial') as 'commercial' | 'residential'}
              safetyExpiresAt={listing.safety_expires_at}
              onClaim={handleClaim}
              claiming={claimingId === listing.id}
            />
          ))
        )}
      </main>
    </div>
  );
}
