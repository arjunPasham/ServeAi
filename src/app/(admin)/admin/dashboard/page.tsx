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

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  await checkAdmin();
  const { error, ok } = await searchParams;

  const [catalog, merchants, loads, scans] = await Promise.all([
    getValuationCatalog(),
    getAdminMerchants(),
    getAdminLoads(),
    getAdminScans(),
  ]);

  const current = currentValuations(catalog.valuations);

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
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Metro</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Joined</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {merchants.map(m => (
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
                      <td className="px-4 py-3 text-gray-600">{m.metroId}</td>
                      <td className="px-4 py-3 text-right text-gray-500 text-xs">
                        <LocalDateTime iso={m.createdAt} variant="date" />
                      </td>
                    </tr>
                  ))}
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
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loads.map(l => (
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
                    </tr>
                  ))}
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
