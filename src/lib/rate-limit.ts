import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const DEV_MODE = !process.env.UPSTASH_REDIS_REST_URL;

let _redis: Redis | null = null;
function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return _redis;
}

let _otpPhone: Ratelimit | null = null;
let _otpIP: Ratelimit | null = null;
let _authIP: Ratelimit | null = null;
let _registerIP: Ratelimit | null = null;
let _scanUser: Ratelimit | null = null;
let _inboundView: Ratelimit | null = null;

function getOtpPhoneLimit() {
  if (!_otpPhone) _otpPhone = new Ratelimit({ redis: getRedis(), limiter: Ratelimit.slidingWindow(5, '1 h'), prefix: 'rl:otp:phone' });
  return _otpPhone;
}
function getOtpIPLimit() {
  if (!_otpIP) _otpIP = new Ratelimit({ redis: getRedis(), limiter: Ratelimit.slidingWindow(10, '1 h'), prefix: 'rl:otp:ip' });
  return _otpIP;
}
function getAuthIPLimit() {
  if (!_authIP) _authIP = new Ratelimit({ redis: getRedis(), limiter: Ratelimit.slidingWindow(5, '15 m'), prefix: 'rl:auth:ip' });
  return _authIP;
}
function getRegisterIPLimit() {
  // Registration provisions an auth user, spends a Smarty address lookup, and
  // sends an OTP — so it must be throttled per-IP BEFORE any of that work runs,
  // to stop a script rotating fresh accounts to defeat the per-user scan cap.
  if (!_registerIP) _registerIP = new Ratelimit({ redis: getRedis(), limiter: Ratelimit.slidingWindow(5, '1 h'), prefix: 'rl:register:ip' });
  return _registerIP;
}
function getScanUserLimit() {
  // Each scan spends Gemini quota; a legitimate donor lists a handful of items
  // per session, so 20/h leaves headroom while capping abuse.
  if (!_scanUser) _scanUser = new Ratelimit({ redis: getRedis(), limiter: Ratelimit.slidingWindow(20, '1 h'), prefix: 'rl:scan:user' });
  return _scanUser;
}
function getInboundViewLimit() {
  // The no-login /inbound/[token] view (Phase 2 Task 4) has no auth to lean
  // on, so it's the one public read endpoint a script could hammer to enumerate
  // tokens or scrape offers. 60/h per IP is generous for a real institution
  // reloading/re-sharing a link a few times, while still capping abuse.
  if (!_inboundView) _inboundView = new Ratelimit({ redis: getRedis(), limiter: Ratelimit.slidingWindow(60, '1 h'), prefix: 'rl:inbound:ip' });
  return _inboundView;
}

export type RateLimitResult = { allowed: boolean; retryAfter?: number };

export async function checkOtpPhoneLimit(phone: string): Promise<RateLimitResult> {
  if (DEV_MODE) { console.log('[rate-limit DEV] OTP phone check skipped:', phone); return { allowed: true }; }
  const { success, reset } = await getOtpPhoneLimit().limit(phone);
  return { allowed: success, retryAfter: success ? undefined : Math.ceil((reset - Date.now()) / 1000) };
}

export async function checkOtpIPLimit(ip: string): Promise<RateLimitResult> {
  if (DEV_MODE) { console.log('[rate-limit DEV] OTP IP check skipped:', ip); return { allowed: true }; }
  const { success, reset } = await getOtpIPLimit().limit(ip);
  return { allowed: success, retryAfter: success ? undefined : Math.ceil((reset - Date.now()) / 1000) };
}

export async function checkAuthIPLimit(ip: string): Promise<RateLimitResult> {
  if (DEV_MODE) { console.log('[rate-limit DEV] Auth IP check skipped:', ip); return { allowed: true }; }
  const { success, reset } = await getAuthIPLimit().limit(ip);
  return { allowed: success, retryAfter: success ? undefined : Math.ceil((reset - Date.now()) / 1000) };
}

export async function checkRegisterIPLimit(ip: string): Promise<RateLimitResult> {
  if (DEV_MODE) { console.log('[rate-limit DEV] Register IP check skipped:', ip); return { allowed: true }; }
  const { success, reset } = await getRegisterIPLimit().limit(ip);
  return { allowed: success, retryAfter: success ? undefined : Math.ceil((reset - Date.now()) / 1000) };
}

export async function checkScanUserLimit(userId: string): Promise<RateLimitResult> {
  if (DEV_MODE) { console.log('[rate-limit DEV] Scan user check skipped:', userId); return { allowed: true }; }
  const { success, reset } = await getScanUserLimit().limit(userId);
  return { allowed: success, retryAfter: success ? undefined : Math.ceil((reset - Date.now()) / 1000) };
}

export async function checkInboundViewLimit(ip: string): Promise<RateLimitResult> {
  if (DEV_MODE) { console.log('[rate-limit DEV] Inbound view check skipped:', ip); return { allowed: true }; }
  const { success, reset } = await getInboundViewLimit().limit(ip);
  return { allowed: success, retryAfter: success ? undefined : Math.ceil((reset - Date.now()) / 1000) };
}
