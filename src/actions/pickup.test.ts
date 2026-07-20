import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}));

import { confirmPickup } from './pickup';
import { createClient, createServiceClient } from '@/lib/supabase/server';

const mockCreateClient = vi.mocked(createClient);
const mockCreateServiceClient = vi.mocked(createServiceClient);

const FLAG = 'NEXT_PUBLIC_CONSUMER_ENABLED';

describe('confirmPickup — mothball guard (Task 0.4)', () => {
  afterEach(() => {
    delete process.env[FLAG];
    vi.clearAllMocks();
  });

  test('returns CONSUMER_DISABLED and never touches supabase when the flag is unset', async () => {
    delete process.env[FLAG];

    const result = await confirmPickup('order-1', 'ABC123');

    expect(result).toEqual({ success: false, error: 'CONSUMER_DISABLED' });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });
});
