'use client';

import { useState } from 'react';

interface DeliveryConfirmProps {
  orderId: string;
  detectedItem: string;
  pickupAddress: string;
  deliveryAddress: string;
  onConfirm: (orderId: string) => Promise<void>;
}

export function DeliveryConfirm({
  orderId,
  detectedItem,
  pickupAddress,
  deliveryAddress,
  onConfirm,
}: DeliveryConfirmProps) {
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  async function handleConfirm() {
    setConfirming(true);
    try {
      await onConfirm(orderId);
      setConfirmed(true);
    } finally {
      setConfirming(false);
    }
  }

  if (confirmed) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-2xl p-6 text-center space-y-2">
        <div className="text-3xl">✓</div>
        <h3 className="font-semibold text-green-800">Delivery confirmed!</h3>
        <p className="text-sm text-green-700">Your earnings will be transferred shortly.</p>
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5 space-y-4">
      <h3 className="font-semibold text-gray-900">Active delivery</h3>

      <div className="space-y-2 text-sm">
        <div className="flex gap-2">
          <span className="text-gray-400 w-16 shrink-0">Item</span>
          <span className="text-gray-900 font-medium">{detectedItem}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-gray-400 w-16 shrink-0">Pickup</span>
          <span className="text-gray-900">{pickupAddress}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-gray-400 w-16 shrink-0">Drop-off</span>
          <span className="text-gray-900">{deliveryAddress}</span>
        </div>
      </div>

      <button
        onClick={handleConfirm}
        disabled={confirming}
        className="w-full min-h-[44px] bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold rounded-full py-3 text-sm transition-colors"
      >
        {confirming ? 'Confirming…' : 'Confirm delivery'}
      </button>

      <p className="text-xs text-center text-gray-400">
        Only tap after you have handed off the food to the recipient.
      </p>
    </div>
  );
}
