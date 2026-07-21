import { serve } from 'inngest/next';
import { inngest } from '@/inngest/client';
import { courierDispatch } from '@/inngest/functions/courier-dispatch';
import { disputeWindow } from '@/inngest/functions/dispute-window';
import { feedbackPrompt } from '@/inngest/functions/feedback-prompt';
import { claimExpiry } from '@/inngest/functions/claim-expiry';
import { expireOffers } from '@/inngest/functions/expire-offers';
import { offerNotification } from '@/inngest/functions/offer-notification';

// cold-chain-check + delivery-reconcile: dead pre-pivot 5-min crons, unregistered
// pre-Phase-2 (files retained for Phase 3 deletion)

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [courierDispatch, disputeWindow, feedbackPrompt, claimExpiry, expireOffers, offerNotification],
  signingKey: process.env.INNGEST_SIGNING_KEY,
});
