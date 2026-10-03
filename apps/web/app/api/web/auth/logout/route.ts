import { runHandler } from '@/lib/core';
import { clearSession } from '@/lib/session';

/** POST /api/web/auth/logout — drop the session cookie; the browser client signs out of Supabase too. */
export async function POST(): Promise<Response> {
  return runHandler(async () => {
    await clearSession();
    return Response.json({ ok: true });
  });
}
