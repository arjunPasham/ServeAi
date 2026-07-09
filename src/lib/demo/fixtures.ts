// Demo-mode fixtures — the ONLY fake layer in the simulate experience.
// Demo pages render the real presentational components (ListingCard,
// PricingSlider, DispatchCard…) with this data injected as props.
// Nothing in src/lib/demo or src/app/(demo) may touch Supabase, Stripe,
// Inngest, or any server action (enforced by no-restricted-imports).

import type { FoodScanResult } from '@/types/food';
import type { PricingInput } from '@/lib/pricing';

/** Self-contained food "photo": gradient SVG + emoji, no network fetch. */
function foodImage(emoji: string, from: string, to: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='640' height='400'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='${from}'/><stop offset='1' stop-color='${to}'/>` +
    `</linearGradient></defs>` +
    `<rect width='640' height='400' fill='url(#g)'/>` +
    `<text x='320' y='235' font-size='130' text-anchor='middle'>${emoji}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export interface DemoListing {
  id: string;
  detectedItem: string;
  estimatedQuantityLbs: number;
  consumerPriceCents: number;
  temperatureSensitive: boolean;
  imageUrl: string;
  donorType: 'commercial' | 'residential';
  /** Minutes from "now" until the safety window closes (materialized at render). */
  safetyExpiresInMinutes: number;
  donorName: string;
  distanceMiles: number;
}

export const DEMO_LISTINGS: DemoListing[] = [
  {
    id: 'demo-listing-1',
    detectedItem: 'Penne with roasted vegetables',
    estimatedQuantityLbs: 8,
    consumerPriceCents: 878,
    temperatureSensitive: true,
    imageUrl: foodImage('🍝', '#fde68a', '#fca5a5'),
    donorType: 'commercial',
    safetyExpiresInMinutes: 52,
    donorName: 'Trattoria Nonna',
    distanceMiles: 0.8,
  },
  {
    id: 'demo-listing-2',
    detectedItem: 'Sourdough loaves (day-of bake)',
    estimatedQuantityLbs: 6,
    consumerPriceCents: 523,
    temperatureSensitive: false,
    imageUrl: foodImage('🍞', '#fef3c7', '#d6a97a'),
    donorType: 'commercial',
    safetyExpiresInMinutes: 26 * 60,
    donorName: 'Hearth & Grain Bakery',
    distanceMiles: 1.2,
  },
  {
    id: 'demo-listing-3',
    detectedItem: 'Garden salad trays',
    estimatedQuantityLbs: 4,
    consumerPriceCents: 486,
    temperatureSensitive: true,
    imageUrl: foodImage('🥗', '#bbf7d0', '#86efac'),
    donorType: 'commercial',
    safetyExpiresInMinutes: 95,
    donorName: 'Verde Catering Co.',
    distanceMiles: 2.1,
  },
  {
    id: 'demo-listing-4',
    detectedItem: 'Fresh fruit box (apples, oranges, grapes)',
    estimatedQuantityLbs: 12,
    consumerPriceCents: 712,
    temperatureSensitive: false,
    imageUrl: foodImage('🍎', '#fecaca', '#fdba74'),
    donorType: 'residential',
    safetyExpiresInMinutes: 8 * 60,
    donorName: 'Neighborhood share',
    distanceMiles: 0.4,
  },
];

/** What the AI scanner "finds" in the donor demo's sample photo. */
export const DEMO_SCAN_RESULT: FoodScanResult = {
  items: [
    {
      foodName: 'Penne with roasted vegetables',
      category: 'Pasta',
      estimatedQuantity: 2,
      unit: 'trays',
      estimatedServings: 16,
      confidence: 0.93,
    },
    {
      foodName: 'Vegetable rice pilaf',
      category: 'Rice & Grains',
      estimatedQuantity: 2,
      unit: 'trays',
      estimatedServings: 14,
      confidence: 0.58,
    },
    {
      foodName: 'Mixed prepared meal',
      category: 'Mixed/Prepared Meal',
      estimatedQuantity: 2,
      unit: 'trays',
      estimatedServings: 12,
      confidence: 0.34,
    },
  ],
  overallConfidence: 0.93,
  needsManualReview: false,
  notes: 'Two full catering trays of pasta with visible roasted zucchini and peppers.',
};

export const DEMO_SCAN_PHOTO = foodImage('🍝', '#fde68a', '#fca5a5');

/**
 * Feeds the REAL computePricing() — PREPARED_HOT_FOOD commodity rates, so the
 * pricing the demo shows is exactly what production would compute.
 */
export function demoPricingInput(quantityLbs: number): PricingInput {
  return {
    pricePerLb: 1.5,
    retailBenchmarkPerLb: 4.99,
    quantityLbs,
    updatedAt: new Date().toISOString(), // always fresh — never trips the 60-day staleness guard
  };
}

/** The simulated courier used in delivery tracking + the dispatch "system view". */
export const DEMO_COURIER = {
  name: 'Maya R.',
  vehicle: 'Bike with insulated bag',
  rating: 4.9,
  etaMinutes: 18,
};

export type DemoDeliveryStatus =
  | 'finding_courier'
  | 'courier_assigned'
  | 'picked_up'
  | 'delivered';

/** Timed status script for the simulated delivery (ms after payment). */
export const DEMO_DELIVERY_SCRIPT: Array<{ status: DemoDeliveryStatus; atMs: number }> = [
  { status: 'finding_courier', atMs: 0 },
  { status: 'courier_assigned', atMs: 4500 },
  { status: 'picked_up', atMs: 10000 },
  { status: 'delivered', atMs: 16000 },
];
