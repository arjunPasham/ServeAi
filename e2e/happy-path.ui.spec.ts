// TRD acceptance criterion: listing -> live -> purchase (happy path), driven
// through the real browser UI for registration + claim. Dispatch/delivery/
// payouts beyond the claim step are covered by happy-path.api.spec.ts (they
// require a courier physically "arriving", which is out of scope for a
// browser-only test) — this spec asserts the order is created and moving.
//
// BLOCKED on this environment: registerAction (src/actions/auth.ts) inserts
// the role profile row (donor_profiles/consumer_profiles/courier_profiles)
// immediately after creating the auth user, relying on the
// handle_new_auth_user trigger (002_schema.sql, AFTER INSERT ON auth.users)
// to have already created the matching public.users row. On this project's
// live Supabase DB that trigger does not fire — verified directly: a fresh
// admin.createUser() leaves public.users with zero matching rows even after
// a 5s wait (an orphaned "trigger.probe.x91@gmail.com" auth user from
// 2026-07-07 shows this was hit before). Real registration through /register
// fails with "Could not create your profile. Please try again." for EVERY
// role, not just this test — this is a pre-existing DB/infra gap outside
// Step 15's scope (no DB DDL access available to re-create the trigger from
// here: no Supabase CLI project link, no Postgres connection string, no
// Management API token — only the REST/service-role key, which cannot run
// DDL). Per the task's fallback rule for a UI flow that "proves impossible"
// in this environment: this test is skipped with this explanation rather
// than weakened, and happy-path.api.spec.ts covers the same state machine
// via the RPCs directly (bypassing the broken trigger by upserting
// public.users in the test helper, same as every other spec in this suite).
//
// TODO(product bug, not Step 15): once handle_new_auth_user is confirmed
// firing on this Supabase project again (e.g. after re-running 002_schema.sql
// with a role that has DDL rights on the `auth` schema), remove the
// test.skip() call below to re-enable the real /register walkthrough.
import { test, expect } from '@playwright/test';
import {
  getServiceClient,
  newContext,
  createTestUser,
  createLiveListing,
  cleanup,
  TEST_PASSWORD,
  type TestContext,
} from './helpers';

let ctx: TestContext;

test.describe('consumer happy path', () => {
  test.beforeAll(() => {
    ctx = newContext('happy');
  });

  test.afterAll(async () => {
    await cleanup(ctx);
  });

  test('register as consumer, verify phone, browse, and claim a live listing', async ({ page }) => {
    test.skip(
      true,
      'BLOCKED: handle_new_auth_user trigger is not firing on this Supabase project — ' +
        'real /register fails profile creation for every role (see comment above). ' +
        'happy-path.api.spec.ts covers the same state machine at the RPC level.'
    );

    const service = getServiceClient();

    // Seed a donor + live listing ahead of time (the donor-side flow is
    // covered by low-confidence.ui.spec.ts).
    const donor = await createTestUser(ctx, 'donor');
    const detectedItem = `E2E Happy Path Meal ${ctx.runId}`;
    await createLiveListing(ctx, donor.id, { detectedItem });

    const email = `e2e.foodlink.${ctx.runId}.uiconsumer@gmail.com`;
    const phone = `4${String(Date.now()).slice(-9)}`; // any unique 10-digit string

    // ── Register ────────────────────────────────────────────────────────
    await page.goto('/register');
    await page.getByRole('radio', { name: /Consumer/i }).click();

    await page.getByLabel(/Full name/i).fill('E2E Consumer');
    await page.getByLabel(/Delivery address/i).fill('123 Test St, Detroit, MI 48201');
    await page.getByLabel(/Email address/i).fill(email);
    await page.getByLabel(/^Password/i).fill(TEST_PASSWORD);
    await page.getByLabel(/Phone number/i).fill(phone);

    await page.getByRole('button', { name: /Continue/i }).click();
    await page.waitForURL(/\/verify-phone/, { timeout: 15000 });

    // Track the just-created user for cleanup as soon as we can look it up.
    const { data: userRow } = await service.from('users').select('id').eq('email', email).maybeSingle();
    if (userRow) ctx.userIds.push(userRow.id);

    // ── Verify phone (DEV mode: code is always 000000) ─────────────────
    const digits = '000000'.split('');
    for (let i = 0; i < digits.length; i++) {
      await page.getByLabel(`Digit ${i + 1}`).fill(digits[i]);
    }

    await page.waitForURL(/\/consumer\/browse/, { timeout: 15000 });

    if (!userRow) {
      const { data: retry } = await service.from('users').select('id').eq('email', email).maybeSingle();
      if (retry) ctx.userIds.push(retry.id);
    }

    // ── Browse: our seeded listing must be visible ──────────────────────
    const heading = page.getByRole('heading', { name: detectedItem });
    await expect(heading).toBeVisible({ timeout: 15000 });

    // ── Claim it ─────────────────────────────────────────────────────────
    const card = heading.locator('xpath=ancestor::div[contains(@class,"shadow-sm")][1]');
    await card.getByRole('button', { name: /Buy now/i }).click();

    // Fulfillment chooser (Phase 3): pick delivery — exercises the live
    // provider quote (SimulatedProvider in the test env) + claim path.
    await page.getByRole('button', { name: /Delivery ·/i }).click();

    await page.waitForURL(/\/consumer\/orders\//, { timeout: 20000 });
    const orderId = page.url().split('/consumer/orders/')[1]?.split(/[?#]/)[0];
    expect(orderId).toBeTruthy();
    if (orderId) ctx.orderIds.push(orderId);

    // ── Order was actually created server-side, in a post-claim state ──
    const { data: order } = await service
      .from('orders')
      .select('status')
      .eq('id', orderId)
      .single();
    expect(['pending_dispatch', 'dispatched', 'delivered']).toContain(order?.status);

    // ── Status banner renders on the order page ─────────────────────────
    await expect(page.locator('main')).toContainText(/Arranging delivery|On the way|Delivered/i, {
      timeout: 15000,
    });
  });
});
