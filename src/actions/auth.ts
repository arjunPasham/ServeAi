'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { z } from 'zod';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { sendOTP, verifyOTP } from '@/lib/twilio';
import { validateUSAddress } from '@/lib/smarty';

// Accept anything a human types ("(555) 123-4567", "555-123-4567", "+1 555…")
// and normalize to E.164 (+1XXXXXXXXXX). Returns null if not a US number.
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['donor', 'consumer', 'courier']),
  phone: z.string().min(10),
  address: z.string().optional(),
  businessName: z.string().optional(),
  licenseNumber: z.string().optional(),
  organizationName: z.string().optional(),
  fullName: z.string().optional(),
  insulated: z.boolean().optional(),
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

// MVP default: consumers accept deliveries any day, 8am–8pm. Editable in Phase 2.
const DEFAULT_RECEIVING_WINDOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(
  day => ({ day, start: '08:00', end: '20:00' })
);

export async function registerAction(formData: FormData): Promise<AuthResult> {
  const raw = {
    email: formData.get('email'),
    password: formData.get('password'),
    role: formData.get('role'),
    phone: formData.get('phone'),
    address: formData.get('address') ?? undefined,
    businessName: formData.get('businessName') ?? undefined,
    licenseNumber: formData.get('licenseNumber') ?? undefined,
    organizationName: formData.get('organizationName') ?? undefined,
    fullName: formData.get('fullName') ?? undefined,
    insulated: formData.get('insulated') === 'on',
  };

  const parsed = RegisterSchema.safeParse(raw);
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0].message };
  }

  const { email, password, role } = parsed.data;

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    return { success: false, error: 'Please enter a valid US phone number (10 digits).' };
  }

  // Donors and consumers need a physical address for pickup/delivery
  const address = parsed.data.address?.trim() ?? '';
  if ((role === 'donor' || role === 'consumer') && !address) {
    return { success: false, error: 'Address is required for this account type.' };
  }

  const service = await createServiceClient();

  // Pre-check phone uniqueness so we fail before creating an auth user
  const { data: phoneTaken } = await service
    .from('users')
    .select('id')
    .eq('phone', phone)
    .maybeSingle();
  if (phoneTaken) {
    return { success: false, error: 'This phone number is already registered.' };
  }

  // Validate + geocode the address before creating anything
  let validatedAddress: Awaited<ReturnType<typeof validateUSAddress>> | null = null;
  if (role === 'donor' || role === 'consumer') {
    validatedAddress = await validateUSAddress(address);
    if (!validatedAddress.valid) {
      return { success: false, error: 'We could not verify that address. Please check it and try again.' };
    }
  }

  // Create the auth user via the admin API with email pre-confirmed.
  // This guarantees registration works regardless of the Supabase project's
  // email-confirmation setting; phone OTP is our verification gate.
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) {
    const msg = createError?.message ?? 'SIGNUP_FAILED';
    return {
      success: false,
      error: msg.toLowerCase().includes('already') ? 'An account with this email already exists.' : msg,
    };
  }
  const userId = created.user.id;

  // Best-effort cleanup so a failed registration doesn't orphan the email
  async function rollback() {
    try { await service.auth.admin.deleteUser(userId); } catch {}
  }

  // Update the auto-created public.users row (handle_new_auth_user trigger sets role='consumer')
  const { error: updateError } = await service
    .from('users')
    .update({ role, phone })
    .eq('id', userId);
  if (updateError) {
    await rollback();
    return { success: false, error: 'PROFILE_UPDATE_FAILED' };
  }

  // Role + phone_verified live in app_metadata: users cannot modify app_metadata,
  // so the middleware can trust it (user_metadata is user-writable — never use it for auth).
  await service.auth.admin.updateUserById(userId, {
    app_metadata: { role, phone_verified: false },
  });

  // Create the role profile row — without this, listings/dispatch/delivery all break
  let profileError: string | null = null;
  if (role === 'donor') {
    const businessName = parsed.data.businessName?.trim() || null;
    const { error } = await service.from('donor_profiles').insert({
      user_id: userId,
      type: businessName ? 'commercial' : 'residential',
      business_name: businessName,
      license_number: parsed.data.licenseNumber?.trim() || null,
      address: validatedAddress?.standardized?.deliveryLine ?? address,
      address_lat: validatedAddress?.lat ?? null,
      address_lng: validatedAddress?.lng ?? null,
    });
    if (error) profileError = error.message;
  } else if (role === 'consumer') {
    const organizationName = parsed.data.organizationName?.trim() || null;
    const { error } = await service.from('consumer_profiles').insert({
      user_id: userId,
      type: organizationName ? 'shelter' : 'household',
      organization_name: organizationName,
      delivery_address: validatedAddress?.standardized?.deliveryLine ?? address,
      delivery_lat: validatedAddress?.lat ?? null,
      delivery_lng: validatedAddress?.lng ?? null,
      receiving_window: DEFAULT_RECEIVING_WINDOW,
    });
    if (error) profileError = error.message;
  } else if (role === 'courier') {
    const { error } = await service.from('courier_profiles').insert({
      user_id: userId,
      is_available: false,
      insulated_transport_capable: parsed.data.insulated ?? false,
    });
    if (error) profileError = error.message;
  }

  if (profileError) {
    await rollback();
    return { success: false, error: 'Could not create your profile. Please try again.' };
  }

  // Establish the browser session (admin.createUser does not sign the user in)
  const supabase = await createClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
  if (signInError) {
    return { success: false, error: 'Account created but sign-in failed. Please log in.' };
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
  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    return { success: false, error: 'Invalid email or password' };
  }

  const service = await createServiceClient();
  const { data: userRow } = await service
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
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return { success: false, error: 'INVALID_PHONE_FORMAT' };
  }

  // Require an authenticated session — resend is only valid mid-registration
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  // Only allow sending to the caller's own registered phone (SMS abuse guard)
  const service = await createServiceClient();
  const { data: userRow } = await service
    .from('users')
    .select('phone')
    .eq('id', user.id)
    .single();
  if (!userRow || userRow.phone !== normalized) {
    return { success: false, error: 'PHONE_MISMATCH' };
  }

  const headerStore = await headers();
  const ip = headerStore.get('x-real-ip') ?? headerStore.get('x-forwarded-for') ?? '0.0.0.0';
  const result = await sendOTP(normalized, ip);
  return result.success
    ? { success: true }
    : { success: false, error: result.error };
}

export async function verifyOTPAction(phone: string, code: string): Promise<AuthResult> {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return { success: false, error: 'INVALID_PHONE_FORMAT' };
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
  if (!userRow || userRow.phone !== normalized) {
    return { success: false, error: 'PHONE_MISMATCH' };
  }

  const result = await verifyOTP(normalized, code);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  await Promise.all([
    service.from('users').update({ phone_verified: true }).eq('id', user.id),
    // app_metadata (not user_metadata) so the flag cannot be self-granted client-side
    service.auth.admin.updateUserById(user.id, {
      app_metadata: { role: userRow.role, phone_verified: true },
    }),
  ]);

  const role = userRow.role ?? 'consumer';
  return { success: true, redirectTo: ROLE_DASHBOARD[role] ?? '/' };
}

export async function logoutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
