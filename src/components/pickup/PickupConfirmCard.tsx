'use client';

// Donor-side handoff confirmation for self-pickup orders: enter the code the
// consumer shows, confirm, done. Confirming fires the standard
// delivery/confirmed pipeline (dispute window, feedback prompt).

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { confirmPickup, type PendingPickup } from '@/actions/pickup';

const ERROR_LABEL: Record<string, string> = {
  WRONG_CODE_OR_STATE: "That code doesn't match. Ask the consumer to show their order page.",
  LISTING_EXPIRED: 'This listing passed its safety window and can no longer be handed over.',
  CODE_REQUIRED: 'Enter the code from the consumer.',
  SERVER_ERROR: 'Something went wrong. Please try again.',
};

export function PickupConfirmCard({ pickup }: { pickup: PendingPickup }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await confirmPickup(pickup.orderId, code);
      if (result.success) {
        setConfirmed(true);
        router.refresh();
      } else {
        setError(ERROR_LABEL[result.error] ?? ERROR_LABEL.SERVER_ERROR);
      }
    });
  }

  if (confirmed) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-2xl px-4 py-3 text-sm text-green-800 font-medium">
        Handoff confirmed — &quot;{pickup.detectedItem}&quot; is on its way home. ✓
      </div>
    );
  }

  return (
    <div className="bg-white border border-amber-300 rounded-2xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-gray-900 text-sm">{pickup.detectedItem}</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {pickup.estimatedQuantityLbs} lbs · awaiting pickup
          </p>
        </div>
        <span className="text-xs font-medium bg-amber-100 text-amber-800 rounded-full px-2 py-0.5 shrink-0">
          Pickup order
        </span>
      </div>

      <div className="flex gap-2">
        <input
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          placeholder="Handoff code"
          maxLength={6}
          autoCapitalize="characters"
          autoComplete="off"
          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono tracking-widest uppercase focus:outline-none focus:ring-2 focus:ring-green-600"
        />
        <button
          onClick={handleConfirm}
          disabled={isPending || code.trim().length < 4}
          className="min-h-[40px] bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold rounded-full px-5 text-sm transition-colors"
        >
          {isPending ? 'Confirming…' : 'Confirm handoff'}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <p className="text-[11px] text-gray-400">
        Ask the consumer for the 6-character code on their order page.
      </p>
    </div>
  );
}
