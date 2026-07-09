import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { getConnectAccountStatus } from '@/lib/stripe';

const PROFILE_TABLE: Record<string, 'donor_profiles' | 'courier_profiles'> = {
  donor: 'donor_profiles',
  courier: 'courier_profiles',
};

const DASHBOARD: Record<string, string> = {
  donor: '/donor/dashboard',
  courier: '/courier/dashboard',
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const isRefresh = url.searchParams.get('refresh') === '1';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  const service = await createServiceClient();

  // Role comes from the database, never from the query string — a consumer
  // hitting this URL with ?role=donor must not flip donor_profiles state.
  const { data: userRow } = await service
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single();

  const role = userRow?.role;
  if (role !== 'donor' && role !== 'courier') {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  const table = PROFILE_TABLE[role];

  const { data: profile } = await service
    .from(table)
    .select('stripe_account_id')
    .eq('user_id', user.id)
    .single();

  let payoutsEnabled = false;

  if (profile?.stripe_account_id) {
    const status = await getConnectAccountStatus(profile.stripe_account_id);
    payoutsEnabled = status.payoutsEnabled;

    await service
      .from(table)
      .update({ payouts_enabled: payoutsEnabled })
      .eq('user_id', user.id);
  }

  const dashboard = DASHBOARD[role];
  const connectState = !isRefresh && payoutsEnabled ? 'complete' : 'incomplete';

  return NextResponse.redirect(new URL(`${dashboard}?connect=${connectState}`, req.url));
}
