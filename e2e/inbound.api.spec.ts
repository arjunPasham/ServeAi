// Phase 2 (Match), Task 4 — the no-login inbound view's DATA path: create a
// merchant + declared load + active-verified institution, offer_load it,
// then exercise the ACTUAL production functions (src/actions/inbound.ts) the
// public /inbound/[token] page calls — resolving by TOKEN (never an
// allocationId), accept/decline via respond_to_offer, and the not-found
// property for a wrong/expired/terminal token. The page's own render/404/
// rate-limit behavior is browser-level and belongs to Task 5's ui coverage;
// this file proves the token->respond path + the bad-token-no-data property
// at the data layer, same style as allocations.api.spec.ts (no HTTP layer,
// no browser).
//
// actions/inbound.ts is importable directly here (unlike most 'use server'
// action files) because it only calls createServiceClient() — never
// createClient()/cookies() — so it never touches next/headers at runtime;
// see src/lib/scan-persist.ts's "framework-free" precedent for the same
// reasoning applied to a plain lib module.
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
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
import { getInboundOffer, respondToOffer } from '../src/actions/inbound';
import { sendEmail } from '../src/lib/email';

let ctx: TestContext;

test.describe('inbound token -> preview -> accept/decline (Phase 2 Task 4)', () => {
  test.beforeAll(() => {
    ctx = newContext('inbound');
  });

  test.afterAll(async () => {
    await cleanup(ctx);
  });

  test('resolves a valid token to its receiver-safe preview, then accept flips allocation+load and writes an audit row', async () => {
    const service = getServiceClient();
    const user = await createTestUser(ctx, 'donor', { emailLabel: 'inbound-accept' });
    const merchantName = `E2E Inbound Merchant ${ctx.runId}`;
    const { merchantId } = await createMerchant(ctx, user.id, { businessName: merchantName });
    const safetyExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const { loadId } = await createDeclaredLoad(ctx, {
      merchantId,
      scannedBy: user.id,
      items: [{ categoryKey: 'BAKERY', foodName: 'Sourdough Loaves', estLbs: 4, safetyExpiresAt }],
    });
    const { institutionId } = await createInstitution(ctx, { orgName: `E2E Inbound Institution ${ctx.runId}` });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const { data: alloc, error } = await service.rpc('offer_load', {
      p_load_id: loadId,
      p_institution_id: institutionId,
      p_offered_by: user.id,
      p_expires_at: expiresAt,
    });
    expect(error).toBeNull();
    expect(alloc.public_view_token).toBeTruthy();

    // Resolve BY TOKEN — the no-login view's only entry point. No
    // allocationId is ever passed in.
    const offer = await getInboundOffer(alloc.public_view_token);
    expect(offer).not.toBeNull();
    expect(offer!.status).toBe('viewable');
    expect(offer!.merchantBusinessName).toBe(merchantName);
    expect(offer!.windowDate).toBeTruthy();
    expect(offer!.items).toHaveLength(1);
    expect(offer!.items[0].foodName).toBe('Sourdough Loaves');
    expect(offer!.items[0].categoryLabel).toBe('Bakery & desserts');
    expect(offer!.items[0].estLbs).toBe(4);
    // Postgres round-trips timestamptz in its own text format (offset
    // notation, not necessarily 'Z' with 3-digit ms) — compare by instant,
    // not by exact string.
    expect(new Date(offer!.items[0].safetyExpiresAt!).getTime()).toBe(new Date(safetyExpiresAt).getTime());
    // PII check: InboundOffer/InboundOfferItem simply have no fields for
    // signer contact, merchant address, or any valuation/$$ column — there
    // is nothing in the returned shape capable of leaking them.
    expect(Object.keys(offer!).sort()).toEqual(['items', 'merchantBusinessName', 'status', 'windowDate'].sort());
    expect(Object.keys(offer!.items[0]).sort()).toEqual(
      ['categoryLabel', 'estLbs', 'foodName', 'safetyExpiresAt'].sort()
    );

    const result = await respondToOffer(alloc.public_view_token, 'accepted');
    expect(result).toEqual({ success: true });

    const { data: accepted } = await service.from('allocations').select('status').eq('id', alloc.id).single();
    expect(accepted!.status).toBe('accepted');
    const { data: matchedLoad } = await service.from('loads').select('status').eq('id', loadId).single();
    expect(matchedLoad!.status).toBe('matched');

    const { data: auditRows } = await service
      .from('audit_log')
      .select('event_type')
      .eq('entity_type', 'allocation')
      .eq('entity_id', alloc.id)
      .eq('event_type', 'offer_accepted');
    expect((auditRows ?? []).length).toBeGreaterThanOrEqual(1);

    // Post-accept, the view resolves 'accepted' (read-only confirmation) —
    // never not-found. The receiver legitimately accepted it themselves, so
    // this is not the leak the not-found rule guards against.
    const afterAccept = await getInboundOffer(alloc.public_view_token);
    expect(afterAccept!.status).toBe('accepted');
  });

  test('decline flips allocation to declined + frees the load back to declared, with an audit row; the token then resolves to no row', async () => {
    const service = getServiceClient();
    const user = await createTestUser(ctx, 'donor', { emailLabel: 'inbound-decline' });
    const { merchantId } = await createMerchant(ctx, user.id);
    const { loadId } = await createDeclaredLoad(ctx, {
      merchantId,
      scannedBy: user.id,
      items: [{ categoryKey: 'BAKERY', foodName: 'Bagels', estLbs: 2 }],
    });
    const { institutionId } = await createInstitution(ctx, { orgName: `E2E Inbound Decline ${ctx.runId}` });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const { data: alloc } = await service.rpc('offer_load', {
      p_load_id: loadId,
      p_institution_id: institutionId,
      p_offered_by: user.id,
      p_expires_at: expiresAt,
    });

    const result = await respondToOffer(alloc.public_view_token, 'declined');
    expect(result).toEqual({ success: true });

    const { data: declined } = await service.from('allocations').select('status').eq('id', alloc.id).single();
    expect(declined!.status).toBe('declined');
    const { data: freedLoad } = await service.from('loads').select('status').eq('id', loadId).single();
    expect(freedLoad!.status).toBe('declared');

    const { data: auditRows } = await service
      .from('audit_log')
      .select('event_type')
      .eq('entity_type', 'allocation')
      .eq('entity_id', alloc.id)
      .eq('event_type', 'offer_declined');
    expect((auditRows ?? []).length).toBeGreaterThanOrEqual(1);

    // Terminal 'declined' state must resolve to no row on re-view — a
    // wrong/expired/terminal token leaks nothing further.
    const afterDecline = await getInboundOffer(alloc.public_view_token);
    expect(afterDecline).toBeNull();

    // And a second response attempt against the same (now-terminal) token
    // is rejected by respond_to_offer's own guard, not silently re-applied.
    const secondResult = await respondToOffer(alloc.public_view_token, 'accepted');
    expect(secondResult).toEqual({ success: false, error: 'OFFER_NOT_PENDING' });
  });

  test('an unknown/random token resolves to no row — the not-found basis, and cannot be used to respond', async () => {
    const offer = await getInboundOffer(randomUUID());
    expect(offer).toBeNull();

    const result = await respondToOffer(randomUUID(), 'accepted');
    expect(result).toEqual({ success: false, error: 'NOT_FOUND' });
  });

  test('an expired-but-not-yet-swept offer resolves to no row (past-expiry leaks nothing even though status is still "offered")', async () => {
    const service = getServiceClient();
    const user = await createTestUser(ctx, 'donor', { emailLabel: 'inbound-expired' });
    const { merchantId } = await createMerchant(ctx, user.id);
    const { loadId } = await createDeclaredLoad(ctx, {
      merchantId,
      scannedBy: user.id,
      items: [{ categoryKey: 'BAKERY', foodName: 'Muffins', estLbs: 1 }],
    });
    const { institutionId } = await createInstitution(ctx, { orgName: `E2E Inbound Expired ${ctx.runId}` });
    // offer_load itself never validates expires_at against now() (same note
    // as allocations.api.spec.ts's expire_stale_offers test) — this directly
    // models an offer whose TTL passed before the 10-minute sweep ran.
    const pastExpiresAt = new Date(Date.now() - 60 * 1000).toISOString();

    const { data: alloc } = await service.rpc('offer_load', {
      p_load_id: loadId,
      p_institution_id: institutionId,
      p_offered_by: user.id,
      p_expires_at: pastExpiresAt,
    });

    const { data: stillOffered } = await service.from('allocations').select('status').eq('id', alloc.id).single();
    expect(stillOffered!.status).toBe('offered'); // confirms the sweep hasn't touched it

    const offer = await getInboundOffer(alloc.public_view_token);
    expect(offer).toBeNull();

    const result = await respondToOffer(alloc.public_view_token, 'accepted');
    expect(result).toEqual({ success: false, error: 'OFFER_EXPIRED' });
  });

  test('dev-mode notification path: sendEmail (the channel offer-notification.ts calls) logs [DEV] Email in dev mode', async () => {
    // Lightweight confirmation of the notification path per the task brief —
    // not a full Inngest-invocation test (offer-notification.ts's own event
    // handler runs under Inngest's step machinery, which isn't invokable
    // from a plain Playwright process without heavy test infra the brief
    // says to skip). This asserts the exact dev-mode fallback
    // offer-notification.ts relies on for its email leg.
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(String(args[0] ?? ''));
      originalLog(...args);
    };
    try {
      const result = await sendEmail({
        to: 'inbound-e2e@example.com',
        subject: 'New surplus food offer — E2E Inbound Institution',
        text: 'itemized preview + link',
      });
      expect(result.sent).toBe(true);
    } finally {
      console.log = originalLog;
    }
    expect(logs.some(line => line.includes('[DEV] Email'))).toBe(true);
  });
});
