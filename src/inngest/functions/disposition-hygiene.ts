import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { DANGLE_WINDOW_DAYS } from '@/lib/reports';

// Disposition-hygiene sweep (Task 1, transition-plan Phase 7): flags scans left
// in 'pending' with NO load past DANGLE_WINDOW_DAYS — abandoned manifests, the
// dataset-rot case — so the surplus dataset never silently rots.
//
// READ-ONLY. It surfaces the danglers (count + oldest + sample ids) via a
// structured log / the Inngest run result; it does NOT mutate disposition.
// Terminal dispositions (donated/rejected_returned/…) come from the custody
// flow (Phase 4), which does not exist yet — inventing one here would be
// fiction. Declared-but-pending items (load_id set, awaiting custody) are
// EXPECTED, not danglers, so the predicate excludes them (load_id IS NULL).
//
// Cron-triggered (no event payload) → no FoodLinkEvents entry, same as
// expire-offers.ts. Daily is plenty: abandoned scans are a slow-accumulating
// hygiene signal, not a time-critical state.
export const dispositionHygiene = inngest.createFunction(
  { id: 'disposition-hygiene', retries: 3 },
  { cron: '0 9 * * *' }, // daily 09:00 UTC
  async ({ step }) => {
    const result = await step.run('scan-danglers', async () => {
      const supabase = await createServiceClient();
      const cutoff = new Date(Date.now() - DANGLE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('scan_items')
        .select('id, category_key, created_at')
        .eq('disposition', 'pending')
        .is('load_id', null)
        .lt('created_at', cutoff)
        .order('created_at', { ascending: true });
      if (error) {
        throw new Error(`disposition-hygiene: dangler query failed: ${error.message}`);
      }
      const rows = data ?? [];
      return {
        count: rows.length,
        oldestCreatedAt: rows[0]?.created_at ?? null,
        sampleIds: rows.slice(0, 20).map(r => r.id as string),
      };
    });

    if (result.count > 0) {
      console.warn(
        `[disposition-hygiene] ${result.count} scan_item(s) dangling in 'pending' with no load ` +
          `older than ${DANGLE_WINDOW_DAYS}d (oldest ${result.oldestCreatedAt}). ` +
          `These are abandoned manifests, not custody-pending items.`
      );
    }
    return result;
  }
);
