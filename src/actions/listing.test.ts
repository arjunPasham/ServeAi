import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Same mocking boundary as auth.test.ts: stub the supabase server clients so
// no network/env access happens.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}));

import { createDraftListing, getLiveListings } from './listing';
import { createClient, createServiceClient } from '@/lib/supabase/server';

const mockCreateClient = vi.mocked(createClient);
const mockCreateServiceClient = vi.mocked(createServiceClient);

const FLAG = 'NEXT_PUBLIC_CONSUMER_ENABLED';

function makeAuthClient(user: unknown) {
  return { auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) } };
}

describe('createDraftListing — mothball guard (Task 0.4)', () => {
  afterEach(() => {
    delete process.env[FLAG];
    vi.clearAllMocks();
  });

  test('returns CONSUMER_DISABLED and never touches supabase when the flag is unset', async () => {
    delete process.env[FLAG];

    const result = await createDraftListing({
      detectedItem: 'Test',
      estimatedQuantityLbs: 5,
      confidenceScore: 0.9,
      usdaCategory: 'BAKERY',
      imageUrl: 'x.jpg',
      donorPayoutCents: 100,
      consumerPriceCents: 200,
      platformFeeCents: 10,
      courierFeeCents: 20,
    });

    expect(result).toEqual({ success: false, error: 'CONSUMER_DISABLED' });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });

  test('returns CONSUMER_DISABLED when the flag is set to something other than "true"', async () => {
    process.env[FLAG] = 'false';

    const result = await createDraftListing({
      detectedItem: 'Test',
      estimatedQuantityLbs: 5,
      confidenceScore: 0.9,
      usdaCategory: 'BAKERY',
      imageUrl: 'x.jpg',
      donorPayoutCents: 100,
      consumerPriceCents: 200,
      platformFeeCents: 10,
      courierFeeCents: 20,
    });

    expect(result).toEqual({ success: false, error: 'CONSUMER_DISABLED' });
  });
});

describe('getLiveListings — unauthenticated read gate (Task 0.4 §3)', () => {
  beforeEach(() => {
    // This read isn't behind the CONSUMER_DISABLED flag — it's the "no auth
    // check at all" gap, closed independently of the flag.
    process.env[FLAG] = 'true';
  });
  afterEach(() => {
    delete process.env[FLAG];
    vi.clearAllMocks();
  });

  test('returns [] instead of hitting the service client for an unauthenticated caller', async () => {
    mockCreateClient.mockResolvedValue(makeAuthClient(null) as never);

    const result = await getLiveListings();

    expect(result).toEqual([]);
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });
});
