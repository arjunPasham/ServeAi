// TRD acceptance criterion: cold-chain expiry hides a listing. Seeds a
// temperature-sensitive listing whose safety_expires_at is already in the
// past, runs the sweep RPC once, and asserts it drops off the live feed.
import { test, expect } from '@playwright/test';
import {
  getServiceClient,
  newContext,
  createTestUser,
  createLiveListing,
  cleanup,
  type TestContext,
} from './helpers';

let ctx: TestContext;

test.describe('cold-chain expiry', () => {
  test.beforeAll(() => {
    ctx = newContext('cold');
  });

  test.afterAll(async () => {
    await cleanup(ctx);
  });

  test('hide_expired_listing hides an expired temp-sensitive listing and it drops off the live feed', async () => {
    const service = getServiceClient();
    const donor = await createTestUser(ctx, 'donor');
    const pastExpiry = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 minutes ago

    const listing = await createLiveListing(ctx, donor.id, {
      temperatureSensitive: true,
      safetyExpiresAt: pastExpiry,
    });
    expect(listing.status).toBe('live');
    expect(listing.temperature_sensitive).toBe(true);

    const { error } = await service.rpc('hide_expired_listing', { p_listing_id: listing.id });
    expect(error).toBeNull();

    const { data: after } = await service
      .from('listings')
      .select('status')
      .eq('id', listing.id)
      .single();
    expect(after?.status).toBe('hidden');

    // Live-feed query (status = 'live') must no longer return it.
    const { data: liveFeedHit } = await service
      .from('listings')
      .select('id')
      .eq('status', 'live')
      .eq('id', listing.id);
    expect(liveFeedHit ?? []).toHaveLength(0);
  });

  test('hide_expired_listing is a no-op for a listing that has not expired yet', async () => {
    const service = getServiceClient();
    const donor = await createTestUser(ctx, 'donor', { emailLabel: 'donor2' });
    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h from now

    const listing = await createLiveListing(ctx, donor.id, {
      temperatureSensitive: true,
      safetyExpiresAt: futureExpiry,
      detectedItem: `E2E Test Meal ${ctx.runId}-2`,
    });

    const { error } = await service.rpc('hide_expired_listing', { p_listing_id: listing.id });
    expect(error).toBeNull();

    const { data: after } = await service
      .from('listings')
      .select('status')
      .eq('id', listing.id)
      .single();
    expect(after?.status).toBe('live');
  });
});
