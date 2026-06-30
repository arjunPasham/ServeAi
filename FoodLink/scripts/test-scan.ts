/**
 * Isolated test harness for the Gemini Vision food-scan pipeline.
 *
 * Runs every image in ./test-images through scanFoodImage(), prints the JSON,
 * validates the shape, and reports auto-approve vs. needs-review + timing.
 *
 *   npx tsx scripts/test-scan.ts
 *
 * Loads .env.local (for GEMINI_API_KEY) before importing the service, so the
 * lazy client picks up the key. Does NOT touch any live flow.
 */

import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { scanFoodImage } from "../src/services/foodVision";
import { FOOD_CATEGORIES, type FoodScanResult } from "../src/types/food";

// Load .env.local explicitly (dotenv defaults to .env). Static imports are safe
// here because foodVision uses a lazy client that reads GEMINI_API_KEY at call
// time (inside scanFoodImage), not at import time — so loading env before main()
// runs is sufficient, and no top-level await is needed.
loadEnv({ path: resolve(process.cwd(), ".env.local") });

const TEST_DIR = resolve(process.cwd(), "test-images");

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

/** Structural validation of a FoodScanResult. Returns a list of problems. */
function validate(result: unknown): string[] {
  const errors: string[] = [];
  const r = result as Partial<FoodScanResult>;

  if (typeof result !== "object" || result === null) {
    return ["result is not an object"];
  }
  if (!Array.isArray(r.items)) errors.push("items is not an array");
  if (typeof r.overallConfidence !== "number")
    errors.push("overallConfidence is not a number");
  else if (r.overallConfidence < 0 || r.overallConfidence > 1)
    errors.push(`overallConfidence ${r.overallConfidence} out of [0,1]`);
  if (typeof r.needsManualReview !== "boolean")
    errors.push("needsManualReview is not a boolean");
  if (typeof r.notes !== "string") errors.push("notes is not a string");

  if (Array.isArray(r.items)) {
    r.items.forEach((item, i) => {
      if (typeof item.foodName !== "string")
        errors.push(`items[${i}].foodName not a string`);
      if (!(FOOD_CATEGORIES as readonly string[]).includes(item.category))
        errors.push(`items[${i}].category "${item.category}" not in enum`);
      if (typeof item.estimatedQuantity !== "number")
        errors.push(`items[${i}].estimatedQuantity not a number`);
      if (typeof item.unit !== "string")
        errors.push(`items[${i}].unit not a string`);
      if (typeof item.estimatedServings !== "number")
        errors.push(`items[${i}].estimatedServings not a number`);
      if (
        typeof item.confidence !== "number" ||
        item.confidence < 0 ||
        item.confidence > 1
      )
        errors.push(`items[${i}].confidence ${item.confidence} invalid`);
    });
  }
  return errors;
}

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.error(
      "✗ GEMINI_API_KEY not found. Add it to .env.local (no NEXT_PUBLIC_ prefix) and retry.",
    );
    process.exit(1);
  }

  if (!existsSync(TEST_DIR)) {
    console.error(`✗ test-images/ folder not found at ${TEST_DIR}`);
    process.exit(1);
  }

  const files = readdirSync(TEST_DIR).filter((f) =>
    Object.keys(MIME_BY_EXT).includes(extname(f).toLowerCase()),
  );

  if (files.length === 0) {
    console.error(
      `✗ No images found in ${TEST_DIR}. Drop some .jpg/.png/.webp photos in and retry.`,
    );
    process.exit(1);
  }

  console.log(`Found ${files.length} image(s) in ${TEST_DIR}\n`);

  let approved = 0;
  let review = 0;
  let invalid = 0;

  for (const file of files) {
    const mime = MIME_BY_EXT[extname(file).toLowerCase()];
    const base64 = readFileSync(join(TEST_DIR, file)).toString("base64");

    console.log("─".repeat(70));
    console.log(`▶ ${file}  (${mime})`);

    const started = Date.now();
    const result = await scanFoodImage(base64, mime);
    const ms = Date.now() - started;

    console.log(JSON.stringify(result, null, 2));

    const errors = validate(result);
    if (errors.length > 0) {
      invalid++;
      console.log(`✗ SCHEMA INVALID:\n   - ${errors.join("\n   - ")}`);
    } else {
      console.log("✓ schema valid");
    }

    if (result.needsManualReview) {
      review++;
      console.log(`⚠ NEEDS MANUAL REVIEW  (${ms} ms)`);
    } else {
      approved++;
      console.log(`✓ AUTO-APPROVED  (${ms} ms)`);
    }
    console.log();
  }

  console.log("═".repeat(70));
  console.log(
    `Summary: ${approved} auto-approved, ${review} need review, ${invalid} schema-invalid (of ${files.length}).`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
