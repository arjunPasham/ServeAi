'use client';

import { centsToDisplay } from '@/lib/pricing';

interface ListingCardProps {
  id: string;
  detectedItem: string;
  estimatedQuantityLbs: number;
  consumerPriceCents: number;
  temperatureSensitive: boolean;
  imageUrl: string | null;
  donorType: 'commercial' | 'residential';
  safetyExpiresAt: string | null;
  onClaim?: (listingId: string) => void;
  claiming?: boolean;
}

export function ListingCard({
  id,
  detectedItem,
  estimatedQuantityLbs,
  consumerPriceCents,
  temperatureSensitive,
  imageUrl,
  donorType,
  safetyExpiresAt,
  onClaim,
  claiming,
}: ListingCardProps) {
  const originLabel = donorType === 'commercial' ? 'Restaurant' : 'Household';

  const minutesRemaining = safetyExpiresAt
    ? Math.max(0, Math.round((new Date(safetyExpiresAt).getTime() - Date.now()) / 60000))
    : null;

  const urgentExpiry = minutesRemaining !== null && minutesRemaining < 60;

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">
      {imageUrl && (
        <div className="h-40 bg-gray-100 overflow-hidden">
          <img
            src={imageUrl}
            alt={detectedItem}
            className="w-full h-full object-cover"
          />
        </div>
      )}
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-semibold text-gray-900 text-sm leading-tight">{detectedItem}</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {estimatedQuantityLbs} lbs · {originLabel}
            </p>
          </div>
          <span className="text-lg font-bold text-green-600 shrink-0">
            {centsToDisplay(consumerPriceCents)}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {temperatureSensitive && (
            <span className="inline-flex items-center gap-1 text-xs font-medium bg-orange-50 text-orange-700 border border-orange-200 rounded-full px-2 py-0.5">
              Temp sensitive
            </span>
          )}
          {urgentExpiry && minutesRemaining !== null && (
            <span className="inline-flex items-center gap-1 text-xs font-medium bg-red-50 text-red-700 border border-red-200 rounded-full px-2 py-0.5">
              {minutesRemaining}m left
            </span>
          )}
        </div>

        {onClaim && (
          <button
            onClick={() => onClaim(id)}
            disabled={claiming}
            className="w-full min-h-[44px] bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-full py-2.5 text-sm transition-colors"
          >
            {claiming ? 'Claiming…' : `Buy now · ${centsToDisplay(consumerPriceCents)}`}
          </button>
        )}
      </div>
    </div>
  );
}
