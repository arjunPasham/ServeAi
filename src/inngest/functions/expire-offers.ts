import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';

// Stale-offer sweep (Phase 2 Task 3, folded requirement 2): flips every offer
// still 'offered' past its expires_at -> 'expired' and frees its load back to
// 'declared', via the expire_stale_offers() RPC (025_withdraw_offer.sql) —
// so an institution that simply ignores an offer can't strand the load past
// its safety window. Runs every 10 minutes: frequent enough that an ignored
// offer doesn't sit stuck for long relative to the hours-scale TTLs offerLoad
// clamps against (src/actions/allocations.ts / src/lib/match-score.ts),
// without hammering the DB over a table that's normally near-empty.
// expire_stale_offers is idempotent and uses FOR UPDATE SKIP LOCKED, so an
// overlapping run (a slow sweep + the next tick) never contends with itself
// or with a concurrent respond_to_offer/withdraw_offer on the same row — a
// locked allocation is just picked up on the next pass.
//
// Cron-triggered (no event payload), so there is no corresponding entry in
// FoodLinkEvents (src/inngest/client.ts).
export const expireOffers = inngest.createFunction(
  { id: 'expire-offers', retries: 3 },
  { cron: '*/10 * * * *' },
  async ({ step }) => {
    const count = await step.run('expire-stale-offers', async () => {
      const supabase = await createServiceClient();
      const { data, error } = await supabase.rpc('expire_stale_offers');
      if (error) {
        throw new Error(`expire-offers: expire_stale_offers failed: ${error.message}`);
      }
      return (data as number | null) ?? 0;
    });

    console.log(`[expire-offers] expired ${count} stale offer(s)`);
    return { expired: count };
  }
);
