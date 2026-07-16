import { describe, expect, test } from 'vitest';
import { toCategoryKey, estimateLbs } from './food-taxonomy';
import type { FoodItem } from '../types/food';

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
    expect(toCategoryKey('Dessert')).toBe('BAKERY');
    expect(toCategoryKey('Fruit')).toBe('PRODUCE_WHOLE');
    expect(toCategoryKey('Dairy')).toBe('DAIRY');
    expect(toCategoryKey('Beverage')).toBe('BEVERAGE');
    expect(toCategoryKey('Mixed/Prepared Meal')).toBe('PREPARED_HOT');
    expect(toCategoryKey('Other')).toBe('OTHER');
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
