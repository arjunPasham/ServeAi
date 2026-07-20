// Shared helpers for the Step 15 E2E suite. Runs against the REAL dev Supabase
// project (not a local/emulated DB) — every entity created here MUST carry a
// unique run-id marker and be deleted via cleanup() in each spec's afterAll.
//
// Reads NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from .env.local.
// Never hardcode real keys here.

import { config as loadEnv } from 'dotenv';
import path from 'path';
import { randomUUID } from 'crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

loadEnv({ path: path.resolve(__dirname, '../.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error(
    'e2e/helpers.ts: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing — check .env.local'
  );
}

let _service: SupabaseClient | null = null;
export function getServiceClient(): SupabaseClient {
  if (!_service) {
    _service = createClient(SUPABASE_URL as string, SERVICE_ROLE_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return _service;
}

// Detroit, MI — used for every seeded profile so distance/geo RPCs behave sanely.
export const DETROIT_LAT = 42.3314;
export const DETROIT_LNG = -83.0458;

// Registration requires 8+ chars; used for every test user created here.
export const TEST_PASSWORD = 'E2eTestPassw0rd!';

const DEFAULT_RECEIVING_WINDOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => ({
  day,
  start: '08:00',
  end: '20:00',
}));

export function newRunId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface TestContext {
  runId: string;
  userIds: string[];
  listingIds: string[];
  orderIds: string[];
  merchantIds: string[];
  scanRecordIds: string[];
}

export function newContext(prefix: string): TestContext {
  return { runId: newRunId(prefix), userIds: [], listingIds: [], orderIds: [], merchantIds: [], scanRecordIds: [] };
}

// +1 313 XXX XXXX — Detroit area code plus 7 varying digits derived from the
// millisecond timestamp and a UUID. users.phone is UNIQUE, and 4 random
// digits (10k values) flaked under parallel spec files; ms-timestamp + random
// gives ~10^7 spread per millisecond, so collisions are effectively impossible.
function fakePhone(): string {
  const ts = Date.now().toString().slice(-4);
  const rand = randomUUID().replace(/\D/g, '').padEnd(3, '7').slice(0, 3);
  return `+1313${ts}${rand}`;
}

export type Role = 'donor' | 'consumer' | 'courier';

export interface TestUser {
  id: string;
  email: string;
  phone: string;
}

/**
 * Creates a fully-usable test user: auth user (email pre-confirmed), the
 * public.users row (role + verified phone), and the matching role profile
 * with Detroit coordinates. Mirrors what src/actions/auth.ts registerAction
 * does, minus the HTTP round-trip.
 */
export async function createTestUser(
  ctx: TestContext,
  role: Role,
  opts?: { emailLabel?: string }
): Promise<TestUser> {
  const service = getServiceClient();
  const label = opts?.emailLabel ?? role;
  const email = `e2e.foodlink.${ctx.runId}.${label}@gmail.com`;
  const phone = fakePhone();

  const { data: created, error: createErr } = await service.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    throw new Error(`createTestUser(${role}): ${createErr?.message ?? 'no user returned'}`);
  }
  const id = created.user.id;
  ctx.userIds.push(id);

  // handle_new_auth_user() (015_fix_auth_trigger.sql) auto-creates the
  // public.users row, so this is normally an UPDATE that fills in role/phone.
  // Kept as an upsert so fixtures survive any future trigger regression
  // (which is what originally motivated it — see 61a2fea8).
  const { error: upsertErr } = await service
    .from('users')
    .upsert({ id, email, role, phone, phone_verified: true }, { onConflict: 'id' });
  if (upsertErr) throw new Error(`createTestUser(${role}) users upsert: ${upsertErr.message}`);

  const { error: metaErr } = await service.auth.admin.updateUserById(id, {
    app_metadata: { role, phone_verified: true },
  });
  if (metaErr) throw new Error(`createTestUser(${role}) app_metadata: ${metaErr.message}`);

  if (role === 'donor') {
    const { error } = await service.from('donor_profiles').insert({
      user_id: id,
      type: 'commercial',
      business_name: `E2E Donor ${ctx.runId}`,
      address: '1 Woodward Ave, Detroit, MI 48226',
      address_lat: DETROIT_LAT,
      address_lng: DETROIT_LNG,
    });
    if (error) throw new Error(`createTestUser(donor) profile: ${error.message}`);
  } else if (role === 'consumer') {
    const { error } = await service.from('consumer_profiles').insert({
      user_id: id,
      type: 'household',
      delivery_address: '2 Woodward Ave, Detroit, MI 48226',
      delivery_lat: DETROIT_LAT,
      delivery_lng: DETROIT_LNG,
      receiving_window: DEFAULT_RECEIVING_WINDOW,
    });
    if (error) throw new Error(`createTestUser(consumer) profile: ${error.message}`);
  } else {
    const { error } = await service.from('courier_profiles').insert({
      user_id: id,
      is_available: true,
      current_lat: DETROIT_LAT,
      current_lng: DETROIT_LNG,
      insulated_transport_capable: true,
    });
    if (error) throw new Error(`createTestUser(courier) profile: ${error.message}`);
  }

  return { id, email, phone };
}

export interface PendingMerchant {
  businessName: string;
  address: string;
  addressLat: number | null;
  addressLng: number | null;
  addressValidated: boolean;
}

/**
 * Reproduces the state registerAction now leaves after the pivot's C1 fix: an
 * auth user + public.users row that is NOT phone-verified, with the merchant
 * provisioning payload stashed in app_metadata.pending_merchant and NO merchants
 * row yet (that row is materialized only by verifyOTPAction after OTP success).
 * Used to assert the "no provisioning before OTP" invariant end-to-end.
 */
export async function createUnverifiedMerchantRegistrant(
  ctx: TestContext,
  opts?: { emailLabel?: string; pending?: Partial<PendingMerchant> }
): Promise<{ id: string; email: string; phone: string; pending: PendingMerchant }> {
  const service = getServiceClient();
  const label = opts?.emailLabel ?? 'unverified';
  const email = `e2e.foodlink.${ctx.runId}.${label}@gmail.com`;
  const phone = fakePhone();

  const { data: created, error: createErr } = await service.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    throw new Error(`createUnverifiedMerchantRegistrant: ${createErr?.message ?? 'no user returned'}`);
  }
  const id = created.user.id;
  ctx.userIds.push(id);

  const { error: upsertErr } = await service
    .from('users')
    .upsert({ id, email, role: 'donor', phone, phone_verified: false }, { onConflict: 'id' });
  if (upsertErr) throw new Error(`createUnverifiedMerchantRegistrant users upsert: ${upsertErr.message}`);

  const pending: PendingMerchant = {
    businessName: opts?.pending?.businessName ?? `E2E Pending Merchant ${ctx.runId}`,
    address: opts?.pending?.address ?? '1 Woodward Ave, Detroit, MI 48226',
    addressLat: opts?.pending?.addressLat ?? DETROIT_LAT,
    addressLng: opts?.pending?.addressLng ?? DETROIT_LNG,
    addressValidated: opts?.pending?.addressValidated ?? false,
  };

  const { error: metaErr } = await service.auth.admin.updateUserById(id, {
    app_metadata: { role: 'donor', phone_verified: false, pending_merchant: pending },
  });
  if (metaErr) throw new Error(`createUnverifiedMerchantRegistrant app_metadata: ${metaErr.message}`);

  return { id, email, phone, pending };
}

/** Creates a merchants row for an existing (donor-role) user. Phase 1 pivot. */
export async function createMerchant(
  ctx: TestContext,
  userId: string,
  opts?: { businessName?: string }
): Promise<{ merchantId: string }> {
  const service = getServiceClient();
  const { data, error } = await service
    .from('merchants')
    .insert({
      user_id: userId,
      business_name: opts?.businessName ?? `E2E Merchant ${ctx.runId}`,
      address: '1 Woodward Ave, Detroit, MI 48226',
      address_lat: DETROIT_LAT,
      address_lng: DETROIT_LNG,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`createMerchant: ${error?.message}`);
  ctx.merchantIds.push(data.id);
  return { merchantId: data.id };
}

export interface ScanItemSeed {
  categoryKey: string;
  foodName: string;
  estLbs: number;
  confirmed?: boolean;
  temperatureSensitive?: boolean;
  preparedAt?: string | null;
  safetyExpiresAt?: string | null;
}

/** Seeds a scan_records row + scan_items directly (bypassing /api/scan). */
export async function createScanRecord(
  ctx: TestContext,
  params: { merchantId: string; scannedBy: string; items: ScanItemSeed[] }
): Promise<{ scanRecordId: string; scanItemIds: string[] }> {
  const service = getServiceClient();
  const { data: record, error: recordError } = await service
    .from('scan_records')
    .insert({
      merchant_id: params.merchantId,
      scanned_by: params.scannedBy,
      model_id: 'e2e-seed',
      overall_confidence: 0.9,
      raw_response: { items: [], seeded: ctx.runId },
    })
    .select('id')
    .single();
  if (recordError || !record) throw new Error(`createScanRecord: ${recordError?.message}`);
  ctx.scanRecordIds.push(record.id);

  const { data: items, error: itemsError } = await service
    .from('scan_items')
    .insert(
      params.items.map(item => ({
        scan_record_id: record.id,
        category_key: item.categoryKey,
        food_name: item.foodName,
        est_lbs: item.estLbs,
        ai_category_key: item.categoryKey,
        ai_food_name: item.foodName,
        ai_est_lbs: item.estLbs,
        ai_confidence: 0.9,
        merchant_confirmed: item.confirmed ?? false,
        confirmed_at: item.confirmed ? new Date().toISOString() : null,
        temperature_sensitive: item.temperatureSensitive ?? false,
        prepared_at: item.preparedAt ?? null,
        safety_expires_at: item.safetyExpiresAt ?? null,
      }))
    )
    .select('id');
  if (itemsError || !items) throw new Error(`createScanRecord items: ${itemsError?.message}`);
  return { scanRecordId: record.id, scanItemIds: items.map(r => r.id as string) };
}

export interface LiveListingOpts {
  temperatureSensitive?: boolean;
  /** ISO timestamp. Only meaningful when temperatureSensitive is true. */
  safetyExpiresAt?: string;
  detectedItem?: string;
  confidenceScore?: number;
}

/**
 * Creates a listing and publishes it (draft -> live) via the real
 * create_draft_listing / publish_listing RPCs, so listings created this way
 * exercise the same DB-side invariants (audit log, pricing lock trigger,
 * safety attestation) as the app itself.
 */
export async function createLiveListing(
  ctx: TestContext,
  donorId: string,
  opts: LiveListingOpts = {}
) {
  const service = getServiceClient();
  const detectedItem = opts.detectedItem ?? `E2E Test Meal ${ctx.runId}`;

  const { data: draft, error: draftError } = await service.rpc('create_draft_listing', {
    p_donor_id: donorId,
    p_detected_item: detectedItem,
    p_estimated_quantity_lbs: 5,
    p_confidence_score: opts.confidenceScore ?? 0.9,
    p_temperature_sensitive: opts.temperatureSensitive ?? false,
    p_usda_category: 'PREPARED_HOT_FOOD',
    p_image_url: `https://picsum.photos/seed/${ctx.runId}-${randomUUID().slice(0, 8)}/400/300`,
    p_base_commodity_price_cents: 750,
    p_suggested_donor_payout_cents: 300,
    p_donor_payout_cents: 300,
    p_consumer_price_cents: 698,
    p_platform_fee_cents: 99,
    p_courier_fee_cents: 299,
  });
  if (draftError || !draft) {
    throw new Error(`createLiveListing: draft failed: ${draftError?.message}`);
  }
  ctx.listingIds.push(draft.id);

  if (opts.temperatureSensitive) {
    const preparedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const safetyExpiresAt =
      opts.safetyExpiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { error: updateError } = await service
      .from('listings')
      .update({ prepared_at: preparedAt, safety_expires_at: safetyExpiresAt })
      .eq('id', draft.id)
      .eq('status', 'draft');
    if (updateError) {
      throw new Error(`createLiveListing: safety window update failed: ${updateError.message}`);
    }
  }

  const { error: publishError } = await service.rpc('publish_listing', {
    p_listing_id: draft.id,
    p_donor_id: donorId,
    p_safety_attested: true,
  });
  if (publishError) {
    throw new Error(`createLiveListing: publish failed: ${publishError.message}`);
  }

  const { data: listing, error: fetchError } = await service
    .from('listings')
    .select('*')
    .eq('id', draft.id)
    .single();
  if (fetchError || !listing) {
    throw new Error(`createLiveListing: refetch failed: ${fetchError?.message}`);
  }
  return listing;
}

/**
 * Directly inserts an order row in a given state — used by tests that need a
 * 'delivered' order without driving the full claim -> dispatch -> deliver
 * state machine (e.g. the feedback-window RPC test only cares about
 * submit_feedback's own guards).
 */
export async function createOrder(
  ctx: TestContext,
  params: {
    listingId: string;
    consumerId: string;
    status?: string;
    disputeWindowExpiresAt?: string | null;
    deliveredAt?: string | null;
  }
) {
  const service = getServiceClient();
  const { data: order, error } = await service
    .from('orders')
    .insert({
      listing_id: params.listingId,
      consumer_id: params.consumerId,
      stripe_payment_intent_id: `pi_test_${randomUUID().slice(0, 12)}`,
      status: params.status ?? 'delivered',
      delivered_at: params.deliveredAt ?? new Date().toISOString(),
      dispute_window_expires_at: params.disputeWindowExpiresAt ?? null,
    })
    .select('*')
    .single();
  if (error || !order) throw new Error(`createOrder: ${error?.message}`);
  ctx.orderIds.push(order.id);
  return order;
}

/**
 * Deletes everything tracked on the context, in FK-safe order:
 * feedback_events/dispatch_events (children of orders) -> orders -> listings
 * -> auth users (which cascades to public.users and the role profile table).
 *
 * Beyond the explicitly-tracked ids, orders/listings are ALSO swept by
 * ctx.userIds: a spec that fails mid-test may have created rows through the
 * app (claim actions, RPCs) that were never pushed onto the context, and any
 * such row would FK-block auth.admin.deleteUser below.
 *
 * audit_log rows created by the run persist by design — DELETE on audit_log
 * is revoked (005_audit.sql); the log is append-only even for tests.
 */
export async function cleanup(ctx: TestContext): Promise<void> {
  const service = getServiceClient();

  // Sweep untracked rows owned by this run's users
  if (ctx.userIds.length) {
    const { data: userOrders } = await service
      .from('orders')
      .select('id')
      .or(`consumer_id.in.(${ctx.userIds.join(',')}),courier_id.in.(${ctx.userIds.join(',')})`);
    for (const row of userOrders ?? []) {
      if (!ctx.orderIds.includes(row.id)) ctx.orderIds.push(row.id);
    }
    const { data: userListings } = await service
      .from('listings')
      .select('id')
      .in('donor_id', ctx.userIds);
    for (const row of userListings ?? []) {
      if (!ctx.listingIds.includes(row.id)) ctx.listingIds.push(row.id);
    }
    // Orders against this run's listings may belong to non-test consumers too
    if (ctx.listingIds.length) {
      const { data: listingOrders } = await service
        .from('orders')
        .select('id')
        .in('listing_id', ctx.listingIds);
      for (const row of listingOrders ?? []) {
        if (!ctx.orderIds.includes(row.id)) ctx.orderIds.push(row.id);
      }
    }
  }

  if (ctx.orderIds.length) {
    await service.from('feedback_events').delete().in('order_id', ctx.orderIds);
    await service.from('dispatch_events').delete().in('order_id', ctx.orderIds);
    await service.from('orders').delete().in('id', ctx.orderIds);
  }
  if (ctx.listingIds.length) {
    await service.from('listings').delete().in('id', ctx.listingIds);
  }

  // Pivot tables — sweep by merchants owned by this run's users, plus any
  // explicitly tracked ids (mirrors the orders/listings sweep above).
  if (ctx.userIds.length) {
    const { data: userMerchants } = await service
      .from('merchants')
      .select('id')
      .in('user_id', ctx.userIds);
    for (const row of userMerchants ?? []) {
      if (!ctx.merchantIds.includes(row.id)) ctx.merchantIds.push(row.id);
    }
  }
  if (ctx.merchantIds.length) {
    const { data: merchantLoads } = await service
      .from('loads')
      .select('id')
      .in('merchant_id', ctx.merchantIds);
    const loadIds = (merchantLoads ?? []).map(r => r.id as string);

    const { data: merchantScans } = await service
      .from('scan_records')
      .select('id')
      .in('merchant_id', ctx.merchantIds);
    for (const row of merchantScans ?? []) {
      if (!ctx.scanRecordIds.includes(row.id)) ctx.scanRecordIds.push(row.id);
    }

    if (loadIds.length) await service.from('load_items').delete().in('load_id', loadIds);
    if (ctx.scanRecordIds.length) await service.from('scan_items').delete().in('scan_record_id', ctx.scanRecordIds);
    if (loadIds.length) await service.from('loads').delete().in('id', loadIds);
    if (ctx.scanRecordIds.length) await service.from('scan_records').delete().in('id', ctx.scanRecordIds);
    await service.from('merchants').delete().in('id', ctx.merchantIds);
  }

  for (const id of ctx.userIds) {
    try {
      await service.auth.admin.deleteUser(id);
    } catch {
      // best-effort — do not fail the suite over cleanup
    }
  }
}
