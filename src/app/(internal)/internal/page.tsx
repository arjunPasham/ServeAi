// Internal staff console — three panels: pipeline health, unit economics, legal
// handoff. All reads are assertInternalStaff-gated (the layout also gates the
// page). Reuses existing tables/views; read-only.

import Link from 'next/link';
import { LocalDateTime } from '@/components/LocalDateTime';
import {
  getPipelineHealth,
  getUnitEconomics,
  getLegalHandoffList,
} from '@/actions/internal';
import { LOAD_STAGES } from '@/lib/loads';

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const STAGE_COLOR: Record<string, string> = {
  declared: 'bg-blue-900 text-blue-200',
  matched: 'bg-purple-900 text-purple-200',
  scheduled: 'bg-purple-900 text-purple-200',
  picked_up: 'bg-amber-900 text-amber-200',
  delivered: 'bg-green-900 text-green-200',
  closed: 'bg-gray-800 text-gray-300',
  canceled: 'bg-gray-800 text-gray-500',
};

const RECEIPT_BADGE: Record<string, string> = {
  none: 'text-gray-500',
  draft: 'text-amber-300',
  issued: 'text-green-300',
};

export default async function InternalConsolePage() {
  const [pipeline, econ, handoffs] = await Promise.all([
    getPipelineHealth(),
    getUnitEconomics(),
    getLegalHandoffList(),
  ]);

  return (
    <main className="max-w-6xl mx-auto p-4 space-y-8">
      <header>
        <h1 className="text-xl font-bold">Internal console</h1>
        <p className="text-sm text-gray-400">Pipeline health · unit economics · legal handoff. Read-only.</p>
      </header>

      {/* ─── A. Pipeline health ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="font-semibold">Pipeline health</h2>
        <div className="flex flex-wrap gap-2">
          {LOAD_STAGES.map(stage => (
            <span key={stage} className={`text-xs font-medium rounded-full px-3 py-1 ${STAGE_COLOR[stage] ?? 'bg-gray-800'}`}>
              {stage}: {pipeline.stageCounts[stage] ?? 0}
            </span>
          ))}
        </div>
        {pipeline.loads.length === 0 ? (
          <p className="text-sm text-gray-500">No loads yet.</p>
        ) : (
          <div className="border border-gray-800 rounded-xl overflow-x-auto">
            <table className="w-full text-sm min-w-[820px]">
              <thead className="bg-gray-900 text-gray-400">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Merchant</th>
                  <th className="text-left px-3 py-2 font-medium">Recipient</th>
                  <th className="text-left px-3 py-2 font-medium">Stage</th>
                  <th className="text-left px-3 py-2 font-medium">Method</th>
                  <th className="text-left px-3 py-2 font-medium">Receipt</th>
                  <th className="text-left px-3 py-2 font-medium">Flags</th>
                  <th className="text-left px-3 py-2 font-medium">Window</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {pipeline.loads.map(l => (
                  <tr key={l.id}>
                    <td className="px-3 py-2">{l.merchantBusinessName}</td>
                    <td className="px-3 py-2 text-gray-400">{l.recipientOrgName ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs rounded-full px-2 py-0.5 ${STAGE_COLOR[l.stage] ?? 'bg-gray-800'}`}>{l.stage}</span>
                    </td>
                    <td className="px-3 py-2 text-gray-400">{l.method ?? '—'}</td>
                    <td className={`px-3 py-2 ${RECEIPT_BADGE[l.receiptState]}`}>{l.receiptState}</td>
                    <td className="px-3 py-2 text-xs">
                      {l.windowBlown && <span className="text-red-400 mr-2">⚠ window blown</span>}
                      {l.hasDiscrepancy && <span className="text-amber-400">⚑ discrepancy</span>}
                      {!l.windowBlown && !l.hasDiscrepancy && <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-3 py-2 text-gray-500 text-xs">{l.windowDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ─── B. Unit economics ──────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="font-semibold">Unit economics</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Scans" value={String(econ.scanCount)} />
          <Stat label="Merchants" value={String(econ.merchantCount)} />
          <Stat label="Avg scans / merchant" value={String(econ.avgScansPerMerchant)} />
          <Stat label="Receipts issued" value={String(econ.receiptsIssued)} />
          <Stat label="Deliveries" value={String(econ.deliveryCount)} />
          <Stat label="Window-blown rate" value={`${(econ.windowBlownRate * 100).toFixed(1)}%`} sub={`${econ.windowBlownCount}/${econ.deliveryCount}`} />
          <Stat label="Est. scan cost" value={fmt(econ.estimatedScanCostCents)} sub={`${econ.costPerScanCents}¢/scan${econ.costConfigured ? '' : ' (assumed)'}`} />
        </div>
        {!econ.costConfigured && (
          <p className="text-xs text-gray-500">
            Cost is derived (scan count × assumed rate) — the scan pipeline doesn&apos;t store Gemini token usage. Set
            <code className="mx-1 text-gray-300">MODEL_COST_PER_SCAN_CENTS</code> for a real rate; capturing per-scan
            usageMetadata for exact costs is a follow-up.
          </p>
        )}
        {econ.topMerchants.length > 0 && (
          <div className="text-xs text-gray-400">
            <span className="text-gray-500">Top by scans: </span>
            {econ.topMerchants.map(m => `${m.merchantId.slice(0, 8)}…: ${m.scanCount}`).join(' · ')}
          </div>
        )}
      </section>

      {/* ─── C. Legal handoff ───────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="font-semibold">Legal handoff — donation receipts</h2>
        <p className="text-xs text-gray-500">
          DRAFT worksheets for CPA/counsel review. Values frozen at issue from the load&apos;s valuation snapshots. Issuance
          finalizes once <code className="text-gray-300">RECEIPT_TEMPLATE_APPROVED=true</code>.
        </p>
        {handoffs.length === 0 ? (
          <p className="text-sm text-gray-500">No receipts issued yet.</p>
        ) : (
          <div className="border border-gray-800 rounded-xl overflow-x-auto">
            <table className="w-full text-sm min-w-[820px]">
              <thead className="bg-gray-900 text-gray-400">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Issued</th>
                  <th className="text-left px-3 py-2 font-medium">Merchant → Recipient</th>
                  <th className="text-right px-3 py-2 font-medium">FMV</th>
                  <th className="text-right px-3 py-2 font-medium">Basis</th>
                  <th className="text-right px-3 py-2 font-medium">170(e)(3)</th>
                  <th className="text-left px-3 py-2 font-medium">State</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {handoffs.map(h => (
                  <tr key={h.receiptId}>
                    <td className="px-3 py-2 text-gray-400 text-xs"><LocalDateTime iso={h.issuedAt} variant="date" /></td>
                    <td className="px-3 py-2">{h.merchantBusinessName} <span className="text-gray-500">→</span> {h.recipientOrgName}</td>
                    <td className="px-3 py-2 text-right">{fmt(h.fmvTotalCents)}</td>
                    <td className="px-3 py-2 text-right text-gray-400">{fmt(h.basisTotalCents)}</td>
                    <td className="px-3 py-2 text-right text-green-300">{fmt(h.enhancedDeductionCents)}</td>
                    <td className="px-3 py-2">
                      <span className={h.templateApproved ? 'text-green-300 text-xs' : 'text-amber-300 text-xs font-semibold'}>
                        {h.templateApproved ? 'ISSUED' : 'DRAFT'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link href={`/internal/receipts/${h.receiptId}`} className="text-blue-400 hover:text-blue-300 text-xs">
                        Review →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-gray-800 rounded-xl p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {sub && <div className="text-[11px] text-gray-500">{sub}</div>}
    </div>
  );
}
