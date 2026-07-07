'use client';

import { useState, useTransition } from 'react';
import { getListingPricing, createDraftListing, publishListing } from '@/actions/listing';
import { isTemperatureSensitive } from '@/lib/temperature-map';
import { PricingSlider } from '@/components/listing/PricingSlider';
import { FoodScanner, ScanSelection } from '@/components/FoodScanner';
import { useRouter } from 'next/navigation';

const USDA_CATEGORIES = [
  'POULTRY', 'BEEF', 'PORK', 'SEAFOOD', 'EGGS', 'DAIRY',
  'COOKED_RICE', 'COOKED_BEANS', 'PREPARED_HOT_FOOD',
  'CUT_PRODUCE', 'SPROUTS', 'PRODUCE_LEAFY', 'PRODUCE_ROOT',
  'GRAIN', 'BAKED_GOOD', 'OTHER',
];

const CATEGORY_LABEL: Record<string, string> = {
  POULTRY: 'Poultry', BEEF: 'Beef', PORK: 'Pork', SEAFOOD: 'Seafood',
  EGGS: 'Eggs', DAIRY: 'Dairy', COOKED_RICE: 'Cooked Rice',
  COOKED_BEANS: 'Cooked Beans', PREPARED_HOT_FOOD: 'Prepared Hot Food',
  CUT_PRODUCE: 'Cut Produce', SPROUTS: 'Sprouts', PRODUCE_LEAFY: 'Leafy Greens',
  PRODUCE_ROOT: 'Root Vegetables', GRAIN: 'Grain', BAKED_GOOD: 'Baked Good', OTHER: 'Other',
};

type Step = 'scan' | 'details' | 'pricing' | 'attest';

export default function NewListingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('scan');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Step 1 fields — prefilled by the AI scan, editable in the details step
  const [detectedItem, setDetectedItem] = useState('');
  const [quantityLbs, setQuantityLbs] = useState('');
  const [category, setCategory] = useState('');
  const [handlingNotes, setHandlingNotes] = useState('');
  const [confidenceScore, setConfidenceScore] = useState(1.0);
  // Stored on the listing: a storage key from the scan (bucket is private;
  // readers get signed URLs) or the placeholder URL for manual entry.
  const [imageUrl, setImageUrl] = useState('https://placehold.co/400x300');
  // Short-lived signed URL used only to preview the scanned photo in this form
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  function handleScanSelect(selection: ScanSelection) {
    setDetectedItem(selection.detectedItem);
    setQuantityLbs(String(selection.quantityLbs));
    setCategory(selection.usdaCategory);
    setConfidenceScore(selection.confidence);
    if (selection.imagePath) setImageUrl(selection.imagePath);
    setPreviewUrl(selection.previewUrl);
    setStep('details');
  }

  // Step 2 pricing
  const [pricingData, setPricingData] = useState<Awaited<ReturnType<typeof getListingPricing>> | null>(null);
  const [confirmedPricing, setConfirmedPricing] = useState<{
    donorPayoutCents: number;
    consumerPriceCents: number;
    platformFeeCents: number;
    courierFeeCents: number;
    preparedAt: string | null;
  } | null>(null);

  // Step 3 attestation
  const [safetyAttested, setSafetyAttested] = useState(false);

  function handleFetchPricing() {
    setError(null);
    if (!detectedItem.trim() || !quantityLbs || !category) {
      setError('Please fill in all required fields');
      return;
    }
    startTransition(async () => {
      const result = await getListingPricing(category, Number(quantityLbs));
      if (!result.success) {
        setError(
          result.error === 'USDA_DATA_STALE'
            ? 'USDA price data for this category is too old. An admin must refresh it before you can post.'
            : result.error === 'DISCOUNT_FLOOR_VIOLATED'
            ? 'Commodity price is too high to meet the 30% discount requirement. Listing blocked.'
            : 'Could not load pricing. Check category and try again.'
        );
        return;
      }
      setPricingData(result);
      setStep('pricing');
    });
  }

  function handlePricingConfirm(params: typeof confirmedPricing extends null ? never : NonNullable<typeof confirmedPricing>) {
    setConfirmedPricing(params);
    setStep('attest');
  }

  function handlePublish() {
    if (!safetyAttested || !confirmedPricing || !pricingData?.success) return;
    setError(null);

    startTransition(async () => {
      // First create the draft
      const draftResult = await createDraftListing({
        detectedItem,
        estimatedQuantityLbs: Number(quantityLbs),
        confidenceScore,
        usdaCategory: category,
        imageUrl,
        donorPayoutCents: confirmedPricing.donorPayoutCents,
        consumerPriceCents: confirmedPricing.consumerPriceCents,
        platformFeeCents: confirmedPricing.platformFeeCents,
        courierFeeCents: confirmedPricing.courierFeeCents,
        handlingNotes: handlingNotes || undefined,
      });

      if (!draftResult.success) {
        setError('Failed to create listing. Please try again.');
        return;
      }

      // Then publish it
      const publishResult = await publishListing({
        listingId: draftResult.listingId,
        safetyAttested: true,
        preparedAt: confirmedPricing.preparedAt,
      });

      if (!publishResult.success) {
        setError(
          publishResult.error === 'SAFETY_WINDOW_EXPIRED'
            ? 'The safety window for this food has already passed. Please prepare fresh food.'
            : 'Failed to publish listing. Please try again.'
        );
        return;
      }

      router.push('/donor/dashboard');
    });
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-10">
        <div className="max-w-lg mx-auto flex items-center gap-3">
          <button onClick={() => {
            if (step === 'details') setStep('scan');
            else if (step === 'pricing') setStep('details');
            else if (step === 'attest') setStep('pricing');
            else router.push('/donor/dashboard');
          }} className="text-gray-400 hover:text-gray-600">
            ←
          </button>
          <h1 className="text-lg font-bold text-gray-900">
            {step === 'scan' ? 'Scan your food' : step === 'details' ? 'Food details' : step === 'pricing' ? 'Set pricing' : 'Safety check'}
          </h1>
        </div>
      </header>

      <main className="p-4 max-w-lg mx-auto space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {step === 'scan' && (
          <FoodScanner
            onSelect={handleScanSelect}
            onManualEntry={() => setStep('details')}
          />
        )}

        {step === 'details' && (
          <div className="space-y-4">
            {previewUrl && (
              <div className="h-40 bg-gray-100 rounded-2xl overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previewUrl} alt={detectedItem || 'Scanned food'} className="w-full h-full object-cover" />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                What food are you donating? <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={detectedItem}
                onChange={e => setDetectedItem(e.target.value)}
                placeholder="e.g. Roasted Chicken Thighs"
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Quantity (lbs) <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                value={quantityLbs}
                onChange={e => setQuantityLbs(e.target.value)}
                min="0.1"
                step="0.1"
                placeholder="e.g. 5"
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                USDA Category <span className="text-red-500">*</span>
              </label>
              <select
                value={category}
                onChange={e => setCategory(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-600 bg-white"
              >
                <option value="">Select a category</option>
                {USDA_CATEGORIES.map(cat => (
                  <option key={cat} value={cat}>{CATEGORY_LABEL[cat] ?? cat}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Handling notes (optional)
              </label>
              <textarea
                value={handlingNotes}
                onChange={e => setHandlingNotes(e.target.value)}
                rows={2}
                placeholder="e.g. Keep refrigerated, nut allergy warning"
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-600 resize-none"
              />
            </div>

            <button
              onClick={handleFetchPricing}
              disabled={isPending}
              className="w-full min-h-[44px] bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold rounded-full py-3 text-sm transition-colors"
            >
              {isPending ? 'Loading pricing…' : 'Continue to pricing →'}
            </button>
          </div>
        )}

        {step === 'pricing' && pricingData?.success && (
          <PricingSlider
            initialPricing={pricingData.pricing}
            pricingInput={pricingData.input}
            temperatureSensitive={isTemperatureSensitive(category)}
            onConfirm={handlePricingConfirm as Parameters<typeof PricingSlider>[0]['onConfirm']}
          />
        )}

        {step === 'attest' && confirmedPricing && (
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 space-y-2">
              <h3 className="font-semibold text-blue-900 text-sm">Safety attestation</h3>
              <p className="text-sm text-blue-800">
                By checking the box below, you confirm that this food is safe for consumption,
                has been handled according to applicable food safety guidelines, and you take
                responsibility for any mislabeling or quality issues.
              </p>
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={safetyAttested}
                onChange={e => setSafetyAttested(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-600"
              />
              <span className="text-sm text-gray-700">
                I confirm this food is safe to eat and properly handled.
              </span>
            </label>

            <button
              onClick={handlePublish}
              disabled={!safetyAttested || isPending}
              className="w-full min-h-[44px] bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-full py-3 text-sm transition-colors"
            >
              {isPending ? 'Publishing…' : 'Post listing →'}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
