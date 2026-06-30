/**
 * Food domain types — shared across the FoodLink scan pipeline.
 *
 * NOTE: This file was an empty placeholder; these are the first types defined
 * here. New, unrelated food types can be appended below without touching these.
 */

/**
 * Canonical food categories used for scan results and listing classification.
 * Order matters: it is reused as the Gemini structured-output enum, so keep
 * additions deliberate.
 */
export const FOOD_CATEGORIES = [
  "Pasta",
  "Rice & Grains",
  "Meat",
  "Poultry",
  "Seafood",
  "Vegetables",
  "Salad",
  "Soup",
  "Bread & Bakery",
  "Dessert",
  "Fruit",
  "Dairy",
  "Beverage",
  "Mixed/Prepared Meal",
  "Other",
] as const;

export type FoodCategory = (typeof FOOD_CATEGORIES)[number];

/** A single distinct food identified in a scanned photo. */
export interface FoodItem {
  foodName: string;
  category: FoodCategory;
  /** Estimated amount, expressed in `unit`. */
  estimatedQuantity: number;
  /** Unit for `estimatedQuantity`, e.g. "servings", "kg", "trays", "pieces". */
  unit: string;
  /** Estimated number of single-person servings this item provides. */
  estimatedServings: number;
  /** Model confidence for this item, clamped to 0–1. */
  confidence: number;
}

/** Full result of scanning one food photo. */
export interface FoodScanResult {
  items: FoodItem[];
  /** Aggregate confidence across the whole scan, clamped to 0–1. */
  overallConfidence: number;
  /** True when a human should review before the result is trusted. */
  needsManualReview: boolean;
  /** Free-text notes: model rationale, caveats, or error details on failure. */
  notes: string;
}
