'use server';

import { createClient, createServiceClient } from '@/lib/supabase/server';
import {
  createConnectAccount,
  createConnectOnboardingLink,
} from '@/lib/stripe';

export type ConnectRole = 'donor' | 'courier';

const PROFILE_TABLE: Record<ConnectRole, 'donor_profiles' | 'courier_profiles'> = {
  donor: 'donor_profiles',
  courier: 'courier_profiles',
};

export type StartConnectOnboardingResult =
  | { success: true; url: string }
  | { success: false; error: string };

export async function startConnectOnboarding(): Promise<StartConnectOnboardingResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  const service = await createServiceClient();

  const { data: userRow } = await service
    .from('users')
    .select('role, email')
    .eq('id', user.id)
    .single();

  const rawRole = userRow?.role;
  if (rawRole !== 'donor' && rawRole !== 'courier') {
    return { success: false, error: 'ROLE_NOT_ELIGIBLE' };
  }
  const role: ConnectRole = rawRole;

  const table = PROFILE_TABLE[role];
  const { data: profile, error: profileError } = await service
    .from(table)
    .select('stripe_account_id')
    .eq('user_id', user.id)
    .single();

  if (profileError || !profile) {
    return { success: false, error: 'PROFILE_NOT_FOUND' };
  }

  let accountId = profile.stripe_account_id as string | null;

  if (!accountId) {
    const email = userRow?.email ?? user.email ?? '';
    const { accountId: newAccountId } = await createConnectAccount({ userId: user.id, email });
    accountId = newAccountId;

    const { error: updateError } = await service
      .from(table)
      .update({ stripe_account_id: accountId })
      .eq('user_id', user.id);
    if (updateError) {
      return { success: false, error: 'SERVER_ERROR' };
    }
  }

  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const returnUrl = `${base}/api/stripe/connect/return?role=${role}`;
  const refreshUrl = `${base}/api/stripe/connect/return?role=${role}&refresh=1`;

  const { url } = await createConnectOnboardingLink({ accountId, refreshUrl, returnUrl });

  return { success: true, url };
}

export type ConnectStatus = { hasAccount: boolean; payoutsEnabled: boolean };

export async function getConnectStatus(): Promise<ConnectStatus | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const service = await createServiceClient();

  const { data: userRow } = await service
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single();

  const rawRole = userRow?.role;
  if (rawRole !== 'donor' && rawRole !== 'courier') return null;
  const role: ConnectRole = rawRole;

  const table = PROFILE_TABLE[role];
  const { data: profile } = await service
    .from(table)
    .select('stripe_account_id, payouts_enabled')
    .eq('user_id', user.id)
    .single();

  if (!profile) return null;

  return {
    hasAccount: !!profile.stripe_account_id,
    payoutsEnabled: profile.payouts_enabled === true,
  };
}
