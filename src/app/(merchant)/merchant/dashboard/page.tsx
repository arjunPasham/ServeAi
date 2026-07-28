// Merchant dashboard (Phase 1 pivot + v3 Delivery-log): declared loads, the scan
// CTA, and — for matched loads the recipient accepted — the records-only delivery
// workflow (pick method + party -> scheduled, then mark picked up). Recipient
// confirms delivery in Task 2. No routing/dispatch/courier — v3 records only.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getMerchantDashboard } from '@/actions/manifest';
import { getDeliverableLoads, setDeliveryMethod, markPickedUp } from '@/actions/deliveries';
import { DELIVERY_METHODS, RESPONSIBLE_PARTIES, deliveryMethodLabel, responsiblePartyLabel } from '@/lib/deliveries';
import { LocalDateTime } from '@/components/LocalDateTime';

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  declared:  { label: 'Declared',   color: 'bg-blue-100 text-blue-700' },
  matched:   { label: 'Matched',    color: 'bg-purple-100 text-purple-700' },
  scheduled: { label: 'Scheduled',  color: 'bg-purple-100 text-purple-700' },
  picked_up: { label: 'Picked up',  color: 'bg-amber-100 text-amber-700' },
  delivered: { label: 'Delivered',  color: 'bg-green-100 text-green-800' },
  closed:    { label: 'Closed',     color: 'bg-gray-100 text-gray-600' },
  canceled:  { label: 'Canceled',   color: 'bg-gray-100 text-gray-500' },
};

const DELIVERY_ERROR: Record<string, string> = {
  NOT_A_MERCHANT: 'Not authorized.',
  INVALID_METHOD: 'Pick a valid delivery method.',
  INVALID_PARTY: 'Pick who is responsible.',
  LOAD_NOT_FOUND: 'That load was not found.',
  LOAD_NOT_SCHEDULABLE: 'That load can no longer be scheduled.',
  OFFER_NOT_ACCEPTED: 'The recipient hasn’t accepted this load yet.',
  ALREADY_SCHEDULED: 'A delivery method was already set for this load.',
  LOAD_NOT_PICKUPABLE: 'That load can’t be marked picked up right now.',
  NO_DELIVERY: 'Set a delivery method first.',
  SERVER_ERROR: 'Something went wrong — try again.',
};

async function setDeliveryMethodAction(formData: FormData) {
  'use server';
  const loadId = String(formData.get('loadId') ?? '');
  const allocationId = String(formData.get('allocationId') ?? '');
  const method = String(formData.get('method') ?? '');
  const responsibleParty = String(formData.get('responsibleParty') ?? '');
  const notes = String(formData.get('notes') ?? '');
  const result = await setDeliveryMethod(loadId, allocationId, method, responsibleParty, notes || undefined);
  revalidatePath('/merchant/dashboard');
  redirect(result.success ? '/merchant/dashboard?ok=scheduled' : `/merchant/dashboard?error=${encodeURIComponent(result.error)}`);
}

async function markPickedUpAction(formData: FormData) {
  'use server';
  const loadId = String(formData.get('loadId') ?? '');
  const result = await markPickedUp(loadId);
  revalidatePath('/merchant/dashboard');
  if (!result.success) redirect(`/merchant/dashboard?error=${encodeURIComponent(result.error)}`);
  redirect(`/merchant/dashboard?ok=${result.windowBlown ? 'picked_up_window_blown' : 'picked_up'}`);
}

export default async function MerchantDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { error, ok } = await searchParams;

  const dashboard = await getMerchantDashboard();
  if (!dashboard.ok) {
    // 'not_a_merchant' goes to a stable dead end, not /login — redirecting
    // there for an already-authenticated donor just bounces straight back to
    // this page (the redirect-loop debt fix; see getMerchantDashboard).
    redirect(dashboard.authz === 'not_a_merchant' ? '/merchant/no-account' : '/login');
  }

  const deliverable = await getDeliverableLoads();

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-10">
        <div className="flex items-center justify-between max-w-lg mx-auto">
          <div>
            <h1 className="text-lg font-bold text-gray-900">{dashboard.businessName}</h1>
            <p className="text-sm text-gray-500">{dashboard.loads.length} recent loads</p>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/merchant/billing" className="text-sm text-gray-500 hover:text-gray-700">
              Billing
            </Link>
            <Link
              href="/merchant/scan"
              className="min-h-[44px] flex items-center bg-green-600 hover:bg-green-700 text-white font-semibold rounded-full px-5 text-sm transition-colors"
            >
              + Scan surplus
            </Link>
          </div>
        </div>
      </header>

      <main className="p-4 max-w-lg mx-auto space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800">
            {DELIVERY_ERROR[error] ?? 'Something went wrong.'}
          </div>
        )}
        {ok === 'scheduled' && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800">
            Delivery method recorded.
          </div>
        )}
        {ok === 'picked_up' && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800">
            Marked picked up.
          </div>
        )}
        {ok === 'picked_up_window_blown' && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
            Marked picked up — recorded past the safety window (flagged, not blocked).
          </div>
        )}

        {/* ─── Delivery (v3 records-only): matched-and-accepted loads in handoff ─ */}
        {deliverable.length > 0 && (
          <section className="space-y-2">
            <h2 className="font-semibold text-gray-900 text-sm px-1">Delivery</h2>
            {deliverable.map(load => {
              const status = STATUS_LABEL[load.status] ?? { label: load.status, color: 'bg-gray-100 text-gray-600' };
              return (
                <div key={load.id} className="bg-white border border-gray-200 rounded-2xl p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-semibold text-gray-900 text-sm">
                        {load.recipientOrgName ?? 'Recipient'} · {load.totalEstLbs.toFixed(1)} lbs
                      </h3>
                      <p className="text-xs text-gray-500 mt-0.5">Window: {load.windowDate}</p>
                    </div>
                    <span className={`text-xs font-medium rounded-full px-2 py-0.5 ${status.color}`}>{status.label}</span>
                  </div>

                  {load.delivery && (
                    <p className="text-xs text-gray-600">
                      {deliveryMethodLabel(load.delivery.method)} · {responsiblePartyLabel(load.delivery.responsibleParty)}
                      {load.delivery.pickedUpAt && (
                        <> · picked up <LocalDateTime iso={load.delivery.pickedUpAt} /></>
                      )}
                      {load.delivery.deliveredAt && (
                        <> · delivered <LocalDateTime iso={load.delivery.deliveredAt} /></>
                      )}
                      {load.delivery.windowBlown && (
                        <span className="ml-1 text-amber-700 font-semibold">⚠ safety window blown</span>
                      )}
                    </p>
                  )}

                  {/* matched + accepted, no delivery yet → pick method */}
                  {load.status === 'matched' && load.acceptedAllocationId && (
                    <form action={setDeliveryMethodAction} className="space-y-2 pt-1">
                      <input type="hidden" name="loadId" value={load.id} />
                      <input type="hidden" name="allocationId" value={load.acceptedAllocationId} />
                      <div className="flex gap-2">
                        <label className="sr-only" htmlFor={`method-${load.id}`}>Delivery method</label>
                        <select id={`method-${load.id}`} name="method" required defaultValue="" className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-xs">
                          <option value="" disabled>Method…</option>
                          {DELIVERY_METHODS.map(m => (
                            <option key={m} value={m}>{deliveryMethodLabel(m)}</option>
                          ))}
                        </select>
                        <label className="sr-only" htmlFor={`party-${load.id}`}>Responsible party</label>
                        <select id={`party-${load.id}`} name="responsibleParty" required defaultValue="" className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-xs">
                          <option value="" disabled>Who…</option>
                          {RESPONSIBLE_PARTIES.map(p => (
                            <option key={p} value={p}>{responsiblePartyLabel(p)}</option>
                          ))}
                        </select>
                      </div>
                      <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded px-3 py-1.5">
                        Schedule delivery
                      </button>
                    </form>
                  )}

                  {load.status === 'matched' && !load.acceptedAllocationId && (
                    <p className="text-xs text-gray-500">Awaiting recipient acceptance.</p>
                  )}

                  {load.status === 'scheduled' && (
                    <form action={markPickedUpAction} className="pt-1">
                      <input type="hidden" name="loadId" value={load.id} />
                      <button type="submit" className="w-full bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded px-3 py-1.5">
                        Mark picked up
                      </button>
                    </form>
                  )}

                  {load.status === 'picked_up' && (
                    <p className="text-xs text-gray-500">Picked up — awaiting the recipient&apos;s confirmation on arrival.</p>
                  )}
                  {load.status === 'delivered' && (
                    <p className="text-xs text-green-700">Delivered — recipient confirmation pending close-out.</p>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {/* ─── Loads history ─────────────────────────────────────────────── */}
        {dashboard.loads.length === 0 ? (
          <div className="text-center py-20 space-y-4">
            <p className="text-gray-500 font-medium">No loads declared yet</p>
            <p className="text-sm text-gray-400">Scan tonight&apos;s surplus — it takes about four minutes.</p>
            <Link
              href="/merchant/scan"
              className="inline-flex min-h-[44px] items-center bg-green-600 hover:bg-green-700 text-white font-semibold rounded-full px-6 py-3 text-sm transition-colors"
            >
              Scan your first load
            </Link>
          </div>
        ) : (
          dashboard.loads.map(load => {
            const status = STATUS_LABEL[load.status] ?? { label: load.status, color: 'bg-gray-100 text-gray-600' };
            const totalLbs = load.load_items.reduce((sum, li) => sum + Number(li.est_lbs), 0);
            const totalFmv = load.load_items.reduce(
              (sum, li) => sum + Math.round(li.fmv_per_lb_cents * Number(li.est_lbs)), 0);
            return (
              <div key={load.id} className="bg-white border border-gray-200 rounded-2xl p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold text-gray-900 text-sm">
                      {load.load_items.length} item{load.load_items.length === 1 ? '' : 's'} · {totalLbs.toFixed(1)} lbs
                    </h3>
                    <p className="text-xs text-gray-500 mt-0.5">Window: {load.window_date}</p>
                  </div>
                  <div className="text-right space-y-1">
                    <span className={`text-xs font-medium rounded-full px-2 py-0.5 ${status.color}`}>{status.label}</span>
                    <div className="text-sm font-semibold text-gray-900">{centsToDollars(totalFmv)} FMV</div>
                  </div>
                </div>
                {load.earliest_safety_expires_at && (
                  <p className="text-xs text-amber-700">
                    Earliest safety expiry: <LocalDateTime iso={load.earliest_safety_expires_at} />
                  </p>
                )}
              </div>
            );
          })
        )}
      </main>
    </div>
  );
}
