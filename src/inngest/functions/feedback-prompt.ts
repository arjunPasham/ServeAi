import { inngest } from '../client';
import { sendFeedbackPrompt } from '@/lib/onesignal';
import { sendEmail, getUserEmail } from '@/lib/email';

export const feedbackPrompt = inngest.createFunction(
  { id: 'feedback-prompt', retries: 3 },
  { event: 'delivery/confirmed' },
  async ({ event, step }) => {
    await step.sleep('wait-feedback-delay', '30m');

    await step.run('send-feedback-push', async () => {
      await sendFeedbackPrompt(event.data.consumer_id, event.data.order_id);
      try {
        const email = await getUserEmail(event.data.consumer_id);
        if (email) {
          await sendEmail({
            to: email,
            subject: 'How was your order? — FoodLink',
            text: 'How was your order? Report any issue within the 2-hour window.',
          });
        }
      } catch (err) {
        console.error('[feedback-prompt] email notify failed:', err);
      }
    });
  }
);
