import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-green-600 flex items-center justify-center">
            <span className="text-white text-sm font-bold">F</span>
          </div>
          <span className="font-bold text-gray-900">FoodLink</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/login" className="text-sm text-gray-600 hover:text-gray-900 font-medium">
            Sign in
          </Link>
          <Link
            href="/register"
            className="text-sm bg-green-600 hover:bg-green-700 text-white font-semibold px-4 py-2 rounded-full transition-colors"
          >
            Get started
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center text-center px-6 py-24">
        <div className="inline-flex items-center gap-2 bg-green-50 text-green-700 text-xs font-semibold px-3 py-1.5 rounded-full mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-green-600 inline-block" />
          Now in early access
        </div>

        <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 max-w-2xl leading-tight mb-6">
          Rescue food.<br />Feed your community.
        </h1>

        <p className="text-lg text-gray-500 max-w-md mb-10">
          FoodLink connects donors with surplus food to consumers who need it — with couriers handling same-day pickup and delivery.
        </p>

        <div className="flex flex-col sm:flex-row gap-3">
          <Link
            href="/register"
            className="bg-green-600 hover:bg-green-700 text-white font-semibold px-6 py-3 rounded-full text-sm transition-colors"
          >
            Join as Donor, Consumer, or Courier →
          </Link>
          <Link
            href="/login"
            className="border border-gray-200 hover:border-gray-300 text-gray-700 font-semibold px-6 py-3 rounded-full text-sm transition-colors"
          >
            Sign in
          </Link>
        </div>

        {/* Role pills */}
        <div className="flex flex-wrap justify-center gap-3 mt-14">
          {[
            { icon: '🏪', label: 'Donors', desc: 'List surplus food' },
            { icon: '🛍️', label: 'Consumers', desc: 'Buy at deep discounts' },
            { icon: '🚲', label: 'Couriers', desc: 'Earn delivering food' },
          ].map(r => (
            <div
              key={r.label}
              className="flex items-center gap-3 bg-gray-50 border border-gray-100 rounded-xl px-5 py-3"
            >
              <span className="text-2xl">{r.icon}</span>
              <div className="text-left">
                <div className="text-sm font-semibold text-gray-900">{r.label}</div>
                <div className="text-xs text-gray-500">{r.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </main>

      <footer className="text-center text-xs text-gray-400 py-6 border-t border-gray-100">
        © {new Date().getFullYear()} FoodLink · ServeAI initiative
      </footer>
    </div>
  );
}
