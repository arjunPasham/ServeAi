'use client';

import { useState, useRef, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { verifyOTPAction, sendOTPAction } from '@/actions/auth';

function VerifyPhoneForm() {
  const router = useRouter();
  const params = useSearchParams();
  const phone = params.get('phone') ?? '';

  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendTimer, setResendTimer] = useState(60);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  useEffect(() => {
    if (resendTimer <= 0) return;
    const t = setInterval(() => setResendTimer(s => s - 1), 1000);
    return () => clearInterval(t);
  }, [resendTimer]);

  function handleDigit(index: number, value: string) {
    const digit = value.replace(/\D/g, '').slice(-1);
    const next = [...code];
    next[index] = digit;
    setCode(next);
    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
    // Auto-submit when all 6 digits filled
    if (digit && index === 5 && next.every(d => d)) {
      submitCode(next.join(''));
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }

  async function submitCode(fullCode: string) {
    setLoading(true);
    setError('');
    const result = await verifyOTPAction(phone, fullCode);
    setLoading(false);
    if (!result.success) {
      setError('Incorrect code. Please check and try again.');
      setCode(['', '', '', '', '', '']);
      inputRefs.current[0]?.focus();
      return;
    }
    router.push(result.redirectTo!);
  }

  async function handleResend() {
    if (resendTimer > 0) return;
    setError('');
    const result = await sendOTPAction(phone);
    if (!result.success) {
      setError(result.error ?? 'Failed to resend. Try again.');
      return;
    }
    setResendTimer(60);
  }

  const displayPhone = phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '+1 ($1) $2-$3');

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Progress bar — step 2 of 2 */}
        <div className="mb-8">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
            <span>Step 2 of 2 · ~15 seconds remaining</span>
          </div>
          <div className="h-1.5 bg-gray-200 rounded-full">
            <div className="h-1.5 bg-green-600 rounded-full w-full transition-all" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-8">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-green-50 mb-4">
              <span className="text-2xl">📱</span>
            </div>
            <h2 className="text-xl font-bold text-gray-900">Verify your phone</h2>
            <p className="text-sm text-gray-500 mt-2">
              We sent a 6-digit code to{' '}
              <span className="font-medium text-gray-700">{displayPhone}</span>
            </p>
          </div>

          {/* 6-digit OTP input — per UI/UX accessibility requirements */}
          <div className="flex gap-3 justify-center mb-6" role="group" aria-label="Verification code">
            {code.map((digit, i) => (
              <input
                key={i}
                ref={el => { inputRefs.current[i] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={e => handleDigit(i, e.target.value)}
                onKeyDown={e => handleKeyDown(i, e)}
                aria-label={`Digit ${i + 1}`}
                className="w-12 h-14 text-center text-xl font-bold border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-600 focus:border-transparent transition-all"
              />
            ))}
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4 text-center">
              {error}
            </div>
          )}

          <button
            onClick={() => {
              const full = code.join('');
              if (full.length === 6) submitCode(full);
            }}
            disabled={loading || code.some(d => !d)}
            className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white font-semibold rounded-full py-3 text-sm transition-colors"
          >
            {loading ? 'Verifying...' : 'Verify phone →'}
          </button>

          <div className="text-center mt-4">
            {resendTimer > 0 ? (
              <p className="text-sm text-gray-400">Resend code in {resendTimer}s</p>
            ) : (
              <button
                onClick={handleResend}
                className="text-sm text-green-600 font-medium hover:underline"
              >
                Resend code
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function VerifyPhonePage() {
  return (
    <Suspense>
      <VerifyPhoneForm />
    </Suspense>
  );
}
