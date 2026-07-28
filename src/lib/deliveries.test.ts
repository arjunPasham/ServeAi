import { describe, expect, test } from 'vitest';
import {
  DELIVERY_METHODS,
  RESPONSIBLE_PARTIES,
  DISPUTE_WINDOW_HOURS,
  DISPUTE_WINDOW_MS,
  isDeliveryMethod,
  isResponsibleParty,
  deliveryMethodLabel,
  responsiblePartyLabel,
} from './deliveries';

describe('delivery method / party vocab', () => {
  test('the method set matches the 031 CHECK', () => {
    expect([...DELIVERY_METHODS]).toEqual([
      'merchant_delivery', 'pickup', 'uber_direct', 'local_courier', 'other',
    ]);
    expect([...RESPONSIBLE_PARTIES]).toEqual(['donor', 'recipient']);
  });

  test('isDeliveryMethod / isResponsibleParty guard the enums', () => {
    expect(isDeliveryMethod('uber_direct')).toBe(true);
    expect(isDeliveryMethod('helicopter')).toBe(false);
    expect(isDeliveryMethod('')).toBe(false);
    expect(isResponsibleParty('recipient')).toBe(true);
    expect(isResponsibleParty('courier')).toBe(false); // v3 brokers no couriers
  });
});

describe('DISPUTE_WINDOW', () => {
  test('is a sane positive window with MS derived from HOURS', () => {
    expect(DISPUTE_WINDOW_HOURS).toBeGreaterThan(0);
    expect(DISPUTE_WINDOW_MS).toBe(DISPUTE_WINDOW_HOURS * 60 * 60 * 1000);
  });
});

describe('labels', () => {
  test('known values get friendly labels, unknown falls back to the raw value', () => {
    expect(deliveryMethodLabel('merchant_delivery')).toBe('Merchant delivers');
    expect(deliveryMethodLabel('pickup')).toBe('Recipient pickup');
    expect(deliveryMethodLabel('weird')).toBe('weird');
    expect(responsiblePartyLabel('donor')).toBe('Merchant (donor)');
    expect(responsiblePartyLabel('recipient')).toBe('Recipient');
    expect(responsiblePartyLabel('nobody')).toBe('nobody');
  });
});
