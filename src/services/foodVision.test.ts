import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Hoisted so the vi.mock factory below can reference it.
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
  // Minimal stand-in for the Type enum used by RESPONSE_SCHEMA.
  Type: {
    OBJECT: 'OBJECT',
    ARRAY: 'ARRAY',
    STRING: 'STRING',
    NUMBER: 'NUMBER',
    BOOLEAN: 'BOOLEAN',
  },
}));

import { scanFoodImage } from './foodVision';

const VALID_RESPONSE = {
  text: JSON.stringify({
    items: [
      {
        foodName: 'Penne Pasta Tray',
        category: 'Pasta',
        estimatedQuantity: 8,
        unit: 'lbs',
        estimatedServings: 12,
        confidence: 0.93,
      },
    ],
    overallConfidence: 0.9,
    needsManualReview: false,
    notes: 'clear photo',
  }),
};

function capacityError(): Error {
  const err = new Error(
    'got status: UNAVAILABLE. {"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}',
  );
  (err as Error & { status: number }).status = 503;
  return err;
}

describe('scanFoodImage retry on capacity errors', () => {
  beforeEach(() => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    generateContent.mockReset();
  });

  test('retries on 503 UNAVAILABLE and succeeds on the second attempt', async () => {
    generateContent
      .mockRejectedValueOnce(capacityError())
      .mockResolvedValueOnce(VALID_RESPONSE);

    const promise = scanFoodImage('aGk=', 'image/jpeg');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(1);
    expect(result.needsManualReview).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('capacity'),
      expect.anything(),
    );
  });

  test('gives up after retries exhaust and returns the safe fallback', async () => {
    generateContent.mockRejectedValue(capacityError());

    const promise = scanFoodImage('aGk=', 'image/jpeg');
    await vi.runAllTimersAsync();
    const result = await promise;

    // 1 initial attempt + 2 retries
    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(result.items).toHaveLength(0);
    expect(result.needsManualReview).toBe(true);
    expect(result.notes).toContain('Scan failed');
  });

  test('does not retry non-capacity errors', async () => {
    const badRequest = new Error('got status: INVALID_ARGUMENT');
    (badRequest as Error & { status: number }).status = 400;
    generateContent.mockRejectedValue(badRequest);

    const promise = scanFoodImage('aGk=', 'image/jpeg');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(result.needsManualReview).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  test('dev-mode bypass still returns synthetic result without an API key', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');

    const result = await scanFoodImage('aGk=', 'image/jpeg', 'photo.jpg');

    expect(generateContent).not.toHaveBeenCalled();
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.notes).toContain('[DEV MODE]');
  });
});
