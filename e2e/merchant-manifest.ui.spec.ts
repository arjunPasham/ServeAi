// Phase 1 pivot acceptance: a merchant scans a photo, confirms the manifest
// (two items in the dev-mode synthetic scan), and a declared load with
// valuation snapshots exists in the DB. This is the "four minutes at the
// deli case" flow, end to end through the real browser.
import path from 'path';
import { test, expect } from '@playwright/test';
import {
  getServiceClient,
  newContext,
  createTestUser,
  createMerchant,
  cleanup,
  TEST_PASSWORD,
  type TestContext,
} from './helpers';

let ctx: TestContext;

test.describe('merchant scan → manifest → declared load', () => {
  test.beforeAll(() => {
    ctx = newContext('manifestui');
  });

  test.afterAll(async () => {
    await cleanup(ctx);
  });

  test('scan, edit, confirm — load lands in the DB with items and snapshots', async ({ page }) => {
    const service = getServiceClient();
    const user = await createTestUser(ctx, 'donor');
    const { merchantId } = await createMerchant(ctx, user.id);

    // Log in
    await page.goto('/login');
    await page.locator('#email').fill(user.email);
    await page.locator('#password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/merchant/dashboard');

    // Scan (dev mode: two-item synthetic — Penne PREPARED_HOT + Chicken POULTRY_RAW)
    await page.goto('/merchant/scan');
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(path.join(__dirname, 'fixtures', 'normal.jpg'));

    // Both items render in the manifest editor
    await expect(page.getByLabel('Item 1 name')).toHaveValue('Penne Pasta Tray');
    await expect(page.getByLabel('Item 2 name')).toHaveValue('Roast Chicken Halves');

    // Confirm is blocked until TCS items get prepared-at times
    const confirmButton = page.getByRole('button', { name: /confirm manifest/i });
    await expect(confirmButton).toBeDisabled();

    // Fill prepared-at for both TCS items (30 minutes ago, local wall clock)
    const prepared = new Date(Date.now() - 30 * 60 * 1000);
    const local = new Date(prepared.getTime() - prepared.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    const preparedInputs = page.locator('input[type="datetime-local"]');
    await expect(preparedInputs).toHaveCount(2);
    await preparedInputs.nth(0).fill(local);
    await preparedInputs.nth(1).fill(local);

    // Edit the first item's weight
    await page.getByLabel('Item 1 weight in pounds').fill('6');

    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    // Lands on the dashboard with the declared load visible
    await page.waitForURL('**/merchant/dashboard');
    await expect(page.getByText(/2 items/)).toBeVisible();
    await expect(page.getByText('Declared')).toBeVisible();

    // DB truth: one load, two snapshot lines, confirmed + linked scan items
    const { data: loads } = await service
      .from('loads')
      .select('id, status, earliest_safety_expires_at, load_items(est_lbs, fmv_per_lb_cents, basis_per_lb_cents)')
      .eq('merchant_id', merchantId);
    expect(loads).toHaveLength(1);
    expect(loads![0].status).toBe('declared');
    expect(loads![0].earliest_safety_expires_at).not.toBeNull();
    const lineWeights = (loads![0].load_items as { est_lbs: number }[]).map(li => Number(li.est_lbs)).sort();
    expect(lineWeights).toEqual([6, 6]); // edited penne 6 lbs + chicken 6 lbs

    const { data: confirmedItems } = await service
      .from('scan_items')
      .select('merchant_confirmed, load_id, safety_expires_at')
      .eq('load_id', loads![0].id);
    expect(confirmedItems).toHaveLength(2);
    expect(confirmedItems!.every(i => i.merchant_confirmed && i.safety_expires_at)).toBe(true);
  });

  // Task 6 review finding, closed out here: items the merchant removes from
  // the manifest editor before confirming must be closed out as
  // disposition='not_shipped' (analysis/03, schema decision 1) rather than
  // left dangling in 'pending'. No prior test drove this path.
  test('scan, remove one item, confirm — removed item closes out as not_shipped', async ({ page }) => {
    const service = getServiceClient();
    const user = await createTestUser(ctx, 'donor', { emailLabel: 'removeflow' });
    const { merchantId } = await createMerchant(ctx, user.id);

    // Log in
    await page.goto('/login');
    await page.locator('#email').fill(user.email);
    await page.locator('#password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/merchant/dashboard');

    // Scan (dev mode: two-item synthetic — Penne PREPARED_HOT + Chicken POULTRY_RAW)
    await page.goto('/merchant/scan');
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(path.join(__dirname, 'fixtures', 'normal.jpg'));

    await expect(page.getByLabel('Item 1 name')).toHaveValue('Penne Pasta Tray');
    await expect(page.getByLabel('Item 2 name')).toHaveValue('Roast Chicken Halves');

    // Remove the second item (Roast Chicken Halves) from the manifest editor
    await page.getByRole('button', { name: 'Remove item 2' }).click();
    await expect(page.getByLabel('Item 1 name')).toHaveValue('Penne Pasta Tray');
    await expect(page.getByLabel('Item 2 name')).toHaveCount(0);

    // Confirm is blocked until the remaining TCS item gets a prepared-at time
    const confirmButton = page.getByRole('button', { name: /confirm manifest/i });
    await expect(confirmButton).toBeDisabled();

    const prepared = new Date(Date.now() - 30 * 60 * 1000);
    const local = new Date(prepared.getTime() - prepared.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    const preparedInputs = page.locator('input[type="datetime-local"]');
    await expect(preparedInputs).toHaveCount(1);
    await preparedInputs.nth(0).fill(local);

    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    // Lands on the dashboard with the (single-item) declared load visible
    await page.waitForURL('**/merchant/dashboard');
    await expect(page.getByText(/1 item\b/)).toBeVisible();
    await expect(page.getByText('Declared')).toBeVisible();

    // DB truth: one load with exactly one line item
    const { data: loads } = await service
      .from('loads')
      .select('id, load_items(id)')
      .eq('merchant_id', merchantId);
    expect(loads).toHaveLength(1);
    expect(loads![0].load_items).toHaveLength(1);
    const loadId = loads![0].id;

    // Find this run's scan_record through the merchant id (the /api/scan
    // response body isn't visible to the test), then its scan_items.
    const { data: scanRecords } = await service
      .from('scan_records')
      .select('id')
      .eq('merchant_id', merchantId);
    expect(scanRecords).toHaveLength(1);
    const scanRecordId = scanRecords![0].id;

    const { data: items } = await service
      .from('scan_items')
      .select('food_name, merchant_confirmed, load_id, disposition, disposition_at')
      .eq('scan_record_id', scanRecordId);
    expect(items).toHaveLength(2);

    const kept = items!.find(i => i.load_id !== null);
    const removed = items!.find(i => i.load_id === null);

    expect(kept).toBeTruthy();
    expect(kept!.food_name).toBe('Penne Pasta Tray');
    expect(kept!.merchant_confirmed).toBe(true);
    expect(kept!.load_id).toBe(loadId);

    expect(removed).toBeTruthy();
    expect(removed!.food_name).toBe('Roast Chicken Halves');
    expect(removed!.disposition).toBe('not_shipped');
    expect(removed!.disposition_at).not.toBeNull();
    expect(removed!.load_id).toBeNull();
  });
});
