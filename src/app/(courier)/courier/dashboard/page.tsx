'use client';

import { useEffect, useState, useTransition } from 'react';
import { getCourierActiveOrder, getCourierStatus, getPendingOffers, setCourierAvailability, updateCourierLocation, confirmDelivery } from '@/actions/dispatch';
import { DeliveryConfirm } from '@/components/dispatch/DeliveryConfirm';
import Link from 'next/link';

type ActiveOrder = Awaited<ReturnType<typeof getCourierActiveOrder>>;
type PendingOffer = Awaited<ReturnType<typeof getPendingOffers>>[number];

export default function CourierDashboardPage() {
  const [activeOrder, setActiveOrder] = useState<ActiveOrder | undefined>(undefined);
  const [offers, setOffers] = useState<PendingOffer[]>([]);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [, startTransition] = useTransition();

  useEffect(() => {
    async function refresh() {
      const [order, pending] = await Promise.all([
        getCourierActiveOrder(),
        getPendingOffers(),
      ]);
      setActiveOrder(order ?? undefined);
      setOffers(pending);
      setLoading(false);
    }
    refresh();

    // Poll for new dispatch offers / order changes (push is console-only in dev)
    const interval = setInterval(refresh, 10000);

    // Reflect the courier's real availability (persisted server-side), and
    // request geolocation. In dev mode (synthetic donor coords), fall back to
    // a default location when GPS is denied so dispatch still finds couriers.
    let watchId: number | undefined;
    getCourierStatus().then(status => {
      if (status) setAvailable(status.isAvailable);
      const devFallback = status?.devLocationFallback ?? false;

      if (navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition(
          pos => {
            updateCourierLocation(pos.coords.latitude, pos.coords.longitude);
          },
          () => {
            if (devFallback) updateCourierLocation(42.3314, -83.0458);
          }
        );
      } else if (devFallback) {
        updateCourierLocation(42.3314, -83.0458);
      }
    });

    return () => {
      clearInterval(interval);
      if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
    };
  }, []);

  function toggleAvailability() {
    const next = !available;
    setAvailable(next);
    startTransition(async () => {
      await setCourierAvailability(next);
    });
  }

  async function handleConfirmDelivery(orderId: string) {
    await confirmDelivery(orderId);
    setActiveOrder(undefined);
  }

  const listing = activeOrder?.listings as unknown as {
    detected_item: string;
    estimated_quantity_lbs: number;
    image_url: string | null;
    handling_notes: string | null;
    donor_profiles: { address: string; type: string };
  } | null;

  const consumerProfile = (activeOrder as Record<string, unknown> | null)?.consumer_profiles as {
    delivery_address: string;
  } | null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-10">
        <h1 className="text-lg font-bold text-gray-900">Courier dashboard</h1>
      </header>

      <main className="p-4 max-w-lg mx-auto space-y-4">
        {/* Availability toggle */}
        <div className="bg-white border border-gray-200 rounded-2xl px-4 py-4 flex items-center justify-between">
          <div>
            <p className="font-semibold text-sm text-gray-900">
              {available ? 'You are online' : 'You are offline'}
            </p>
            <p className="text-xs text-gray-500">
              {available ? 'Ready to receive dispatch offers' : 'Toggle to go online'}
            </p>
          </div>
          <button
            onClick={toggleAvailability}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
              available ? 'bg-green-600' : 'bg-gray-300'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                available ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {/* Incoming dispatch offers */}
        {!activeOrder && offers.length > 0 && (
          <div className="space-y-2">
            {offers.map(offer => (
              <Link
                key={offer.id}
                href={`/courier/dispatch/${offer.order_id}`}
                className="block bg-green-50 border border-green-300 rounded-2xl px-4 py-4 hover:border-green-500 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-sm text-green-900">New delivery offer 🚲</p>
                    <p className="text-xs text-green-700">Tap to view pickup details and accept</p>
                  </div>
                  <span className="text-green-700 text-lg">→</span>
                </div>
              </Link>
            ))}
          </div>
        )}

        {/* Active delivery */}
        {loading ? (
          <div className="bg-white border border-gray-200 rounded-2xl h-48 animate-pulse" />
        ) : activeOrder && listing ? (
          <DeliveryConfirm
            orderId={activeOrder.id}
            detectedItem={listing.detected_item}
            pickupAddress={listing.donor_profiles?.address ?? 'Pickup address loading…'}
            deliveryAddress={consumerProfile?.delivery_address ?? 'Drop-off loading…'}
            onConfirm={handleConfirmDelivery}
          />
        ) : (
          <div className="text-center py-16 space-y-2">
            <p className="text-gray-500 font-medium">No active deliveries</p>
            <p className="text-sm text-gray-400">
              {available ? 'Waiting for dispatch offers…' : 'Go online to receive offers'}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
