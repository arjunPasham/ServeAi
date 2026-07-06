import { serve } from 'inngest/next';
import { inngest } from '@/inngest/client';
import { coldChainCheck } from '@/inngest/functions/cold-chain-check';
import { courierDispatch } from '@/inngest/functions/courier-dispatch';
import { disputeWindow } from '@/inngest/functions/dispute-window';
import { feedbackPrompt } from '@/inngest/functions/feedback-prompt';
import { claimExpiry } from '@/inngest/functions/claim-expiry';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [coldChainCheck, courierDispatch, disputeWindow, feedbackPrompt, claimExpiry],
  signingKey: process.env.INNGEST_SIGNING_KEY,
});
