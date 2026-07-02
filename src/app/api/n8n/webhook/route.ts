import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get('x-n8n-signature');
  const secret = process.env.N8N_WEBHOOK_SECRET;

  if (!sig || !secret) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 401 });
  }

  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')}`;

  if (sig !== expected) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Route by event type in body
  let body: { event?: string } = {};
  try { body = JSON.parse(rawBody); } catch { /* non-JSON payloads are ignored */ }

  // Placeholder: future n8n callback events will be routed here
  return NextResponse.json({ ok: true, event: body.event ?? null });
}
