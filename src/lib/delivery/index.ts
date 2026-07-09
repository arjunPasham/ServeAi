import { DeliveryProvider } from './types';
import { UberDirectProvider } from './uber';
import { SimulatedProvider } from './simulated';

export * from './types';

// DELIVERY_MODE gates the fleet decommission (Phase 3c): 'uber' (default)
// routes orders through the provider abstraction + self-pickup; 'internal'
// re-enables the legacy courier dispatch loop. Courier code/migrations stay
// intact but untriggered under 'uber'.
export type DeliveryMode = 'uber' | 'internal';

export function getDeliveryMode(): DeliveryMode {
  return process.env.DELIVERY_MODE === 'internal' ? 'internal' : 'uber';
}

export function isUberConfigured(): boolean {
  return Boolean(
    process.env.UBER_CUSTOMER_ID &&
      process.env.UBER_CLIENT_ID &&
      process.env.UBER_CLIENT_SECRET
  );
}

let provider: DeliveryProvider | null = null;

/** Uber Direct when its env vars are present, otherwise the local simulation. */
export function getDeliveryProvider(): DeliveryProvider {
  if (!provider) {
    provider = isUberConfigured() ? new UberDirectProvider() : new SimulatedProvider();
  }
  return provider;
}
