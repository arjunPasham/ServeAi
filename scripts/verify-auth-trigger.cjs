// Verifies the P0 fix in 015_fix_auth_trigger.sql: creating a real auth user
// must produce a public.users mirror row (role='consumer') via the
// handle_new_auth_user trigger.
//
// Run from the repo root: node scripts/verify-auth-trigger.cjs
const { createClient } = require('@supabase/supabase-js');
const { readFileSync } = require('node:fs');

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

(async () => {
  const email = `verify-trigger-${Date.now()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: 'Verify-Trigger-1234!',
    email_confirm: true,
  });
  if (error) {
    console.error('FAIL: auth.admin.createUser errored:', error.status, error.message);
    process.exit(1);
  }

  const { data: row, error: selErr } = await admin
    .from('users')
    .select('id, email, role')
    .eq('id', data.user.id)
    .maybeSingle();

  await admin.auth.admin.deleteUser(data.user.id); // cleanup regardless of outcome

  if (selErr) {
    console.error('FAIL: could not read public.users:', selErr.message);
    process.exit(1);
  }
  if (!row) {
    console.error('FAIL: no public.users row — handle_new_auth_user trigger did not fire/insert.');
    console.error('Apply supabase/migrations/015_fix_auth_trigger.sql and re-run.');
    process.exit(1);
  }
  if (row.role !== 'consumer' || row.email !== email) {
    console.error('FAIL: mirror row has unexpected values:', JSON.stringify(row));
    process.exit(1);
  }
  console.log('PASS: trigger created public.users mirror row', JSON.stringify(row));
})();
