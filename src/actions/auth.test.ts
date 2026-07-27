import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Mock the boundaries the way foodVision.test.ts mocks @google/genai: the
// supabase server clients and the twilio verification wrapper. verifyOTPAction
// touches nothing else external.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}));
vi.mock('@/lib/twilio', () => ({
  sendOTP: vi.fn(),
  verifyOTP: vi.fn(),
}));
// registerAction (below) touches these boundaries too. Mocking them here is
// inert for the verifyOTPAction tests (which never call them).
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Map<string, string>()) }));
vi.mock('@/lib/smarty', () => ({ validateUSAddress: vi.fn(), isSmartyDevMode: vi.fn(() => true) }));
vi.mock('@/lib/delivery', () => ({ getDeliveryMode: vi.fn(() => 'provider') }));
vi.mock('@/lib/rate-limit', () => ({ checkAuthIPLimit: vi.fn(), checkRegisterIPLimit: vi.fn() }));

import { registerAction, verifyOTPAction } from './auth';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { sendOTP, verifyOTP } from '@/lib/twilio';
import { validateUSAddress, isSmartyDevMode } from '@/lib/smarty';
import { checkRegisterIPLimit } from '@/lib/rate-limit';

const mockCreateClient = vi.mocked(createClient);
const mockCreateServiceClient = vi.mocked(createServiceClient);
const mockVerifyOTP = vi.mocked(verifyOTP);
const mockSendOTP = vi.mocked(sendOTP);
const mockValidateAddress = vi.mocked(validateUSAddress);
const mockIsSmartyDevMode = vi.mocked(isSmartyDevMode);
const mockCheckRegisterIPLimit = vi.mocked(checkRegisterIPLimit);

const PHONE = '+13135551234';
const PENDING = {
  businessName: 'Test Deli',
  address: '1 Woodward Ave, Detroit, MI 48226',
  addressLat: 42.3314,
  addressLng: -83.0458,
  addressValidated: false,
};

type WriteResult = { data?: unknown; error: { message: string } | null };

interface ServiceConfig {
  userRow?: { role: string; phone: string } | null;
  userSelectError?: { message: string } | null;
  merchantsUpsertResult?: WriteResult;
  usersUpdateResult?: WriteResult;
  metaUpdateResult?: WriteResult;
}

/**
 * A chainable stand-in for the supabase service client. Terminal calls
 * (.single()/.maybeSingle() and awaiting an .update()/.upsert() chain) resolve
 * to per-(table, op) configured results, and every write payload is recorded
 * so tests can assert what was (and was NOT) written.
 */
function makeService(cfg: ServiceConfig) {
  const calls = {
    merchantsUpsert: [] as unknown[],
    usersUpdate: [] as unknown[],
    metaUpdate: [] as { id: string; attrs: unknown }[],
  };
  const updateUserById = vi.fn(async (id: string, attrs: unknown) => {
    calls.metaUpdate.push({ id, attrs });
    return cfg.metaUpdateResult ?? { data: {}, error: null };
  });

  function builder(table: string) {
    let op: string | null = null;
    let payload: unknown = null;
    const resolve = () => {
      if (table === 'users' && op === 'select') {
        return Promise.resolve({ data: cfg.userRow ?? null, error: cfg.userSelectError ?? null });
      }
      if (table === 'users' && op === 'update') {
        calls.usersUpdate.push(payload);
        return Promise.resolve(cfg.usersUpdateResult ?? { data: null, error: null });
      }
      if (table === 'merchants' && op === 'upsert') {
        calls.merchantsUpsert.push(payload);
        return Promise.resolve(cfg.merchantsUpsertResult ?? { data: null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: vi.fn(() => { op = 'select'; return b; }),
      update: vi.fn((p: unknown) => { op = 'update'; payload = p; return b; }),
      upsert: vi.fn((p: unknown) => { op = 'upsert'; payload = p; return b; }),
      insert: vi.fn((p: unknown) => { op = 'insert'; payload = p; return b; }),
      eq: vi.fn(() => b),
      single: vi.fn(() => resolve()),
      maybeSingle: vi.fn(() => resolve()),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then: (onF: any, onR: any) => resolve().then(onF, onR),
    };
    return b;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service: any = {
    from: vi.fn((table: string) => builder(table)),
    auth: { admin: { updateUserById } },
  };
  return { service, calls, updateUserById };
}

function makeAuthClient(user: unknown) {
  return { auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) } };
}

function donorUser() {
  return {
    id: 'user-1',
    app_metadata: { role: 'donor', phone_verified: false, pending_merchant: PENDING },
  };
}

describe('verifyOTPAction', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  test('success: materializes the merchant row from pending_merchant, then marks verified', async () => {
    mockVerifyOTP.mockResolvedValue({ success: true });
    const { service, calls, updateUserById } = makeService({
      userRow: { role: 'donor', phone: PHONE },
      merchantsUpsertResult: { data: null, error: null },
      usersUpdateResult: { data: null, error: null },
      metaUpdateResult: { data: {}, error: null },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeAuthClient(donorUser()) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServiceClient.mockResolvedValue(service as any);

    const result = await verifyOTPAction(PHONE, '000000');

    expect(result.success).toBe(true);
    expect(result.redirectTo).toBe('/merchant/dashboard');
    // merchant row created from the stash…
    expect(calls.merchantsUpsert).toHaveLength(1);
    expect(calls.merchantsUpsert[0]).toMatchObject({
      user_id: 'user-1',
      business_name: 'Test Deli',
    });
    // …and verification persisted, clearing the stash
    expect(calls.usersUpdate).toHaveLength(1);
    expect(updateUserById).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        app_metadata: expect.objectContaining({ phone_verified: true, pending_merchant: null }),
      }),
    );
  });

  test('PROVISIONING_FAILED when the merchant row cannot be materialized; stays unverified', async () => {
    mockVerifyOTP.mockResolvedValue({ success: true });
    const { service, calls, updateUserById } = makeService({
      userRow: { role: 'donor', phone: PHONE },
      merchantsUpsertResult: { data: null, error: { message: 'merchants insert failed' } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeAuthClient(donorUser()) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServiceClient.mockResolvedValue(service as any);

    const result = await verifyOTPAction(PHONE, '000000');

    expect(result).toEqual({ success: false, error: 'PROVISIONING_FAILED' });
    expect(calls.merchantsUpsert).toHaveLength(1);
    // must NOT mark verified — the user retries the whole verify via re-login
    expect(calls.usersUpdate).toHaveLength(0);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  test('VERIFY_PERSIST_FAILED when the app_metadata write fails', async () => {
    mockVerifyOTP.mockResolvedValue({ success: true });
    const { service, calls } = makeService({
      userRow: { role: 'donor', phone: PHONE },
      merchantsUpsertResult: { data: null, error: null },
      metaUpdateResult: { data: null, error: { message: 'auth admin unavailable' } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeAuthClient(donorUser()) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServiceClient.mockResolvedValue(service as any);

    const result = await verifyOTPAction(PHONE, '000000');

    expect(result).toEqual({ success: false, error: 'VERIFY_PERSIST_FAILED' });
    // the merchant row was materialized before the failed verify write…
    expect(calls.merchantsUpsert).toHaveLength(1);
    // …app_metadata is written first, so a users.phone_verified write is never issued
    expect(calls.usersUpdate).toHaveLength(0);
    expect(console.error).toHaveBeenCalled();
  });

  test('VERIFY_PERSIST_FAILED when the users.phone_verified write fails', async () => {
    mockVerifyOTP.mockResolvedValue({ success: true });
    const { service, calls, updateUserById } = makeService({
      userRow: { role: 'donor', phone: PHONE },
      merchantsUpsertResult: { data: null, error: null },
      metaUpdateResult: { data: {}, error: null },
      usersUpdateResult: { data: null, error: { message: 'users update failed' } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeAuthClient(donorUser()) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServiceClient.mockResolvedValue(service as any);

    const result = await verifyOTPAction(PHONE, '000000');

    expect(result).toEqual({ success: false, error: 'VERIFY_PERSIST_FAILED' });
    expect(updateUserById).toHaveBeenCalled();
    expect(calls.usersUpdate).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
  });

  test('propagates an OTP failure and performs no writes', async () => {
    mockVerifyOTP.mockResolvedValue({ success: false, error: 'INVALID_CODE' });
    const { service, calls, updateUserById } = makeService({
      userRow: { role: 'donor', phone: PHONE },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeAuthClient(donorUser()) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServiceClient.mockResolvedValue(service as any);

    const result = await verifyOTPAction(PHONE, '999999');

    expect(result).toEqual({ success: false, error: 'INVALID_CODE' });
    expect(calls.merchantsUpsert).toHaveLength(0);
    expect(calls.usersUpdate).toHaveLength(0);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  test('PHONE_MISMATCH when the stored phone differs, before any OTP check', async () => {
    const { service } = makeService({ userRow: { role: 'donor', phone: '+13139999999' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeAuthClient(donorUser()) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServiceClient.mockResolvedValue(service as any);

    const result = await verifyOTPAction(PHONE, '000000');

    expect(result).toEqual({ success: false, error: 'PHONE_MISMATCH' });
    expect(mockVerifyOTP).not.toHaveBeenCalled();
  });

  test('NOT_AUTHENTICATED when there is no session', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeAuthClient(null) as any);
    const { service } = makeService({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServiceClient.mockResolvedValue(service as any);

    const result = await verifyOTPAction(PHONE, '000000');

    expect(result).toEqual({ success: false, error: 'NOT_AUTHENTICATED' });
  });

  test('a role with no pending_merchant verifies without materializing a merchant row', async () => {
    mockVerifyOTP.mockResolvedValue({ success: true });
    const { service, calls } = makeService({
      userRow: { role: 'consumer', phone: PHONE },
      usersUpdateResult: { data: null, error: null },
      metaUpdateResult: { data: {}, error: null },
    });
    const user = { id: 'user-2', app_metadata: { role: 'consumer', phone_verified: false } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeAuthClient(user) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServiceClient.mockResolvedValue(service as any);

    const result = await verifyOTPAction(PHONE, '000000');

    expect(result.success).toBe(true);
    expect(result.redirectTo).toBe('/consumer/browse');
    expect(calls.merchantsUpsert).toHaveLength(0);
  });
});

// ─── registerAction (merchant provisioning deferral — review C1) ─────────────
// Directly executes registerAction to close the flagged gap: its merchant path
// had zero direct test coverage. The invariant: a donor registration STASHES
// pending_merchant in app_metadata and creates NO merchants row (and leaves the
// account unverified) — provisioning is deferred to verifyOTPAction after OTP.

/**
 * A register-focused service double. Records every write and exposes the
 * auth-admin surface registerAction uses (createUser/updateUserById/deleteUser).
 * Any table write resolves to { error: null } unless it's a tracked one.
 */
function makeRegisterService(cfg?: { metaError?: string; deleteError?: string }) {
  const calls = {
    merchantsWrites: [] as { op: string; payload: unknown }[],
    donorInsert: [] as unknown[],
    consumerInsert: [] as unknown[],
    metaUpdate: [] as { id: string; attrs: { app_metadata?: Record<string, unknown> } }[],
    createUser: 0,
    deleteUser: 0,
  };
  const admin = {
    createUser: vi.fn(async () => {
      calls.createUser += 1;
      return { data: { user: { id: 'new-user' } }, error: null };
    }),
    updateUserById: vi.fn(async (id: string, attrs: { app_metadata?: Record<string, unknown> }) => {
      calls.metaUpdate.push({ id, attrs });
      return cfg?.metaError ? { data: null, error: { message: cfg.metaError } } : { data: {}, error: null };
    }),
    deleteUser: vi.fn(async () => {
      calls.deleteUser += 1;
      return cfg?.deleteError ? { data: null, error: { message: cfg.deleteError } } : { data: {}, error: null };
    }),
  };

  function builder(table: string) {
    let op: string | null = null;
    let payload: unknown = null;
    const resolve = () => {
      if (table === 'users' && op === 'select') return Promise.resolve({ data: null, error: null }); // phone not taken
      if (table === 'merchants') { calls.merchantsWrites.push({ op: op ?? '?', payload }); return Promise.resolve({ error: null }); }
      if (table === 'donor_profiles' && op === 'insert') { calls.donorInsert.push(payload); return Promise.resolve({ error: null }); }
      if (table === 'consumer_profiles' && op === 'insert') { calls.consumerInsert.push(payload); return Promise.resolve({ error: null }); }
      return Promise.resolve({ data: null, error: null });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: vi.fn(() => { op = 'select'; return b; }),
      update: vi.fn((p: unknown) => { op = 'update'; payload = p; return b; }),
      upsert: vi.fn((p: unknown) => { op = 'upsert'; payload = p; return b; }),
      insert: vi.fn((p: unknown) => { op = 'insert'; payload = p; return b; }),
      eq: vi.fn(() => b),
      single: vi.fn(() => resolve()),
      maybeSingle: vi.fn(() => resolve()),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then: (onF: any, onR: any) => resolve().then(onF, onR),
    };
    return b;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service: any = { from: vi.fn((table: string) => builder(table)), auth: { admin } };
  return { service, calls };
}

function makeRegisterAuthClient() {
  return { auth: { signInWithPassword: vi.fn(async () => ({ data: { user: { id: 'new-user' } }, error: null })) } };
}

function registerForm(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe('registerAction', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCheckRegisterIPLimit.mockResolvedValue({ allowed: true });
    mockSendOTP.mockResolvedValue({ success: true });
    mockIsSmartyDevMode.mockReturnValue(true);
    mockValidateAddress.mockResolvedValue({
      valid: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      standardized: { deliveryLine: '1 Woodward Ave' } as any,
      lat: 42.3314,
      lng: -83.0458,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  test('a donor registration stashes pending_merchant and creates NO merchants row before OTP', async () => {
    const { service, calls } = makeRegisterService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServiceClient.mockResolvedValue(service as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeRegisterAuthClient() as any);

    const result = await registerAction(registerForm({
      email: 'deli@example.com',
      password: 'password123',
      role: 'donor',
      phone: '313-555-1234',
      address: '1 Woodward Ave, Detroit, MI 48226',
      businessName: 'Test Deli',
    }));

    expect(result.success).toBe(true);
    expect(result.redirectTo).toContain('/verify-phone');

    // The core C1 invariant: NO merchants row written during registration.
    expect(calls.merchantsWrites).toHaveLength(0);

    // pending_merchant stashed in app_metadata, account left UNVERIFIED.
    expect(calls.metaUpdate).toHaveLength(1);
    const appMeta = calls.metaUpdate[0].attrs.app_metadata ?? {};
    expect(appMeta.phone_verified).toBe(false);
    expect(appMeta.pending_merchant).toMatchObject({
      businessName: 'Test Deli',
      addressValidated: false, // dev-mode Smarty coords never count as validated
    });

    // The donor profile row IS created (the merchants row is what's deferred).
    expect(calls.donorInsert).toHaveLength(1);
  });

  test('a consumer registration stashes no pending_merchant and writes no merchants row', async () => {
    const { service, calls } = makeRegisterService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServiceClient.mockResolvedValue(service as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeRegisterAuthClient() as any);

    const result = await registerAction(registerForm({
      email: 'shelter@example.com',
      password: 'password123',
      role: 'consumer',
      phone: '313-555-9876',
      address: '2 Woodward Ave, Detroit, MI 48226',
    }));

    expect(result.success).toBe(true);
    expect(calls.merchantsWrites).toHaveLength(0);
    expect(calls.consumerInsert).toHaveLength(1);
    expect(calls.metaUpdate).toHaveLength(1);
    const appMeta = calls.metaUpdate[0].attrs.app_metadata ?? {};
    expect(appMeta.phone_verified).toBe(false);
    expect(appMeta.pending_merchant).toBeUndefined();
  });

  // Compound-failure strand (audit data-integrity #1).
  test('app_metadata failure with a successful rollback returns a retry-able error, no orphan log', async () => {
    const { service, calls } = makeRegisterService({ metaError: 'auth admin unavailable' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServiceClient.mockResolvedValue(service as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeRegisterAuthClient() as any);

    const result = await registerAction(registerForm({
      email: 'deli2@example.com',
      password: 'password123',
      role: 'donor',
      phone: '313-555-2222',
      address: '1 Woodward Ave, Detroit, MI 48226',
      businessName: 'Test Deli',
    }));

    expect(result).toEqual({ success: false, error: 'PROFILE_UPDATE_FAILED' });
    expect(calls.deleteUser).toBe(1); // rollback attempted…
    // …and succeeded, so nothing is stranded and no orphan is logged.
    expect(console.error).not.toHaveBeenCalled();
  });

  test('app_metadata failure AND a failed rollback logs the orphan and returns a distinct support error', async () => {
    const { service, calls } = makeRegisterService({
      metaError: 'auth admin unavailable',
      deleteError: 'delete failed too',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServiceClient.mockResolvedValue(service as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeRegisterAuthClient() as any);

    const result = await registerAction(registerForm({
      email: 'deli3@example.com',
      password: 'password123',
      role: 'donor',
      phone: '313-555-3333',
      address: '1 Woodward Ave, Detroit, MI 48226',
      businessName: 'Test Deli',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('contact support'); // distinct, honest, not a generic code
    expect(calls.deleteUser).toBe(1);
    // The orphaned auth user is logged (ops-recoverable), not silently swallowed.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('orphaned auth user'),
      expect.objectContaining({ userId: 'new-user', email: 'deli3@example.com' }),
    );
  });
});
