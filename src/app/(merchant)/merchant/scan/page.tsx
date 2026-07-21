'use client';

// Merchant scan flow (Phase 1 pivot): photo → /api/scan (persists the scan
// server-side) → ManifestEditor → confirmManifest declares tonight's load.

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  confirmManifest,
  getCategoriesWithValuations,
  type CategoryOption,
  type ManifestItemInput,
} from '@/actions/manifest';
import { ManifestEditor, type EditableItem } from '@/components/manifest/ManifestEditor';
import type { FoodItem } from '@/types/food';
import { toCategoryKey, estimateLbs } from '@/lib/food-taxonomy';

type ScanApiResponse = {
  items: (FoodItem & { scanItemId: string | null })[];
  scanRecordId: string;
  needsManualReview: boolean;
  notes: string;
  previewUrl: string | null;
  error?: string;
};

type ScanState =
  | { phase: 'idle' }
  | { phase: 'scanning' }
  | { phase: 'manifest'; scanRecordId: string; items: EditableItem[]; needsReview: boolean; previewUrl: string | null }
  | { phase: 'error'; message: string };

const CONFIRM_ERROR_LABEL: Record<string, string> = {
  PREPARED_AT_REQUIRED: 'Temperature-sensitive items need a prepared-at time.',
  PREPARED_AT_IN_FUTURE: 'A prepared-at time is in the future — check the clock.',
  SAFETY_WINDOW_EXPIRED: 'An item is already past its safety window and cannot be declared.',
  VALUATION_MISSING: 'A category is missing valuation data — contact ops.',
  ITEMS_NOT_DECLARABLE: 'This manifest was already declared. Check your dashboard.',
};

export default function MerchantScanPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<ScanState>({ phase: 'idle' });
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function loadCategories() {
    try {
      const cats = await getCategoriesWithValuations();
      setCategories(cats);
    } catch {
      setState({ phase: 'error', message: "Couldn't load categories — check your connection and try again." });
    }
  }

  useEffect(() => {
    loadCategories();
  }, []);

  async function handleFile(file: File) {
    setState({ phase: 'scanning' });
    const formData = new FormData();
    formData.append('image', file);

    try {
      const res = await fetch('/api/scan', { method: 'POST', body: formData });
      const body = (await res.json()) as ScanApiResponse;

      if (!res.ok && res.status !== 422) {
        setState({ phase: 'error', message: body.error ?? 'Scan failed. Try again.' });
        return;
      }
      if (!body.items?.length) {
        setState({ phase: 'error', message: body.notes || 'No food detected — try a clearer photo.' });
        return;
      }

      setState({
        phase: 'manifest',
        scanRecordId: body.scanRecordId,
        needsReview: res.status === 422,
        previewUrl: body.previewUrl,
        items: body.items.map(item => ({
          scanItemId: item.scanItemId,
          foodName: item.foodName,
          categoryKey: toCategoryKey(item.category),
          estLbs: estimateLbs(item),
          confidence: item.confidence,
          preparedAt: '',
        })),
      });
    } catch {
      setState({ phase: 'error', message: 'Could not reach the scanner. Check your connection.' });
    }
  }

  function handleConfirm(items: ManifestItemInput[], windowDate: string) {
    if (state.phase !== 'manifest') return;
    setConfirmError(null);
    const scanRecordId = state.scanRecordId;
    startTransition(async () => {
      const result = await confirmManifest({ scanRecordId, windowDate, items });
      if (result.success) {
        router.push('/merchant/dashboard');
      } else {
        setConfirmError(CONFIRM_ERROR_LABEL[result.error] ?? 'Could not declare the load. Please try again.');
      }
    });
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-10">
        <div className="max-w-lg mx-auto flex items-center gap-3">
          <button onClick={() => router.push('/merchant/dashboard')} className="text-gray-400 hover:text-gray-600">←</button>
          <h1 className="text-lg font-bold text-gray-900">
            {state.phase === 'manifest' ? 'Confirm your manifest' : 'Scan your surplus'}
          </h1>
        </div>
      </header>

      <main className="p-4 max-w-lg mx-auto space-y-4">
        {state.phase === 'idle' && (
          <div className="text-center py-16 space-y-4">
            <p className="text-gray-600 text-sm">
              Photograph what won&apos;t sell. We&apos;ll identify the items, estimate weights, and value the load.
            </p>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
            <button
              onClick={() => inputRef.current?.click()}
              className="min-h-[44px] bg-green-600 hover:bg-green-700 text-white font-semibold rounded-full px-8 py-3 text-sm transition-colors"
            >
              Take a photo
            </button>
          </div>
        )}

        {state.phase === 'scanning' && (
          <div className="text-center py-16 space-y-2">
            <div className="bg-white border border-gray-200 rounded-2xl h-40 animate-pulse" />
            <p className="text-sm text-gray-500">Analyzing your food… this takes a few seconds.</p>
          </div>
        )}

        {state.phase === 'manifest' && (
          <>
            {state.previewUrl && (
              <div className="h-40 bg-gray-100 rounded-2xl overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={state.previewUrl} alt="Scanned surplus" className="w-full h-full object-cover" />
              </div>
            )}
            <ManifestEditor
              initialItems={state.items}
              categories={categories}
              needsReview={state.needsReview}
              submitting={isPending}
              error={confirmError}
              onConfirm={handleConfirm}
            />
          </>
        )}

        {state.phase === 'error' && (
          <div className="text-center py-16 space-y-4">
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{state.message}</p>
            <button
              onClick={() => {
                setState({ phase: 'idle' });
                loadCategories();
              }}
              className="min-h-[44px] border border-gray-300 hover:border-green-600 text-gray-700 font-semibold rounded-full px-8 py-3 text-sm transition-colors"
            >
              Try again
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
