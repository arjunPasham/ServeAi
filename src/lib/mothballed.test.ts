import { afterEach, describe, expect, test } from 'vitest';
import {
  consumerSurfaceEnabled,
  consumerDisabledResult,
  assertConsumerSurfaceEnabled,
} from './mothballed';

const FLAG = 'NEXT_PUBLIC_CONSUMER_ENABLED';

describe('consumerSurfaceEnabled', () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  test('false when the flag is unset', () => {
    delete process.env[FLAG];
    expect(consumerSurfaceEnabled()).toBe(false);
  });

  test('false for any value other than the literal string "true"', () => {
    process.env[FLAG] = 'TRUE';
    expect(consumerSurfaceEnabled()).toBe(false);
    process.env[FLAG] = '1';
    expect(consumerSurfaceEnabled()).toBe(false);
  });

  test('true only when set to the literal string "true"', () => {
    process.env[FLAG] = 'true';
    expect(consumerSurfaceEnabled()).toBe(true);
  });
});

describe('consumerDisabledResult', () => {
  test('returns a typed refusal shape', () => {
    expect(consumerDisabledResult()).toEqual({ success: false, error: 'CONSUMER_DISABLED' });
  });
});

describe('assertConsumerSurfaceEnabled', () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  test('throws naming the action when the surface is disabled', () => {
    delete process.env[FLAG];
    expect(() => assertConsumerSurfaceEnabled('someAction')).toThrow(
      /CONSUMER_DISABLED: someAction is a mothballed pre-pivot surface/
    );
  });

  test('does not throw when the surface is enabled', () => {
    process.env[FLAG] = 'true';
    expect(() => assertConsumerSurfaceEnabled('someAction')).not.toThrow();
  });
});
