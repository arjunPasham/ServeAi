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

import { verifyOTPAction } from './auth';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { verifyOTP } from '@/lib/twilio';

const mockCreateClient = vi.mocked(createClient);
const mockCreateServiceClient = vi.mocked(createServiceClient);
const mockVerifyOTP = vi.mocked(verifyOTP);

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
