import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Hoisted so the vi.mock factories below can reference them (house style per
// src/services/foodVision.test.ts). Mocks sit at the same boundaries the
// route itself imports: authz, rate-limit, the service-role client, and
// scan persistence. scanFoodImage/@/services/foodVision is deliberately left
// UNMOCKED for the 422/200 cases below so the real dev-mode synthetic path
// (the low-confidence branch the review flagged) actually runs.
const { requireVerifiedMerchant } = vi.hoisted(() => ({ requireVerifiedMerchant: vi.fn() }));
const { checkScanUserLimit } = vi.hoisted(() => ({ checkScanUserLimit: vi.fn() }));
const { createServiceClient } = vi.hoisted(() => ({ createServiceClient: vi.fn() }));
const { persistScanResult } = vi.hoisted(() => ({ persistScanResult: vi.fn() }));

vi.mock('@/lib/authz', () => ({ requireVerifiedMerchant }));
vi.mock('@/lib/rate-limit', () => ({ checkScanUserLimit }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient }));
vi.mock('@/lib/scan-persist', () => ({ persistScanResult }));

import { POST } from './route';

const OK_MERCHANT = {
  ok: true as const,
  merchant: { userId: 'u1', merchantId: 'm1', businessName: 'Test' },
};

function makeServiceMock() {
  return {
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(async () => ({ error: null })),
        createSignedUrl: vi.fn(async () => ({ data: { signedUrl: 'https://signed.example/x' } })),
      })),
    },
  };
}

function jsonRequest() {
  return new Request('http://x/api/scan', { method: 'POST' });
}

function imageRequest(file: File) {
  const form = new FormData();
  form.set('image', file);
  return new Request('http://x/api/scan', { method: 'POST', body: form });
}

describe('POST /api/scan', () => {
  beforeEach(() => {
    // Dev-mode bypass in foodVision reads this at call time; stub it so the
    // 422/200 cases are deterministic regardless of a real key in .env.local.
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    requireVerifiedMerchant.mockResolvedValue(OK_MERCHANT);
    checkScanUserLimit.mockResolvedValue({ allowed: true });
    createServiceClient.mockResolvedValue(makeServiceMock());
    persistScanResult.mockResolvedValue({ scanRecordId: 'scan-1', scanItemIds: ['item-1'] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    requireVerifiedMerchant.mockReset();
    checkScanUserLimit.mockReset();
    createServiceClient.mockReset();
    persistScanResult.mockReset();
  });

  test('401 when there is no session', async () => {
    requireVerifiedMerchant.mockResolvedValue({ ok: false, error: 'NOT_AUTHENTICATED' });

    const res = await POST(jsonRequest());
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe('Not authenticated.');
  });

  test('403 when the phone is not verified', async () => {
    requireVerifiedMerchant.mockResolvedValue({ ok: false, error: 'PHONE_NOT_VERIFIED' });

    const res = await POST(jsonRequest());
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe('Phone verification required.');
  });

  test('403 when the account has no merchants row', async () => {
    requireVerifiedMerchant.mockResolvedValue({ ok: false, error: 'NOT_A_MERCHANT' });

    const res = await POST(jsonRequest());
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe('Scanning requires a merchant account.');
  });

  test('500 when requireVerifiedMerchant throws (infra error does not masquerade as 403)', async () => {
    requireVerifiedMerchant.mockRejectedValue(new Error('merchants lookup failed'));

    const res = await POST(jsonRequest());

    expect(res.status).toBe(500);
  });

  test('429 with Retry-After when the per-user scan limit is exhausted', async () => {
    checkScanUserLimit.mockResolvedValue({ allowed: false, retryAfter: 42 });

    const res = await POST(jsonRequest());

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
  });

  test('415 on an unsupported image type', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'x.gif', { type: 'image/gif' });

    const res = await POST(imageRequest(file));

    expect(res.status).toBe(415);
  });

  test('413 when the image exceeds the 10 MB cap', async () => {
    const oversized = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.jpg', {
      type: 'image/jpeg',
    });

    const res = await POST(imageRequest(oversized));

    expect(res.status).toBe(413);
  });

  test('422 on a low-confidence scan, driving the real dev-mode synthetic result', async () => {
    persistScanResult.mockResolvedValue({ scanRecordId: 'scan-low', scanItemIds: ['item-low'] });
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'lowconf.jpg', {
      type: 'image/jpeg',
    });

    const res = await POST(imageRequest(file));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.needsManualReview).toBe(true);
  });

  test('200 on a high-confidence scan, with the persisted ids mapped onto the response', async () => {
    persistScanResult.mockResolvedValue({
      scanRecordId: 'scan-ok',
      scanItemIds: ['item-a', 'item-b'],
    });
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'normal.jpg', {
      type: 'image/jpeg',
    });

    const res = await POST(imageRequest(file));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.needsManualReview).toBe(false);
    expect(body.scanRecordId).toBe('scan-ok');
    expect(body.items[0].scanItemId).toBe('item-a');
  });
});
