import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}));

import { acceptDispatch, updateCourierLocation } from './dispatch';
import { createClient, createServiceClient } from '@/lib/supabase/server';

const mockCreateClient = vi.mocked(createClient);
const mockCreateServiceClient = vi.mocked(createServiceClient);

const FLAG = 'NEXT_PUBLIC_CONSUMER_ENABLED';

describe('acceptDispatch — mothball guard, typed-result flavor (Task 0.4)', () => {
  afterEach(() => {
    delete process.env[FLAG];
    vi.clearAllMocks();
  });

  test('returns CONSUMER_DISABLED and never touches supabase when the flag is unset', async () => {
    delete process.env[FLAG];

    const result = await acceptDispatch('order-1', 'dispatch-1');

    expect(result).toEqual({ success: false, error: 'CONSUMER_DISABLED' });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });
});

describe('updateCourierLocation — mothball guard, throw flavor (Task 0.4)', () => {
  afterEach(() => {
    delete process.env[FLAG];
    vi.clearAllMocks();
  });

  test('throws CONSUMER_DISABLED and never touches supabase when the flag is unset', async () => {
    delete process.env[FLAG];

    await expect(updateCourierLocation(42.33, -83.05)).rejects.toThrow(
      /CONSUMER_DISABLED: updateCourierLocation is a mothballed pre-pivot surface/
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });
});
