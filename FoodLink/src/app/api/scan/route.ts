/**
 * POST /api/scan — accepts a food photo and returns a structured FoodScanResult.
 *
 * Runs on the Node.js runtime (Gemini SDK + Buffer). The GEMINI_API_KEY stays
 * server-side; the image never leaves this server except to call Gemini.
 *
 * NOTE: built for isolated testing of the vision pipeline — not yet wired into
 * any live listing/checkout flow.
 */

import { NextResponse } from "next/server";
import { scanFoodImage } from "../../../services/foodVision";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export async function POST(req: Request): Promise<Response> {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data with an 'image' field." },
      { status: 400 },
    );
  }

  const image = formData.get("image");
  if (!(image instanceof File)) {
    return NextResponse.json(
      { error: "Missing 'image' file field." },
      { status: 400 },
    );
  }

  if (!ALLOWED_TYPES.has(image.type)) {
    return NextResponse.json(
      {
        error: `Unsupported image type: ${image.type || "unknown"}. Allowed: ${[
          ...ALLOWED_TYPES,
        ].join(", ")}.`,
      },
      { status: 415 },
    );
  }

  if (image.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Image too large (${image.size} bytes). Max is ${MAX_BYTES}.` },
      { status: 413 },
    );
  }

  const arrayBuffer = await image.arrayBuffer();
  const imageBase64 = Buffer.from(arrayBuffer).toString("base64");

  const result = await scanFoodImage(imageBase64, image.type);

  // 422 signals "we have a result but it should not be auto-trusted".
  return NextResponse.json(result, {
    status: result.needsManualReview ? 422 : 200,
  });
}
