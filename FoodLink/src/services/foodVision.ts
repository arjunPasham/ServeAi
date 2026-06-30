/**
 * foodVision — server-side Gemini Vision food scanner.
 *
 * Identifies distinct foods in a photo and estimates catering quantities.
 * SERVER-ONLY: reads GEMINI_API_KEY at call time. Never import into client code.
 *
 * Uses the @google/genai SDK (the current SDK; NOT the deprecated
 * @google/generative-ai package).
 */

import { GoogleGenAI, Type } from "@google/genai";
import {
  FOOD_CATEGORIES,
  type FoodItem,
  type FoodScanResult,
} from "../types/food";

/** Model id — kept in one place so it is trivial to swap. */
const MODEL = "gemini-2.5-flash";

// --- Review thresholds (named so the policy is obvious and tunable) ---------
/** Flag for review if the overall confidence drops below this. */
const MIN_OVERALL_CONFIDENCE = 0.6;
/** Flag for review if ANY single item's confidence drops below this. */
const MIN_ITEM_CONFIDENCE = 0.5;
/** Flag for review if total estimated servings across all items exceeds this. */
const MAX_AUTO_SERVINGS = 50;
/** Flag for review if the number of distinct items exceeds this. */
const MAX_AUTO_ITEMS = 6;

/**
 * Lazy singleton client. We construct it on first use (not at import time) so
 * the API key is read when a scan actually runs — this keeps imports cheap and
 * lets the route boot even if the key is configured later.
 */
let cachedClient: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to .env.local (server-side, no NEXT_PUBLIC_ prefix).",
    );
  }
  cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}

/**
 * Structured-output schema mirroring FoodScanResult. propertyOrdering pins the
 * key order so the model emits a stable, predictable shape, and `category` is
 * constrained to the FOOD_CATEGORIES enum.
 */
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          foodName: { type: Type.STRING },
          category: { type: Type.STRING, enum: [...FOOD_CATEGORIES] },
          estimatedQuantity: { type: Type.NUMBER },
          unit: { type: Type.STRING },
          estimatedServings: { type: Type.NUMBER },
          confidence: { type: Type.NUMBER },
        },
        propertyOrdering: [
          "foodName",
          "category",
          "estimatedQuantity",
          "unit",
          "estimatedServings",
          "confidence",
        ],
        required: [
          "foodName",
          "category",
          "estimatedQuantity",
          "unit",
          "estimatedServings",
          "confidence",
        ],
      },
    },
    overallConfidence: { type: Type.NUMBER },
    needsManualReview: { type: Type.BOOLEAN },
    notes: { type: Type.STRING },
  },
  propertyOrdering: ["items", "overallConfidence", "needsManualReview", "notes"],
  required: ["items", "overallConfidence", "needsManualReview", "notes"],
} as const;

const SYSTEM_PROMPT = `You are a professional catering estimator for a food-rescue platform.
A photo shows surplus prepared food that may be donated. Analyze it carefully.

For EACH distinct food you can identify:
- Name it specifically (e.g. "beef lasagna", not just "pasta").
- Classify it into exactly one of the allowed categories.
- Estimate how much is present (estimatedQuantity + unit) and how many
  single-person servings it provides (estimatedServings).
- Give a per-item confidence in [0,1] for how sure you are.

Use these serving references when judging quantity:
- A full hotel/steam pan ≈ 20–25 servings.
- A half pan ≈ 10–12 servings.
- A quarter pan ≈ 5–6 servings.
- A single plate ≈ 1 serving.
Scale proportionally for partial pans and visible fill levels.

Be CONSERVATIVE when unsure: prefer lower serving counts and lower confidence
rather than guessing high. If the image is unclear, blurry, empty, or not food,
return an empty items array and explain why in notes.

Also provide an overallConfidence in [0,1] for the whole scan, a
needsManualReview boolean, and short notes explaining your reasoning or any
uncertainty. Respond ONLY with JSON matching the provided schema.`;

/** Clamp any number into [0,1]; non-finite input becomes 0. */
function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** Build the safe fallback result returned on any failure. */
function safeFailure(notes: string): FoodScanResult {
  return {
    items: [],
    overallConfidence: 0,
    needsManualReview: true,
    notes,
  };
}

/**
 * Scan a single food image and return a structured estimate.
 *
 * @param imageBase64 Base64-encoded image bytes (no data: URL prefix).
 * @param mimeType    e.g. "image/jpeg", "image/png", "image/webp".
 */
export async function scanFoodImage(
  imageBase64: string,
  mimeType: string,
): Promise<FoodScanResult> {
  try {
    const ai = getClient();

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: SYSTEM_PROMPT },
            { inlineData: { mimeType, data: imageBase64 } },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    const text = response.text;
    if (!text) {
      return safeFailure("Model returned an empty response.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return safeFailure(
        `Failed to parse model JSON. Raw response: ${text.slice(0, 500)}`,
      );
    }

    const raw = parsed as Partial<FoodScanResult>;

    // Normalize + clamp items defensively — never trust the model's numbers.
    const items: FoodItem[] = Array.isArray(raw.items)
      ? raw.items.map((it) => {
          const item = it as Partial<FoodItem>;
          return {
            foodName: String(item.foodName ?? "Unknown"),
            category: (FOOD_CATEGORIES as readonly string[]).includes(
              item.category as string,
            )
              ? (item.category as FoodItem["category"])
              : "Other",
            estimatedQuantity: Number(item.estimatedQuantity) || 0,
            unit: String(item.unit ?? ""),
            estimatedServings: Number(item.estimatedServings) || 0,
            confidence: clamp01(item.confidence),
          };
        })
      : [];

    const overallConfidence = clamp01(raw.overallConfidence);
    const notes = String(raw.notes ?? "");

    // Do NOT trust the model for the review flag — derive it from policy.
    const totalServings = items.reduce((sum, i) => sum + i.estimatedServings, 0);
    const needsManualReview =
      items.length === 0 ||
      overallConfidence < MIN_OVERALL_CONFIDENCE ||
      items.some((i) => i.confidence < MIN_ITEM_CONFIDENCE) ||
      totalServings > MAX_AUTO_SERVINGS ||
      items.length > MAX_AUTO_ITEMS;

    return { items, overallConfidence, needsManualReview, notes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return safeFailure(`Scan failed: ${message}`);
  }
}
