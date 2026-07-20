import { describe, expect, test } from 'vitest';
import { REQUIRED_PROD_ENV, missingRequiredEnv, assertProductionEnv } from './env';

/** A fully-populated env record — every required-in-prod var set to a dummy value. */
function fullEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of REQUIRED_PROD_ENV) env[name] = 'dummy-value';
  return env;
}

describe('missingRequiredEnv', () => {
  test('returns an empty array when every required var is present', () => {
    expect(missingRequiredEnv(fullEnv())).toEqual([]);
  });

  test('returns ALL missing names, not just the first', () => {
    const env = fullEnv();
    delete env.GEMINI_API_KEY;
    delete env.STRIPE_SECRET_KEY;
    delete env.UPSTASH_REDIS_REST_URL;

    const missing = missingRequiredEnv(env);
    expect(missing).toContain('GEMINI_API_KEY');
    expect(missing).toContain('STRIPE_SECRET_KEY');
    expect(missing).toContain('UPSTASH_REDIS_REST_URL');
    expect(missing).toHaveLength(3);
  });

  test('treats an empty string as missing', () => {
    const env = fullEnv();
    env.TWILIO_VERIFY_SERVICE_SID = '';

    expect(missingRequiredEnv(env)).toEqual(['TWILIO_VERIFY_SERVICE_SID']);
  });

  test('reports every required var missing when the env record is empty', () => {
    expect(missingRequiredEnv({})).toEqual([...REQUIRED_PROD_ENV]);
  });
});

describe('assertProductionEnv', () => {
  test('throws in production listing every missing var by name', () => {
    const env = fullEnv();
    delete env.GEMINI_API_KEY;
    delete env.SMARTY_AUTH_ID;
    env.NODE_ENV = 'production';

    let thrown: unknown;
    try {
      assertProductionEnv(env);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('GEMINI_API_KEY');
    expect(message).toContain('SMARTY_AUTH_ID');
  });

  test('does not throw in production when every required var is present', () => {
    const env = fullEnv();
    env.NODE_ENV = 'production';
    expect(() => assertProductionEnv(env)).not.toThrow();
  });

  test('never throws outside production, even with everything missing', () => {
    expect(() => assertProductionEnv({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertProductionEnv({ NODE_ENV: 'test' })).not.toThrow();
    expect(() => assertProductionEnv({})).not.toThrow();
  });
});
