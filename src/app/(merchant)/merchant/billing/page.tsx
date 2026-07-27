// Merchant self-service billing (Task 2): read-only subscription status +
// invoice history, plus a handoff to the Stripe customer portal for plan /
// payment-method management. Display + portal handoff only — no charge logic.
// /merchant/* is middleware-gated (phone_verified + donor); getMerchantBilling
// re-asserts requireVerifiedMerchant.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getMerchantBilling, openMerchantBillingPortal } from '@/actions/billing';
import { subscriptionStatusLabel } from '@/lib/billing';
import { LocalDateTime } from '@/components/LocalDateTime';

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const PORTAL_ERROR: Record<string, string> = {
  NOT_A_MERCHANT: 'Not authorized.',
  NO_CUSTOMER: 'Billing isn’t set up for your account yet — please contact ops.',
  SERVER_ERROR: 'Could not open the billing portal — please try again.',
};

// Opens the Stripe portal and redirects to it; on failure bounces back with an
// error code. Delegates to the requireVerifiedMerchant-gated action.
async function openPortalAction() {
  'use server';
  const result = await openMerchantBillingPortal();
  if (!result.success) redirect(`/merchant/billing?error=${encodeURIComponent(result.error)}`);
  redirect(result.url);
}

const SUBSCRIBED = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);

export default async function MerchantBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const billing = await getMerchantBilling();
  const subscribed = SUBSCRIBED.has(billing.subscriptionStatus);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-10">
        <div className="flex items-center justify-between max-w-lg mx-auto">
          <div>
            <h1 className="text-lg font-bold text-gray-900">Billing</h1>
            <p className="text-sm text-gray-500">{billing.businessName}</p>
          </div>
          <Link href="/merchant/dashboard" className="text-sm text-gray-500 hover:text-gray-700">
            ← Dashboard
          </Link>
        </div>
      </header>

      <main className="p-4 max-w-lg mx-auto space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800">
            {PORTAL_ERROR[error] ?? 'Something went wrong.'}
          </div>
        )}

        {/* Subscription status */}
        <section className="bg-white border border-gray-200 rounded-2xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">Plan</p>
              <p className="font-semibold text-gray-900 capitalize">{billing.plan}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-500">Status</p>
              <p className={`font-semibold ${subscribed ? 'text-green-700' : 'text-gray-600'}`}>
                {subscriptionStatusLabel(billing.subscriptionStatus)}
              </p>
            </div>
          </div>
          {billing.currentPeriodEnd && (
            <p className="text-xs text-gray-500">
              Current period ends <LocalDateTime iso={billing.currentPeriodEnd} variant="date" />
            </p>
          )}

          {billing.hasCustomer ? (
            <form action={openPortalAction} className="pt-1">
              <button
                type="submit"
                className="min-h-[44px] w-full bg-gray-900 hover:bg-gray-800 text-white font-semibold rounded-full px-5 text-sm transition-colors"
              >
                Manage billing
              </button>
              <p className="mt-1 text-[11px] text-gray-400 text-center">
                Update your plan, payment method, or download invoices in Stripe.
              </p>
            </form>
          ) : (
            <p className="pt-1 text-xs text-gray-500">
              Billing isn’t set up for your account yet — ops will send your subscription. Once it’s active you can
              manage it here.
            </p>
          )}
        </section>

        {/* Invoice history */}
        <section className="space-y-2">
          <h2 className="font-semibold text-gray-900 text-sm px-1">Invoice history</h2>
          {billing.invoices.length === 0 ? (
            <p className="text-sm text-gray-500 px-1">No invoices yet.</p>
          ) : (
            <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden divide-y divide-gray-100">
              {billing.invoices.map(inv => (
                <div key={inv.stripeInvoiceId} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{centsToDollars(inv.amountPaidCents || inv.amountDueCents)}</p>
                    <p className="text-xs text-gray-500">
                      <LocalDateTime iso={inv.createdAt} variant="date" /> · {inv.status}
                    </p>
                  </div>
                  {inv.hostedInvoiceUrl ? (
                    <a
                      href={inv.hostedInvoiceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-semibold text-blue-600 hover:text-blue-700"
                    >
                      View
                    </a>
                  ) : (
                    <span className="text-xs text-gray-400">—</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
