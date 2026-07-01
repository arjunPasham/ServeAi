import { Inngest } from 'inngest';

export const inngest = new Inngest({
  id: 'foodlink',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

// Typed event definitions for type safety across functions
export type FoodLinkEvents = {
  'dispatch/initiated': {
    data: {
      order_id: string;
      listing_id: string;
      consumer_id: string;
      donor_lat: number;
      donor_lng: number;
      requires_cold_chain: boolean;
      detected_item: string;
      consumer_price_cents: number;
    };
  };
  'delivery/confirmed': {
    data: {
      order_id: string;
      listing_id: string;
      consumer_id: string;
      courier_id: string;
      donor_stripe_account_id: string;
      courier_stripe_account_id: string;
      donor_payout_cents: number;
      courier_fee_cents: number;
      stripe_charge_id: string;
      detected_item: string;
    };
  };
};
