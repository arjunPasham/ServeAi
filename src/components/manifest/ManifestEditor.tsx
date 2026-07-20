'use client';

// The manifest confirm step (Phase 1 pivot): the deli manager reviews the
// AI's item list, fixes names/categories/weights, sets prepared-at for TCS
// items, and confirms the whole manifest — which declares tonight's load.

import { useState } from 'react';
import type { CategoryOption, ManifestItemInput } from '@/actions/manifest';

export interface EditableItem {
  scanItemId: string | null;
  foodName: string;
  categoryKey: string;
  estLbs: number;
  confidence: number;
  preparedAt: string; // datetime-local value; '' = unset
}

interface ManifestEditorProps {
  initialItems: EditableItem[];
  categories: CategoryOption[];
  needsReview: boolean;
  submitting: boolean;
  error: string | null;
  onConfirm: (items: ManifestItemInput[], windowDate: string) => void;
}

// datetime-local has no timezone — append the local UTC offset so the server
// parses the merchant's wall-clock time correctly (ported from the deleted
// PricingSlider).
function toIsoWithOffset(localDatetime: string): string {
  const date = new Date(localDatetime);
  const tzOffset = -date.getTimezoneOffset();
  const sign = tzOffset >= 0 ? '+' : '-';
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  return `${localDatetime}:00${sign}${pad(Math.floor(Math.abs(tzOffset) / 60))}:${pad(Math.abs(tzOffset) % 60)}`;
}

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function ManifestEditor({
  initialItems,
  categories,
  needsReview,
  submitting,
  error,
  onConfirm,
}: ManifestEditorProps) {
  const [items, setItems] = useState<EditableItem[]>(initialItems);
  const [windowDate, setWindowDate] = useState(() => {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  });

  const catByKey = new Map(categories.map(c => [c.categoryKey, c]));

  function updateItem(index: number, patch: Partial<EditableItem>) {
    setItems(prev => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function removeItem(index: number) {
    setItems(prev => prev.filter((_, i) => i !== index));
  }

  function addItem() {
    setItems(prev => [
      ...prev,
      { scanItemId: null, foodName: '', categoryKey: 'OTHER', estLbs: 1, confidence: 0, preparedAt: '' },
    ]);
  }

  const totalFmvCents = items.reduce((sum, item) => {
    const cat = catByKey.get(item.categoryKey);
    return sum + (cat ? Math.round(cat.fmvPerLbCents * (item.estLbs || 0)) : 0);
  }, 0);

  const invalidReason = (() => {
    if (!items.length) return 'Add at least one item.';
    for (const item of items) {
      if (!item.foodName.trim()) return 'Every item needs a name.';
      if (!(item.estLbs > 0)) return 'Every item needs a weight above zero.';
      const cat = catByKey.get(item.categoryKey);
      if (cat?.temperatureSensitive && !item.preparedAt) {
        return 'Temperature-sensitive items need a prepared-at time.';
      }
    }
    return null;
  })();

  function handleConfirm() {
    if (invalidReason) return;
    onConfirm(
      items.map(item => ({
        scanItemId: item.scanItemId,
        foodName: item.foodName.trim(),
        categoryKey: item.categoryKey,
        estLbs: item.estLbs,
        preparedAt: item.preparedAt ? toIsoWithOffset(item.preparedAt) : null,
      })),
      windowDate
    );
  }

  return (
    <div className="space-y-4">
      {needsReview && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
          The scan wasn&apos;t fully confident — double-check each item before confirming.
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {items.map((item, index) => {
        const cat = catByKey.get(item.categoryKey);
        return (
          <div key={item.scanItemId ?? `new-${index}`} className="bg-white border border-gray-200 rounded-2xl p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <input
                type="text"
                value={item.foodName}
                onChange={e => updateItem(index, { foodName: e.target.value })}
                placeholder="Item name"
                aria-label={`Item ${index + 1} name`}
                className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-green-600"
              />
              <button
                onClick={() => removeItem(index)}
                aria-label={`Remove item ${index + 1}`}
                className="text-gray-400 hover:text-red-600 text-sm px-2 py-2"
              >
                Remove
              </button>
            </div>

            <div className="flex gap-3">
              <select
                value={item.categoryKey}
                onChange={e => updateItem(index, { categoryKey: e.target.value })}
                aria-label={`Item ${index + 1} category`}
                className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-600"
              >
                {categories.map(c => (
                  <option key={c.categoryKey} value={c.categoryKey}>{c.label}</option>
                ))}
              </select>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  value={item.estLbs}
                  min="0.1"
                  step="0.1"
                  onChange={e => updateItem(index, { estLbs: Number(e.target.value) })}
                  aria-label={`Item ${index + 1} weight in pounds`}
                  className="w-20 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
                />
                <span className="text-xs text-gray-500">lbs</span>
              </div>
            </div>

            {cat?.temperatureSensitive && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Prepared / pulled at <span className="text-red-500">*</span>
                  <span className="text-gray-400"> — {cat.safetyWindowHours}h safety window</span>
                </label>
                <input
                  type="datetime-local"
                  value={item.preparedAt}
                  onChange={e => updateItem(index, { preparedAt: e.target.value })}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
                />
              </div>
            )}

            <div className="flex justify-between text-xs text-gray-400">
              <span>{item.confidence > 0 ? `${Math.round(item.confidence * 100)}% match` : 'added manually'}</span>
              {cat && <span>est. value {centsToDollars(Math.round(cat.fmvPerLbCents * (item.estLbs || 0)))}</span>}
            </div>
          </div>
        );
      })}

      <button
        onClick={addItem}
        className="w-full border border-dashed border-gray-300 hover:border-green-600 text-sm text-gray-600 rounded-2xl py-3 transition-colors"
      >
        + Add an item the scan missed
      </button>

      <div className="bg-white border border-gray-200 rounded-2xl p-4 space-y-3">
        <div className="flex justify-between text-sm">
          <span className="font-semibold text-gray-900">Estimated value (FMV)</span>
          <span className="font-bold text-green-600">{centsToDollars(totalFmvCents)}</span>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Pickup window date</label>
          <input
            type="date"
            value={windowDate}
            onChange={e => setWindowDate(e.target.value)}
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
          />
        </div>
        <button
          onClick={handleConfirm}
          disabled={Boolean(invalidReason) || submitting}
          className="w-full min-h-[44px] bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-full py-3 text-sm transition-colors"
        >
          {submitting ? 'Declaring load…' : `Confirm manifest — ${items.length} item${items.length === 1 ? '' : 's'} →`}
        </button>
        {invalidReason && <p className="text-xs text-center text-gray-400">{invalidReason}</p>}
      </div>
    </div>
  );
}
