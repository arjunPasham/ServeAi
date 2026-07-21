/**
 * POST /api/scan — accepts a food photo and returns a structured FoodScanResult
 * plus a hosted image URL for the listing record.
 *
 * Runs on the Node.js runtime (Gemini SDK + Buffer). The GEMINI_API_KEY stays
 * server-side; the image never leaves this server except to call Gemini.
 * Requires an authenticated session — this endpoint spends Gemini quota.
 */

import { randomUUID } from 'crypto';
import { scanFoodImage, MODEL } from '@/services/foodVision';
import { createServiceClient } from '@/lib/supabase/server';
import { requireVerifiedMerchant, type RequireVerifiedMerchantResult } from '@/lib/authz';
import { checkScanUserLimit } from '@/lib/rate-limit';
import { persistScanResult, type PersistedScan } from '@/lib/scan-persist';

export const runtime = 'nodejs';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export async function POST(req: Request): Promise<Response> {
  // Gate on the full invariant — authenticated + phone-verified + owns a
  // merchants row — BEFORE spending any Gemini quota (review C1). phone_verified
  // was previously enforced only in page middleware, which never runs for this
  // API route, so an unverified account could reach real spend.
  let authz: RequireVerifiedMerchantResult;
  try {
    authz = await requireVerifiedMerchant();
  } catch (err) {
    console.error('[scan] merchant authz failed:', err);
    return Response.json({ error: 'Could not resolve merchant account.' }, { status: 500 });
  }
  if (!authz.ok) {
    if (authz.error === 'NOT_AUTHENTICATED') {
      return Response.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    if (authz.error === 'PHONE_NOT_VERIFIED') {
      return Response.json({ error: 'Phone verification required.' }, { status: 403 });
    }
    // Every scan must land in the dataset (the pivot's core asset): no merchants
    // row → no scan.
    return Response.json({ error: 'Scanning requires a merchant account.' }, { status: 403 });
  }
  const userId = authz.merchant.userId;
  const merchant = { id: authz.merchant.merchantId };
  const service = await createServiceClient();

  const limit = await checkScanUserLimit(userId);
  if (!limit.allowed) {
    return Response.json(
      { error: 'Too many scans — please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter ?? 60) } },
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return Response.json(
      { error: "Expected multipart/form-data with an 'image' field." },
      { status: 400 },
    );
  }

  const image = formData.get('image');
  if (!(image instanceof File)) {
    return Response.json({ error: "Missing 'image' file field." }, { status: 400 });
  }

  if (!ALLOWED_TYPES.has(image.type)) {
    return Response.json(
      {
        error: `Unsupported image type: ${image.type || 'unknown'}. Allowed: ${[
          ...ALLOWED_TYPES,
        ].join(', ')}.`,
      },
      { status: 415 },
    );
  }

  if (image.size > MAX_BYTES) {
    return Response.json(
      { error: `Image too large (${image.size} bytes). Max is ${MAX_BYTES}.` },
      { status: 413 },
    );
  }

  const arrayBuffer = await image.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const imageBase64 = buffer.toString('base64');

  const result = await scanFoodImage(imageBase64, image.type, image.name);

  // Persist the photo so the listing shows the real food, not a placeholder.
  // Server-generated path — the client never controls storage keys. The bucket
  // is PRIVATE (009_storage.sql / SH-3): the storage key goes into the listing
  // record and readers get short-lived signed URLs; previewUrl is only for the
  // immediate scan UI.
  let imagePath: string | null = null;
  let previewUrl: string | null = null;
  try {
    const path = `scans/${userId}/${randomUUID()}.${EXT_BY_TYPE[image.type] ?? 'jpg'}`;
    const { error: uploadError } = await service.storage
      .from('listing-photos')
      .upload(path, buffer, { contentType: image.type });
    if (!uploadError) {
      imagePath = path;
      const { data } = await service.storage
        .from('listing-photos')
        .createSignedUrl(path, 3600);
      previewUrl = data?.signedUrl ?? null;
    }
  } catch {
    // Non-fatal: scan results are still useful without a hosted image
  }

  // Persist the scan server-side — the client never gets a result that isn't
  // already in the dataset. Failure here is a failed scan, not a soft warning.
  let persisted: PersistedScan;
  try {
    persisted = await persistScanResult(service, {
      merchantId: merchant.id,
      scannedBy: userId,
      photoKey: imagePath,
      modelId: process.env.GEMINI_API_KEY ? MODEL : 'dev-synthetic',
      result,
    });
  } catch (err) {
    console.error('[scan] persistence failed:', err);
    return Response.json({ error: 'Scan could not be recorded. Please try again.' }, { status: 500 });
  }

  // 422 signals "we have a result but it should not be auto-trusted".
  return Response.json(
    {
      ...result,
      items: result.items.map((item, i) => ({ ...item, scanItemId: persisted.scanItemIds[i] ?? null })),
      scanRecordId: persisted.scanRecordId,
      imagePath,
      previewUrl,
    },
    { status: result.needsManualReview ? 422 : 200 },
  );
}
