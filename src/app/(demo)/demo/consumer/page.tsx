'use client';

// Consumer demo: browse (REAL ListingCards) → escrowed "payment" → simulated
// delivery with timed courier status transitions. Fixture data only.

import { useState } from 'react';
import Link from 'next/link';
import {
  Bike,
  Check,
  CircleDashed,
  Lock,
  MapPin,
  PackageCheck,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import { ListingCard } from '@/components/listing/ListingCard';
import { ETABadge } from '@/components/shared/ETABadge';
import { centsToDisplay } from '@/lib/pricing';
import { DEMO_COURIER, type DemoDeliveryStatus, type DemoListing } from '@/lib/demo/fixtures';
import { useDemoState } from '@/lib/demo/demo-state';
import { CoachMark } from '@/lib/demo/CoachMark';

type Phase = { step: 'browse' } | { step: 'checkout'; listing: DemoListing } | { step: 'tracking' };

const TOTAL_TOUR_STEPS = 4;

const STATUS_LABELS: Record<DemoDeliveryStatus, string> = {
  finding_courier: 'Finding the nearest courier…',
  courier_assigned: `${DEMO_COURIER.name} accepted — heading to pickup`,
  picked_up: 'Food picked up — on the way to you',
  delivered: 'Delivered!',
};

const STATUS_ORDER: DemoDeliveryStatus[] = [
  'finding_courier',
  'courier_assigned',
  'picked_up',
  'delivered',
];

export default function ConsumerDemoPage() {
  const { seededAt, listings, order, placeOrder, resetOrder } = useDemoState();
  const [phase, setPhase] = useState<Phase>(order ? { step: 'tracking' } : { step: 'browse' });
  const [paying, setPaying] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);

  function claim(listingId: string) {
    const listing = listings.find(l => l.id === listingId);
    if (listing) setPhase({ step: 'checkout', listing });
  }

  function pay(listing: DemoListing) {
    setPaying(true);
    setTimeout(() => {
      setPaying(false);
      placeOrder(listing);
      setPhase({ step: 'tracking' });
    }, 1200);
  }

  function restart() {
    resetOrder();
    setFeedback(null);
    setPhase({ step: 'browse' });
  }

  return (
    <main className="max-w-3xl mx-auto px-6 py-10">
      <p className="text-xs font-semibold text-accent uppercase tracking-wide mb-1">
        Consumer flow · demo
      </p>
      <h1 className="font-display text-2xl text-foreground mb-8">
        {phase.step === 'browse' && 'Surplus food near you'}
        {phase.step === 'checkout' && 'Checkout'}
        {phase.step === 'tracking' && 'Your order'}
      </h1>

      {phase.step === 'browse' && (
        <section data-demo-tour="consumer-browse">
          <CoachMark
            id="consumer-1-browse"
            targetId="consumer-browse"
            title="Verified listings, 30%+ below retail"
            body="Every card is a real donor listing: AI-identified food, safety window counting down, price capped at 70% of USDA retail. Claim one with “Buy now”."
            step={1}
            totalSteps={TOTAL_TOUR_STEPS}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {listings.map(l => (
              <ListingCard
                key={l.id}
                id={l.id}
                detectedItem={l.detectedItem}
                estimatedQuantityLbs={l.estimatedQuantityLbs}
                consumerPriceCents={l.consumerPriceCents}
                temperatureSensitive={l.temperatureSensitive}
                imageUrl={l.imageUrl}
                donorType={l.donorType}
                safetyExpiresAt={new Date(seededAt + l.safetyExpiresInMinutes * 60000).toISOString()}
                onClaim={claim}
              />
            ))}
          </div>
        </section>
      )}

      {phase.step === 'checkout' && (
        <section className="max-w-md space-y-6">
          <div className="bg-card border border-border rounded-2xl p-5 space-y-3">
            <div className="flex justify-between items-start gap-3">
              <div>
                <h2 className="font-semibold text-foreground text-sm">
                  {phase.listing.detectedItem}
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {phase.listing.estimatedQuantityLbs} lbs · {phase.listing.donorName} ·{' '}
                  {phase.listing.distanceMiles} mi away
                </p>
              </div>
              <ETABadge etaMinutes={DEMO_COURIER.etaMinutes} />
            </div>
            <div className="border-t border-border pt-3 flex justify-between text-sm">
              <span className="text-muted-foreground">Total (incl. delivery)</span>
              <span className="font-bold text-foreground">
                {centsToDisplay(phase.listing.consumerPriceCents)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 shrink-0" />
              Held in escrow — the donor is only paid after you confirm delivery.
            </p>
          </div>

          <div data-demo-tour="consumer-pay" className="space-y-3">
            <CoachMark
              id="consumer-2-pay"
              targetId="consumer-pay"
              title="Escrowed payment"
              body="In the real app this is a Stripe payment. Funds sit in escrow with a 2-hour dispute window after delivery before the donor is paid out. Use the sample card."
              step={2}
              totalSteps={TOTAL_TOUR_STEPS}
            />
            <div className="bg-card border border-border rounded-xl px-4 py-3 text-sm text-muted-foreground flex justify-between items-center">
              <span>Sample card</span>
              <span className="font-mono text-foreground">4242 4242 4242 4242</span>
            </div>
            <button
              onClick={() => pay(phase.listing)}
              disabled={paying}
              className="w-full min-h-[44px] bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground font-semibold rounded-full py-3 text-sm transition-colors"
            >
              {paying ? 'Processing…' : `Pay ${centsToDisplay(phase.listing.consumerPriceCents)}`}
            </button>
            <button
              onClick={() => setPhase({ step: 'browse' })}
              disabled={paying}
              className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              ← Back to browse
            </button>
          </div>
        </section>
      )}

      {phase.step === 'tracking' && order && (
        <section className="max-w-md space-y-6">
          <div data-demo-tour="consumer-tracking" className="bg-card border border-border rounded-2xl p-5">
            <CoachMark
              id="consumer-3-tracking"
              targetId="consumer-tracking"
              title="Dispatch happens automatically"
              body="The instant payment lands, the system offers the job to the nearest courier and streams status back here. Watch it progress — this simulation runs on a few-second timer."
              step={3}
              totalSteps={TOTAL_TOUR_STEPS}
            />
            <div className="flex justify-between items-start gap-3 mb-5">
              <div>
                <h2 className="font-semibold text-foreground text-sm">
                  {order.listing.detectedItem}
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                  <MapPin className="w-3 h-3" /> {order.listing.donorName}
                </p>
              </div>
              <span className="text-sm font-bold text-accent">
                {centsToDisplay(order.listing.consumerPriceCents)}
              </span>
            </div>

            <ol className="space-y-4">
              {STATUS_ORDER.map(status => {
                const reachedIdx = STATUS_ORDER.indexOf(order.status);
                const idx = STATUS_ORDER.indexOf(status);
                const reached = idx <= reachedIdx;
                const current = idx === reachedIdx && order.status !== 'delivered';
                const Icon =
                  status === 'delivered' ? PackageCheck : status === 'finding_courier' ? CircleDashed : Bike;
                return (
                  <li key={status} className="flex items-center gap-3">
                    <span
                      className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                        reached ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground'
                      } ${current ? 'animate-pulse' : ''}`}
                    >
                      {reached && !current ? <Check className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
                    </span>
                    <span
                      className={`text-sm ${
                        reached ? 'text-foreground font-medium' : 'text-muted-foreground'
                      }`}
                    >
                      {STATUS_LABELS[status]}
                    </span>
                  </li>
                );
              })}
            </ol>

            {order.status === 'courier_assigned' && (
              <p className="mt-4 text-xs text-muted-foreground bg-muted rounded-lg px-3 py-2">
                {DEMO_COURIER.name} · {DEMO_COURIER.vehicle} · ★ {DEMO_COURIER.rating}
              </p>
            )}
          </div>

          {order.status === 'delivered' && (
            <div data-demo-tour="consumer-feedback" className="bg-card border border-border rounded-2xl p-5 text-center space-y-3">
              <CoachMark
                id="consumer-4-feedback"
                targetId="consumer-feedback"
                title="Feedback closes the loop"
                body="After delivery you get a 2-hour window to report a problem — otherwise the donor is paid automatically. Quality signals feed back into donor ratings."
                step={4}
                totalSteps={TOTAL_TOUR_STEPS}
              />
              {feedback === null ? (
                <>
                  <h3 className="font-semibold text-foreground text-sm">How was your order?</h3>
                  <div className="flex justify-center gap-3">
                    <button
                      onClick={() => setFeedback('up')}
                      className="w-12 h-12 rounded-full bg-accent/10 hover:bg-accent/20 text-accent flex items-center justify-center transition-colors"
                      aria-label="Good order"
                    >
                      <ThumbsUp className="w-5 h-5" />
                    </button>
                    <button
                      onClick={() => setFeedback('down')}
                      className="w-12 h-12 rounded-full bg-destructive/10 hover:bg-destructive/20 text-destructive flex items-center justify-center transition-colors"
                      aria-label="Problem with order"
                    >
                      <ThumbsDown className="w-5 h-5" />
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {feedback === 'up'
                    ? 'Thanks! The donor will be paid out when the dispute window closes.'
                    : 'In the real app this opens a dispute and pauses the donor payout.'}
                </p>
              )}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={restart}
              className="flex-1 min-h-[44px] border border-border hover:border-foreground/20 text-foreground font-semibold rounded-full py-2.5 text-sm transition-colors"
            >
              Restart demo
            </button>
            <Link
              href="/demo/donor"
              className="flex-1 min-h-[44px] inline-flex items-center justify-center bg-primary hover:bg-primary-hover text-primary-foreground font-semibold rounded-full py-2.5 text-sm transition-colors"
            >
              Try the donor flow
            </Link>
          </div>
        </section>
      )}
    </main>
  );
}
