// Ops matching console (Phase 2 Task 3). "Ops is the algorithm" — there is
// no auto-matching; every offer/withdraw here is a deliberate admin action,
// and the underlying RPCs record it (audit_log). checkAdmin() below is
// copied VERBATIM from src/app/(admin)/admin/dashboard/page.tsx.

import { createClient, createServiceClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { LocalDateTime } from '@/components/LocalDateTime';
import {
  getMatchableLoads,
  getInstitutions,
  getSuggestedMatches,
  offerLoad,
  withdrawOffer,
  type SuggestedMatch,
} from '@/actions/allocations';
import { isEligibleInstitution } from '@/lib/match-score';

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

// How many ranked suggestions to show per load before falling back to the
// manual-override picker for the rest — a presentation cap, not a data-layer
// one; getSuggestedMatches itself returns the full ranked list.
const SUGGESTION_DISPLAY_LIMIT = 5;

const ERROR_MESSAGES: Record<string, string> = {
  NOT_ADMIN: 'Not authorized.',
  LOAD_NOT_OFFERABLE: 'That load is no longer offerable — it may already be matched, withdrawn, or resolved.',
  INSTITUTION_NOT_ELIGIBLE: "That institution isn't eligible for this load's lane (must be active, and npo_verified for a donation).",
  ALREADY_ALLOCATED: 'That load already has an active offer.',
  SAFETY_WINDOW_PASSED: "This load's safety window has already passed — it can no longer be offered.",
  OFFER_NOT_ACTIVE: 'That offer is no longer active.',
  SERVER_ERROR: 'Something went wrong — try again.',
};

// Wrapper server actions: adapt the <form> FormData contract to
// allocations.ts's typed-argument functions, then revalidate. Both delegate
// to an action that already requireAdmin-gates itself (offerLoad/
// withdrawOffer return { success:false, error:'NOT_ADMIN' } for a non-admin
// caller), so there's no separate admin check to duplicate here — a
// redundant one would just be two sources of truth for the same guard.
async function offerLoadAction(formData: FormData) {
  'use server';
  const loadId = String(formData.get('loadId') ?? '');
  const institutionId = String(formData.get('institutionId') ?? '');
  const result = await offerLoad(loadId, institutionId);
  revalidatePath('/admin/matching');
  if (!result.success) redirect(`/admin/matching?error=${encodeURIComponent(result.error)}`);
  redirect('/admin/matching');
}

async function withdrawOfferAction(formData: FormData) {
  'use server';
  const allocationId = String(formData.get('allocationId') ?? '');
  const result = await withdrawOffer(allocationId);
  revalidatePath('/admin/matching');
  if (!result.success) redirect(`/admin/matching?error=${encodeURIComponent(result.error)}`);
  redirect('/admin/matching');
}

export default async function AdminMatchingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await checkAdmin();
  const { error } = await searchParams;

  const [loads, institutions] = await Promise.all([getMatchableLoads(), getInstitutions()]);

  // One getSuggestedMatches call per not-yet-allocated load — each is its own
  // read (a load with an active allocation doesn't need suggestions at all).
  const suggestionsByLoad = new Map<string, SuggestedMatch[]>();
  await Promise.all(
    loads
      .filter(load => !load.activeAllocation)
      .map(async load => {
        suggestionsByLoad.set(load.id, await getSuggestedMatches(load.id));
      })
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-10">
        <h1 className="text-lg font-bold text-gray-900">Ops matching console</h1>
        <p className="text-sm text-gray-500">
          {loads.length} load{loads.length === 1 ? '' : 's'} awaiting a match decision
        </p>
      </header>

      <main className="p-4 max-w-4xl mx-auto space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800">
            {ERROR_MESSAGES[error] ?? `Action failed: ${error}`}
          </div>
        )}

        {loads.length === 0 ? (
          <p className="text-sm text-gray-500">No loads need matching right now.</p>
        ) : (
          loads.map(load => {
            const suggestions = (suggestionsByLoad.get(load.id) ?? []).slice(0, SUGGESTION_DISPLAY_LIMIT);
            const eligibleInstitutions = institutions.filter(inst =>
              isEligibleInstitution({ status: 'active', npoVerified: inst.npoVerified, lane: load.lane })
            );

            return (
              <section key={load.id} className="bg-white border border-gray-200 rounded-2xl p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h2 className="font-semibold text-gray-900 text-sm">
                      {load.merchantBusinessName} · {load.items.length} item{load.items.length === 1 ? '' : 's'} ·{' '}
                      {load.totalEstLbs.toFixed(1)} lbs
                    </h2>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Window: {load.windowDate} · Lane: {load.lane}
                    </p>
                  </div>
                  {load.earliestSafetyExpiresAt && (
                    <p className="text-xs text-amber-700 text-right">
                      Earliest safety expiry
                      <br />
                      <LocalDateTime iso={load.earliestSafetyExpiresAt} />
                    </p>
                  )}
                </div>

                <ul className="text-xs text-gray-600 space-y-0.5">
                  {load.items.map(item => (
                    <li key={item.scanItemId}>
                      {item.foodName} — {item.categoryKey} — {item.estLbs.toFixed(1)} lbs
                      {item.safetyExpiresAt && (
                        <>
                          {' '}
                          (expires <LocalDateTime iso={item.safetyExpiresAt} />)
                        </>
                      )}
                    </li>
                  ))}
                </ul>

                {load.activeAllocation ? (
                  <div className="bg-purple-50 border border-purple-200 rounded-xl px-3 py-2 flex items-center justify-between gap-3">
                    <div className="text-xs text-purple-800">
                      <p className="font-semibold">{load.activeAllocation.institutionOrgName}</p>
                      <p>
                        Status: {load.activeAllocation.status} · expires{' '}
                        <LocalDateTime iso={load.activeAllocation.expiresAt} />
                      </p>
                    </div>
                    <form action={withdrawOfferAction}>
                      <input type="hidden" name="allocationId" value={load.activeAllocation.id} />
                      <button
                        type="submit"
                        className="bg-gray-700 text-white text-xs font-semibold rounded px-3 py-1.5 hover:bg-gray-800"
                      >
                        Withdraw
                      </button>
                    </form>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {suggestions.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-xs font-medium text-gray-500">Suggested (ranked)</p>
                        {suggestions.map(s => (
                          <form
                            key={s.institutionId}
                            action={offerLoadAction}
                            className="flex items-center justify-between gap-2 text-xs bg-gray-50 rounded-lg px-3 py-2"
                          >
                            <input type="hidden" name="loadId" value={load.id} />
                            <input type="hidden" name="institutionId" value={s.institutionId} />
                            <span className="text-gray-700">
                              {s.orgName}{' '}
                              <span className="text-gray-400">
                                score {s.score.toFixed(2)} · {s.recentOfferCount} recent offer{s.recentOfferCount === 1 ? '' : 's'}
                              </span>
                            </span>
                            <button
                              type="submit"
                              className="bg-green-600 text-white font-semibold rounded px-3 py-1 hover:bg-green-700"
                            >
                              Offer
                            </button>
                          </form>
                        ))}
                      </div>
                    )}

                    <form action={offerLoadAction} className="flex items-center gap-2 text-xs">
                      <input type="hidden" name="loadId" value={load.id} />
                      <select
                        name="institutionId"
                        required
                        defaultValue=""
                        className="border border-gray-200 rounded px-2 py-1.5 flex-1"
                      >
                        <option value="" disabled>
                          Manual override — pick an institution…
                        </option>
                        {eligibleInstitutions.map(inst => (
                          <option key={inst.id} value={inst.id}>
                            {inst.orgName}
                          </option>
                        ))}
                      </select>
                      <button
                        type="submit"
                        className="bg-blue-600 text-white font-semibold rounded px-3 py-1.5 hover:bg-blue-700"
                      >
                        Offer
                      </button>
                    </form>
                  </div>
                )}
              </section>
            );
          })
        )}
      </main>
    </div>
  );
}
