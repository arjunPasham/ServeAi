'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { z } from 'zod';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { sendOTP, verifyOTP } from '@/lib/twilio';
import { validateUSAddress, isSmartyDevMode } from '@/lib/smarty';
import { getDeliveryMode } from '@/lib/delivery';
import { checkAuthIPLimit, checkRegisterIPLimit } from '@/lib/rate-limit';

// Merchant provisioning is deferred to phone verification (review C1): instead
// of writing the merchants row at registration, registerAction stashes this
// payload in the auth user's server-managed app_metadata, and verifyOTPAction
// materializes the row only after the OTP succeeds.
interface PendingMerchant {
  businessName: string;
  address: string;
  addressLat: number | null;
  addressLng: number | null;
  addressValidated: boolean;
}

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
  retryAfter?: number;
};

// Single source of truth for role → dashboard routes used by all auth actions
const ROLE_DASHBOARD: Record<string, string> = {
  donor: '/merchant/dashboard',
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

  // Courier self-registration is closed: deliveries run through the delivery
  // provider (Uber Direct) unless the internal fleet is explicitly re-enabled
  // with DELIVERY_MODE=internal. Existing courier accounts stay valid.
  if (role === 'courier' && getDeliveryMode() !== 'internal') {
    return { success: false, error: 'Courier registration is closed — deliveries are handled by our delivery partner.' };
  }

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    return { success: false, error: 'Please enter a valid US phone number (10 digits).' };
  }

  // Donors and consumers need a physical address for pickup/delivery
  const address = parsed.data.address?.trim() ?? '';
  if ((role === 'donor' || role === 'consumer') && !address) {
    return { success: false, error: 'Address is required for this account type.' };
  }

  // Pivot: donor accounts are merchant accounts — a business name is required.
  const merchantBusinessName = parsed.data.businessName?.trim() ?? '';
  if (role === 'donor' && !merchantBusinessName) {
    return { success: false, error: 'Business name is required for merchant accounts.' };
  }

  // Throttle by IP BEFORE any write, Smarty lookup, or OTP send. Dev mode (no
  // Upstash) stays permissive — the 0.1-established posture; prod fails closed
  // on missing keys, so the limiter is guaranteed real there.
  const headerStore = await headers();
  const ip = headerStore.get('x-real-ip') ?? headerStore.get('x-forwarded-for') ?? '0.0.0.0';
  const registerCheck = await checkRegisterIPLimit(ip);
  if (!registerCheck.allowed) {
    return {
      success: false,
      error: 'Too many registration attempts. Please try again later.',
      retryAfter: registerCheck.retryAfter,
    };
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

  // Merchant accounts (role='donor') are NOT provisioned here (review C1): the
  // merchants row is created by verifyOTPAction only after the OTP succeeds.
  // Stash the provisioning payload in app_metadata so the OTP step can
  // materialize it — app_metadata is server-managed and carries the same trust
  // level the middleware relies on.
  const pendingMerchant: PendingMerchant | null =
    role === 'donor'
      ? {
          businessName: merchantBusinessName,
          address: validatedAddress?.standardized?.deliveryLine ?? address,
          addressLat: validatedAddress?.lat ?? null,
          addressLng: validatedAddress?.lng ?? null,
          // Only a real validator counts — dev-mode synthetic coords must never
          // be treated as a validated address downstream.
          addressValidated: validatedAddress?.valid === true && !isSmartyDevMode(),
        }
      : null;

  // Role + phone_verified live in app_metadata: users cannot modify app_metadata,
  // so the middleware can trust it (user_metadata is user-writable — never use it for auth).
  // Checked: if this write fails the stash is lost, which would strand the user
  // as verified-with-no-merchant later — so roll back rather than continue.
  const { error: metaError } = await service.auth.admin.updateUserById(userId, {
    app_metadata: {
      role,
      phone_verified: false,
      ...(pendingMerchant ? { pending_merchant: pendingMerchant } : {}),
    },
  });
  if (metaError) {
    await rollback();
    return { success: false, error: 'PROFILE_UPDATE_FAILED' };
  }

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
      // Only a real validator counts — dev-mode synthetic coords must never
      // be handed to a delivery provider (delivery is gated on this flag)
      address_validated: validatedAddress?.valid === true && !isSmartyDevMode(),
    });
    if (error) profileError = error.message;
    // The merchants row is intentionally NOT created here — verifyOTPAction
    // materializes it from app_metadata.pending_merchant after OTP success.
  } else if (role === 'consumer') {
    const organizationName = parsed.data.organizationName?.trim() || null;
    const { error } = await service.from('consumer_profiles').insert({
      user_id: userId,
      type: organizationName ? 'shelter' : 'household',
      organization_name: organizationName,
      delivery_address: validatedAddress?.standardized?.deliveryLine ?? address,
      delivery_lat: validatedAddress?.lat ?? null,
      delivery_lng: validatedAddress?.lng ?? null,
      address_validated: validatedAddress?.valid === true && !isSmartyDevMode(),
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

  // Rate-limit BEFORE attempting sign-in. Checking only after a failure (the
  // previous version) throttled the error message while letting the actual
  // password-guessing calls through unbounded.
  const authCheck = await checkAuthIPLimit(ip);
  if (!authCheck.allowed) {
    return {
      success: false,
      error: 'Too many login attempts. Please try again later.',
      retryAfter: authCheck.retryAfter,
    };
  }

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

  const role = userRow.role ?? 'consumer';

  // Materialize the merchants row from the registration stash BEFORE marking
  // the account verified. If provisioning fails we return PROVISIONING_FAILED
  // WITHOUT setting phone_verified, so the account stays unverified and the
  // user simply re-verifies (loginAction routes unverified users back to
  // /verify-phone; Twilio Verify allows a fresh code). That is strictly safer
  // than marking verified first, which would leave a verified merchant with no
  // merchants row and no working retry path. The upsert is idempotent
  // (ON CONFLICT (user_id) DO NOTHING), so a retry after a partial failure —
  // or a stale stash — resolves to success.
  const pendingMerchant = user.app_metadata?.pending_merchant as PendingMerchant | undefined;
  if (pendingMerchant) {
    const { error: merchantError } = await service
      .from('merchants')
      .upsert(
        {
          user_id: user.id,
          business_name: pendingMerchant.businessName,
          address: pendingMerchant.address,
          address_lat: pendingMerchant.addressLat,
          address_lng: pendingMerchant.addressLng,
          address_validated: pendingMerchant.addressValidated,
        },
        { onConflict: 'user_id', ignoreDuplicates: true },
      );
    if (merchantError) {
      console.error('[verifyOTP] merchant provisioning failed:', {
        userId: user.id,
        error: merchantError.message,
      });
      return { success: false, error: 'PROVISIONING_FAILED' };
    }
  }

  // Persist verification and clear the stash. Written SEQUENTIALLY with
  // app_metadata first (the auth source of truth the middleware trusts) then the
  // users column (loginAction's routing gate): if either fails we return
  // VERIFY_PERSIST_FAILED rather than silently claiming success on a spent OTP.
  // Ordering matters — loginAction gates on users.phone_verified, so a failure
  // there still routes the user back to /verify-phone to retry, never into a
  // dashboard redirect loop. app_metadata (not user_metadata) so the flag
  // cannot be self-granted client-side.
  const { error: metaError } = await service.auth.admin.updateUserById(user.id, {
    app_metadata: { role, phone_verified: true, pending_merchant: null },
  });
  if (metaError) {
    console.error('[verifyOTP] app_metadata verification write failed:', {
      userId: user.id,
      error: metaError.message,
    });
    return { success: false, error: 'VERIFY_PERSIST_FAILED' };
  }

  const { error: usersError } = await service
    .from('users')
    .update({ phone_verified: true })
    .eq('id', user.id);
  if (usersError) {
    console.error('[verifyOTP] users.phone_verified write failed:', {
      userId: user.id,
      error: usersError.message,
    });
    return { success: false, error: 'VERIFY_PERSIST_FAILED' };
  }

  return { success: true, redirectTo: ROLE_DASHBOARD[role] ?? '/' };
}

export async function logoutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
