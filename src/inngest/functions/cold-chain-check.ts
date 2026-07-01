import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { notifyListingExpired } from '@/services/n8n';

export const coldChainCheck = inngest.createFunction(
  { id: 'cold-chain-check', retries: 3 },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    const expiring = await step.run('fetch-expiring', async () => {
      const supabase = await createServiceClient();
      const { data } = await supabase
        .from('listings')
        .select('id, consumer_price_cents, detected_item, donor_id, status')
        .eq('temperature_sensitive', true)
        .in('status', ['live', 'dispatched'])
        .not('safety_expires_at', 'is', null)
        .lte('safety_expires_at', new Date().toISOString());

      return data ?? [];
    });

    for (const listing of expiring) {
      await step.run(`hide-listing-${listing.id}`, async () => {
        const supabase = await createServiceClient();
        await supabase.rpc('hide_expired_listing', { p_listing_id: listing.id });

        // If the listing was dispatched, the consumer may need a refund — n8n handles notification
        if (listing.status === 'dispatched') {
          await notifyListingExpired({
            listing_id: listing.id,
            donor_id: listing.donor_id,
            detected_item: listing.detected_item,
          });
        }
      });
    }

    return { processed: expiring.length };
  }
);
