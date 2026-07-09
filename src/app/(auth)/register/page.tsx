'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { registerAction } from '@/actions/auth';
import { Store, ShoppingBasket, Eye, EyeOff, ChevronLeft, type LucideIcon } from 'lucide-react';

// Courier self-registration is closed — deliveries run through Uber Direct or
// consumer self-pickup (DELIVERY_MODE gate; registerAction enforces this
// server-side too).
type Role = 'donor' | 'consumer';
type Step = 'role' | 'details';

const ROLES: { value: Role; label: string; description: string; icon: LucideIcon; accent: string; bg: string }[] = [
  { value: 'donor', label: 'Donor', description: 'I have surplus food to list', icon: Store, accent: 'text-primary', bg: 'bg-primary/10' },
  { value: 'consumer', label: 'Consumer / Recipient', description: 'I want to buy discounted food', icon: ShoppingBasket, accent: 'text-accent', bg: 'bg-accent/10' },
];

export default function RegisterPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('role');
  const [role, setRole] = useState<Role | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

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
      <div className="min-h-screen bg-grain flex flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          {/* Logo + tagline */}
          <div className="text-center mb-10">
            <Link href="/" className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary mb-4 shadow-sm">
              <span className="text-primary-foreground text-2xl font-display">F</span>
            </Link>
            <h1 className="font-display text-2xl text-foreground">Join FoodLink</h1>
            <p className="text-muted-foreground mt-1 text-sm">Rescue food. Feed your community.</p>
          </div>

          {/* Role cards */}
          <div className="space-y-3" role="radiogroup" aria-label="Choose your role">
            {ROLES.map(r => {
              const Icon = r.icon;
              return (
                <button
                  key={r.value}
                  type="button"
                  role="radio"
                  aria-checked={role === r.value}
                  onClick={() => { setRole(r.value); setStep('details'); }}
                  className="w-full text-left bg-card border border-border rounded-2xl p-5 flex items-center gap-4 hover:border-primary/40 hover:shadow-md transition-all active:scale-[0.99] min-h-[44px]"
                >
                  <div className={`w-12 h-12 shrink-0 rounded-xl ${r.bg} flex items-center justify-center`}>
                    <Icon className={`w-6 h-6 ${r.accent}`} strokeWidth={2} />
                  </div>
                  <div>
                    <div className="font-semibold text-foreground">{r.label}</div>
                    <div className="text-sm text-muted-foreground">{r.description}</div>
                  </div>
                </button>
              );
            })}
          </div>

          <p className="text-center text-sm text-muted-foreground mt-8">
            Already have an account?{' '}
            <Link href="/login" className="text-primary font-medium hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    );
  }

  const selectedRole = ROLES.find(r => r.value === role)!;
  const RoleIcon = selectedRole.icon;

  return (
    <div className="min-h-screen bg-grain flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        {/* Progress bar */}
        <div className="mb-8">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
            <button
              type="button"
              onClick={() => setStep('role')}
              className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              Back
            </button>
            <span>Step 2 of 2 · ~20 seconds remaining</span>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full w-full transition-all duration-300" />
          </div>
        </div>

        <div className="bg-card rounded-3xl border border-border p-8 shadow-sm">
          <div className="flex items-center gap-3 mb-1">
            <div className={`w-9 h-9 shrink-0 rounded-lg ${selectedRole.bg} flex items-center justify-center`}>
              <RoleIcon className={`w-[18px] h-[18px] ${selectedRole.accent}`} strokeWidth={2} />
            </div>
            <h2 className="font-display text-xl text-foreground">
              {role === 'donor' ? 'Verify your business' : 'Create your account'}
            </h2>
          </div>
          <p className="text-sm text-muted-foreground mb-6 ml-12">
            {role === 'donor'
              ? 'We need your food service permit to activate your account.'
              : 'Full name, email, and phone to get started.'}
          </p>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <input type="hidden" name="role" value={role ?? ''} />

            {role === 'consumer' && (
              <div>
                <label htmlFor="fullName" className="block text-sm font-medium text-foreground mb-1.5">
                  Full name <span className="text-destructive">*</span>
                </label>
                <input
                  id="fullName"
                  name="fullName"
                  type="text"
                  required
                  autoComplete="name"
                  placeholder="Your name"
                  className="w-full border border-border bg-background rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-shadow"
                />
              </div>
            )}

            {role === 'donor' && (
              <>
                <div>
                  <label htmlFor="businessName" className="block text-sm font-medium text-foreground mb-1.5">
                    Business name
                  </label>
                  <input
                    id="businessName"
                    name="businessName"
                    type="text"
                    autoComplete="organization"
                    placeholder="Restaurant or business name"
                    className="w-full border border-border bg-background rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-shadow"
                  />
                  <p className="text-xs text-muted-foreground mt-1.5">Leave blank if you&apos;re donating as a household.</p>
                </div>
                <div>
                  <label htmlFor="licenseNumber" className="block text-sm font-medium text-foreground mb-1.5">
                    Food service permit / license #
                  </label>
                  <input
                    id="licenseNumber"
                    name="licenseNumber"
                    type="text"
                    placeholder="Required for businesses"
                    className="w-full border border-border bg-background rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-shadow"
                  />
                </div>
                <div>
                  <label htmlFor="address" className="block text-sm font-medium text-foreground mb-1.5">
                    Pickup address <span className="text-destructive">*</span>
                  </label>
                  <input
                    id="address"
                    name="address"
                    type="text"
                    required
                    autoComplete="street-address"
                    placeholder="Street, city, state, ZIP"
                    className="w-full border border-border bg-background rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-shadow"
                  />
                  <p className="text-xs text-muted-foreground mt-1.5">Only shared with your assigned courier — never shown publicly.</p>
                </div>
              </>
            )}

            {role === 'consumer' && (
              <>
                <div>
                  <label htmlFor="organizationName" className="block text-sm font-medium text-foreground mb-1.5">
                    Organization name (optional)
                  </label>
                  <input
                    id="organizationName"
                    name="organizationName"
                    type="text"
                    autoComplete="organization"
                    placeholder="Shelter or food bank name — leave blank for household"
                    className="w-full border border-border bg-background rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-shadow"
                  />
                </div>
                <div>
                  <label htmlFor="address" className="block text-sm font-medium text-foreground mb-1.5">
                    Delivery address <span className="text-destructive">*</span>
                  </label>
                  <input
                    id="address"
                    name="address"
                    type="text"
                    required
                    autoComplete="street-address"
                    placeholder="Street, city, state, ZIP"
                    className="w-full border border-border bg-background rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-shadow"
                  />
                </div>
              </>
            )}

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-foreground mb-1.5">
                Email address <span className="text-destructive">*</span>
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                inputMode="email"
                placeholder="you@example.com"
                className="w-full border border-border bg-background rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-shadow"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-foreground mb-1.5">
                Password <span className="text-destructive">*</span>
              </label>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  placeholder="8+ characters"
                  className="w-full border border-border bg-background rounded-xl px-4 py-3 pr-11 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-shadow"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(s => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="phone" className="block text-sm font-medium text-foreground mb-1.5">
                Phone number <span className="text-destructive">*</span>
              </label>
              <input
                id="phone"
                name="phone"
                type="tel"
                required
                autoComplete="tel"
                inputMode="tel"
                placeholder="(555) 000-0000"
                className="w-full border border-border bg-background rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-shadow"
              />
              <p className="text-xs text-muted-foreground mt-1.5">US numbers only — any format works. We&apos;ll send a verification code.</p>
            </div>

            {error && (
              <div role="alert" className="bg-destructive/10 border border-destructive/20 text-destructive text-sm rounded-xl px-4 py-3">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full min-h-[44px] bg-primary hover:bg-primary-hover disabled:opacity-60 text-primary-foreground font-semibold rounded-full py-3.5 text-sm transition-colors mt-2 shadow-sm"
            >
              {loading ? 'Creating account…' : 'Continue →'}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-muted-foreground mt-6">
          Already have an account?{' '}
          <Link href="/login" className="text-primary font-medium hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
