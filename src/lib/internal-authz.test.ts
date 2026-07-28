import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}));

import { parseAllowlist, isAllowlisted, requireInternalStaff } from './internal-authz';
import { createClient, createServiceClient } from '@/lib/supabase/server';

const mockCreateClient = vi.mocked(createClient);
const mockCreateServiceClient = vi.mocked(createServiceClient);

describe('parseAllowlist', () => {
  test('trims, lowercases, drops empties', () => {
    expect(parseAllowlist(' A@x.com , b@Y.com ,, ')).toEqual(['a@x.com', 'b@y.com']);
    expect(parseAllowlist('')).toEqual([]);
    expect(parseAllowlist('   ')).toEqual([]);
  });
});

describe('isAllowlisted', () => {
  const list = ['a@x.com', 'b@y.com'];
  test('case-insensitive membership', () => {
    expect(isAllowlisted('A@X.com', list)).toBe(true);
    expect(isAllowlisted(' b@y.com ', list)).toBe(true);
    expect(isAllowlisted('c@z.com', list)).toBe(false);
  });
  test('fail-closed: missing email or empty allowlist → false', () => {
    expect(isAllowlisted(null, list)).toBe(false);
    expect(isAllowlisted(undefined, list)).toBe(false);
    expect(isAllowlisted('a@x.com', [])).toBe(false);
  });
});

// Mocked-Supabase gate scenarios.
function mockAuth(user: { id: string; email: string } | null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockCreateClient.mockResolvedValue({ auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) } } as any);
}
function mockRole(role: string | null) {
  const single = vi.fn(async () => ({ data: role === null ? null : { role }, error: null }));
  const eq = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ eq }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockCreateServiceClient.mockResolvedValue({ from: vi.fn(() => ({ select })) } as any);
}

describe('requireInternalStaff', () => {
  const ORIGINAL = process.env.INTERNAL_STAFF_ALLOWLIST;
  beforeEach(() => { process.env.INTERNAL_STAFF_ALLOWLIST = 'staff@foodlink.test, other@foodlink.test'; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.INTERNAL_STAFF_ALLOWLIST;
    else process.env.INTERNAL_STAFF_ALLOWLIST = ORIGINAL;
    vi.clearAllMocks();
  });

  test('unauthenticated → NOT_AUTHENTICATED', async () => {
    mockAuth(null);
    mockRole(null);
    expect(await requireInternalStaff()).toEqual({ ok: false, error: 'NOT_AUTHENTICATED' });
  });

  test('allowlisted NON-admin → NOT_ADMIN (role gate wins)', async () => {
    mockAuth({ id: 'u1', email: 'staff@foodlink.test' });
    mockRole('donor');
    expect(await requireInternalStaff()).toEqual({ ok: false, error: 'NOT_ADMIN' });
  });

  test('admin NOT on the allowlist → NOT_ALLOWLISTED', async () => {
    mockAuth({ id: 'u2', email: 'randomadmin@foodlink.test' });
    mockRole('admin');
    expect(await requireInternalStaff()).toEqual({ ok: false, error: 'NOT_ALLOWLISTED' });
  });

  test('allowlisted admin (case-insensitive) → allowed', async () => {
    mockAuth({ id: 'u3', email: 'STAFF@foodlink.test' });
    mockRole('admin');
    expect(await requireInternalStaff()).toEqual({ ok: true, userId: 'u3', email: 'STAFF@foodlink.test' });
  });

  test('fail-closed: empty/unset allowlist denies even an admin', async () => {
    delete process.env.INTERNAL_STAFF_ALLOWLIST;
    mockAuth({ id: 'u4', email: 'staff@foodlink.test' });
    mockRole('admin');
    expect(await requireInternalStaff()).toEqual({ ok: false, error: 'NOT_ALLOWLISTED' });
  });
});
