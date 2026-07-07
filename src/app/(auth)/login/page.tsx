'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { loginAction } from '@/actions/auth';
import { Eye, EyeOff } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const formData = new FormData(e.currentTarget);
    const result = await loginAction(formData);
    setLoading(false);

    if (!result.success) {
      const retryMsg = result.retryAfter
        ? ` Try again in ${Math.ceil(result.retryAfter / 60)} minutes.`
        : '';
      setError((result.error ?? 'Something went wrong.') + retryMsg);
      return;
    }
    router.push(result.redirectTo!);
  }

  return (
    <div className="min-h-screen bg-grain flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-10">
          <Link href="/" className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary mb-4 shadow-sm">
            <span className="text-primary-foreground text-2xl font-display">F</span>
          </Link>
          <h1 className="font-display text-2xl text-foreground">Welcome back</h1>
          <p className="text-muted-foreground mt-1 text-sm">Rescue food. Feed your community.</p>
        </div>

        <div className="bg-card rounded-3xl border border-border p-8 shadow-sm">
          <h2 className="font-display text-xl text-foreground mb-6">Sign in</h2>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-foreground mb-1.5">
                Email address
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
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  placeholder="Your password"
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

            {error && (
              <div role="alert" className="bg-destructive/10 border border-destructive/20 text-destructive text-sm rounded-xl px-4 py-3">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full min-h-[44px] bg-primary hover:bg-primary-hover disabled:opacity-60 text-primary-foreground font-semibold rounded-full py-3.5 text-sm transition-colors shadow-sm"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-muted-foreground mt-6">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="text-primary font-medium hover:underline">
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
