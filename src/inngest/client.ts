import { EventSchemas, Inngest } from 'inngest';

export const inngest = new Inngest({
  id: 'foodlink',
  eventKey: process.env.INNGEST_EVENT_KEY,
  // Bind the event schema so inngest.send() and createFunction() are type-checked.
  schemas: new EventSchemas().fromRecord<FoodLinkEvents>(),
});

// Typed event definitions for type safety across functions
export type FoodLinkEvents = {
  // Fired after payment is captured (webhook in real mode, claim action in dev mode)
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
  // Fired by accept/decline server actions so the dispatch loop can react
  // immediately instead of sleeping out the full 5-minute window
  'dispatch/responded': {
    data: {
      dispatch_event_id: string;
      order_id: string;
      courier_id: string;
      response: 'accepted' | 'declined';
    };
  };
  // Fired at claim time in real-payment mode; starts the payment watchdog
  'order/claimed': {
    data: {
      order_id: string;
      listing_id: string;
      payment_intent_id: string;
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
