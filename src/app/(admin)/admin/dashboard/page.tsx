// Ops console (Task A — real admin tooling, closes audit I4). Replaces the
// pre-pivot admin dashboard: the disabled usda_commodity_prices editor (a
// silent no-op — the live flow never read that table), the donor_profiles
// license-review queue, and the frozen `orders` list are all gone. In their
// place: an append-only valuation_table editor (the price surface the live
// flow ACTUALLY reads) plus read-only visibility into merchants, loads, and
// scans. checkAdmin() below is copied VERBATIM from the matching page.

import { createClient, createServiceClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { LocalDateTime } from '@/components/LocalDateTime';
import {
  getValuationCatalog,
  appendValuation,
  getAdminMerchants,
  getAdminLoads,
  getAdminScans,
} from '@/actions/admin';
import { startMerchantSubscription } from '@/actions/billing';
import { issueDonationReceipt } from '@/actions/receipts';
import { getSurplusPatterns, getDanglingScanSummary } from '@/actions/reports';
import { canStartSubscription } from '@/lib/billing';
import { describeSurplusPattern } from '@/lib/reports';
import { currentValuations } from '@/lib/valuation';

async function checkAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const service = await createServiceClient();
  const { data } = await service
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single();

  if (data?.role !== 'admin') redirect('/login');
  return user;
}

const ERROR_MESSAGES: Record<string, string> = {
  NOT_ADMIN: 'Not authorized.',
  INVALID_FMV: 'The FMV must be a number ≥ 0 (dollars per lb).',
  INVALID_BASIS: 'The basis must be a number ≥ 0 (dollars per lb).',
  UNKNOWN_CATEGORY: 'That category no longer exists.',
  INVALID_VALUATION: 'FMV and basis must both be present and ≥ 0.',
  // Billing (Task B)
  MERCHANT_NOT_FOUND: 'Merchant not found.',
  NOT_SUBSCRIPTION_PLAN: "That merchant's plan isn't a subscription plan (weekly/monthly/annual).",
  ALREADY_SUBSCRIBED: 'That merchant already has an active subscription.',
  PRICE_NOT_CONFIGURED: 'No Stripe Price configured for that plan (set STRIPE_PRICE_* env vars).',
  // Donation receipt (Task 3)
  LOAD_NOT_FOUND: 'That load was not found.',
  NOT_DONATION_LANE: 'Only donation-lane loads get a receipt (a sale is recovered revenue).',
  NOT_DELIVERED: 'That load isn’t delivered + recipient-confirmed yet.',
  NOT_CONFIRMED: 'The recipient hasn’t confirmed receipt yet.',
  DONEE_NOT_VERIFIED: 'The donee isn’t a verified 501(c)(3).',
  ALREADY_ISSUED: 'A receipt has already been issued for that load.',
  EMPTY_LOAD: 'That load has no line items to value.',
  SERVER_ERROR: 'Something went wrong — try again.',
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function centsToDollarInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

// Wrapper server action: adapts the <form> FormData contract to
// appendValuation, which already requireAdmin-gates itself (returns
// { success:false, error:'NOT_ADMIN' } for a non-admin), so there's no
// separate admin check to duplicate here — same reasoning as the matching
// page's offerLoadAction.
async function appendValuationAction(formData: FormData) {
  'use server';
  const categoryKey = String(formData.get('categoryKey') ?? '');
  const fmvDollars = String(formData.get('fmvDollars') ?? '');
  const basisDollars = String(formData.get('basisDollars') ?? '');
  const result = await appendValuation(categoryKey, fmvDollars, basisDollars);
  revalidatePath('/admin/dashboard');
  if (!result.success) redirect(`/admin/dashboard?error=${encodeURIComponent(result.error)}`);
  redirect(`/admin/dashboard?ok=${encodeURIComponent(categoryKey)}`);
}

// Start a merchant's subscription (Task B). Delegates to the admin-guarded
// startMerchantSubscription. In dev the subscription is simulated active; in
// prod we redirect the ops user straight to the Stripe Checkout URL to complete
// setup (or hand off to the merchant).
async function startBillingAction(formData: FormData) {
  'use server';
  const merchantId = String(formData.get('merchantId') ?? '');
  const result = await startMerchantSubscription(merchantId);
  revalidatePath('/admin/dashboard');
  if (!result.success) redirect(`/admin/dashboard?error=${encodeURIComponent(result.error)}`);
  if (result.mode === 'checkout') redirect(result.checkoutUrl);
  redirect('/admin/dashboard?billing=started');
}

// Generate a donation receipt worksheet for a delivered + confirmed donation
// load (Task 3). Gated + frozen in issueDonationReceipt; an un-approved template
// yields a DRAFT worksheet (pending CPA/counsel sign-off), not a claimable receipt.
async function generateReceiptAction(formData: FormData) {
  'use server';
  const loadId = String(formData.get('loadId') ?? '');
  const result = await issueDonationReceipt(loadId);
  revalidatePath('/admin/dashboard');
  if (!result.success) redirect(`/admin/dashboard?error=${encodeURIComponent(result.error)}`);
  redirect(`/admin/dashboard?receipt=${result.templateApproved ? 'issued' : 'draft'}`);
}

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; billing?: string; receipt?: string }>;
}) {
  await checkAdmin();
  const { error, ok, billing, receipt } = await searchParams;

  const [catalog, merchants, loads, scans, surplusPatterns, dangling] = await Promise.all([
    getValuationCatalog(),
    getAdminMerchants(),
    getAdminLoads(),
    getAdminScans(),
    getSurplusPatterns(),
    getDanglingScanSummary(),
  ]);

  const current = currentValuations(catalog.valuations);

  // Top surplus patterns across merchants (highest total lbs first), capped for
  // the ops overview — the full ranked set is available per-merchant via the
  // reports action / the 028 views.
  const topPatterns = surplusPatterns.slice(0, 20);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-10">
        <h1 className="text-lg font-bold text-gray-900">Ops console</h1>
        <p className="text-sm text-gray-500">Valuations, merchants, loads, and scans.</p>
      </header>

      <main className="p-4 max-w-5xl mx-auto space-y-8">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800">
            {ERROR_MESSAGES[error] ?? `Action failed: ${error}`}
          </div>
        )}
        {ok && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800">
            New valuation saved for <span className="font-mono">{ok}</span>.
          </div>
        )}
        {billing === 'started' && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800">
            Subscription started.
          </div>
        )}
        {billing === 'canceled' && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
            Checkout was canceled — the merchant has no active subscription.
          </div>
        )}
        {receipt === 'issued' && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800">
            Donation receipt issued.
          </div>
        )}
        {receipt === 'draft' && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
            Draft worksheet generated — pending template approval (not a claimable receipt).
          </div>
        )}
        {dangling.count > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
            <span className="font-semibold">{dangling.count}</span> scan item{dangling.count === 1 ? '' : 's'} dangling in{' '}
            <span className="font-mono">pending</span> with no load (abandoned manifests). Oldest:{' '}
            {dangling.oldestCreatedAt ? <LocalDateTime iso={dangling.oldestCreatedAt} variant="date" /> : '—'}.
          </div>
        )}

        {/* ─── Valuation editor (append-only) ─────────────────────────────── */}
        <section className="space-y-3">
          <div>
            <h2 className="font-semibold text-gray-900">Valuation table</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Append-only: saving a category records a NEW valuation effective now. History is never edited,
              and loads/receipts keep the value they snapshotted at declaration. FMV and basis are $/lb.
            </p>
          </div>

          <div className="bg-white border border-gray-200 rounded-2xl overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Category</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Current FMV</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Current basis</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Effective</th>
                  <th className="px-4 py-3 font-medium text-gray-600">New valuation ($/lb)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {catalog.categories.map(cat => {
                  const cur = current.get(cat.categoryKey) ?? null;
                  return (
                    <tr key={cat.categoryKey}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{cat.label}</div>
                        <div className="font-mono text-[11px] text-gray-400">{cat.categoryKey}</div>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700">
                        {cur ? formatCents(cur.fmvPerLbCents) : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700">
                        {cur ? formatCents(cur.basisPerLbCents) : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500 text-xs">
                        {cur ? <LocalDateTime iso={cur.effectiveFrom} variant="date" /> : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <form action={appendValuationAction} className="flex gap-1 items-center justify-end">
                          <input type="hidden" name="categoryKey" value={cat.categoryKey} />
                          <label className="sr-only" htmlFor={`fmv-${cat.categoryKey}`}>FMV $/lb</label>
                          <input
                            id={`fmv-${cat.categoryKey}`}
                            type="number"
                            name="fmvDollars"
                            aria-label={`FMV $/lb for ${cat.label}`}
                            defaultValue={cur ? centsToDollarInput(cur.fmvPerLbCents) : ''}
                            step="0.01"
                            min="0"
                            required
                            placeholder="FMV"
                            className="w-20 border border-gray-200 rounded px-2 py-1 text-xs"
                          />
                          <label className="sr-only" htmlFor={`basis-${cat.categoryKey}`}>Basis $/lb</label>
                          <input
                            id={`basis-${cat.categoryKey}`}
                            type="number"
                            name="basisDollars"
                            aria-label={`Basis $/lb for ${cat.label}`}
                            defaultValue={cur ? centsToDollarInput(cur.basisPerLbCents) : ''}
                            step="0.01"
                            min="0"
                            required
                            placeholder="Basis"
                            className="w-20 border border-gray-200 rounded px-2 py-1 text-xs"
                          />
                          <button
                            type="submit"
                            className="bg-blue-600 text-white text-xs font-semibold rounded px-2 py-1 hover:bg-blue-700"
                          >
                            Save
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* ─── Surplus patterns (supply intelligence — scan/declare signal) ─ */}
        <section className="space-y-3">
          <div>
            <h2 className="font-semibold text-gray-900">Surplus patterns</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              What merchants tend to have left over, by category and weekday, over the last 90 days —
              from confirmed scans + declared loads (supply signal only; no delivery outcome). Weekday is the
              merchant&apos;s local (Eastern) day.
            </p>
          </div>
          {topPatterns.length === 0 ? (
            <p className="text-sm text-gray-500">No surplus patterns yet.</p>
          ) : (
            <div className="bg-white border border-gray-200 rounded-2xl overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Merchant</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Pattern</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Total lbs (90d)</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Last seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {topPatterns.map(p => (
                    <tr key={`${p.merchantId}-${p.categoryKey}-${p.localDow}`}>
                      <td className="px-4 py-3 font-medium text-gray-900">{p.merchantBusinessName}</td>
                      <td className="px-4 py-3 text-gray-700">{describeSurplusPattern(p)}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{p.totalEstLbs.toFixed(1)}</td>
                      <td className="px-4 py-3 text-right text-gray-500 text-xs">
                        <LocalDateTime iso={p.lastSeen} variant="date" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ─── Merchants (read-only) ──────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="font-semibold text-gray-900">
            Merchants <span className="text-sm font-normal text-gray-500">({merchants.length})</span>
          </h2>
          {merchants.length === 0 ? (
            <p className="text-sm text-gray-500">No merchants yet.</p>
          ) : (
            <div className="bg-white border border-gray-200 rounded-2xl overflow-x-auto">
              <table className="w-full text-sm min-w-[720px]">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Business</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">EIN</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Contact</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Plan</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Fee</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Billing</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Metro</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Joined</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {merchants.map(m => {
                    const subscribed = m.subscriptionStatus === 'active' || m.subscriptionStatus === 'trialing';
                    // Only offer "Start" when there is no live subscription — a
                    // delinquent (past_due/unpaid/…) merchant still has one, and a
                    // second Checkout would double-bill (server-enforced too).
                    const canStart = canStartSubscription(m.subscriptionStatus);
                    return (
                    <tr key={m.id}>
                      <td className="px-4 py-3 font-medium text-gray-900">{m.businessName}</td>
                      <td className="px-4 py-3 text-gray-600 font-mono text-xs">{m.ein ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-600 text-xs">
                        {m.contactName ?? '—'}
                        {m.phone ? <><br /><span className="text-gray-400">{m.phone}</span></> : null}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{m.plan}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{formatCents(m.feeCents)}</td>
                      <td className="px-4 py-3 text-gray-600">{m.status}</td>
                      <td className="px-4 py-3 text-xs">
                        <span className={subscribed ? 'text-green-700 font-medium' : 'text-gray-500'}>
                          {m.subscriptionStatus}
                        </span>
                        {canStart && (
                          <form action={startBillingAction} className="mt-1">
                            <input type="hidden" name="merchantId" value={m.id} />
                            <button
                              type="submit"
                              className="bg-blue-600 text-white text-[11px] font-semibold rounded px-2 py-0.5 hover:bg-blue-700"
                            >
                              Start subscription
                            </button>
                          </form>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{m.metroId}</td>
                      <td className="px-4 py-3 text-right text-gray-500 text-xs">
                        <LocalDateTime iso={m.createdAt} variant="date" />
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ─── Loads (read-only, most recent) ─────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="font-semibold text-gray-900">
            Loads <span className="text-sm font-normal text-gray-500">(most recent {loads.length})</span>
          </h2>
          {loads.length === 0 ? (
            <p className="text-sm text-gray-500">No loads yet.</p>
          ) : (
            <div className="bg-white border border-gray-200 rounded-2xl overflow-x-auto">
              <table className="w-full text-sm min-w-[720px]">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Merchant</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Window</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Lane</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Items</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Earliest safety</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Declared</th>
                    <th className="px-4 py-3 font-medium text-gray-600">Receipt</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loads.map(l => {
                    // Donation receipt is available once a donation load is
                    // delivered + recipient-confirmed (issueDonationReceipt/033
                    // re-check the confirm + npo_verified + not-already-issued).
                    const receiptEligible = l.lane === 'donation' && (l.status === 'delivered' || l.status === 'closed');
                    return (
                    <tr key={l.id}>
                      <td className="px-4 py-3 font-medium text-gray-900">{l.merchantBusinessName}</td>
                      <td className="px-4 py-3 text-gray-600">{l.windowDate}</td>
                      <td className="px-4 py-3 text-gray-600">{l.lane}</td>
                      <td className="px-4 py-3 text-gray-600">{l.status}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{l.itemCount}</td>
                      <td className="px-4 py-3 text-right text-gray-500 text-xs">
                        {l.earliestSafetyExpiresAt ? <LocalDateTime iso={l.earliestSafetyExpiresAt} /> : '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500 text-xs">
                        <LocalDateTime iso={l.createdAt} variant="date" />
                      </td>
                      <td className="px-4 py-3">
                        {receiptEligible ? (
                          <form action={generateReceiptAction}>
                            <input type="hidden" name="loadId" value={l.id} />
                            <button type="submit" className="bg-gray-700 text-white text-[11px] font-semibold rounded px-2 py-0.5 hover:bg-gray-800">
                              Generate
                            </button>
                          </form>
                        ) : (
                          <span className="text-gray-300 text-xs">—</span>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ─── Scans (read-only, most recent) ─────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="font-semibold text-gray-900">
            Scans <span className="text-sm font-normal text-gray-500">(most recent {scans.length})</span>
          </h2>
          {scans.length === 0 ? (
            <p className="text-sm text-gray-500">No scans yet.</p>
          ) : (
            <div className="bg-white border border-gray-200 rounded-2xl overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Merchant</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Scanned</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Model</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Confidence</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Items</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Review</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {scans.map(s => (
                    <tr key={s.id} className={s.needsReview ? 'bg-amber-50' : ''}>
                      <td className="px-4 py-3 font-medium text-gray-900">{s.merchantBusinessName}</td>
                      <td className="px-4 py-3 text-right text-gray-500 text-xs">
                        <LocalDateTime iso={s.scannedAt} />
                      </td>
                      <td className="px-4 py-3 text-gray-600 font-mono text-xs">{s.modelId}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{(s.overallConfidence * 100).toFixed(0)}%</td>
                      <td className="px-4 py-3 text-right text-gray-700">{s.itemCount}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {s.needsReview ? <span className="text-amber-700 font-semibold text-xs">NEEDS REVIEW</span> : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
