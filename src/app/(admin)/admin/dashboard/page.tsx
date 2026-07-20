import { createServiceClient } from '@/lib/supabase/server';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { LocalDateTime } from '@/components/LocalDateTime';

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

// Server actions are HTTP endpoints callable by any authenticated user — each
// one must verify the admin role itself; the page-level check doesn't cover them.
async function requireAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const service = await createServiceClient();
  const { data } = await service
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single();

  return data?.role === 'admin';
}

async function updateCommodityPrice(formData: FormData) {
  'use server';
  if (!(await requireAdmin())) return;

  const category = formData.get('category') as string;
  const pricePerLb = Number(formData.get('price_per_lb'));
  const retailBenchmarkPerLb = Number(formData.get('retail_benchmark_per_lb'));
  if (!Number.isFinite(pricePerLb) || pricePerLb <= 0 ||
      !Number.isFinite(retailBenchmarkPerLb) || retailBenchmarkPerLb <= 0) {
    return;
  }

  const service = await createServiceClient();
  await service
    .from('usda_commodity_prices')
    .update({
      price_per_lb: pricePerLb,
      retail_benchmark_per_lb: retailBenchmarkPerLb,
      updated_at: new Date().toISOString(),
    })
    .eq('category', category);

  revalidatePath('/admin/dashboard');
}

async function verifyDonorLicense(formData: FormData) {
  'use server';
  if (!(await requireAdmin())) return;

  const userId = formData.get('user_id') as string;

  const service = await createServiceClient();
  await service
    .from('donor_profiles')
    .update({ license_verified: true })
    .eq('user_id', userId);

  revalidatePath('/admin/dashboard');
}

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

export default async function AdminDashboardPage() {
  await checkAdmin();

  const service = await createServiceClient();

  const [{ data: commodities }, { data: pendingDonors }, { data: recentOrders }] = await Promise.all([
    service.from('usda_commodity_prices').select('*').order('category'),
    service
      .from('donor_profiles')
      .select('user_id, business_name, license_number, type, address, users!inner(email)')
      .eq('license_verified', false)
      .eq('type', 'commercial'),
    service
      .from('orders')
      .select('id, status, created_at, listings(detected_item, consumer_price_cents)')
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  const staleCategories = (commodities ?? []).filter(c => {
    return new Date().getTime() - new Date(c.updated_at).getTime() > SIXTY_DAYS_MS;
  });

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-10">
        <h1 className="text-lg font-bold text-gray-900">Admin dashboard</h1>
      </header>

      <main className="p-4 max-w-4xl mx-auto space-y-8">
        {/* USDA Commodity Prices */}
        <section className="space-y-3">
          <h2 className="font-semibold text-gray-900">USDA Commodity Prices</h2>

          {staleCategories.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800">
              {staleCategories.length} categories are stale (&gt;60 days old) — listings blocked for these categories.
            </div>
          )}

          <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Category</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">$/lb</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Retail $/lb</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Updated</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(commodities ?? []).map(commodity => {
                  const isStale = new Date().getTime() - new Date(commodity.updated_at).getTime() > SIXTY_DAYS_MS;
                  return (
                    <tr key={commodity.id} className={isStale ? 'bg-red-50' : ''}>
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {commodity.category}
                        {isStale && <span className="ml-2 text-xs text-red-600 font-semibold">STALE</span>}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700">${Number(commodity.price_per_lb).toFixed(4)}</td>
                      <td className="px-4 py-3 text-right text-gray-700">${Number(commodity.retail_benchmark_per_lb).toFixed(4)}</td>
                      <td className="px-4 py-3 text-right text-gray-500 text-xs">
                        <LocalDateTime iso={commodity.updated_at} variant="date" />
                      </td>
                      <td className="px-4 py-3">
                        <form action={updateCommodityPrice}>
                          <input type="hidden" name="category" value={commodity.category} />
                          <div className="flex gap-1 items-center">
                            <input
                              type="number"
                              name="price_per_lb"
                              defaultValue={commodity.price_per_lb}
                              step="0.0001"
                              min="0"
                              className="w-20 border border-gray-200 rounded px-2 py-1 text-xs"
                            />
                            <input
                              type="number"
                              name="retail_benchmark_per_lb"
                              defaultValue={commodity.retail_benchmark_per_lb}
                              step="0.0001"
                              min="0"
                              className="w-20 border border-gray-200 rounded px-2 py-1 text-xs"
                            />
                            <button
                              type="submit"
                              className="bg-green-600 text-white text-xs font-semibold rounded px-2 py-1 hover:bg-green-700"
                            >
                              Update
                            </button>
                          </div>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* License Review Queue */}
        <section className="space-y-3">
          <h2 className="font-semibold text-gray-900">
            License Review Queue{' '}
            <span className="text-sm font-normal text-gray-500">({(pendingDonors ?? []).length} pending)</span>
          </h2>

          {(pendingDonors ?? []).length === 0 ? (
            <p className="text-sm text-gray-500">No pending license reviews</p>
          ) : (
            <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Business</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">License #</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Email</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(pendingDonors ?? []).map((donor: Record<string, unknown>) => {
                    const users = donor.users as { email: string } | null;
                    return (
                      <tr key={donor.user_id as string}>
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {(donor.business_name as string) ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                          {(donor.license_number as string) ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-600">{users?.email ?? '—'}</td>
                        <td className="px-4 py-3">
                          <form action={verifyDonorLicense}>
                            <input type="hidden" name="user_id" value={donor.user_id as string} />
                            <button
                              type="submit"
                              className="bg-green-600 text-white text-xs font-semibold rounded px-3 py-1.5 hover:bg-green-700"
                            >
                              Verify
                            </button>
                          </form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Recent Orders */}
        <section className="space-y-3">
          <h2 className="font-semibold text-gray-900">Recent Orders</h2>
          <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Order ID</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Item</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(recentOrders ?? []).map(order => {
                  const listing = order.listings as unknown as { detected_item: string; consumer_price_cents: number } | null;
                  return (
                    <tr key={order.id}>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">
                        {order.id.slice(0, 8)}…
                      </td>
                      <td className="px-4 py-3 text-gray-900">{listing?.detected_item ?? '—'}</td>
                      <td className="px-4 py-3 text-right text-gray-700">
                        ${((listing?.consumer_price_cents ?? 0) / 100).toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{order.status}</td>
                      <td className="px-4 py-3 text-right text-gray-500 text-xs">
                        <LocalDateTime iso={order.created_at} variant="date" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
