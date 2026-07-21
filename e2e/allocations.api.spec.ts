// Phase 2 (Match), Task 3b — offer_load / withdraw_offer / expire_stale_offers
// RPC invariants (024_allocations.sql / 025_withdraw_offer.sql). Exercises
// the RPCs directly against the real dev DB, mirroring manifest.api.spec.ts's
// style: no HTTP layer, no browser.
//
// offerLoad()'s TS-side expires_at clamp (src/actions/allocations.ts) is a
// 'use server' action and can't be invoked from this project — same reason
// no other *.api.spec.ts file imports a server action: it calls
// createClient(), which needs a real Next request context (cookies()), not
// available from a plain Playwright/Node process. The clamp's pure math
// (computeOfferExpiry) is unit-tested instead, in src/lib/match-score.test.ts.
// The offer -> accept/decline flow via respond_to_offer is Task 5's
// coverage, not duplicated here.
import { test, expect } from '@playwright/test';
import {
  getServiceClient,
  newContext,
  createTestUser,
  createMerchant,
  createDeclaredLoad,
  createInstitution,
  cleanup,
  type TestContext,
} from './helpers';

let ctx: TestContext;

test.describe('offer_load / withdraw_offer / expire_stale_offers', () => {
  test.beforeAll(() => {
    ctx = newContext('alloc');
  });

  test.afterAll(async () => {
    await cleanup(ctx);
  });

  test('offers a declared load to an npo_verified institution, flipping the load to matched; rejects an unverified institution on the donation lane; rejects a double-offer', async () => {
    const service = getServiceClient();
    const user = await createTestUser(ctx, 'donor', { emailLabel: 'offer' });
    const { merchantId } = await createMerchant(ctx, user.id);
    const { loadId } = await createDeclaredLoad(ctx, {
      merchantId,
      scannedBy: user.id,
      items: [{ categoryKey: 'BAKERY', foodName: 'Rolls', estLbs: 5 }],
    });
    const { institutionId: unverifiedId } = await createInstitution(ctx, {
      orgName: `E2E Unverified ${ctx.runId}`,
      npoVerified: false,
    });
    const { institutionId: verifiedId } = await createInstitution(ctx, {
      orgName: `E2E Verified ${ctx.runId}`,
      npoVerified: true,
    });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    // Donation lane (the only lane Phase 2 declares) hard-gates on
    // npo_verified — an unverified institution must never receive an offer.
    const { error: unverifiedError } = await service.rpc('offer_load', {
      p_load_id: loadId,
      p_institution_id: unverifiedId,
      p_offered_by: user.id,
      p_expires_at: expiresAt,
    });
    expect(unverifiedError?.message).toContain('INSTITUTION_NOT_ELIGIBLE');

    const { data: alloc, error } = await service.rpc('offer_load', {
      p_load_id: loadId,
      p_institution_id: verifiedId,
      p_offered_by: user.id,
      p_expires_at: expiresAt,
    });
    expect(error).toBeNull();
    expect(alloc.status).toBe('offered');
    expect(alloc.lane).toBe('donation');

    const { data: load } = await service.from('loads').select('status').eq('id', loadId).single();
    expect(load!.status).toBe('matched');

    // A second offer while the first is still active must be rejected —
    // the one-active-allocation-per-load guard.
    const { institutionId: secondId } = await createInstitution(ctx, { orgName: `E2E Second ${ctx.runId}` });
    const { error: dupError } = await service.rpc('offer_load', {
      p_load_id: loadId,
      p_institution_id: secondId,
      p_offered_by: user.id,
      p_expires_at: expiresAt,
    });
    expect(dupError?.message).toContain('ALREADY_ALLOCATED');
  });

  test('withdraw_offer frees the load back to declared and marks the allocation withdrawn; rejects withdrawing a non-active allocation', async () => {
    const service = getServiceClient();
    const user = await createTestUser(ctx, 'donor', { emailLabel: 'withdraw' });
    const { merchantId } = await createMerchant(ctx, user.id);
    const { loadId } = await createDeclaredLoad(ctx, {
      merchantId,
      scannedBy: user.id,
      items: [{ categoryKey: 'BAKERY', foodName: 'Bagels', estLbs: 3 }],
    });
    const { institutionId } = await createInstitution(ctx, { orgName: `E2E Withdraw ${ctx.runId}` });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const { data: alloc } = await service.rpc('offer_load', {
      p_load_id: loadId,
      p_institution_id: institutionId,
      p_offered_by: user.id,
      p_expires_at: expiresAt,
    });

    const { data: freedLoad, error } = await service.rpc('withdraw_offer', {
      p_allocation_id: alloc.id,
      p_actor: user.id,
    });
    expect(error).toBeNull();
    expect(freedLoad.status).toBe('declared');

    const { data: withdrawn } = await service.from('allocations').select('status').eq('id', alloc.id).single();
    expect(withdrawn!.status).toBe('withdrawn');

    // Already withdrawn — no longer an active offer.
    const { error: secondError } = await service.rpc('withdraw_offer', {
      p_allocation_id: alloc.id,
      p_actor: user.id,
    });
    expect(secondError?.message).toContain('OFFER_NOT_ACTIVE');
  });

  test('expire_stale_offers flips a past-expiry offer to expired and frees its load back to declared', async () => {
    const service = getServiceClient();
    const user = await createTestUser(ctx, 'donor', { emailLabel: 'expire' });
    const { merchantId } = await createMerchant(ctx, user.id);
    const { loadId } = await createDeclaredLoad(ctx, {
      merchantId,
      scannedBy: user.id,
      items: [{ categoryKey: 'BAKERY', foodName: 'Muffins', estLbs: 2 }],
    });
    const { institutionId } = await createInstitution(ctx, { orgName: `E2E Expire ${ctx.runId}` });

    // offer_load itself never validates expires_at against now() — that's
    // the TS-side clamp's job (computeOfferExpiry) — so this directly
    // models what a stranded, ignored offer looks like in the DB.
    const pastExpiresAt = new Date(Date.now() - 60 * 1000).toISOString();
    const { data: alloc, error } = await service.rpc('offer_load', {
      p_load_id: loadId,
      p_institution_id: institutionId,
      p_offered_by: user.id,
      p_expires_at: pastExpiresAt,
    });
    expect(error).toBeNull();

    const { data: count, error: sweepError } = await service.rpc('expire_stale_offers');
    expect(sweepError).toBeNull();
    // >=1 rather than ===1: the sweep is global (every stale offer in the
    // dev DB), so a concurrently-running spec's stale offer could also be
    // swept in the same call — this test only asserts what happened to ITS
    // OWN allocation below, re-fetched by id.
    expect(count as number).toBeGreaterThanOrEqual(1);

    const { data: expired } = await service.from('allocations').select('status').eq('id', alloc.id).single();
    expect(expired!.status).toBe('expired');

    const { data: freedLoad } = await service.from('loads').select('status').eq('id', loadId).single();
    expect(freedLoad!.status).toBe('declared');
  });
});
