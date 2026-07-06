'use server';

import { createClient, createServiceClient } from '@/lib/supabase/server';

export type FeedbackResult =
  | { success: true }
  | { success: false; error: string };

// Map submit_feedback RPC exceptions (010_feedback_guards.sql) to stable codes
function mapFeedbackError(message: string | undefined): string {
  if (message?.includes('DISPUTE_WINDOW_EXPIRED')) return 'DISPUTE_WINDOW_EXPIRED';
  if (message?.includes('ORDER_NOT_FOUND_OR_NOT_DELIVERED')) return 'ORDER_NOT_FOUND_OR_NOT_DELIVERED';
  if (message?.includes('PHOTO_REQUIRED')) return 'PHOTO_REQUIRED';
  return 'SERVER_ERROR';
}

export async function submitPositiveFeedback(orderId: string): Promise<FeedbackResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  const service = await createServiceClient();
  const { error } = await service.rpc('submit_feedback', {
    p_order_id: orderId,
    p_consumer_id: user.id,
    p_outcome: 'positive',
    p_photo_url: null,
  });

  if (error) return { success: false, error: mapFeedbackError(error.message) };
  return { success: true };
}

export async function submitIssueFeedback(
  orderId: string,
  photoUrl: string
): Promise<FeedbackResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  if (!photoUrl) return { success: false, error: 'PHOTO_REQUIRED' };

  const service = await createServiceClient();
  const { error } = await service.rpc('submit_feedback', {
    p_order_id: orderId,
    p_consumer_id: user.id,
    p_outcome: 'issue_reported',
    p_photo_url: photoUrl,
  });

  if (error) return { success: false, error: mapFeedbackError(error.message) };
  return { success: true };
}

export async function getSignedUploadUrl(
  orderId: string,
  filename: string
): Promise<{ signedUrl: string; path: string } | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const service = await createServiceClient();

  // Only the consumer who placed the order may upload into its dispute-photos path
  const { data: order } = await service
    .from('orders')
    .select('id')
    .eq('id', orderId)
    .eq('consumer_id', user.id)
    .single();
  if (!order) return null;

  const path = `dispute-photos/${orderId}/${filename}`;

  const { data } = await service.storage
    .from('listing-photos')
    .createSignedUploadUrl(path);

  if (!data) return null;
  return { signedUrl: data.signedUrl, path };
}
