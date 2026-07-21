import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}));

import { syncDeliveryStatus } from './payment';
import { createClient, createServiceClient } from '@/lib/supabase/server';

const mockCreateClient = vi.mocked(createClient);
const mockCreateServiceClient = vi.mocked(createServiceClient);

const FLAG = 'NEXT_PUBLIC_CONSUMER_ENABLED';

describe('syncDeliveryStatus — mothball guard, throw flavor (Task 0.4)', () => {
  afterEach(() => {
    delete process.env[FLAG];
    vi.clearAllMocks();
  });

  test('throws CONSUMER_DISABLED and never touches supabase when the flag is unset', async () => {
    delete process.env[FLAG];

    await expect(syncDeliveryStatus('order-1')).rejects.toThrow(
      /CONSUMER_DISABLED: syncDeliveryStatus is a mothballed pre-pivot surface/
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });
});
