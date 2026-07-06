'use client';

import { use, useEffect, useState, useTransition } from 'react';
import { getOrderDetails } from '@/actions/payment';
import { submitPositiveFeedback, submitIssueFeedback, getSignedUploadUrl } from '@/actions/feedback';
import { centsToDisplay } from '@/lib/pricing';

type OrderDetails = Awaited<ReturnType<typeof getOrderDetails>>;

const STATUS_LABEL: Record<string, string> = {
  pending_dispatch: 'Finding a courier…',
  dispatched: 'On the way',
  delivered: 'Delivered',
  disputed: 'Issue reported',
  refunded: 'Refunded',
};

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [order, setOrder] = useState<OrderDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getOrderDetails(id).then(data => {
      setOrder(data);
      setLoading(false);
    });

    // Poll status every 10 seconds while pending
    const interval = setInterval(async () => {
      const data = await getOrderDetails(id);
      setOrder(data);
      if (data?.status === 'delivered' || data?.status === 'refunded') {
        clearInterval(interval);
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [id]);

  const FEEDBACK_ERROR_LABEL: Record<string, string> = {
    DISPUTE_WINDOW_CLOSED: 'The 2-hour reporting window for this order has closed.',
    FEEDBACK_ALREADY_SUBMITTED: 'Feedback was already submitted for this order.',
    ORDER_NOT_ELIGIBLE: 'This order is not eligible for feedback yet.',
  };

  function handlePositiveFeedback() {
    startTransition(async () => {
      const result = await submitPositiveFeedback(id);
      if (result.success) setFeedbackSent(true);
      else setError(FEEDBACK_ERROR_LABEL[result.error] ?? 'Could not submit feedback. Please try again.');
    });
  }

  async function handleIssueFeedback() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setUploadingPhoto(true);
      setError(null);

      try {
        const urlData = await getSignedUploadUrl(id, file.name);
        if (!urlData) { setError('Upload failed'); return; }

        await fetch(urlData.signedUrl, { method: 'PUT', body: file });
        const result = await submitIssueFeedback(id, urlData.path);
        if (result.success) setFeedbackSent(true);
        else setError(FEEDBACK_ERROR_LABEL[result.error] ?? 'Failed to submit issue report');
      } finally {
        setUploadingPhoto(false);
      }
    };
    input.click();
  }

  const listing = order?.listings as unknown as {
    detected_item: string;
    estimated_quantity_lbs: number;
    consumer_price_cents: number;
    image_url: string | null;
    handling_notes: string | null;
    temperature_sensitive: boolean;
  } | null;

  const disputeWindowActive =
    order?.status === 'delivered' &&
    order.dispute_window_expires_at &&
    new Date(order.dispute_window_expires_at) > new Date();

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-10">
        <h1 className="text-lg font-bold text-gray-900">Your order</h1>
      </header>

      <main className="p-4 max-w-lg mx-auto space-y-4">
        {loading ? (
          <div className="bg-white border border-gray-200 rounded-2xl h-64 animate-pulse" />
        ) : !order ? (
          <p className="text-center text-gray-500 py-12">Order not found</p>
        ) : (
          <>
            {/* Status banner */}
            <div className={`rounded-2xl px-4 py-4 text-center ${
              order.status === 'delivered' ? 'bg-green-50 border border-green-200' :
              order.status === 'refunded'  ? 'bg-gray-50 border border-gray-200' :
              order.status === 'disputed'  ? 'bg-red-50 border border-red-200' :
              'bg-blue-50 border border-blue-200'
            }`}>
              <p className="font-semibold text-sm">
                {STATUS_LABEL[order.status] ?? order.status}
              </p>
              {order.status === 'pending_dispatch' && (
                <p className="text-xs text-gray-500 mt-1">We're finding the nearest courier</p>
              )}
            </div>

            {/* Item details */}
            {listing && (
              <div className="bg-white border border-gray-200 rounded-2xl p-4 space-y-3">
                {listing.image_url && (
                  <img src={listing.image_url} alt={listing.detected_item} className="w-full h-40 object-cover rounded-xl" />
                )}
                <div className="flex justify-between items-start">
                  <div>
                    <h2 className="font-semibold text-gray-900">{listing.detected_item}</h2>
                    <p className="text-sm text-gray-500">{listing.estimated_quantity_lbs} lbs</p>
                  </div>
                  <span className="font-bold text-green-600">{centsToDisplay(listing.consumer_price_cents)}</span>
                </div>
                {listing.handling_notes && (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-3 py-2">
                    {listing.handling_notes}
                  </p>
                )}
              </div>
            )}

            {/* Feedback section — shown only in dispute window */}
            {disputeWindowActive && !feedbackSent && (
              <div className="bg-white border border-gray-200 rounded-2xl p-4 space-y-3">
                <h3 className="font-semibold text-gray-900 text-sm">How was your order?</h3>
                {error && (
                  <p className="text-xs text-red-600">{error}</p>
                )}
                <div className="flex gap-3">
                  <button
                    onClick={handlePositiveFeedback}
                    disabled={isPending || uploadingPhoto}
                    className="flex-1 min-h-[44px] bg-green-600 hover:bg-green-700 text-white font-semibold rounded-full py-2.5 text-sm transition-colors disabled:opacity-50"
                  >
                    All good ✓
                  </button>
                  <button
                    onClick={handleIssueFeedback}
                    disabled={isPending || uploadingPhoto}
                    className="flex-1 min-h-[44px] border border-red-300 text-red-700 hover:bg-red-50 font-semibold rounded-full py-2.5 text-sm transition-colors disabled:opacity-50"
                  >
                    {uploadingPhoto ? 'Uploading…' : 'Report issue'}
                  </button>
                </div>
              </div>
            )}

            {feedbackSent && (
              <div className="bg-green-50 border border-green-200 rounded-2xl px-4 py-4 text-center text-sm text-green-800 font-medium">
                Thank you for your feedback!
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
