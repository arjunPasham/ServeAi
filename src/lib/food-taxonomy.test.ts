import { describe, expect, test } from 'vitest';
import { toCategoryKey, estimateLbs } from './food-taxonomy';
import { FOOD_CATEGORIES, type FoodCategory, type FoodItem } from '../types/food';

function item(overrides: Partial<FoodItem>): FoodItem {
  return {
    foodName: 'x', category: 'Other', estimatedQuantity: 0, unit: '',
    estimatedServings: 0, confidence: 0.9, ...overrides,
  };
}

describe('toCategoryKey', () => {
  test('maps every Gemini category to a stable key', () => {
    expect(toCategoryKey('Pasta')).toBe('PREPARED_HOT');
    expect(toCategoryKey('Rice & Grains')).toBe('PREPARED_HOT');
    expect(toCategoryKey('Meat')).toBe('MEAT_RAW');
    expect(toCategoryKey('Poultry')).toBe('POULTRY_RAW');
    expect(toCategoryKey('Seafood')).toBe('SEAFOOD');
    expect(toCategoryKey('Vegetables')).toBe('CUT_PRODUCE');
    expect(toCategoryKey('Salad')).toBe('PREPARED_COLD');
    expect(toCategoryKey('Soup')).toBe('PREPARED_HOT');
    expect(toCategoryKey('Bread & Bakery')).toBe('BAKERY');
    expect(toCategoryKey('Dessert')).toBe('PREPARED_COLD');
    expect(toCategoryKey('Fruit')).toBe('CUT_PRODUCE');
    expect(toCategoryKey('Dairy')).toBe('DAIRY');
    expect(toCategoryKey('Beverage')).toBe('BEVERAGE');
    expect(toCategoryKey('Mixed/Prepared Meal')).toBe('PREPARED_HOT');
    expect(toCategoryKey('Other')).toBe('OTHER');
  });

  test('unknown/unrecognized category falls back to OTHER', () => {
    expect(toCategoryKey('NotAReal' as FoodCategory)).toBe('OTHER');
  });

  // Safety invariant (audit #2, 2026-07-21, pilot-blocking): a scanned food
  // must never silently land with NO food-safety window. The whole pipeline
  // (ManifestEditor prepared-at prompt/gate, confirmManifest's TCS/window
  // derivation) is driven entirely by categories.temperature_sensitive, so
  // the only way this invariant can be verified without a DB is to mirror
  // the seeded TCS set here and assert every mapping lands in it unless the
  // category is DELIBERATELY, explicitly marked safe.
  describe('conservative-by-default safety invariant', () => {
    // mirror of categories table (018 seed + migration 022); keep in sync
    const TCS_KEYS = new Set([
      'PREPARED_HOT',
      'PREPARED_COLD',
      'MEAT_RAW',
      'POULTRY_RAW',
      'SEAFOOD',
      'DELI',
      'DAIRY',
      'EGGS',
      'CUT_PRODUCE',
      'OTHER',
    ]);

    // The only Gemini categories deliberately mapped to a non-TCS key —
    // every other category must resolve into TCS_KEYS. Note: 'Fruit' is NO
    // LONGER in this set (it now maps to CUT_PRODUCE, which is TCS).
    const DELIBERATELY_SAFE: ReadonlySet<FoodCategory> = new Set([
      'Bread & Bakery',
      'Beverage',
    ]);

    test('every FoodCategory maps into a TCS key unless deliberately marked safe', () => {
      for (const category of FOOD_CATEGORIES) {
        const key = toCategoryKey(category);
        if (DELIBERATELY_SAFE.has(category)) {
          expect(TCS_KEYS.has(key)).toBe(false);
        } else {
          expect(TCS_KEYS.has(key)).toBe(true);
        }
      }
    });
  });
});

describe('estimateLbs', () => {
  test('uses weight units directly', () => {
    expect(estimateLbs(item({ estimatedQuantity: 8, unit: 'lbs' }))).toBe(8);
    expect(estimateLbs(item({ estimatedQuantity: 2, unit: 'kg' }))).toBe(4.4);
    expect(estimateLbs(item({ estimatedQuantity: 32, unit: 'oz' }))).toBe(2);
  });
  test('falls back to servings at 0.75 lbs each', () => {
    expect(estimateLbs(item({ estimatedQuantity: 2, unit: 'trays', estimatedServings: 12 }))).toBe(9);
  });
  test('never returns less than 0.1', () => {
    expect(estimateLbs(item({}))).toBeGreaterThanOrEqual(0.1);
  });
  test('applies 0.1 floor to computed weights below 0.1', () => {
    expect(estimateLbs(item({ estimatedQuantity: 0.4, unit: 'oz' }))).toBe(0.1);
  });
});
