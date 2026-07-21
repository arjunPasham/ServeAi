// Phase 2 Task 4 — public, no-login inbound offer view. /inbound is
// deliberately absent from middleware's PREFIX_ROLE (src/lib/supabase/
// middleware.ts) and there is no catch-all auth gate, so this route renders
// for anonymous visitors holding nothing but the token in the URL — that
// token is the capability. See src/actions/inbound.ts for the token-as-
// capability resolution and the exact not-found rule (getInboundOffer's doc
// comment) this page relies on.

import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { LocalDateTime } from '@/components/LocalDateTime';
import { checkInboundViewLimit } from '@/lib/rate-limit';
import { getInboundOffer, respondToOffer } from '@/actions/inbound';

const ERROR_MESSAGES: Record<string, string> = {
  OFFER_NOT_PENDING: 'This offer is no longer pending — it may already have a response.',
  OFFER_EXPIRED: 'This offer has expired.',
  NOT_FOUND: 'This offer could not be found.',
  SERVER_ERROR: 'Something went wrong — please try again.',
};

// Adapts the <form> FormData contract to respondToOffer's typed
// (token, decision) signature, then redirects — same shape as
// offerLoadAction/withdrawOfferAction in
// src/app/(admin)/admin/matching/page.tsx. The hidden `token` field is set
// by THIS page from its own URL param, never client-chosen; respondToOffer
// re-resolves it to an allocation server-side regardless, so there is no
// path to act on a different allocation than the one this token names.
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
  if (!result.success) {
    redirect(`/inbound/${token}?error=${result.error}`);
  }
  redirect(`/inbound/${token}?responded=${decision}`);
}

export default async function InboundOfferPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; responded?: string }>;
}) {
  const { token } = await params;
  const { error, responded } = await searchParams;

  // Rate-limit FIRST, before any DB read (auth.ts's checkX pattern) — a
  // "too many requests" state renders a plain message, never a 500.
  const headerStore = await headers();
  const ip = headerStore.get('x-real-ip') ?? headerStore.get('x-forwarded-for') ?? '0.0.0.0';
  const rateCheck = await checkInboundViewLimit(ip);
  if (!rateCheck.allowed) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <p className="text-sm text-gray-600 text-center">
          Too many requests — please try again shortly.
        </p>
      </main>
    );
  }

  // A just-completed decline moves the allocation to a terminal 'declined'
  // status, which getInboundOffer (by design) treats as not-viewable and
  // returns null for — so this confirmation renders from the redirect's own
  // query param, BEFORE that lookup ever runs, instead of racing the
  // notFound() a reload of this same URL would otherwise hit.
  if (responded === 'declined') {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="bg-white border border-gray-200 rounded-2xl p-6 max-w-md text-center space-y-2">
          <h1 className="font-semibold text-gray-900">Response recorded</h1>
          <p className="text-sm text-gray-600">
            You&apos;ve declined this offer. Thank you for letting us know.
          </p>
        </div>
      </main>
    );
  }

  const offer = await getInboundOffer(token);
  if (!offer) notFound();

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="max-w-lg mx-auto bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
        <header>
          <h1 className="text-lg font-bold text-gray-900">Surplus food offer</h1>
          <p className="text-sm text-gray-500">
            From {offer.merchantBusinessName} · window {offer.windowDate}
          </p>
        </header>

        {error && ERROR_MESSAGES[error] && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800">
            {ERROR_MESSAGES[error]}
          </div>
        )}

        <ul className="text-sm text-gray-700 space-y-1.5">
          {offer.items.map((item, i) => (
            <li key={i} className="flex items-center justify-between gap-2">
              <span>
                {item.foodName} · {item.categoryLabel} · {item.estLbs.toFixed(1)} lbs
              </span>
              {item.safetyExpiresAt && (
                <span className="text-xs text-amber-700 whitespace-nowrap">
                  use by <LocalDateTime iso={item.safetyExpiresAt} />
                </span>
              )}
            </li>
          ))}
        </ul>

        {offer.status === 'accepted' ? (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-4 text-center text-sm text-green-800 font-medium">
            You&apos;ve accepted this delivery. Thank you!
          </div>
        ) : (
          <div className="flex gap-3 pt-2">
            <form action={respondAction} className="flex-1">
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="decision" value="accepted" />
              <button
                type="submit"
                className="w-full min-h-[44px] bg-green-600 hover:bg-green-700 text-white font-semibold rounded-full py-2.5 text-sm transition-colors"
              >
                Accept
              </button>
            </form>
            <form action={respondAction} className="flex-1">
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="decision" value="declined" />
              <button
                type="submit"
                className="w-full min-h-[44px] border border-red-300 text-red-700 hover:bg-red-50 font-semibold rounded-full py-2.5 text-sm transition-colors"
              >
                Decline
              </button>
            </form>
          </div>
        )}
      </div>
    </main>
  );
}
