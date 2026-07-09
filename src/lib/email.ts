import { createServiceClient } from '@/lib/supabase/server';

const DEV_MODE = !process.env.RESEND_API_KEY;

export async function sendEmail(params: {
  to: string;
  subject: string;
  text: string;
}): Promise<{ sent: boolean }> {
  if (DEV_MODE) {
    console.log(`[DEV] Email to ${params.to}: ${params.subject} — ${params.text}`);
    return { sent: true };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM ?? 'FoodLink <onboarding@resend.dev>',
        to: params.to,
        subject: params.subject,
        text: params.text,
      }),
    });

    if (!res.ok) {
      console.error(`[email] Resend API error: ${res.status} ${await res.text()}`);
      return { sent: false };
    }

    return { sent: true };
  } catch (err) {
    console.error('[email] send failed:', err);
    return { sent: false };
  }
}

export async function getUserEmail(userId: string): Promise<string | null> {
  try {
    const supabase = await createServiceClient();
    const { data } = await supabase
      .from('users')
      .select('email')
      .eq('id', userId)
      .single();
    return data?.email ?? null;
  } catch (err) {
    console.error('[email] getUserEmail failed:', err);
    return null;
  }
}
