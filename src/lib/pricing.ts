// Pure pricing functions — no DB, safe to import in client and server components.
// Decision log: recovery_rate=40% (decision #7), platform_fee=10%/$0.99 floor (decision #6),
// courier_fee=$2.99 placeholder (decision #4 pending — pass as param when finalized).

export const DONOR_RECOVERY_RATE = 0.40;
export const PLATFORM_FEE_RATE = 0.10;
export const PLATFORM_FEE_FLOOR_CENTS = 99;    // $0.99
export const COURIER_FEE_CENTS = 299;           // $2.99 placeholder — decision #4 pending
export const USDA_STALE_DAYS = 60;
export const MAX_CONSUMER_TO_RETAIL_RATIO = 0.70; // consumer price must be ≤ 70% of USDA retail
export const SLIDER_BAND = 0.25;                  // ±25% around suggested payout

// Threshold at which platform fee rate kicks in over the floor
// Derived from constants so it stays correct if either constant changes
const PLATFORM_FEE_CROSSOVER = Math.floor(PLATFORM_FEE_FLOOR_CENTS / PLATFORM_FEE_RATE);

export interface PricingInput {
  pricePerLb: number;
  retailBenchmarkPerLb: number;
  quantityLbs: number;
  updatedAt: string;
}

export interface PricingResult {
  baseCommodityPriceCents: number;
  suggestedDonorPayoutCents: number;
  sliderMinCents: number;
  sliderMaxCents: number;           // always >= sliderMinCents
  donorPayoutCents: number;
  platformFeeCents: number;
  courierFeeCents: number;
  consumerPriceCents: number;
  retailBenchmarkCents: number;
  discountFloorViolated: boolean;
  staleData: boolean;
}

export function centsToDisplay(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function computePlatformFee(donorPayoutCents: number): number {
  return Math.max(Math.round(donorPayoutCents * PLATFORM_FEE_RATE), PLATFORM_FEE_FLOOR_CENTS);
}

export function computeConsumerPrice(donorPayoutCents: number): number {
  return donorPayoutCents + computePlatformFee(donorPayoutCents) + COURIER_FEE_CENTS;
}

// Returns the max donor_payout_cents that keeps consumer_price ≤ 70% of retail benchmark.
// Uses Math.floor throughout to stay strictly within the budget.
export function computePayoutCap(retailBenchmarkPerLb: number, quantityLbs: number): number {
  const maxConsumerCents = Math.floor(
    retailBenchmarkPerLb * quantityLbs * 100 * MAX_CONSUMER_TO_RETAIL_RATIO
  );
  if (maxConsumerCents < COURIER_FEE_CENTS + PLATFORM_FEE_FLOOR_CENTS) {
    // Retail price is so low that even a $0 payout would violate the cap via fixed fees.
    // Return -1 to signal infeasibility; computePricing will set discountFloorViolated.
    return -1;
  }
  // When fee rate applies (payout > crossover):
  //   consumer = payout * (1 + rate) + courier ≤ max
  //   payout ≤ (max - courier) / (1 + rate)
  const rateCap = Math.floor((maxConsumerCents - COURIER_FEE_CENTS) / (1 + PLATFORM_FEE_RATE));
  if (rateCap > PLATFORM_FEE_CROSSOVER) return rateCap;
  // When floor applies (payout ≤ crossover):
  //   consumer = payout + floor + courier ≤ max
  //   payout ≤ max - floor - courier
  return maxConsumerCents - COURIER_FEE_CENTS - PLATFORM_FEE_FLOOR_CENTS;
}

export function isUsdaStale(updatedAt: string): boolean {
  const daysSince = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince > USDA_STALE_DAYS;
}

export function computePricing(input: PricingInput, donorPayoutCents?: number): PricingResult {
  const { pricePerLb, retailBenchmarkPerLb, quantityLbs, updatedAt } = input;

  const baseCommodityPriceCents = Math.round(pricePerLb * quantityLbs * 100);
  const suggestedDonorPayoutCents = Math.round(baseCommodityPriceCents * DONOR_RECOVERY_RATE);
  // Use raw product to stay consistent with computePayoutCap (avoids 1-cent divergence)
  const retailBenchmarkCents = Math.floor(retailBenchmarkPerLb * quantityLbs * 100);

  const sliderMinCents = Math.round(suggestedDonorPayoutCents * (1 - SLIDER_BAND));
  const payoutCap = computePayoutCap(retailBenchmarkPerLb, quantityLbs);

  // Violation: cap is infeasible or suggested price itself exceeds 70% of retail
  const suggestedConsumerPrice = computeConsumerPrice(suggestedDonorPayoutCents);
  const maxAllowedConsumerCents = Math.floor(retailBenchmarkCents * MAX_CONSUMER_TO_RETAIL_RATIO);
  const discountFloorViolated = payoutCap < 0 || suggestedConsumerPrice > maxAllowedConsumerCents;

  const staleData = isUsdaStale(updatedAt);

  // sliderMax = min(suggested * 1.25, payoutCap), but always >= sliderMin so the range is valid
  const uncappedMax = Math.round(suggestedDonorPayoutCents * (1 + SLIDER_BAND));
  const sliderMaxCents = Math.max(
    sliderMinCents,
    payoutCap >= 0 ? Math.min(uncappedMax, payoutCap) : sliderMinCents
  );

  const resolved = donorPayoutCents ?? suggestedDonorPayoutCents;
  const clamped = Math.min(Math.max(resolved, sliderMinCents), sliderMaxCents);

  const platformFeeCents = computePlatformFee(clamped);
  const consumerPriceCents = computeConsumerPrice(clamped);

  return {
    baseCommodityPriceCents,
    suggestedDonorPayoutCents,
    sliderMinCents,
    sliderMaxCents,
    donorPayoutCents: clamped,
    platformFeeCents,
    courierFeeCents: COURIER_FEE_CENTS,
    consumerPriceCents,
    retailBenchmarkCents,
    discountFloorViolated,
    staleData,
  };
}
