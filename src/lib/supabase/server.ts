import { createServerClient } from '@supabase/ssr';
import {
  createClient as createSupabaseClient,
  type SupabaseClient,
} from '@supabase/supabase-js';
import { cookies } from 'next/headers';

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from Server Component — middleware handles session refresh
          }
        },
      },
    }
  );
}

// Service-role client — server-side only, bypasses RLS.
// IMPORTANT: must NOT be built from request cookies. If a user session is
// attached, supabase-js sends the user's JWT as the Authorization header and
// every query silently runs under the caller's RLS instead of service_role.
let _serviceClient: SupabaseClient | null = null;

export async function createServiceClient(): Promise<SupabaseClient> {
  if (!_serviceClient) {
    _serviceClient = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      }
    );
  }
  return _serviceClient;
}
