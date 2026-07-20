// Phase 2 hardening (review C1): merchant provisioning must NOT happen before
// phone verification. registerAction stashes the merchant payload in
// app_metadata.pending_merchant and leaves the account unverified with no
// merchants row; verifyOTPAction materializes that row (idempotently) only
// after the OTP succeeds.
//
// Driving the real server actions from the api project is impractical (they
// need a Next request context, cookies, and a live session), so this exercises
// the same invariant through the service-role operations the actions perform:
// the "unverified registrant" state, then the exact idempotent upsert
// verifyOTPAction runs, against the real dev DB (unique constraint included).
import { test, expect } from '@playwright/test';
import {
  getServiceClient,
  newContext,
  createUnverifiedMerchantRegistrant,
  cleanup,
  type TestContext,
} from './helpers';

let ctx: TestContext;

test.describe('merchant provisioning is deferred to phone verification', () => {
  test.beforeAll(() => {
    ctx = newContext('provisioning');
  });

  test.afterAll(async () => {
    await cleanup(ctx);
  });

  test('no merchants row before OTP; verify materializes exactly one, idempotently', async () => {
    const service = getServiceClient();
    const registrant = await createUnverifiedMerchantRegistrant(ctx, { emailLabel: 'defer' });

    // Registration-equivalent state: unverified, stash present, NO merchants row.
    const { data: authUser } = await service.auth.admin.getUserById(registrant.id);
    expect(authUser.user?.app_metadata?.phone_verified).toBe(false);
    expect(authUser.user?.app_metadata?.pending_merchant).toMatchObject({
      businessName: registrant.pending.businessName,
    });

    const { data: beforeRow, error: beforeErr } = await service
      .from('merchants')
      .select('id')
      .eq('user_id', registrant.id)
      .maybeSingle();
    expect(beforeErr).toBeNull();
    expect(beforeRow).toBeNull();

    // Simulate verifyOTPAction's materialization: the same idempotent upsert.
    const pending = authUser.user!.app_metadata!.pending_merchant as typeof registrant.pending;
    const materialize = () =>
      service.from('merchants').upsert(
        {
          user_id: registrant.id,
          business_name: pending.businessName,
          address: pending.address,
          address_lat: pending.addressLat,
          address_lng: pending.addressLng,
          address_validated: pending.addressValidated,
        },
        { onConflict: 'user_id', ignoreDuplicates: true },
      );

    const { error: firstErr } = await materialize();
    expect(firstErr).toBeNull();

    // Idempotent: a retry (partial-failure recovery / stale stash) must not
    // create a second row — merchants.user_id is UNIQUE.
    const { error: secondErr } = await materialize();
    expect(secondErr).toBeNull();

    const { data: afterRows, error: afterErr } = await service
      .from('merchants')
      .select('id, business_name')
      .eq('user_id', registrant.id);
    expect(afterErr).toBeNull();
    expect(afterRows).toHaveLength(1);
    expect(afterRows![0].business_name).toBe(registrant.pending.businessName);
  });
});
