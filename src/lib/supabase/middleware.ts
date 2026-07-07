import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const ROLE_DASHBOARD: Record<string, string> = {
  donor: '/donor/dashboard',
  consumer: '/consumer/browse',
  courier: '/courier/dashboard',
  admin: '/admin/dashboard',
};

// Which role owns each protected prefix
const PREFIX_ROLE: Record<string, string> = {
  '/donor': 'donor',
  '/consumer': 'consumer',
  '/courier': 'courier',
  '/admin': 'admin',
};

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const matchedPrefix = Object.keys(PREFIX_ROLE).find(p => pathname.startsWith(p));

  if (matchedPrefix) {
    if (!user) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = '/login';
      loginUrl.searchParams.set('redirect', pathname);
      return NextResponse.redirect(loginUrl);
    }

    // phone_verified and role are stored in app_metadata (server-managed via the
    // admin API). Never trust user_metadata here — users can write it themselves.
    const isPhoneVerified = user.app_metadata?.phone_verified === true;
    if (!isPhoneVerified) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = '/login';
      loginUrl.searchParams.set('redirect', pathname);
      return NextResponse.redirect(loginUrl);
    }

    // Role segregation: a consumer can't open /donor/*, etc.
    // If role is missing from app_metadata (e.g. manually created admin), fall
    // through — server components/actions still enforce ownership themselves.
    const role = user.app_metadata?.role as string | undefined;
    const requiredRole = PREFIX_ROLE[matchedPrefix];
    if (role && role !== requiredRole) {
      const homeUrl = request.nextUrl.clone();
      homeUrl.pathname = ROLE_DASHBOARD[role] ?? '/';
      homeUrl.search = '';
      return NextResponse.redirect(homeUrl);
    }
  }

  return supabaseResponse;
}
