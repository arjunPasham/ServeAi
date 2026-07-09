import Link from 'next/link';
import { Store, ShoppingBasket, ArrowRight } from 'lucide-react';

export const metadata = { title: 'Simulate FoodLink' };

export default function DemoRolePicker() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-16 text-center">
      <h1 className="font-display text-3xl sm:text-4xl text-foreground mb-4">
        See FoodLink in action
      </h1>
      <p className="text-muted-foreground max-w-lg mx-auto mb-12 leading-relaxed">
        Pick a side of the marketplace. A short guided tour walks you through the
        full flow — AI food scanning, automatic pricing, escrowed payment, and
        live delivery tracking — all with sample data.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 text-left">
        <Link
          href="/demo/donor"
          className="group bg-card border border-border hover:border-primary rounded-3xl p-7 shadow-sm hover:shadow-md transition-all"
        >
          <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
            <Store className="w-6 h-6 text-primary" strokeWidth={2} />
          </div>
          <h2 className="font-semibold text-foreground text-lg mb-1.5">I have surplus food</h2>
          <p className="text-sm text-muted-foreground leading-relaxed mb-5">
            Scan a sample photo, watch the AI identify and price it, and publish
            a listing — the whole donor flow in under a minute.
          </p>
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
            Try the donor flow
            <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>

        <Link
          href="/demo/consumer"
          className="group bg-card border border-border hover:border-accent rounded-3xl p-7 shadow-sm hover:shadow-md transition-all"
        >
          <div className="w-12 h-12 rounded-2xl bg-accent/10 flex items-center justify-center mb-4">
            <ShoppingBasket className="w-6 h-6 text-accent" strokeWidth={2} />
          </div>
          <h2 className="font-semibold text-foreground text-lg mb-1.5">I want affordable food</h2>
          <p className="text-sm text-muted-foreground leading-relaxed mb-5">
            Browse nearby listings, claim one at 30%+ below retail, pay into
            escrow, and watch a simulated delivery arrive.
          </p>
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
            Try the consumer flow
            <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>
      </div>
    </main>
  );
}
