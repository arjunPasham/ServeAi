import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/email';
import { sendPushToUser } from '@/lib/onesignal';

// Phase 2 Task 4 — fires when offerLoad (src/actions/allocations.ts) commits
// a new allocation via the offer_load RPC. Event-driven (no cron), so there
// is no dead-cron concern the way expire-offers.ts documents for its
// schedule. The offer already committed before match/offered was sent, so
// every notification below is best-effort: a failed send here must never
// surface as a failed offer, and each channel gets its OWN try/catch so an
// email failure never blocks the push attempt (or vice versa) — same
// reasoning as feedback-prompt.ts's email try/catch, just per-channel here
// since there are two channels instead of one.
interface AllocationNotifyRow {
  public_view_token: string;
  institutions: {
    org_name: string;
    signer_email: string | null;
    signer_name: string | null;
    user_id: string | null;
  } | null;
  loads: {
    window_date: string;
    scan_items: {
      food_name: string;
      category_key: string;
      est_lbs: number;
      safety_expires_at: string | null;
    }[];
  } | null;
}

export const offerNotification = inngest.createFunction(
  { id: 'offer-notification', retries: 3 },
  { event: 'match/offered' },
  async ({ event, step }) => {
    await step.run('notify-institution', async () => {
      const service = await createServiceClient();
      const { data, error } = await service
        .from('allocations')
        .select<string, AllocationNotifyRow>(
          `public_view_token,
           institutions ( org_name, signer_email, signer_name, user_id ),
           loads ( window_date, scan_items ( food_name, category_key, est_lbs, safety_expires_at ) )`
        )
        .eq('id', event.data.allocation_id)
        .maybeSingle();
      if (error) {
        throw new Error(`offer-notification: allocation lookup failed: ${error.message}`);
      }
      if (!data) {
        // The allocation was just created by offer_load moments before this
        // event fired, so a missing row here means something is genuinely
        // wrong (not a normal race) — throw so Inngest retries.
        throw new Error(`offer-notification: allocation ${event.data.allocation_id} not found`);
      }

      const institution = data.institutions;
      const items = data.loads?.scan_items ?? [];
      const itemLines = items
        .map(item => {
          const expiry = item.safety_expires_at ? `, use by ${item.safety_expires_at}` : '';
          return `- ${item.food_name} (${item.category_key}) — ${Number(item.est_lbs)} lbs${expiry}`;
        })
        .join('\n');

      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
      const link = `${baseUrl}/inbound/${data.public_view_token}`;
      const windowDate = data.loads?.window_date ?? 'the upcoming window';

      const subject = `New surplus food offer — ${institution?.org_name ?? 'FoodLink'}`;
      const text =
        `A new surplus food offer is available for ${windowDate}:\n\n${itemLines}\n\n` +
        `Review and respond: ${link}`;

      if (institution?.signer_email) {
        try {
          await sendEmail({ to: institution.signer_email, subject, text });
        } catch (err) {
          console.error('[offer-notification] email notify failed:', err);
        }
      }

      if (institution?.user_id) {
        try {
          await sendPushToUser({
            externalUserId: institution.user_id,
            title: 'New surplus food offer',
            body: `${items.length} item${items.length === 1 ? '' : 's'} available — tap to review.`,
            data: { allocation_id: event.data.allocation_id, type: 'offer_notification' },
          });
        } catch (err) {
          console.error('[offer-notification] push notify failed:', err);
        }
      }
    });
  }
);
