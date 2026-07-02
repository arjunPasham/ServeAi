'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { z } from 'zod';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { sendOTP, verifyOTP } from '@/lib/twilio';
import { checkAuthIPLimit } from '@/lib/rate-limit';

const PhoneSchema = z.string().regex(/^\+1\d{10}$/, 'Phone must be in E.164 format (+1XXXXXXXXXX)');

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['donor', 'consumer', 'courier']),
  phone: PhoneSchema,
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type AuthResult = {
  success: boolean;
  error?: string;
  redirectTo?: string;
};

// Single source of truth for role → dashboard routes used by all auth actions
const ROLE_DASHBOARD: Record<string, string> = {
  donor: '/donor/dashboard',
  consumer: '/consumer/browse',
  courier: '/courier/dashboard',
  admin: '/admin/dashboard',
};

export async function registerAction(formData: FormData): Promise<AuthResult> {
  const raw = {
    email: formData.get('email'),
    password: formData.get('password'),
    role: formData.get('role'),
    phone: formData.get('phone'),
  };

  const parsed = RegisterSchema.safeParse(raw);
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0].message };
  }

  const { email, password, role, phone } = parsed.data;
  const supabase = await createClient();

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error || !data.user) {
    return { success: false, error: error?.message ?? 'SIGNUP_FAILED' };
  }

  // Update the auto-created public.users row (handle_new_auth_user trigger sets role='consumer')
  const service = await createServiceClient();
  const { error: updateError } = await service
    .from('users')
    .update({ role, phone })
    .eq('id', data.user.id);

  if (updateError) {
    return { success: false, error: 'PROFILE_UPDATE_FAILED' };
  }

  const headerStore = await headers();
  const ip = headerStore.get('x-real-ip') ?? headerStore.get('x-forwarded-for') ?? '0.0.0.0';
  const otpResult = await sendOTP(phone, ip);
  if (!otpResult.success) {
    return { success: false, error: otpResult.error };
  }

  return { success: true, redirectTo: `/verify-phone?phone=${encodeURIComponent(phone)}&role=${role}` };
}

export async function loginAction(formData: FormData): Promise<AuthResult> {
  const raw = {
    email: formData.get('email'),
    password: formData.get('password'),
  };

  const parsed = LoginSchema.safeParse(raw);
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0].message };
  }

  const { email, password } = parsed.data;

  const headerStore = await headers();
  const ip = headerStore.get('x-real-ip') ?? headerStore.get('x-forwarded-for') ?? '0.0.0.0';
  const authCheck = await checkAuthIPLimit(ip);
  if (!authCheck.allowed) {
    return { success: false, error: 'Too many failed login attempts. Please try again later.' };
  }

  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    return { success: false, error: 'Invalid email or password' };
  }

  const { data: userRow } = await supabase
    .from('users')
    .select('role, phone, phone_verified')
    .eq('id', data.user.id)
    .single();

  // Gate: phone must be verified before accessing any dashboard
  if (!userRow?.phone_verified) {
    const phone = userRow?.phone ?? '';
    const role = userRow?.role ?? 'consumer';
    return {
      success: true,
      redirectTo: `/verify-phone?phone=${encodeURIComponent(phone)}&role=${role}`,
    };
  }

  const role = userRow.role ?? 'consumer';
  return { success: true, redirectTo: ROLE_DASHBOARD[role] ?? '/' };
}

export async function sendOTPAction(phone: string): Promise<AuthResult> {
  // Validate E.164 format to prevent SMS toll fraud
  const parsed = PhoneSchema.safeParse(phone);
  if (!parsed.success) {
    return { success: false, error: 'INVALID_PHONE_FORMAT' };
  }

  // Require an authenticated session — resend is only valid mid-registration
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  const headerStore = await headers();
  const ip = headerStore.get('x-real-ip') ?? headerStore.get('x-forwarded-for') ?? '0.0.0.0';
  const result = await sendOTP(phone, ip);
  return result.success
    ? { success: true }
    : { success: false, error: result.error };
}

export async function verifyOTPAction(phone: string, code: string): Promise<AuthResult> {
  const result = await verifyOTP(phone, code);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  // Must have a valid session
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  const service = await createServiceClient();
  const { data: userRow } = await service
    .from('users')
    .select('role, phone')
    .eq('id', user.id)
    .single();

  // Confirm the phone in the URL matches the phone stored for this user during registration
  if (!userRow || userRow.phone !== phone) {
    return { success: false, error: 'PHONE_MISMATCH' };
  }

  await Promise.all([
    service.from('users').update({ phone_verified: true }).eq('id', user.id),
    // Store in auth metadata so middleware can check without extra DB query
    supabase.auth.updateUser({ data: { phone_verified: true } }),
  ]);

  const role = userRow.role ?? 'consumer';
  return { success: true, redirectTo: ROLE_DASHBOARD[role] ?? '/' };
}

export async function logoutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
