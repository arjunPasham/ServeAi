// TRD acceptance criterion: a low-confidence scan cannot publish without
// correction. FoodScanner (src/components/FoodScanner.tsx) surfaces a
// "not fully confident" banner and requires the donor to tap a suggested
// item (or enter manually) before the form is populated — auto-publish from
// an unconfirmed guess is impossible. This drives the real upload -> scan ->
// correction -> publish flow through the browser; the scan fixture's filename
// ("lowconf.jpg") triggers the DEV-mode synthetic low-confidence result added
// in src/services/foodVision.ts (4a) since GEMINI_API_KEY is cleared for the
// e2e webServer.
import path from 'path';
import { test, expect } from '@playwright/test';
import {
  getServiceClient,
  newContext,
  createTestUser,
  cleanup,
  TEST_PASSWORD,
  type TestContext,
} from './helpers';

let ctx: TestContext;

test.describe('low-confidence scan requires correction before publish', () => {
  test.beforeAll(() => {
    ctx = newContext('lowconf');
  });

  test.afterAll(async () => {
    await cleanup(ctx);
  });

  test('donor must confirm a low-confidence item before the listing can be published', async ({ page }) => {
    const service = getServiceClient();
    const donor = await createTestUser(ctx, 'donor');

    // ── Log in as the pre-verified donor ────────────────────────────────
    await page.goto('/login');
    // id-based: getByLabel(/Password/i) also matches the "Show password"
    // toggle button's aria-label and throws a strict-mode violation.
    await page.locator('#email').fill(donor.email);
    await page.locator('#password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: /Sign in/i }).click();
    await page.waitForURL(/\/donor\/dashboard/, { timeout: 15000 });

    // ── Start a new listing and upload the low-confidence fixture ──────
    await page.goto('/donor/listings/new');
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(path.join(__dirname, 'fixtures', 'lowconf.jpg'));

    // Scanning phase, then the correction UI must appear (this is the gate:
    // the form is NOT auto-populated — the donor must make an explicit choice).
    await expect(page.getByText(/We.re not fully confident/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Unlabeled Casserole')).toBeVisible();

    // Confirm the suggested item — this is the "correction" the donor must take.
    await page.getByText('Unlabeled Casserole').click();

    // ── Details step: fields are prefilled from the confirmed selection ─
    // The "What food..." input has no htmlFor/id pairing with its label, so
    // its accessible name falls back to the placeholder — match on that.
    await expect(page.getByPlaceholder(/Roasted Chicken Thighs/i)).toHaveValue('Unlabeled Casserole');
    await page.getByRole('button', { name: /Continue to pricing/i }).click();

    // ── Pricing step: PREPARED_HOT_FOOD is temperature-sensitive, so a
    // prepared-at time is required before pricing can be confirmed ───────
    const preparedAt = new Date(Date.now() - 5 * 60 * 1000);
    const localValue = new Date(preparedAt.getTime() - preparedAt.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    await page.locator('input[type="datetime-local"]').fill(localValue);
    await page.getByRole('button', { name: /AI suggestion|Confirm pricing/i }).click();

    // ── Attest + publish ─────────────────────────────────────────────────
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /Post listing/i }).click();
    await page.waitForURL(/\/donor\/dashboard/, { timeout: 15000 });

    // ── Verify server-side: the listing carries the low confidence score
    // and only went live because the donor explicitly confirmed it ──────
    const { data: listing } = await service
      .from('listings')
      .select('id, status, confidence_score, usda_category, temperature_sensitive')
      .eq('donor_id', donor.id)
      .eq('detected_item', 'Unlabeled Casserole')
      .single();

    expect(listing).toBeTruthy();
    if (listing) ctx.listingIds.push(listing.id);
    expect(listing?.status).toBe('live');
    expect(Number(listing?.confidence_score)).toBeCloseTo(0.55, 2);
    expect(listing?.usda_category).toBe('PREPARED_HOT_FOOD');
    expect(listing?.temperature_sensitive).toBe(true);
  });
});
