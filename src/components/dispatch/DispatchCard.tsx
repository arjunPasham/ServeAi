'use client';

import { centsToDisplay } from '@/lib/pricing';

interface DispatchCardProps {
  orderId: string;
  dispatchEventId: string;
  detectedItem: string;
  estimatedQuantityLbs: number;
  courierFeeCents: number;
  temperatureSensitive: boolean;
  handlingNotes: string | null;
  donorType: 'commercial' | 'residential';
  offeredAt: string;
  onAccept: (orderId: string, dispatchEventId: string) => void;
  onDecline: (dispatchEventId: string) => void;
  accepting?: boolean;
}

export function DispatchCard({
  orderId,
  dispatchEventId,
  detectedItem,
  estimatedQuantityLbs,
  courierFeeCents,
  temperatureSensitive,
  handlingNotes,
  donorType,
  offeredAt,
  onAccept,
  onDecline,
  accepting,
}: DispatchCardProps) {
  const originLabel = donorType === 'commercial' ? 'Restaurant' : 'Household';
  const minutesSinceOffer = Math.round((Date.now() - new Date(offeredAt).getTime()) / 60000);
  const minutesLeft = Math.max(0, 5 - minutesSinceOffer);

  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5 space-y-4 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-gray-900">{detectedItem}</h3>
          <p className="text-sm text-gray-500">{estimatedQuantityLbs} lbs · {originLabel}</p>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold text-green-600">{centsToDisplay(courierFeeCents)}</div>
          <div className="text-xs text-gray-400">your earnings</div>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {temperatureSensitive && (
          <span className="text-xs font-medium bg-orange-50 text-orange-700 border border-orange-200 rounded-full px-2 py-0.5">
            Keep insulated
          </span>
        )}
        <span className="text-xs font-medium bg-yellow-50 text-yellow-700 border border-yellow-200 rounded-full px-2 py-0.5">
          {minutesLeft}m to respond
        </span>
      </div>

      {handlingNotes && (
        <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-3 py-2">
          Note: {handlingNotes}
        </p>
      )}

      <div className="flex gap-3">
        <button
          onClick={() => onDecline(dispatchEventId)}
          disabled={accepting}
          className="flex-1 min-h-[44px] border border-gray-300 text-gray-700 hover:bg-gray-50 font-semibold rounded-full py-2.5 text-sm transition-colors disabled:opacity-50"
        >
          Decline
        </button>
        <button
          onClick={() => onAccept(orderId, dispatchEventId)}
          disabled={accepting}
          className="flex-2 min-h-[44px] bg-green-600 hover:bg-green-700 text-white font-semibold rounded-full py-2.5 px-6 text-sm transition-colors disabled:opacity-50"
        >
          {accepting ? 'Accepting…' : `Accept · ${centsToDisplay(courierFeeCents)}`}
        </button>
      </div>
    </div>
  );
}
