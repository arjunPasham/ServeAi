// Phase 2 Task 4 + v3 Task 2 — public, no-login inbound view. /inbound is
// deliberately absent from middleware's PREFIX_ROLE (src/lib/supabase/
// middleware.ts) and there is no catch-all auth gate, so this route renders
// for anonymous visitors holding nothing but the token in the URL — that token
// is the capability. After the recipient accepts, this same page carries the
// v3 recipient-confirm flow: confirm receipt on arrival, then (within the
// dispute window) optionally flag a discrepancy — recorded, not refereed.

import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { LocalDateTime } from '@/components/LocalDateTime';
import { checkInboundViewLimit } from '@/lib/rate-limit';
import {
  getInboundOffer,
  getInboundDelivery,
  respondToOffer,
  confirmInboundDelivery,
  flagInboundDiscrepancy,
} from '@/actions/inbound';
import { deliveryMethodLabel } from '@/lib/deliveries';

const ERROR_MESSAGES: Record<string, string> = {
  OFFER_NOT_PENDING: 'This offer is no longer pending — it may already have a response.',
  OFFER_EXPIRED: 'This offer has expired.',
  NOT_FOUND: 'This offer could not be found.',
  SIGNER_REQUIRED: 'Please enter the name of the person receiving.',
  NO_DELIVERY: 'The merchant hasn’t arranged delivery yet.',
  NOT_CONFIRMABLE: 'This load can’t be confirmed right now.',
  REASON_REQUIRED: 'Please describe the discrepancy.',
  WINDOW_CLOSED: 'The window to flag a discrepancy has closed.',
  SERVER_ERROR: 'Something went wrong — please try again.',
};

async function respondAction(formData: FormData) {
  'use server';
  const token = String(formData.get('token') ?? '');
  const decisionRaw = String(formData.get('decision') ?? '');
  if (decisionRaw !== 'accepted' && decisionRaw !== 'declined') {
    redirect(`/inbound/${token}?error=SERVER_ERROR`);
  }
  const decision = decisionRaw as 'accepted' | 'declined';
  const result = await respondToOffer(token, decision);
  revalidatePath(`/inbound/${token}`);
  if (!result.success) redirect(`/inbound/${token}?error=${result.error}`);
  redirect(`/inbound/${token}?responded=${decision}`);
}

async function confirmAction(formData: FormData) {
  'use server';
  const token = String(formData.get('token') ?? '');
  const signerName = String(formData.get('signerName') ?? '');
  const discrepancyReason = String(formData.get('discrepancyReason') ?? '');
  const result = await confirmInboundDelivery(token, signerName, discrepancyReason || undefined);
  revalidatePath(`/inbound/${token}`);
  if (!result.success) redirect(`/inbound/${token}?error=${result.error}`);
  redirect(`/inbound/${token}?done=confirmed`);
}

async function flagAction(formData: FormData) {
  'use server';
  const token = String(formData.get('token') ?? '');
  const reason = String(formData.get('reason') ?? '');
  const result = await flagInboundDiscrepancy(token, reason);
  revalidatePath(`/inbound/${token}`);
  if (!result.success) redirect(`/inbound/${token}?error=${result.error}`);
  redirect(`/inbound/${token}?done=flagged`);
}

export default async function InboundOfferPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; responded?: string; done?: string }>;
}) {
  const { token } = await params;
  const { error, responded, done } = await searchParams;

  const headerStore = await headers();
  const ip = headerStore.get('x-real-ip') ?? headerStore.get('x-forwarded-for') ?? '0.0.0.0';
  const rateCheck = await checkInboundViewLimit(ip);
  if (!rateCheck.allowed) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <p className="text-sm text-gray-600 text-center">Too many requests — please try again shortly.</p>
      </main>
    );
  }

  // A just-completed decline moves the allocation to a terminal 'declined'
  // status that getInboundOffer treats as not-viewable — render from the query
  // param before that lookup returns null.
  if (responded === 'declined') {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="bg-white border border-gray-200 rounded-2xl p-6 max-w-md text-center space-y-2">
          <h1 className="font-semibold text-gray-900">Response recorded</h1>
          <p className="text-sm text-gray-600">You&apos;ve declined this offer. Thank you for letting us know.</p>
        </div>
      </main>
    );
  }

  const offer = await getInboundOffer(token);
  if (!offer) notFound();

  const errorBanner = error && ERROR_MESSAGES[error] && (
    <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800">
      {ERROR_MESSAGES[error]}
    </div>
  );

  const itemList = (
    <ul className="text-sm text-gray-700 space-y-1.5">
      {offer.items.map((item, i) => (
        <li key={i} className="flex items-center justify-between gap-2">
          <span>{item.foodName} · {item.categoryLabel} · {item.estLbs.toFixed(1)} lbs</span>
          {item.safetyExpiresAt && (
            <span className="text-xs text-amber-700 whitespace-nowrap">
              use by <LocalDateTime iso={item.safetyExpiresAt} />
            </span>
          )}
        </li>
      ))}
    </ul>
  );

  // ── Still an open offer: accept / decline (Phase 2) ──
  if (offer.status === 'viewable') {
    return (
      <main className="min-h-screen bg-gray-50 px-4 py-8">
        <div className="max-w-lg mx-auto bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
          <header>
            <h1 className="text-lg font-bold text-gray-900">Surplus food offer</h1>
            <p className="text-sm text-gray-500">From {offer.merchantBusinessName} · window {offer.windowDate}</p>
          </header>
          {errorBanner}
          {itemList}
          <div className="flex gap-3 pt-2">
            <form action={respondAction} className="flex-1">
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="decision" value="accepted" />
              <button type="submit" className="w-full min-h-[44px] bg-green-600 hover:bg-green-700 text-white font-semibold rounded-full py-2.5 text-sm transition-colors">
                Accept
              </button>
            </form>
            <form action={respondAction} className="flex-1">
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="decision" value="declined" />
              <button type="submit" className="w-full min-h-[44px] border border-red-300 text-red-700 hover:bg-red-50 font-semibold rounded-full py-2.5 text-sm transition-colors">
                Decline
              </button>
            </form>
          </div>
        </div>
      </main>
    );
  }

  // ── Accepted: v3 recipient-confirm flow ──
  const delivery = await getInboundDelivery(token);
  const loadStatus = delivery?.loadStatus ?? 'matched';

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="max-w-lg mx-auto bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
        <header>
          <h1 className="text-lg font-bold text-gray-900">Your accepted load</h1>
          <p className="text-sm text-gray-500">From {offer.merchantBusinessName} · window {offer.windowDate}</p>
        </header>
        {errorBanner}
        {done === 'confirmed' && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800">
            Receipt confirmed — thank you.
          </div>
        )}
        {done === 'flagged' && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
            Discrepancy recorded. The merchant has been notified.
          </div>
        )}
        {itemList}
        {delivery?.method && (
          <p className="text-xs text-gray-500">Method: {deliveryMethodLabel(delivery.method)}</p>
        )}

        {/* matched: merchant hasn't arranged delivery yet */}
        {loadStatus === 'matched' && (
          <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-4 text-center text-sm text-gray-600">
            You&apos;ve accepted this load. The merchant is arranging delivery — you&apos;ll confirm receipt here when it arrives.
          </div>
        )}

        {/* scheduled / picked_up: confirm receipt on arrival */}
        {(loadStatus === 'scheduled' || loadStatus === 'picked_up') && (
          <form action={confirmAction} className="space-y-3 pt-1">
            <input type="hidden" name="token" value={token} />
            <div>
              <label htmlFor="signerName" className="block text-sm font-medium text-gray-700 mb-1">Received by (your name)</label>
              <input id="signerName" name="signerName" required placeholder="e.g. Maria Lopez"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label htmlFor="discrepancyReason" className="block text-sm font-medium text-gray-700 mb-1">
                Anything wrong? <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <textarea id="discrepancyReason" name="discrepancyReason" rows={2} placeholder="Leave blank if everything looks good"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <button type="submit" className="w-full min-h-[44px] bg-green-600 hover:bg-green-700 text-white font-semibold rounded-full py-2.5 text-sm transition-colors">
              Confirm receipt
            </button>
          </form>
        )}

        {/* delivered: received; flag within the open window */}
        {loadStatus === 'delivered' && (
          <div className="space-y-3">
            <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800">
              Received{delivery?.signerName ? ` by ${delivery.signerName}` : ''}
              {delivery?.deliveredAt && <> · <LocalDateTime iso={delivery.deliveredAt} /></>}.
            </div>
            {delivery?.discrepancyReason && (
              <p className="text-sm text-amber-800">Flagged: {delivery.discrepancyReason}</p>
            )}
            {delivery?.windowOpen ? (
              <form action={flagAction} className="space-y-2">
                <input type="hidden" name="token" value={token} />
                <label htmlFor="reason" className="block text-sm font-medium text-gray-700">
                  Flag a discrepancy {delivery?.disputeWindowExpiresAt && (
                    <span className="font-normal text-gray-400">(until <LocalDateTime iso={delivery.disputeWindowExpiresAt} />)</span>
                  )}
                </label>
                <textarea id="reason" name="reason" rows={2} required placeholder="Describe what was wrong"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                <button type="submit" className="w-full min-h-[44px] border border-amber-400 text-amber-800 hover:bg-amber-50 font-semibold rounded-full py-2 text-sm transition-colors">
                  Flag a discrepancy
                </button>
              </form>
            ) : (
              <p className="text-xs text-gray-500">The window to flag a discrepancy has closed.</p>
            )}
          </div>
        )}

        {/* closed */}
        {loadStatus === 'closed' && (
          <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-4 text-sm text-gray-600 space-y-1">
            <p className="font-medium text-gray-800">Received &amp; closed.</p>
            {delivery?.signerName && <p>Received by {delivery.signerName}.</p>}
            {delivery?.discrepancyReason && <p className="text-amber-800">Flagged: {delivery.discrepancyReason}</p>}
          </div>
        )}
      </div>
    </main>
  );
}
