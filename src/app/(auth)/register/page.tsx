'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { registerAction } from '@/actions/auth';

type Role = 'donor' | 'consumer' | 'courier';
type Step = 'role' | 'details';

const ROLES: { value: Role; label: string; description: string; icon: string }[] = [
  { value: 'donor', label: 'Donor', description: 'I have surplus food to list', icon: '🏪' },
  { value: 'consumer', label: 'Consumer / Recipient', description: 'I want to buy discounted food', icon: '🛍️' },
  { value: 'courier', label: 'Courier', description: 'I want to deliver food', icon: '🚲' },
];

export default function RegisterPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('role');
  const [role, setRole] = useState<Role | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!role) return;
    setLoading(true);
    setError('');

    const formData = new FormData(e.currentTarget);
    formData.set('role', role);

    const result = await registerAction(formData);
    setLoading(false);

    if (!result.success) {
      setError(result.error ?? 'Something went wrong. Please try again.');
      return;
    }
    router.push(result.redirectTo!);
  }

  if (step === 'role') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4">
        <div className="w-full max-w-md">
          {/* Logo + tagline */}
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-green-600 mb-4">
              <span className="text-white text-2xl font-bold">F</span>
            </div>
            <h1 className="text-2xl font-bold text-gray-900">FoodLink</h1>
            <p className="text-gray-500 mt-1 text-sm">Rescue food. Feed your community.</p>
          </div>

          {/* Role cards — UI/UX Donor spec §1 */}
          <div className="space-y-3">
            {ROLES.map(r => (
              <button
                key={r.value}
                onClick={() => { setRole(r.value); setStep('details'); }}
                className="w-full text-left bg-white border border-gray-200 rounded-xl p-5 flex items-center gap-4 hover:border-green-600 hover:shadow-sm transition-all active:scale-[0.99]"
              >
                <span className="text-3xl">{r.icon}</span>
                <div>
                  <div className="font-semibold text-gray-900">{r.label}</div>
                  <div className="text-sm text-gray-500">{r.description}</div>
                </div>
              </button>
            ))}
          </div>

          <p className="text-center text-sm text-gray-500 mt-8">
            Already have an account?{' '}
            <Link href="/login" className="text-green-600 font-medium hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Progress bar — UI/UX spec global component */}
        <div className="mb-8">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
            <span>Step 1 of 2 · ~20 seconds remaining</span>
            <button
              onClick={() => setStep('role')}
              className="text-green-600 hover:underline"
            >
              ← Back
            </button>
          </div>
          <div className="h-1.5 bg-gray-200 rounded-full">
            <div className="h-1.5 bg-green-600 rounded-full w-1/2 transition-all" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-8">
          <h2 className="text-xl font-bold text-gray-900 mb-1">
            {role === 'donor' ? 'Verify your business' : 'Create your account'}
          </h2>
          <p className="text-sm text-gray-500 mb-6">
            {role === 'donor'
              ? 'We need your food service permit to activate your account.'
              : 'Full name, email, and phone to get started.'}
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <input type="hidden" name="role" value={role ?? ''} />

            {role === 'consumer' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full name</label>
                <input
                  name="fullName"
                  type="text"
                  required
                  placeholder="Your name"
                  className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
                />
              </div>
            )}

            {role === 'donor' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Business name</label>
                  <input
                    name="businessName"
                    type="text"
                    placeholder="Restaurant or business name"
                    className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
                  />
                  <p className="text-xs text-gray-400 mt-1">Leave blank if you&apos;re donating as a household.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Food service permit / license #</label>
                  <input
                    name="licenseNumber"
                    type="text"
                    placeholder="Required for businesses"
                    className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Pickup address</label>
                  <input
                    name="address"
                    type="text"
                    required
                    placeholder="Street, city, state, ZIP"
                    className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
                  />
                  <p className="text-xs text-gray-400 mt-1">Only shared with your assigned courier — never shown publicly.</p>
                </div>
              </>
            )}

            {role === 'consumer' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Organization name (optional)</label>
                  <input
                    name="organizationName"
                    type="text"
                    placeholder="Shelter or food bank name — leave blank for household"
                    className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Delivery address</label>
                  <input
                    name="address"
                    type="text"
                    required
                    placeholder="Street, city, state, ZIP"
                    className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
                  />
                </div>
              </>
            )}

            {role === 'courier' && (
              <label className="flex items-start gap-3 cursor-pointer bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
                <input
                  name="insulated"
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-600"
                />
                <span className="text-sm text-gray-700">
                  I have an insulated bag or cooler for temperature-sensitive deliveries
                </span>
              </label>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email address</label>
              <input
                name="email"
                type="email"
                required
                placeholder="you@example.com"
                className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <input
                name="password"
                type="password"
                required
                minLength={8}
                placeholder="8+ characters"
                className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone number</label>
              <input
                name="phone"
                type="tel"
                required
                placeholder="(555) 000-0000"
                className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-600"
              />
              <p className="text-xs text-gray-400 mt-1">US numbers only — any format works. We&apos;ll send a verification code.</p>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white font-semibold rounded-full py-3 text-sm transition-colors mt-2"
            >
              {loading ? 'Creating account...' : 'Continue →'}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-gray-500 mt-6">
          Already have an account?{' '}
          <Link href="/login" className="text-green-600 font-medium hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
