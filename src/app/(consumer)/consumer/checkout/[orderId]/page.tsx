'use client';

// Card checkout for real Stripe mode. The claim action locks the listing and
// returns a PaymentIntent client_secret; browse stores it in sessionStorage and
// routes here. On confirmed payment the Stripe webhook triggers courier dispatch.
// In dev mode (no Stripe keys) this page is never reached.

import { use, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';

function CheckoutForm({ orderId }: { orderId: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const result = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/consumer/orders/${orderId}`,
      },
      redirect: 'if_required',
    });

    if (result.error) {
      setError(result.error.message ?? 'Payment failed. Please try again.');
      setSubmitting(false);
      return;
    }

    sessionStorage.removeItem(`checkout:${orderId}`);
    router.push(`/consumer/orders/${orderId}`);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement />
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={!stripe || submitting}
        className="w-full min-h-[44px] bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold rounded-full py-3 text-sm transition-colors"
      >
        {submitting ? 'Processing…' : 'Pay now'}
      </button>
      <p className="text-xs text-center text-gray-400">
        Your listing is held for 15 minutes while you complete payment.
      </p>
    </form>
  );
}

export default function CheckoutPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = use(params);
  const router = useRouter();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  const stripePromise = useMemo(
    () => (publishableKey ? loadStripe(publishableKey) : null),
    [publishableKey]
  );

  useEffect(() => {
    const secret = sessionStorage.getItem(`checkout:${orderId}`);
    if (secret) setClientSecret(secret);
    else setMissing(true);
  }, [orderId]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-10">
        <h1 className="text-lg font-bold text-gray-900">Complete your purchase</h1>
      </header>

      <main className="p-4 max-w-lg mx-auto">
        {missing || !stripePromise ? (
          <div className="text-center py-20 space-y-3">
            <p className="text-gray-500">
              {!stripePromise
                ? 'Payments are not configured.'
                : 'This checkout session has expired.'}
            </p>
            <button
              onClick={() => router.push(`/consumer/orders/${orderId}`)}
              className="text-green-600 font-semibold text-sm"
            >
              View order status
            </button>
          </div>
        ) : clientSecret ? (
          <div className="bg-white border border-gray-200 rounded-2xl p-5">
            <Elements stripe={stripePromise} options={{ clientSecret }}>
              <CheckoutForm orderId={orderId} />
            </Elements>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-2xl h-64 animate-pulse" />
        )}
      </main>
    </div>
  );
}
