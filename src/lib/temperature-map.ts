// Maps USDA commodity category to temperature_sensitive flag
// Based on FDA Food Code hazardous food definitions
export const TEMPERATURE_SENSITIVE_CATEGORIES = new Set([
  'POULTRY', 'BEEF', 'PORK', 'SEAFOOD', 'EGGS',
  'DAIRY', 'COOKED_RICE', 'COOKED_BEANS', 'PREPARED_HOT_FOOD',
  'CUT_PRODUCE', 'SPROUTS',
]);

export function isTemperatureSensitive(usdaCategory: string): boolean {
  return TEMPERATURE_SENSITIVE_CATEGORIES.has(usdaCategory);
}
