import { inngest } from '../client';
import { sendFeedbackPrompt } from '@/lib/onesignal';

export const feedbackPrompt = inngest.createFunction(
  { id: 'feedback-prompt', retries: 3 },
  { event: 'delivery/confirmed' },
  async ({ event, step }) => {
    await step.sleep('wait-feedback-delay', '30m');

    await step.run('send-feedback-push', async () => {
      await sendFeedbackPrompt(event.data.consumer_id, event.data.order_id);
    });
  }
);
