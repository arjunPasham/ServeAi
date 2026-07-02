'use server';

import { createClient, createServiceClient } from '@/lib/supabase/server';
import { computePricing, PricingInput, PricingResult } from '@/lib/pricing';
import { isTemperatureSensitive } from '@/lib/temperature-map';
import { notifyListingPublished } from '@/services/n8n';
import { redirect } from 'next/navigation';

export type PricingActionResult =
  | { success: true; pricing: PricingResult; input: PricingInput }
  | { success: false; error: string };

export type ListingActionResult =
  | { success: true; listingId: string }
  | { success: false; error: string };

// FDA safety window constants (Step 6 — decision #3 resolved as FDA defaults)
const SAFETY_WINDOW_HOT_MS  = 2 * 60 * 60 * 1000; // 2 hours
const SAFETY_WINDOW_COLD_MS = 4 * 60 * 60 * 1000; // 4 hours
// Hot-food categories require the shorter 2-hour window
const HOT_FOOD_CATEGORIES = new Set(['PREPARED_HOT_FOOD', 'COOKED_RICE', 'COOKED_BEANS']);

export async function getListingPricing(
  usdaCategory: string,
  quantityLbs: number
): Promise<PricingActionResult> {
  if (quantityLbs <= 0) {
    return { success: false, error: 'INVALID_QUANTITY' };
  }

  const service = await createServiceClient();

  const { data, error } = await service
    .from('usda_commodity_prices')
    .select('price_per_lb, retail_benchmark_per_lb, updated_at')
    .eq('category', usdaCategory)
    .single();

  if (error || !data) {
    return { success: false, error: 'USDA_CATEGORY_NOT_FOUND' };
  }

  const input: PricingInput = {
    pricePerLb: Number(data.price_per_lb),
    retailBenchmarkPerLb: Number(data.retail_benchmark_per_lb),
    quantityLbs,
    updatedAt: data.updated_at,
  };

  const pricing = computePricing(input);

  // Enforce hard blocks server-side so they can't be bypassed by skipping the slider UI
  if (pricing.staleData) {
    return { success: false, error: 'USDA_DATA_STALE' };
  }
  if (pricing.discountFloorViolated) {
    return { success: false, error: 'DISCOUNT_FLOOR_VIOLATED' };
  }

  return { success: true, pricing, input };
}

export async function createDraftListing(params: {
  detectedItem: string;
  estimatedQuantityLbs: number;
  confidenceScore: number;
  usdaCategory: string;
  imageUrl: string;
  donorPayoutCents: number;
  consumerPriceCents: number;
  platformFeeCents: number;
  courierFeeCents: number;
  handlingNotes?: string;
}): Promise<ListingActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  const service = await createServiceClient();

  // Fetch commodity price to compute base_commodity_price_cents
  const { data: commodity } = await service
    .from('usda_commodity_prices')
    .select('price_per_lb')
    .eq('category', params.usdaCategory)
    .single();

  if (!commodity) return { success: false, error: 'USDA_CATEGORY_NOT_FOUND' };

  const baseCommodityPriceCents = Math.round(
    Number(commodity.price_per_lb) * params.estimatedQuantityLbs * 100
  );

  const temperatureSensitive = isTemperatureSensitive(params.usdaCategory);

  const { data: listing, error } = await service.rpc('create_draft_listing', {
    p_donor_id: user.id,
    p_detected_item: params.detectedItem,
    p_estimated_quantity_lbs: params.estimatedQuantityLbs,
    p_confidence_score: params.confidenceScore,
    p_temperature_sensitive: temperatureSensitive,
    p_usda_category: params.usdaCategory,
    p_image_url: params.imageUrl,
    p_base_commodity_price_cents: baseCommodityPriceCents,
    p_suggested_donor_payout_cents: params.donorPayoutCents,
    p_donor_payout_cents: params.donorPayoutCents,
    p_consumer_price_cents: params.consumerPriceCents,
    p_platform_fee_cents: params.platformFeeCents,
    p_courier_fee_cents: params.courierFeeCents,
    p_handling_notes: params.handlingNotes ?? null,
  });

  if (error || !listing) return { success: false, error: 'SERVER_ERROR' };

  return { success: true, listingId: listing.id };
}

export async function publishListing(params: {
  listingId: string;
  safetyAttested: boolean;
  preparedAt?: string | null;
}): Promise<ListingActionResult> {
  if (!params.safetyAttested) {
    return { success: false, error: 'SAFETY_ATTESTATION_REQUIRED' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  const service = await createServiceClient();

  // Fetch listing to validate ownership and temperature sensitivity
  const { data: listing } = await service
    .from('listings')
    .select('id, donor_id, status, temperature_sensitive, usda_category, detected_item, image_url, consumer_price_cents, estimated_quantity_lbs, published_at')
    .eq('id', params.listingId)
    .eq('donor_id', user.id)
    .eq('status', 'draft')
    .single();

  if (!listing) return { success: false, error: 'LISTING_NOT_FOUND' };

  // Temperature-sensitive items require prepared_at
  if (listing.temperature_sensitive && !params.preparedAt) {
    return { success: false, error: 'PREPARED_AT_REQUIRED' };
  }

  // Compute safety_expires_at if temperature-sensitive
  let safetyExpiresAt: string | null = null;
  if (listing.temperature_sensitive && params.preparedAt) {
    const preparedDate = new Date(params.preparedAt);
    const windowMs = HOT_FOOD_CATEGORIES.has(listing.usda_category ?? '')
      ? SAFETY_WINDOW_HOT_MS
      : SAFETY_WINDOW_COLD_MS;
    safetyExpiresAt = new Date(preparedDate.getTime() + windowMs).toISOString();
  }

  // If temperature-sensitive and already expired at publish time — block it
  if (safetyExpiresAt && new Date(safetyExpiresAt) <= new Date()) {
    return { success: false, error: 'SAFETY_WINDOW_EXPIRED' };
  }

  // Update prepared_at and safety_expires_at before calling publish RPC
  if (listing.temperature_sensitive && params.preparedAt) {
    await service
      .from('listings')
      .update({
        prepared_at: params.preparedAt,
        safety_expires_at: safetyExpiresAt,
      })
      .eq('id', params.listingId)
      .eq('status', 'draft');
  }

  // Atomically publish via RPC (sets status='live', locks pricing, records audit)
  const { error } = await service.rpc('publish_listing', {
    p_listing_id: params.listingId,
    p_donor_id: user.id,
    p_safety_attested: true,
  });

  if (error) {
    if (error.message?.includes('LISTING_NOT_PUBLISHABLE')) {
      return { success: false, error: 'LISTING_NOT_PUBLISHABLE' };
    }
    return { success: false, error: 'SERVER_ERROR' };
  }

  // Notify n8n for external integrations (marketing, analytics, etc.)
  await notifyListingPublished({
    listing_id: params.listingId,
    donor_id: user.id,
    detected_item: listing.detected_item,
    estimated_quantity_lbs: Number(listing.estimated_quantity_lbs),
    consumer_price_cents: listing.consumer_price_cents,
    temperature_sensitive: listing.temperature_sensitive,
    image_url: listing.image_url,
    published_at: new Date().toISOString(),
  });

  return { success: true, listingId: params.listingId };
}

export async function getDonorListings() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data } = await supabase
    .from('listings')
    .select(`
      id, status, detected_item, estimated_quantity_lbs,
      consumer_price_cents, donor_payout_cents, temperature_sensitive,
      image_url, created_at, published_at, safety_expires_at
    `)
    .eq('donor_id', user.id)
    .order('created_at', { ascending: false });

  return data ?? [];
}

// Consumer browse: live listings with geospatial obfuscation
export async function getLiveListings(params?: {
  lat?: number;
  lng?: number;
  radiusMeters?: number;
}) {
  const supabase = await createClient();

  // Use service client for geospatial query
  const service = await createServiceClient();

  const { data } = await service
    .from('listings')
    .select(`
      id, detected_item, estimated_quantity_lbs,
      consumer_price_cents, temperature_sensitive,
      image_url, published_at, safety_expires_at,
      donor_profiles!inner(type)
    `)
    .eq('status', 'live')
    .order('published_at', { ascending: false })
    .limit(50);

  return data ?? [];
}

export async function getListingSignedUploadUrl(
  listingId: string,
  filename: string
): Promise<{ signedUrl: string; path: string } | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const service = await createServiceClient();
  const path = `listing-photos/${listingId}/${filename}`;

  const { data } = await service.storage
    .from('listing-photos')
    .createSignedUploadUrl(path);

  if (!data) return null;
  return { signedUrl: data.signedUrl, path };
}

export async function getLiveListingsWithSignedUrls(): Promise<
  (Awaited<ReturnType<typeof getLiveListings>>[number] & { signedImageUrl: string | null })[]
> {
  const listings = await getLiveListings();
  const service = await createServiceClient();

  return Promise.all(
    listings.map(async (l) => {
      if (!l.image_url) return { ...l, signedImageUrl: null };
      const { data } = await service.storage
        .from('listing-photos')
        .createSignedUrl(l.image_url, 3600);
      return { ...l, signedImageUrl: data?.signedUrl ?? null };
    })
  );
}
