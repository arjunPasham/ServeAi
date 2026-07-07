import { checkOtpPhoneLimit, checkOtpIPLimit } from '@/lib/rate-limit';

// DEV BYPASS: when TWILIO_VERIFY_SERVICE_SID is not set, OTP is skipped.
// In dev mode the code "000000" always passes. Wire in real Twilio before launch.
const DEV_MODE = !process.env.TWILIO_VERIFY_SERVICE_SID;

// Module-level singleton avoids rebuilding the Twilio client on every call
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _twilioClient: any = null;
async function getTwilioClient() {
  if (!_twilioClient) {
    const twilio = (await import('twilio')).default;
    _twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
  }
  return _twilioClient;
}

export async function sendOTP(phone: string, ip: string): Promise<{ success: boolean; error?: string }> {
  const phoneCheck = await checkOtpPhoneLimit(phone);
  if (!phoneCheck.allowed) return { success: false, error: 'TOO_MANY_REQUESTS_PHONE' };
  const ipCheck = await checkOtpIPLimit(ip);
  if (!ipCheck.allowed) return { success: false, error: 'TOO_MANY_REQUESTS_IP' };

  if (DEV_MODE) {
    console.log(`[DEV] OTP bypass active — use code 000000 for ${phone}`);
    return { success: true };
  }

  const client = await getTwilioClient();
  try {
    await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID!)
      .verifications.create({ to: phone, channel: 'sms' });
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'TWILIO_ERROR';
    return { success: false, error: message };
  }
}

export async function verifyOTP(phone: string, code: string): Promise<{ success: boolean; error?: string }> {
  if (DEV_MODE) {
    return code === '000000'
      ? { success: true }
      : { success: false, error: 'INVALID_CODE' };
  }

  const client = await getTwilioClient();
  try {
    const result = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID!)
      .verificationChecks.create({ to: phone, code });

    return result.status === 'approved'
      ? { success: true }
      : { success: false, error: 'INVALID_CODE' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'TWILIO_ERROR';
    return { success: false, error: message };
  }
}
