'use client';

// Donor demo: scan (simulated AI) → price (REAL PricingSlider + computePricing)
// → published listing (REAL ListingCard) → peek at courier dispatch.
// All data comes from src/lib/demo/fixtures.ts; nothing is persisted.

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Sparkles } from 'lucide-react';
import { PricingSlider } from '@/components/listing/PricingSlider';
import { ListingCard } from '@/components/listing/ListingCard';
import { DispatchCard } from '@/components/dispatch/DispatchCard';
import { computePricing, centsToDisplay } from '@/lib/pricing';
import { estimateLbs } from '@/lib/category-map';
import {
  DEMO_SCAN_RESULT,
  DEMO_SCAN_PHOTO,
  demoPricingInput,
  type DemoListing,
} from '@/lib/demo/fixtures';
import { useDemoState } from '@/lib/demo/demo-state';
import { CoachMark } from '@/lib/demo/CoachMark';

type Phase =
  | { step: 'scan'; scanning: boolean; scanned: boolean }
  | { step: 'pricing'; itemName: string; quantityLbs: number }
  // Timestamps are materialized in the publish handler so render stays pure.
  | { step: 'published'; listing: DemoListing; safetyExpiresAt: string; publishedAt: string };

const TOTAL_TOUR_STEPS = 4;

export default function DonorDemoPage() {
  const [phase, setPhase] = useState<Phase>({ step: 'scan', scanning: false, scanned: false });
  const { publishListing } = useDemoState();

  const pricingInput = demoPricingInput(phase.step === 'pricing' ? phase.quantityLbs : 8);
  const initialPricing = computePricing(pricingInput);

  function runScan() {
    setPhase({ step: 'scan', scanning: true, scanned: false });
    setTimeout(() => setPhase({ step: 'scan', scanning: false, scanned: true }), 1600);
  }

  function selectScanItem(itemName: string, quantityLbs: number) {
    setPhase({ step: 'pricing', itemName, quantityLbs });
  }

  function publish(consumerPriceCents: number, itemName: string, quantityLbs: number) {
    const listing: DemoListing = {
      id: 'demo-published-1',
      detectedItem: itemName,
      estimatedQuantityLbs: quantityLbs,
      consumerPriceCents,
      temperatureSensitive: true,
      imageUrl: DEMO_SCAN_PHOTO,
      donorType: 'commercial',
      safetyExpiresInMinutes: 4 * 60,
      donorName: 'Your kitchen',
      distanceMiles: 0,
    };
    publishListing(listing);
    setPhase({
      step: 'published',
      listing,
      safetyExpiresAt: new Date(Date.now() + listing.safetyExpiresInMinutes * 60000).toISOString(),
      publishedAt: new Date().toISOString(),
    });
  }

  return (
    <main className="max-w-xl mx-auto px-6 py-10">
      <p className="text-xs font-semibold text-primary uppercase tracking-wide mb-1">
        Donor flow · demo
      </p>
      <h1 className="font-display text-2xl text-foreground mb-8">
        {phase.step === 'scan' && 'List surplus food'}
        {phase.step === 'pricing' && 'Set your price'}
        {phase.step === 'published' && 'Your listing is live'}
      </h1>

      {phase.step === 'scan' && (
        <section data-demo-tour="donor-scan" className="space-y-4">
          <CoachMark
            id="donor-1-scan"
            targetId="donor-scan"
            title="This is where you list food"
            body="Snap a photo of your surplus — the AI identifies what it is, how much there is, and whether it's temperature-sensitive. Try it with our sample photo."
            step={1}
            totalSteps={TOTAL_TOUR_STEPS}
          />
          <div className="h-44 bg-muted rounded-2xl overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={DEMO_SCAN_PHOTO} alt="Sample food to scan" className="w-full h-full object-cover" />
          </div>

          {!phase.scanning && !phase.scanned && (
            <button
              onClick={runScan}
              className="w-full min-h-[56px] bg-green-600 hover:bg-green-700 text-white font-semibold rounded-2xl py-4 text-sm transition-colors flex items-center justify-center gap-2"
            >
              <span className="text-xl">📷</span> Scan sample photo
            </button>
          )}

          {phase.scanning && (
            <div className="text-center py-8 space-y-2">
              <div className="inline-block h-8 w-8 border-4 border-green-600 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-500">Identifying your food…</p>
            </div>
          )}

          {phase.scanned && (
            <div className="space-y-3" data-demo-tour="donor-scan-results">
              <CoachMark
                id="donor-2-results"
                targetId="donor-scan-results"
                title="AI classification with confidence"
                body="Gemini returns candidate items ranked by confidence, with quantity estimated in pounds. Low-confidence scans force a human confirmation before anything can be published. Tap the top match."
                step={2}
                totalSteps={TOTAL_TOUR_STEPS}
              />
              <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-accent" /> We found:
              </p>
              {DEMO_SCAN_RESULT.items.map((item, i) => (
                <button
                  key={i}
                  onClick={() => selectScanItem(item.foodName, estimateLbs(item))}
                  className="w-full text-left bg-white border border-gray-200 rounded-xl p-4 flex items-center justify-between gap-3 hover:border-green-600 transition-all"
                >
                  <div>
                    <div className="font-semibold text-gray-900 text-sm">{item.foodName}</div>
                    <div className="text-xs text-gray-500">
                      ~{estimateLbs(item)} lbs · {item.category}
                    </div>
                  </div>
                  <span className="text-xs font-medium text-gray-400 shrink-0">
                    {Math.round(item.confidence * 100)}% match
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {phase.step === 'pricing' && (
        <section data-demo-tour="donor-pricing">
          <CoachMark
            id="donor-3-pricing"
            targetId="donor-pricing"
            title="AI prices it from USDA data"
            body="The suggested payout comes from live USDA commodity prices — consumers always pay at least 30% below retail. Drag to adjust within ±25%, add the prep time (it drives the food-safety window), then confirm."
            step={3}
            totalSteps={TOTAL_TOUR_STEPS}
          />
          <div className="mb-4 bg-muted rounded-xl px-4 py-3 text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{phase.itemName}</span> · ~
            {phase.quantityLbs} lbs · temperature-sensitive
          </div>
          <PricingSlider
            initialPricing={initialPricing}
            pricingInput={pricingInput}
            temperatureSensitive={true}
            onConfirm={({ consumerPriceCents }) =>
              publish(consumerPriceCents, phase.itemName, phase.quantityLbs)
            }
          />
        </section>
      )}

      {phase.step === 'published' && (
        <section className="space-y-8">
          <div data-demo-tour="donor-published">
            <CoachMark
              id="donor-4-published"
              targetId="donor-published"
              title="Live for nearby consumers"
              body="This exact card now appears in consumer browse feeds, with the safety window counting down. When someone claims it, payment is escrowed and delivery is dispatched automatically."
              step={4}
              totalSteps={TOTAL_TOUR_STEPS}
            />
            <ListingCard
              id={phase.listing.id}
              detectedItem={phase.listing.detectedItem}
              estimatedQuantityLbs={phase.listing.estimatedQuantityLbs}
              consumerPriceCents={phase.listing.consumerPriceCents}
              temperatureSensitive={phase.listing.temperatureSensitive}
              imageUrl={phase.listing.imageUrl}
              donorType={phase.listing.donorType}
              safetyExpiresAt={phase.safetyExpiresAt}
            />
          </div>

          <div>
            <h2 className="text-sm font-semibold text-foreground mb-2">
              Behind the scenes: what nearby couriers see
            </h2>
            <p className="text-xs text-muted-foreground mb-3">
              The moment a consumer claims your listing, the dispatch system offers the
              delivery to the nearest available courier — for {centsToDisplay(299)}.
            </p>
            <div className="opacity-90 pointer-events-none select-none">
              <DispatchCard
                orderId="demo-order-preview"
                dispatchEventId="demo-dispatch-preview"
                detectedItem={phase.listing.detectedItem}
                estimatedQuantityLbs={phase.listing.estimatedQuantityLbs}
                courierFeeCents={299}
                temperatureSensitive={phase.listing.temperatureSensitive}
                handlingNotes="Insulated bag recommended — hot food"
                donorType={phase.listing.donorType}
                offeredAt={phase.publishedAt}
                onAccept={() => {}}
                onDecline={() => {}}
              />
            </div>
          </div>

          <Link
            href="/demo/consumer"
            className="group w-full inline-flex items-center justify-center gap-2 bg-accent hover:bg-accent-hover text-accent-foreground font-semibold px-7 py-3.5 rounded-full text-sm transition-colors min-h-[44px]"
          >
            Now see the consumer side — claim this listing
            <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </section>
      )}
    </main>
  );
}
