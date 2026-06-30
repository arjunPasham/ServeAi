'use client';

import { use, useEffect, useState, useTransition } from 'react';
import { getDispatchOffer, acceptDispatch, declineDispatch } from '@/actions/dispatch';
import { DispatchCard } from '@/components/dispatch/DispatchCard';
import { useRouter } from 'next/navigation';

type DispatchOffer = Awaited<ReturnType<typeof getDispatchOffer>>;

export default function DispatchOfferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: orderId } = use(params);
  const router = useRouter();
  const [offer, setOffer] = useState<DispatchOffer | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [, startTransition] = useTransition();

  useEffect(() => {
    getDispatchOffer(orderId).then(data => {
      setOffer(data);
      setLoading(false);
    });
  }, [orderId]);

  async function handleAccept(orderId: string, dispatchEventId: string) {
    setAccepting(true);
    startTransition(async () => {
      const result = await acceptDispatch(orderId, dispatchEventId);
      if (result.success) {
        router.push('/courier/dashboard');
      } else {
        setAccepting(false);
        router.push('/courier/dashboard');
      }
    });
  }

  async function handleDecline(dispatchEventId: string) {
    startTransition(async () => {
      await declineDispatch(dispatchEventId);
      router.push('/courier/dashboard');
    });
  }

  const order = offer?.order;
  const dispatchEvent = offer?.dispatchEvent;
  const listing = order?.listings as unknown as {
    detected_item: string;
    estimated_quantity_lbs: number;
    courier_fee_cents: number;
    temperature_sensitive: boolean;
    handling_notes: string | null;
    image_url: string | null;
    donor_profiles: { type: string; address_lat: number; address_lng: number };
  } | null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-10">
        <h1 className="text-lg font-bold text-gray-900">New delivery offer</h1>
      </header>

      <main className="p-4 max-w-lg mx-auto">
        {loading ? (
          <div className="bg-white border border-gray-200 rounded-2xl h-64 animate-pulse" />
        ) : !offer || !listing || !dispatchEvent || !order ? (
          <div className="text-center py-20">
            <p className="text-gray-500">This offer is no longer available</p>
            <button
              onClick={() => router.push('/courier/dashboard')}
              className="mt-4 text-green-600 font-semibold text-sm"
            >
              Back to dashboard
            </button>
          </div>
        ) : (
          <DispatchCard
            orderId={orderId}
            dispatchEventId={dispatchEvent.id}
            detectedItem={listing.detected_item}
            estimatedQuantityLbs={Number(listing.estimated_quantity_lbs)}
            courierFeeCents={listing.courier_fee_cents}
            temperatureSensitive={listing.temperature_sensitive}
            handlingNotes={listing.handling_notes}
            donorType={(listing.donor_profiles?.type ?? 'commercial') as 'commercial' | 'residential'}
            offeredAt={dispatchEvent.offered_at}
            onAccept={handleAccept}
            onDecline={handleDecline}
            accepting={accepting}
          />
        )}
      </main>
    </div>
  );
}
