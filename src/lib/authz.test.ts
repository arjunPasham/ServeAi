import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}));

import { requireVerifiedMerchant } from './authz';
import { createClient, createServiceClient } from '@/lib/supabase/server';

const mockCreateClient = vi.mocked(createClient);
const mockCreateServiceClient = vi.mocked(createServiceClient);

function makeAuthClient(user: unknown) {
  return { auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) } };
}

function makeService(merchant: unknown, error: { message: string } | null = null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {
    select: vi.fn(() => b),
    eq: vi.fn(() => b),
    maybeSingle: vi.fn(async () => ({ data: merchant, error })),
  };
  return { from: vi.fn(() => b) };
}

describe('requireVerifiedMerchant', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  test('NOT_AUTHENTICATED with no session', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeAuthClient(null) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServiceClient.mockResolvedValue(makeService(null) as any);

    expect(await requireVerifiedMerchant()).toEqual({ ok: false, error: 'NOT_AUTHENTICATED' });
  });

  test('PHONE_NOT_VERIFIED when app_metadata.phone_verified is not true', async () => {
    const user = { id: 'u1', app_metadata: { role: 'donor', phone_verified: false } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeAuthClient(user) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServiceClient.mockResolvedValue(makeService(null) as any);

    expect(await requireVerifiedMerchant()).toEqual({ ok: false, error: 'PHONE_NOT_VERIFIED' });
  });

  test('NOT_A_MERCHANT when verified but no merchant row exists', async () => {
    const user = { id: 'u1', app_metadata: { role: 'donor', phone_verified: true } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeAuthClient(user) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServiceClient.mockResolvedValue(makeService(null) as any);

    expect(await requireVerifiedMerchant()).toEqual({ ok: false, error: 'NOT_A_MERCHANT' });
  });

  test('ok with the merchant context when verified and a merchant row exists', async () => {
    const user = { id: 'u1', app_metadata: { role: 'donor', phone_verified: true } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeAuthClient(user) as any);
    mockCreateServiceClient.mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeService({ id: 'm1', business_name: 'Test Deli' }) as any,
    );

    expect(await requireVerifiedMerchant()).toEqual({
      ok: true,
      merchant: { userId: 'u1', merchantId: 'm1', businessName: 'Test Deli' },
    });
  });

  test('throws on a merchants-lookup infra error (does not masquerade as NOT_A_MERCHANT)', async () => {
    const user = { id: 'u1', app_metadata: { role: 'donor', phone_verified: true } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(makeAuthClient(user) as any);
    mockCreateServiceClient.mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeService(null, { message: 'connection reset' }) as any,
    );

    await expect(requireVerifiedMerchant()).rejects.toThrow(/merchants lookup failed/);
  });
});
