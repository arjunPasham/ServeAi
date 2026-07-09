'use client';

import { useState, useMemo } from 'react';
import {
  computePricing,
  centsToDisplay,
  PricingInput,
  PricingResult,
} from '@/lib/pricing';
import { useNow } from '@/lib/useNow';

interface PricingSliderProps {
  initialPricing: PricingResult;
  pricingInput: PricingInput;
  temperatureSensitive: boolean;
  onConfirm: (params: {
    donorPayoutCents: number;
    consumerPriceCents: number;
    platformFeeCents: number;
    courierFeeCents: number;
    preparedAt: string | null;
  }) => void;
}

export function PricingSlider({
  initialPricing,
  pricingInput,
  temperatureSensitive,
  onConfirm,
}: PricingSliderProps) {
  const [donorPayout, setDonorPayout] = useState(initialPricing.suggestedDonorPayoutCents);
  const [preparedAt, setPreparedAt] = useState('');
  const now = useNow();

  // Reset the slider when the AI suggestion changes (e.g. donor changed quantity
  // or category) — adjust during render rather than in an effect.
  const [prevSuggested, setPrevSuggested] = useState(initialPricing.suggestedDonorPayoutCents);
  if (prevSuggested !== initialPricing.suggestedDonorPayoutCents) {
    setPrevSuggested(initialPricing.suggestedDonorPayoutCents);
    setDonorPayout(initialPricing.suggestedDonorPayoutCents);
  }

  // Recompute on every slider move — memoize stable parts
  const pricing = useMemo(
    () => computePricing(pricingInput, donorPayout),
    [pricingInput, donorPayout]
  );

  // Guard against live pricing violations (e.g., pricingInput drifted from initialPricing)
  if (pricing.staleData || pricing.discountFloorViolated) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-5">
        <p className="text-sm font-semibold text-red-800">
          {pricing.staleData ? 'Pricing data is outdated' : 'Discount requirement not met'}
        </p>
        <p className="text-sm text-red-700 mt-1">
          {pricing.staleData
            ? 'USDA commodity prices for this category are over 60 days old. An admin must refresh the table.'
            : 'This listing cannot be priced at least 30% below retail. Listing creation is blocked.'}
        </p>
      </div>
    );
  }

  const isAtDefault = donorPayout === initialPricing.suggestedDonorPayoutCents;
  const discountPct = Math.round(
    (1 - pricing.consumerPriceCents / pricing.retailBenchmarkCents) * 100
  );

  // prepared_at: browser datetime-local produces a local-time string with no TZ suffix.
  // We append the local UTC offset so the server parses it correctly regardless of TZ.
  function toIsoWithOffset(localDatetime: string): string {
    if (!localDatetime) return '';
    const date = new Date(localDatetime);
    const tzOffset = -date.getTimezoneOffset();
    const sign = tzOffset >= 0 ? '+' : '-';
    const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
    return `${localDatetime}:00${sign}${pad(Math.floor(Math.abs(tzOffset) / 60))}:${pad(Math.abs(tzOffset) % 60)}`;
  }

  // max for datetime-local in local wall-clock time (not UTC)
  const nowLocal = now
    ? new Date(now - new Date(now).getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : undefined;

  const canConfirm = !temperatureSensitive || preparedAt.trim() !== '';

  return (
    <div className="space-y-6">
      {/* Price breakdown card */}
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-5 space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-sm text-gray-500">Your payout</span>
          <span className="text-lg font-bold text-gray-900">
            {centsToDisplay(pricing.donorPayoutCents)}
          </span>
        </div>
        <div className="flex justify-between items-center text-sm text-gray-500">
          <span>Platform fee</span>
          <span>{centsToDisplay(pricing.platformFeeCents)}</span>
        </div>
        <div className="flex justify-between items-center text-sm text-gray-500">
          <span>Courier fee</span>
          <span>{centsToDisplay(pricing.courierFeeCents)}</span>
        </div>
        <div className="border-t border-gray-200 pt-3 flex justify-between items-center">
          <span className="text-sm font-medium text-gray-700">Consumer pays</span>
          <div className="text-right">
            <span className="text-lg font-bold text-green-600">
              {centsToDisplay(pricing.consumerPriceCents)}
            </span>
            <span className="text-xs text-green-600 ml-2 font-medium">
              {discountPct}% off retail
            </span>
          </div>
        </div>
      </div>

      {/* Slider */}
      <div>
        <div className="flex justify-between text-xs text-gray-400 mb-2">
          <span>{centsToDisplay(initialPricing.sliderMinCents)}</span>
          {isAtDefault && (
            <span className="text-green-600 font-semibold">AI suggestion ✓</span>
          )}
          <span>{centsToDisplay(initialPricing.sliderMaxCents)}</span>
        </div>
        <input
          type="range"
          min={initialPricing.sliderMinCents}
          max={initialPricing.sliderMaxCents}
          step={1}
          value={donorPayout}
          onChange={e => setDonorPayout(Number(e.target.value))}
          className="w-full h-2 rounded-full appearance-none bg-gray-200 accent-green-600 cursor-pointer"
          aria-label="Adjust your payout"
          aria-valuemin={initialPricing.sliderMinCents}
          aria-valuemax={initialPricing.sliderMaxCents}
          aria-valuenow={donorPayout}
          aria-valuetext={centsToDisplay(donorPayout)}
        />
        <p className="text-xs text-gray-400 mt-2 text-center">
          Drag to adjust your payout within ±25% of the AI suggestion
        </p>
      </div>

      {/* Temperature-sensitive: require prepared_at in local time with TZ offset */}
      {temperatureSensitive && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            When was this food prepared?{' '}
            <span className="text-red-500">*</span>
          </label>
          <input
            type="datetime-local"
            value={preparedAt}
            onChange={e => setPreparedAt(e.target.value)}
            max={nowLocal}
            className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
          />
          <p className="text-xs text-gray-400 mt-1">
            Required for temperature-sensitive items to compute the safety window.
          </p>
        </div>
      )}

      <button
        disabled={!canConfirm}
        onClick={() =>
          onConfirm({
            donorPayoutCents: pricing.donorPayoutCents,
            consumerPriceCents: pricing.consumerPriceCents,
            platformFeeCents: pricing.platformFeeCents,
            courierFeeCents: pricing.courierFeeCents,
            preparedAt: preparedAt ? toIsoWithOffset(preparedAt) : null,
          })
        }
        className="w-full min-h-[44px] bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-full py-3 text-sm transition-colors"
      >
        {isAtDefault
          ? `Accept AI suggestion · ${centsToDisplay(pricing.consumerPriceCents)} to consumer →`
          : `Confirm pricing · ${centsToDisplay(pricing.consumerPriceCents)} to consumer →`}
      </button>

      {!canConfirm && temperatureSensitive && (
        <p className="text-xs text-center text-red-500">
          Please enter the preparation time before posting.
        </p>
      )}
    </div>
  );
}
