/**
 * Seeded review walkthrough (v3 Task 3) — DEV/OPS ONLY.
 *
 *   npx tsx scripts/seed-review-walkthrough.ts          # seed (idempotent)
 *   npx tsx scripts/seed-review-walkthrough.ts --clear  # remove the demo data
 *
 * Stands up ONE demo merchant (with a real, phone-verified login), ONE verified
 * 501(c)(3) institution, and a handful of loads PARKED at each v3 stage so you
 * can click every stage with real data — no hand-standing-up accounts:
 *   • declared            — merchant dashboard; ops can offer it in /admin/matching
 *   • offered             — open /inbound/<token> and click Accept
 *   • scheduled           — merchant "Mark picked up"; recipient "Confirm receipt"
 *   • delivered + receipt — /internal legal-handoff DRAFT worksheet
 *   • delivered + blown/flagged — window-blown + discrepancy flags on the record
 *
 * Drives the REAL guarded RPCs (declare_load → offer_load → respond_to_offer →
 * set_delivery_method → mark_picked_up → recipient_confirm_delivery →
 * issue_receipt), so the data is genuine, not faked. Idempotent: re-running
 * first clears the prior demo (fixed demo email / org marker), then re-seeds.
 *
 * SAFETY: refuses to run when NODE_ENV=production, and writes ONLY to the
 * Supabase project in .env.local — make sure that is your DEV project. It uses
 * the service role (bypasses RLS) purely to stand up the demo; it is not an app
 * route, so it can never be triggered in the deployed app.
 */

import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

loadEnv({ path: resolve(process.cwd(), '.env.local') });

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run: NODE_ENV=production. This seed is dev/ops-only.');
  process.exit(1);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
const DEMO_MERCHANT_EMAIL = 'demo-merchant@foodlink.dev';
const DEMO_PASSWORD = 'DemoReview123!';
const DEMO_ORG_MARKER = 'DEMO Review Kitchen'; // institution org_name prefix

const service: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const HOUR = 60 * 60 * 1000;
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const today = () => new Date().toISOString().slice(0, 10);

interface ScanItemSeed {
  categoryKey: string;
  foodName: string;
  estLbs: number;
  temperatureSensitive?: boolean;
  safetyExpiresAt?: string | null;
}

async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await service.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

// ─── clear prior demo (FK-safe order) ───────────────────────────────────────
async function clearDemo(): Promise<void> {
  const { data: user } = await service.from('users').select('id').eq('email', DEMO_MERCHANT_EMAIL).maybeSingle();
  const userId = user?.id as string | undefined;

  if (userId) {
    const { data: merchant } = await service.from('merchants').select('id').eq('user_id', userId).maybeSingle();
    const merchantId = merchant?.id as string | undefined;
    if (merchantId) {
      const { data: loads } = await service.from('loads').select('id').eq('merchant_id', merchantId);
      const loadIds = (loads ?? []).map(l => l.id as string);
      const { data: scans } = await service.from('scan_records').select('id').eq('merchant_id', merchantId);
      const scanIds = (scans ?? []).map(s => s.id as string);
      if (loadIds.length) {
        await service.from('receipts').delete().in('load_id', loadIds);
        await service.from('deliveries').delete().in('load_id', loadIds);
        await service.from('allocations').delete().in('load_id', loadIds);
        await service.from('load_items').delete().in('load_id', loadIds);
      }
      if (scanIds.length) await service.from('scan_items').delete().in('scan_record_id', scanIds);
      if (loadIds.length) await service.from('loads').delete().in('id', loadIds);
      if (scanIds.length) await service.from('scan_records').delete().in('id', scanIds);
      await service.from('merchants').delete().eq('id', merchantId);
    }
    try { await service.auth.admin.deleteUser(userId); } catch { /* best-effort */ }
  }

  // Demo institutions (marker-prefixed). Any allocations to them were cleared
  // above via the load path; clear defensively before deleting the rows.
  const { data: insts } = await service.from('institutions').select('id').ilike('org_name', `${DEMO_ORG_MARKER}%`);
  const instIds = (insts ?? []).map(i => i.id as string);
  if (instIds.length) {
    await service.from('allocations').delete().in('institution_id', instIds);
    await service.from('institutions').delete().in('id', instIds);
  }
}

// ─── create the demo actors ─────────────────────────────────────────────────
async function createMerchant(): Promise<{ userId: string; merchantId: string }> {
  const { data: created, error } = await service.auth.admin.createUser({
    email: DEMO_MERCHANT_EMAIL, password: DEMO_PASSWORD, email_confirm: true,
  });
  if (error || !created.user) throw new Error(`createUser: ${error?.message}`);
  const userId = created.user.id;

  // handle_new_auth_user() auto-creates the public.users row; fill role + verified phone.
  const phone = `+1313${Date.now().toString().slice(-7)}`;
  const { error: uErr } = await service.from('users')
    .upsert({ id: userId, email: DEMO_MERCHANT_EMAIL, role: 'donor', phone, phone_verified: true }, { onConflict: 'id' });
  if (uErr) throw new Error(`users upsert: ${uErr.message}`);
  const { error: mErr } = await service.auth.admin.updateUserById(userId, {
    app_metadata: { role: 'donor', phone_verified: true },
  });
  if (mErr) throw new Error(`app_metadata: ${mErr.message}`);

  const { data: merchant, error: merr } = await service.from('merchants')
    .insert({ user_id: userId, business_name: 'Marietta St. Bakery (demo)', address: '1 Marietta St, Atlanta, GA', address_lat: 33.75, address_lng: -84.39 })
    .select('id').single();
  if (merr) throw new Error(`merchants insert: ${merr.message}`);
  return { userId, merchantId: merchant.id as string };
}

async function createInstitution(): Promise<string> {
  const { data, error } = await service.from('institutions')
    .insert({
      org_name: `${DEMO_ORG_MARKER} ${randomUUID().slice(0, 4)}`,
      npo_verified: true, status: 'active',
      demand_category_keys: ['BAKERY', 'PREPARED_HOT'], capacity_lbs: 200,
    })
    .select('id').single();
  if (error) throw new Error(`institutions insert: ${error.message}`);
  return data.id as string;
}

async function declare(merchantId: string, userId: string, items: ScanItemSeed[]): Promise<string> {
  const { data: rec, error: rErr } = await service.from('scan_records')
    .insert({ merchant_id: merchantId, scanned_by: userId, model_id: 'demo-seed', overall_confidence: 0.9, raw_response: { seeded: true } })
    .select('id').single();
  if (rErr) throw new Error(`scan_records: ${rErr.message}`);
  const { data: scanItems, error: iErr } = await service.from('scan_items')
    .insert(items.map(it => ({
      scan_record_id: rec.id, category_key: it.categoryKey, food_name: it.foodName, est_lbs: it.estLbs,
      ai_category_key: it.categoryKey, ai_food_name: it.foodName, ai_est_lbs: it.estLbs, ai_confidence: 0.9,
      merchant_confirmed: true, confirmed_at: new Date().toISOString(),
      temperature_sensitive: it.temperatureSensitive ?? false,
      prepared_at: it.temperatureSensitive ? iso(-HOUR) : null,
      safety_expires_at: it.safetyExpiresAt ?? null,
    })))
    .select('id');
  if (iErr) throw new Error(`scan_items: ${iErr.message}`);
  const load = await rpc<{ id: string }>('declare_load', {
    p_merchant_id: merchantId, p_declared_by: userId, p_window_date: today(),
    p_scan_item_ids: (scanItems ?? []).map(s => s.id as string),
  });
  return load.id;
}

async function offer(loadId: string, institutionId: string, offeredBy: string): Promise<{ allocationId: string; token: string }> {
  const alloc = await rpc<{ id: string; public_view_token: string }>('offer_load', {
    p_load_id: loadId, p_institution_id: institutionId, p_offered_by: offeredBy, p_expires_at: iso(4 * HOUR),
  });
  return { allocationId: alloc.id, token: alloc.public_view_token };
}
const accept = (allocationId: string) => rpc('respond_to_offer', { p_allocation_id: allocationId, p_decision: 'accepted', p_actor: null, p_decline_reason: null });
const setMethod = (loadId: string, merchantId: string, allocationId: string, actor: string) =>
  rpc('set_delivery_method', { p_load_id: loadId, p_merchant_id: merchantId, p_allocation_id: allocationId, p_method: 'pickup', p_responsible_party: 'recipient', p_notes: null, p_actor: actor });
const pickup = (loadId: string, merchantId: string, actor: string) => rpc('mark_picked_up', { p_load_id: loadId, p_merchant_id: merchantId, p_actor: actor });
const confirm = (allocationId: string, discrepancy: string | null) =>
  rpc('recipient_confirm_delivery', { p_allocation_id: allocationId, p_signer_name: 'Kitchen Manager', p_discrepancy_reason: discrepancy, p_expires_at: iso(24 * HOUR), p_actor: null });
const issueReceipt = (loadId: string) => rpc('issue_receipt', { p_load_id: loadId, p_method_version: '170e3-v1', p_template_approved: false, p_actor: null });

const NORMAL_ITEMS: ScanItemSeed[] = [
  { categoryKey: 'BAKERY', foodName: 'Sourdough loaves', estLbs: 6 },
  { categoryKey: 'PREPARED_HOT', foodName: 'Roast vegetables', estLbs: 4.5, temperatureSensitive: true, safetyExpiresAt: iso(2 * HOUR) },
];
const BLOWN_ITEMS: ScanItemSeed[] = [
  { categoryKey: 'PREPARED_HOT', foodName: 'Hot soup', estLbs: 5, temperatureSensitive: true, safetyExpiresAt: iso(-HOUR) }, // past → window blown
];

async function seed(): Promise<void> {
  console.log(`Seeding demo review walkthrough against ${SUPABASE_URL} …`);
  await clearDemo();
  const { userId, merchantId } = await createMerchant();
  const institutionId = await createInstitution();

  // declared
  const declared = await declare(merchantId, userId, NORMAL_ITEMS);

  // offered (awaiting accept — click Accept on /inbound)
  const offeredLoad = await declare(merchantId, userId, NORMAL_ITEMS);
  const offered = await offer(offeredLoad, institutionId, userId);

  // scheduled (accepted + method set — merchant "mark picked up"; recipient "confirm")
  const scheduledLoad = await declare(merchantId, userId, NORMAL_ITEMS);
  const scheduled = await offer(scheduledLoad, institutionId, userId);
  await accept(scheduled.allocationId);
  await setMethod(scheduledLoad, merchantId, scheduled.allocationId, userId);

  // delivered + DRAFT receipt (full chain)
  const deliveredLoad = await declare(merchantId, userId, NORMAL_ITEMS);
  const delivered = await offer(deliveredLoad, institutionId, userId);
  await accept(delivered.allocationId);
  await setMethod(deliveredLoad, merchantId, delivered.allocationId, userId);
  await pickup(deliveredLoad, merchantId, userId);
  await confirm(delivered.allocationId, null);
  await issueReceipt(deliveredLoad);

  // delivered + window blown + discrepancy flagged
  const blownLoad = await declare(merchantId, userId, BLOWN_ITEMS);
  const blown = await offer(blownLoad, institutionId, userId);
  await accept(blown.allocationId);
  await setMethod(blownLoad, merchantId, blown.allocationId, userId);
  await pickup(blownLoad, merchantId, userId); // past safety window → window_blown=true
  await confirm(blown.allocationId, 'Two trays arrived cold — short one loaf.');
  await issueReceipt(blownLoad);

  console.log(`
✅ Demo seeded. Click through every stage with real data:

  Merchant login (real, phone-verified — no OTP needed):
    ${APP_URL}/login   →   ${DEMO_MERCHANT_EMAIL} / ${DEMO_PASSWORD}
    Dashboard shows the declared/matched/scheduled/delivered loads + the Delivery section.

  Recipient (no login — open the token link):
    OFFERED  (click Accept):        ${APP_URL}/inbound/${offered.token}
    SCHEDULED (click Confirm receipt): ${APP_URL}/inbound/${scheduled.token}

  Ops (admin account):
    Matching console:  ${APP_URL}/admin/matching   (offer the 'declared' load)
    Ops console:       ${APP_URL}/admin/dashboard   (valuations, merchants, loads, receipts)

  Internal staff console (admin + allowlist):
    ${APP_URL}/internal   — pipeline health (all stages), unit economics, legal-handoff DRAFT receipts

  Load ids: declared=${declared} offered=${offeredLoad} scheduled=${scheduledLoad} delivered=${deliveredLoad} blown=${blownLoad}

Re-run this script to reset the demo; run with --clear to remove it.
`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--clear')) {
    console.log('Clearing demo review data …');
    await clearDemo();
    console.log('✅ Demo data cleared.');
    return;
  }
  await seed();
}

main().catch(err => { console.error(err); process.exit(1); });
