// Bridges the Gemini vision categories (types/food.ts FOOD_CATEGORIES) to the
// USDA pricing categories used by the listing/pricing pipeline. Without this
// mapping the scan results could never become listings.
import type { FoodCategory, FoodItem } from '@/types/food';

export const FOOD_TO_USDA: Record<FoodCategory, string> = {
  'Pasta': 'PREPARED_HOT_FOOD',
  'Rice & Grains': 'COOKED_RICE',
  'Meat': 'BEEF',
  'Poultry': 'POULTRY',
  'Seafood': 'SEAFOOD',
  'Vegetables': 'CUT_PRODUCE',
  'Salad': 'CUT_PRODUCE',
  'Soup': 'PREPARED_HOT_FOOD',
  'Bread & Bakery': 'BAKED_GOOD',
  'Dessert': 'BAKED_GOOD',
  'Fruit': 'PRODUCE_ROOT', // whole fruit: shelf-stable produce pricing tier
  'Dairy': 'DAIRY',
  'Beverage': 'OTHER',
  'Mixed/Prepared Meal': 'PREPARED_HOT_FOOD',
  'Other': 'OTHER',
};

export function toUsdaCategory(category: FoodCategory): string {
  return FOOD_TO_USDA[category] ?? 'OTHER';
}

// Rough single-person serving weight used when the model reports servings/trays
// instead of a weight unit.
const LBS_PER_SERVING = 0.75;

// Convert a scanned item's quantity estimate into pounds for the listing form.
export function estimateLbs(item: FoodItem): number {
  const unit = item.unit.toLowerCase();
  if (item.estimatedQuantity > 0) {
    if (unit.includes('lb') || unit.includes('pound')) {
      return round1(item.estimatedQuantity);
    }
    if (unit.includes('kg') || unit.includes('kilo')) {
      return round1(item.estimatedQuantity * 2.205);
    }
    if (unit.includes('oz') || unit.includes('ounce')) {
      return round1(item.estimatedQuantity / 16);
    }
  }
  if (item.estimatedServings > 0) {
    return round1(item.estimatedServings * LBS_PER_SERVING);
  }
  return 1;
}

function round1(n: number): number {
  return Math.max(0.1, Math.round(n * 10) / 10);
}
