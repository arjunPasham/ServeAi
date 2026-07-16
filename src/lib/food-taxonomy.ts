// Bridges Gemini vision categories (types/food.ts) to the stable, immutable
// category_key taxonomy (categories table, 018). Framework-free with RELATIVE
// imports only — this file is imported by Playwright e2e specs via
// src/lib/scan-persist.ts, which cannot resolve the '@/' alias.
import type { FoodCategory, FoodItem } from '../types/food';

export const FOOD_TO_CATEGORY_KEY: Record<FoodCategory, string> = {
  'Pasta': 'PREPARED_HOT',
  'Rice & Grains': 'PREPARED_HOT',
  'Meat': 'MEAT_RAW',
  'Poultry': 'POULTRY_RAW',
  'Seafood': 'SEAFOOD',
  'Vegetables': 'CUT_PRODUCE',
  'Salad': 'PREPARED_COLD',
  'Soup': 'PREPARED_HOT',
  'Bread & Bakery': 'BAKERY',
  'Dessert': 'BAKERY',
  'Fruit': 'PRODUCE_WHOLE',
  'Dairy': 'DAIRY',
  'Beverage': 'BEVERAGE',
  'Mixed/Prepared Meal': 'PREPARED_HOT',
  'Other': 'OTHER',
};

export function toCategoryKey(category: FoodCategory): string {
  return FOOD_TO_CATEGORY_KEY[category] ?? 'OTHER';
}

// Rough single-person serving weight used when the model reports servings or
// container units instead of a weight. (Moved from category-map.ts, which is
// deleted with the old listing flow.)
const LBS_PER_SERVING = 0.75;

export function estimateLbs(item: FoodItem): number {
  const unit = item.unit.toLowerCase();
  if (item.estimatedQuantity > 0) {
    if (unit.includes('lb') || unit.includes('pound')) return round1(item.estimatedQuantity);
    if (unit.includes('kg') || unit.includes('kilo')) return round1(item.estimatedQuantity * 2.205);
    if (unit.includes('oz') || unit.includes('ounce')) return round1(item.estimatedQuantity / 16);
  }
  if (item.estimatedServings > 0) return round1(item.estimatedServings * LBS_PER_SERVING);
  return 1;
}

function round1(n: number): number {
  return Math.max(0.1, Math.round(n * 10) / 10);
}
