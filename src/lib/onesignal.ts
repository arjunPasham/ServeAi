import * as OneSignal from '@onesignal/node-onesignal';

const DEV_MODE = !process.env.ONESIGNAL_REST_API_KEY;

function getClient() {
  const configuration = OneSignal.createConfiguration({
    restApiKey: process.env.ONESIGNAL_REST_API_KEY!,
  });
  return new OneSignal.DefaultApi(configuration);
}

export async function sendPushToUser(params: {
  externalUserId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}): Promise<{ success: boolean; error?: string }> {
  if (DEV_MODE) {
    console.log(`[DEV] Push notification to ${params.externalUserId}: ${params.title} — ${params.body}`);
    return { success: true };
  }

  try {
    const client = getClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notification: any = new OneSignal.Notification();
    notification.app_id = process.env.ONESIGNAL_APP_ID!;
    notification.include_external_user_ids = [params.externalUserId];
    notification.headings = { en: params.title };
    notification.contents = { en: params.body };
    if (params.data) {
      notification.data = params.data;
    }

    await client.createNotification(notification);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'ONESIGNAL_ERROR';
    return { success: false, error: message };
  }
}

export async function sendDispatchNotification(courierUserId: string, orderId: string): Promise<void> {
  await sendPushToUser({
    externalUserId: courierUserId,
    title: 'New delivery available',
    body: 'A food pickup is ready near you. Tap to accept.',
    data: { order_id: orderId, type: 'dispatch_offer' },
  });
}

export async function sendFeedbackPrompt(consumerUserId: string, orderId: string): Promise<void> {
  await sendPushToUser({
    externalUserId: consumerUserId,
    title: 'How was your FoodLink delivery?',
    body: 'Let us know if everything arrived safely.',
    data: { order_id: orderId, type: 'feedback_prompt' },
  });
}

export async function sendConsumerRefundNotification(consumerUserId: string, listingItem: string): Promise<void> {
  await sendPushToUser({
    externalUserId: consumerUserId,
    title: 'Order update',
    body: `We couldn't find a courier for "${listingItem}". You will receive a full refund.`,
    data: { type: 'refund_notice' },
  });
}
