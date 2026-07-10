import { createServiceClient } from '@/lib/supabase/server';
import { createClient } from '@/lib/supabase/server';

// POST /api/push/subscribe
// Body: { userId: string }
// Registers the user's OneSignal external user ID so we can target them with push notifications.
// OneSignal SDK on the client calls this after the user grants push permission.

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const playerId = body?.playerId;
  // OneSignal player/subscription ids are UUIDs — reject anything else so
  // arbitrary client JSON can never land in user_metadata.
  if (
    typeof playerId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(playerId)
  ) {
    return Response.json({ error: 'playerId must be a OneSignal player id (UUID)' }, { status: 400 });
  }

  // Store the OneSignal player ID against this user for future targeted pushes.
  // We use the user metadata for simplicity; a dedicated table is fine for Phase 2.
  const service = await createServiceClient();
  await service.auth.admin.updateUserById(user.id, {
    user_metadata: {
      ...user.user_metadata,
      onesignal_player_id: playerId,
    },
  });

  return Response.json({ success: true });
}
