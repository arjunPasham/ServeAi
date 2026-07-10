'use client';

import { useEffect, useState, useTransition } from 'react';
import { getLiveListingsWithSignedUrls } from '@/actions/listing';
import { claimListing, getDeliveryQuote, type FulfillmentMethod } from '@/actions/payment';
import { ListingCard } from '@/components/listing/ListingCard';
import { centsToDisplay, COURIER_FEE_CENTS } from '@/lib/pricing';
import { Footprints, Truck, X } from 'lucide-react';

type LiveListing = Awaited<ReturnType<typeof getLiveListingsWithSignedUrls>>[number];

type QuoteState =
  | { state: 'loading' }
  // previousFeeCents is set when a claim was refused because the live quote
  // moved — the chooser shows the delta and asks for another tap to confirm.
  | { state: 'ready'; feeCents: number; etaMinutes: number; previousFeeCents?: number }
  | { state: 'unavailable' };

export default function BrowsePage() {
  const [listings, setListings] = useState<LiveListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chooser, setChooser] = useState<LiveListing | null>(null);
  const [quote, setQuote] = useState<QuoteState>({ state: 'loading' });
  const [, startTransition] = useTransition();

  useEffect(() => {
    getLiveListingsWithSignedUrls().then(data => {
      setListings(data);
      setLoading(false);
    });
  }, []);

  // Buy now → choose pickup (free) or delivery (live quote, expires in ~15 min
  // so it is fetched when the chooser opens — never at listing time).
  function openChooser(listingId: string) {
    const listing = listings.find(l => l.id === listingId);
    if (!listing) return;
    setError(null);
    setChooser(listing);
    setQuote({ state: 'loading' });
    getDeliveryQuote(listingId).then(result => {
      setQuote(
        result.success
          ? { state: 'ready', feeCents: result.feeCents, etaMinutes: result.etaMinutes }
          : { state: 'unavailable' }
      );
    });
  }

  function handleClaim(listingId: string, fulfillment: FulfillmentMethod) {
    const listing = chooser;
    const displayedFeeCents =
      fulfillment === 'delivery' && quote.state === 'ready' ? quote.feeCents : undefined;
    setClaimingId(listingId);
    setChooser(null);
    setError(null);

    startTransition(async () => {
      const result = await claimListing(listingId, fulfillment, displayedFeeCents);

      if (!result.success) {
        if (result.error === 'FEE_CHANGED' && result.newFeeCents != null) {
          // The live quote moved between display and claim — never charge a
          // price the consumer hasn't seen. Reopen the chooser with the fresh
          // fee and the delta; the next tap confirms at the new price.
          setChooser(listing);
          setQuote({
            state: 'ready',
            feeCents: result.newFeeCents,
            etaMinutes: result.etaMinutes ?? 0,
            previousFeeCents: displayedFeeCents,
          });
          setClaimingId(null);
          return;
        }
        setError(
          result.error === 'LISTING_UNAVAILABLE'
            ? 'Sorry, this listing was just claimed by someone else.'
            : result.error === 'DELIVERY_UNAVAILABLE'
              ? 'Delivery is not available for this address — you can still choose pickup.'
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
        // Dev mode: payment simulated, fulfillment already underway
        window.location.href = `/consumer/orders/${result.orderId}`;
      }
    });
  }

  // Listing prices historically include the legacy flat courier fee — the
  // fulfillment chooser shows the real totals per method instead.
  const baseCents = chooser ? chooser.consumer_price_cents - COURIER_FEE_CENTS : 0;

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
              onClaim={openChooser}
              claiming={claimingId === listing.id}
            />
          ))
        )}
      </main>

      {/* Fulfillment chooser */}
      {chooser && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-gray-900 text-sm">{chooser.detected_item}</h2>
                <p className="text-xs text-gray-500 mt-0.5">How do you want to get it?</p>
              </div>
              <button
                onClick={() => setChooser(null)}
                aria-label="Close"
                className="text-gray-400 hover:text-gray-600 p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <button
              onClick={() => handleClaim(chooser.id, 'pickup')}
              className="w-full text-left border border-gray-200 hover:border-green-600 rounded-xl p-4 flex items-center gap-3 transition-colors"
            >
              <Footprints className="w-5 h-5 text-green-600 shrink-0" />
              <span className="flex-1">
                <span className="block font-semibold text-gray-900 text-sm">Self-pickup · free</span>
                <span className="block text-xs text-gray-500">
                  Pick it up at the donor — you&apos;ll get a handoff code
                </span>
              </span>
              <span className="font-bold text-green-600 text-sm">{centsToDisplay(baseCents)}</span>
            </button>

            <button
              onClick={() => handleClaim(chooser.id, 'delivery')}
              disabled={quote.state !== 'ready'}
              className="w-full text-left border border-gray-200 hover:border-green-600 rounded-xl p-4 flex items-center gap-3 transition-colors disabled:opacity-60"
            >
              <Truck className="w-5 h-5 text-green-600 shrink-0" />
              <span className="flex-1">
                <span className="block font-semibold text-gray-900 text-sm">
                  Delivery
                  {quote.state === 'ready' && ` · ${centsToDisplay(quote.feeCents)} fee`}
                </span>
                <span className="block text-xs text-gray-500">
                  {quote.state === 'loading' && 'Getting a live quote…'}
                  {quote.state === 'ready' && `Courier delivery, ~${quote.etaMinutes} min`}
                  {quote.state === 'unavailable' && 'Not available for your address'}
                </span>
              </span>
              {quote.state === 'ready' && (
                <span className="font-bold text-green-600 text-sm">
                  {centsToDisplay(baseCents + quote.feeCents)}
                </span>
              )}
            </button>

            {quote.state === 'ready' && quote.previousFeeCents != null && (
              <p className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-800">
                The delivery fee just changed from {centsToDisplay(quote.previousFeeCents)} to{' '}
                {centsToDisplay(quote.feeCents)}. Tap Delivery again to confirm the new price —
                nothing has been charged.
              </p>
            )}

            <p className="text-[11px] text-gray-400 text-center">
              Delivery quotes are live and expire after ~15 minutes.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
