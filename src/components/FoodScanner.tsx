'use client';

// AI scan step for the donor listing flow (PRD §7.1): photograph the food,
// send it to /api/scan (Gemini, server-side), and hand the best classification
// back to the form. Low-confidence results surface the alternates as
// single-tap choices; manual entry stays available as the fallback.

import { useRef, useState } from 'react';
import type { FoodItem, FoodScanResult } from '@/types/food';
import { toUsdaCategory, estimateLbs } from '@/lib/category-map';

export interface ScanSelection {
  detectedItem: string;
  quantityLbs: number;
  usdaCategory: string;
  confidence: number;
  // Storage key persisted on the listing (bucket is private — readers sign it)
  imagePath: string | null;
  // Short-lived signed URL for immediate display in the form
  previewUrl: string | null;
}

interface FoodScannerProps {
  onSelect: (selection: ScanSelection) => void;
  onManualEntry: () => void;
}

type ScanState =
  | { phase: 'idle' }
  | { phase: 'scanning' }
  | {
      phase: 'results';
      result: FoodScanResult;
      imagePath: string | null;
      previewUrl: string | null;
      needsReview: boolean;
    }
  | { phase: 'error'; message: string };

export function FoodScanner({ onSelect, onManualEntry }: FoodScannerProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<ScanState>({ phase: 'idle' });
  const [preview, setPreview] = useState<string | null>(null);

  async function handleFile(file: File) {
    setPreview(URL.createObjectURL(file));
    setState({ phase: 'scanning' });

    const formData = new FormData();
    formData.append('image', file);

    try {
      const res = await fetch('/api/scan', { method: 'POST', body: formData });
      const body = await res.json();

      if (!res.ok && res.status !== 422) {
        setState({ phase: 'error', message: body.error ?? 'Scan failed. Try again or enter details manually.' });
        return;
      }

      const result = body as FoodScanResult & { imagePath?: string | null; previewUrl?: string | null };
      if (!result.items?.length) {
        setState({
          phase: 'error',
          message: result.notes || 'No food detected in this photo. Try a clearer shot or enter details manually.',
        });
        return;
      }

      setState({
        phase: 'results',
        result,
        imagePath: result.imagePath ?? null,
        previewUrl: result.previewUrl ?? null,
        needsReview: res.status === 422,
      });
    } catch {
      setState({ phase: 'error', message: 'Could not reach the scanner. Enter details manually.' });
    }
  }

  function selectItem(item: FoodItem, imagePath: string | null, previewUrl: string | null) {
    onSelect({
      detectedItem: item.foodName,
      quantityLbs: estimateLbs(item),
      usdaCategory: toUsdaCategory(item.category),
      confidence: item.confidence,
      imagePath,
      previewUrl,
    });
  }

  return (
    <div className="space-y-4">
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

      {preview && (
        <div className="h-44 bg-gray-100 rounded-2xl overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="Food to scan" className="w-full h-full object-cover" />
        </div>
      )}

      {state.phase === 'idle' && (
        <div className="space-y-3">
          <button
            onClick={() => inputRef.current?.click()}
            className="w-full min-h-[56px] bg-green-600 hover:bg-green-700 text-white font-semibold rounded-2xl py-4 text-sm transition-colors flex items-center justify-center gap-2"
          >
            <span className="text-xl">📷</span> Scan food with camera
          </button>
          <button
            onClick={onManualEntry}
            className="w-full min-h-[44px] border border-gray-300 text-gray-700 hover:bg-gray-50 font-semibold rounded-full py-2.5 text-sm transition-colors"
          >
            Enter details manually
          </button>
        </div>
      )}

      {state.phase === 'scanning' && (
        <div className="text-center py-8 space-y-2">
          <div className="inline-block h-8 w-8 border-4 border-green-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Identifying your food…</p>
        </div>
      )}

      {state.phase === 'results' && (
        <div className="space-y-3">
          {state.needsReview && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
              We&apos;re not fully confident — please confirm the item below or enter it manually.
            </div>
          )}
          <p className="text-sm font-medium text-gray-700">
            {state.needsReview ? 'Tap the correct item:' : 'We found:'}
          </p>
          {state.result.items.slice(0, 3).map((item, i) => (
            <button
              key={i}
              onClick={() => selectItem(item, state.imagePath, state.previewUrl)}
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
          <div className="flex gap-3">
            <button
              onClick={() => { setPreview(null); setState({ phase: 'idle' }); }}
              className="flex-1 min-h-[44px] border border-gray-300 text-gray-700 hover:bg-gray-50 font-semibold rounded-full py-2.5 text-sm transition-colors"
            >
              Rescan
            </button>
            <button
              onClick={onManualEntry}
              className="flex-1 min-h-[44px] border border-gray-300 text-gray-700 hover:bg-gray-50 font-semibold rounded-full py-2.5 text-sm transition-colors"
            >
              Enter manually
            </button>
          </div>
        </div>
      )}

      {state.phase === 'error' && (
        <div className="space-y-3">
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
            {state.message}
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => { setPreview(null); setState({ phase: 'idle' }); }}
              className="flex-1 min-h-[44px] border border-gray-300 text-gray-700 hover:bg-gray-50 font-semibold rounded-full py-2.5 text-sm transition-colors"
            >
              Try again
            </button>
            <button
              onClick={onManualEntry}
              className="flex-1 min-h-[44px] bg-green-600 hover:bg-green-700 text-white font-semibold rounded-full py-2.5 text-sm transition-colors"
            >
              Enter manually
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
