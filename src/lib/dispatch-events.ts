// Server-only helper (NOT a server action — must never be client-invokable):
// looks up donor pickup coordinates and starts the courier dispatch loop.
// Called from the dev-mode claim path and the payment_intent.succeeded webhook.
import { createServiceClient } from '@/lib/supabase/server';
import { inngest } from '@/inngest/client';

export async function fireDispatch(
  orderId: string,
  listingId: string,
  consumerId: string
): Promise<void> {
  const service = await createServiceClient();

  // listings → donor_profiles has no direct FK (both point at users), so
  // PostgREST cannot embed it — fetch the donor profile separately.
  const { data: listing } = await service
    .from('listings')
    .select('id, donor_id, temperature_sensitive, detected_item, consumer_price_cents')
    .eq('id', listingId)
    .single();

  const { data: donorProfile } = listing
    ? await service
        .from('donor_profiles')
        .select('address_lat, address_lng')
        .eq('user_id', listing.donor_id)
        .maybeSingle()
    : { data: null };

  await inngest.send({
    name: 'dispatch/initiated',
    data: {
      order_id: orderId,
      listing_id: listingId,
      consumer_id: consumerId,
      donor_lat: donorProfile?.address_lat ?? 0,
      donor_lng: donorProfile?.address_lng ?? 0,
      requires_cold_chain: listing?.temperature_sensitive ?? false,
      detected_item: listing?.detected_item ?? '',
      consumer_price_cents: listing?.consumer_price_cents ?? 0,
    },
  });
}
