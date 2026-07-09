import Link from 'next/link';
import { Store, ShoppingBasket, Bike, ShieldCheck, Clock, HandCoins, ArrowRight, Play } from 'lucide-react';

const ROLES = [
  {
    icon: Store,
    label: 'Donors',
    desc: 'List surplus food in under a minute — our AI handles pricing and food safety windows',
    accent: 'text-primary',
    bg: 'bg-primary/10',
  },
  {
    icon: ShoppingBasket,
    label: 'Consumers',
    desc: 'Browse verified listings nearby and pay a fraction of retail price',
    accent: 'text-accent',
    bg: 'bg-accent/10',
  },
  {
    icon: Bike,
    label: 'Couriers',
    desc: 'Accept nearby deliveries and get paid the moment you confirm drop-off',
    accent: 'text-courier',
    bg: 'bg-courier/10',
  },
];

const VALUE_PROPS = [
  {
    icon: ShieldCheck,
    title: 'Verified & safety-checked',
    desc: 'Every listing carries a donor safety attestation and an FDA-aligned freshness window — automatically enforced, never left to guesswork.',
  },
  {
    icon: Clock,
    title: 'Same-day, every time',
    desc: 'Our dispatch system finds the nearest available courier the instant a listing sells, so food moves before it spoils.',
  },
  {
    icon: HandCoins,
    title: 'Fair pricing, both ways',
    desc: 'Donors recover real value for surplus food. Consumers pay at least 30% below retail. No middleman markup.',
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 sm:px-10 py-5">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center shadow-sm">
            <span className="text-primary-foreground text-base font-display">F</span>
          </div>
          <span className="font-display text-lg text-foreground">FoodLink</span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="text-sm text-foreground/70 hover:text-foreground font-medium px-3 py-2 transition-colors"
          >
            Sign in
          </Link>
          <Link
            href="/register"
            className="text-sm bg-primary hover:bg-primary-hover text-primary-foreground font-semibold px-5 py-2.5 rounded-full transition-colors shadow-sm"
          >
            Get started
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <header className="bg-grain relative overflow-hidden">
        {/* Organic accent shapes — Nature Distilled texture, decorative only */}
        <div
          aria-hidden="true"
          className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-accent/10 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="absolute top-40 -left-32 w-80 h-80 rounded-full bg-primary/10 blur-3xl"
        />

        <main className="relative flex-1 flex flex-col items-center text-center px-6 py-20 sm:py-28 max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 bg-card border border-border text-muted-foreground text-xs font-semibold px-3.5 py-1.5 rounded-full mb-8 shadow-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-accent inline-block" />
            Now in early access
          </div>

          <h1 className="font-display text-4xl sm:text-6xl text-foreground leading-[1.05] mb-6 text-balance">
            Surplus food finds
            <br />
            <span className="text-primary">a home today.</span>
          </h1>

          <p className="text-lg text-muted-foreground max-w-lg mb-10 leading-relaxed">
            FoodLink connects donors with surplus food to consumers who need it —
            with couriers handling same-day pickup and delivery before anything spoils.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            <Link
              href="/register"
              className="group inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-primary-foreground font-semibold px-7 py-3.5 rounded-full text-sm transition-colors shadow-sm min-h-[44px]"
            >
              Join FoodLink
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center justify-center bg-card border border-border hover:border-foreground/20 text-foreground font-semibold px-7 py-3.5 rounded-full text-sm transition-colors min-h-[44px]"
            >
              Sign in
            </Link>
          </div>

          <Link
            href="/demo"
            className="group inline-flex items-center gap-2 text-sm font-semibold text-accent hover:text-accent-hover transition-colors mb-16"
          >
            <Play className="w-4 h-4" />
            Or simulate the system — no account needed
            <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
          </Link>

          {/* Role cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full text-left">
            {ROLES.map(r => {
              const Icon = r.icon;
              return (
                <div
                  key={r.label}
                  className="bg-card border border-border rounded-2xl p-5 shadow-sm"
                >
                  <div className={`w-10 h-10 rounded-xl ${r.bg} flex items-center justify-center mb-3`}>
                    <Icon className={`w-5 h-5 ${r.accent}`} strokeWidth={2} />
                  </div>
                  <div className="text-sm font-semibold text-foreground mb-1">{r.label}</div>
                  <div className="text-xs text-muted-foreground leading-relaxed">{r.desc}</div>
                </div>
              );
            })}
          </div>
        </main>
      </header>

      {/* Value props */}
      <section className="px-6 sm:px-10 py-20 max-w-5xl mx-auto w-full">
        <div className="text-center mb-14">
          <h2 className="font-display text-2xl sm:text-3xl text-foreground mb-3">
            Built so food moves before it spoils
          </h2>
          <p className="text-muted-foreground max-w-md mx-auto">
            Every part of FoodLink is designed around one constraint: time.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
          {VALUE_PROPS.map(v => {
            const Icon = v.icon;
            return (
              <div key={v.title} className="text-left">
                <div className="w-11 h-11 rounded-xl bg-muted flex items-center justify-center mb-4">
                  <Icon className="w-5 h-5 text-primary" strokeWidth={2} />
                </div>
                <h3 className="font-semibold text-foreground mb-2">{v.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{v.desc}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Final CTA band */}
      <section className="px-6 sm:px-10 py-16">
        <div className="max-w-4xl mx-auto bg-primary rounded-3xl px-8 py-14 text-center relative overflow-hidden">
          <div
            aria-hidden="true"
            className="absolute -bottom-20 -right-20 w-64 h-64 rounded-full bg-white/5 blur-2xl"
          />
          <h2 className="font-display text-2xl sm:text-3xl text-primary-foreground mb-4 relative">
            Ready to rescue food in your community?
          </h2>
          <p className="text-primary-foreground/80 mb-8 max-w-md mx-auto relative">
            Sign up as a donor, consumer, or courier — it takes about a minute.
          </p>
          <Link
            href="/register"
            className="inline-flex items-center gap-2 bg-card text-foreground hover:bg-card/90 font-semibold px-7 py-3.5 rounded-full text-sm transition-colors shadow-sm relative min-h-[44px]"
          >
            Get started
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </section>

      <footer className="text-center text-xs text-muted-foreground py-8 border-t border-border">
        © {new Date().getFullYear()} FoodLink · ServeAI initiative
      </footer>
    </div>
  );
}
