import { afterEach, describe, expect, test, vi } from 'vitest';

// Same mocking boundary as listing.test.ts/payment.test.ts: stub the
// supabase server clients so no network/env access happens.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}));

import { startConnectOnboarding } from './connect';
import { createClient, createServiceClient } from '@/lib/supabase/server';

const mockCreateClient = vi.mocked(createClient);
const mockCreateServiceClient = vi.mocked(createServiceClient);

const FLAG = 'NEXT_PUBLIC_CONSUMER_ENABLED';

describe('startConnectOnboarding — mothball guard (audit #3)', () => {
  afterEach(() => {
    delete process.env[FLAG];
    vi.clearAllMocks();
  });

  test('returns CONSUMER_DISABLED and never touches supabase when the flag is unset', async () => {
    delete process.env[FLAG];

    const result = await startConnectOnboarding();

    expect(result).toEqual({ success: false, error: 'CONSUMER_DISABLED' });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });

  test('returns CONSUMER_DISABLED when the flag is set to something other than "true"', async () => {
    process.env[FLAG] = 'false';

    const result = await startConnectOnboarding();

    expect(result).toEqual({ success: false, error: 'CONSUMER_DISABLED' });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });
});
