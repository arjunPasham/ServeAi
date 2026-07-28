// Legal-handoff detail (v3 Task 2, Panel C) — one donation receipt laid out for
// CPA/counsel review: frozen totals + 170(e)(3), the line-item breakdown, and
// the delivery/confirm record (signer, stamps, blown-window / discrepancy). This
// is the artifact that unblocks receipt go-live. Gated by the (internal) layout;
// the read re-checks internal-staff itself.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LocalDateTime } from '@/components/LocalDateTime';
import { getLegalHandoffDetail } from '@/actions/internal';
import { RECEIPT_DISCLAIMER } from '@/lib/receipt';
import { deliveryMethodLabel, responsiblePartyLabel } from '@/lib/deliveries';

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default async function LegalHandoffDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getLegalHandoffDetail(id);
  if (!detail) notFound();
  const h = detail.header;

  return (
    <main className="max-w-3xl mx-auto p-4 space-y-6">
      <Link href="/internal" className="text-blue-400 hover:text-blue-300 text-sm">← Internal console</Link>

      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Donation receipt worksheet</h1>
        <span className={h.templateApproved ? 'text-green-300 text-sm font-semibold' : 'text-amber-300 text-sm font-semibold'}>
          {h.templateApproved ? 'ISSUED (template approved)' : 'DRAFT — pending template approval'}
        </span>
      </div>

      <section className="border border-gray-800 rounded-xl p-4 text-sm space-y-1">
        <p><span className="text-gray-500">Donor (merchant):</span> {h.merchantBusinessName}</p>
        <p><span className="text-gray-500">Donee (recipient):</span> {h.recipientOrgName}</p>
        <p><span className="text-gray-500">Window date:</span> {detail.windowDate}</p>
        <p><span className="text-gray-500">Issued:</span> <LocalDateTime iso={h.issuedAt} /></p>
        <p><span className="text-gray-500">Received by:</span> {h.signerName ?? '—'}</p>
        <p><span className="text-gray-500">Method version:</span> {h.methodVersion}</p>
      </section>

      <section className="border border-gray-800 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[560px]">
          <thead className="bg-gray-900 text-gray-400">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Item</th>
              <th className="text-left px-3 py-2 font-medium">Category</th>
              <th className="text-right px-3 py-2 font-medium">Lbs</th>
              <th className="text-right px-3 py-2 font-medium">FMV</th>
              <th className="text-right px-3 py-2 font-medium">Basis</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {detail.lines.map((l, i) => (
              <tr key={i}>
                <td className="px-3 py-2">{l.foodName}</td>
                <td className="px-3 py-2 text-gray-400">{l.categoryLabel}</td>
                <td className="px-3 py-2 text-right">{l.estLbs.toFixed(1)}</td>
                <td className="px-3 py-2 text-right">{fmt(l.fmvCents)}</td>
                <td className="px-3 py-2 text-right text-gray-400">{fmt(l.basisCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-gray-700">
            <tr className="font-semibold">
              <td className="px-3 py-2" colSpan={3}>Totals</td>
              <td className="px-3 py-2 text-right">{fmt(h.fmvTotalCents)}</td>
              <td className="px-3 py-2 text-right">{fmt(h.basisTotalCents)}</td>
            </tr>
            <tr className="font-semibold">
              <td className="px-3 py-2 text-green-300" colSpan={4}>Enhanced deduction (IRC 170(e)(3))</td>
              <td className="px-3 py-2 text-right text-green-300">{fmt(h.enhancedDeductionCents)}</td>
            </tr>
          </tfoot>
        </table>
      </section>

      <section className="border border-gray-800 rounded-xl p-4 text-sm space-y-1">
        <h2 className="font-semibold mb-1">Delivery / confirm record</h2>
        {detail.delivery ? (
          <>
            <p><span className="text-gray-500">Method:</span> {deliveryMethodLabel(detail.delivery.method)} · {responsiblePartyLabel(detail.delivery.responsibleParty)}</p>
            <p><span className="text-gray-500">Picked up:</span> {detail.delivery.pickedUpAt ? <LocalDateTime iso={detail.delivery.pickedUpAt} /> : '—'}</p>
            <p><span className="text-gray-500">Delivered:</span> {detail.delivery.deliveredAt ? <LocalDateTime iso={detail.delivery.deliveredAt} /> : '—'}</p>
            <p><span className="text-gray-500">Recipient acknowledged:</span> {detail.delivery.acknowledgedAt ? <LocalDateTime iso={detail.delivery.acknowledgedAt} /> : '—'}</p>
            {detail.delivery.windowBlown && <p className="text-red-400">⚠ Safety window was blown (recorded, not blocked).</p>}
            {detail.delivery.discrepancyReason && <p className="text-amber-400">⚑ Discrepancy flagged: {detail.delivery.discrepancyReason}</p>}
          </>
        ) : (
          <p className="text-gray-500">No delivery record.</p>
        )}
      </section>

      <p className="text-xs text-gray-500 border-t border-gray-800 pt-3">{RECEIPT_DISCLAIMER}</p>
    </main>
  );
}
