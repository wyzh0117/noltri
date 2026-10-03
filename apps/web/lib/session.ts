/**
 * Session cookie read/write for server code (pages, login, auth routes) through `next/headers`,
 * with no extra dependencies. Proxy route handlers deliberately do not use these: they read the
 * cookie straight off the request (lib/cookie.ts) so they can be unit-tested outside Next.js.
 */

import { cookies } from 'next/headers';
import {
  SESSION_COOKIE,
  parseSessionValue,
  serializeSessionValue,
  sessionCookieOptions,
  type SessionRecord,
} from './cookie';

export { SESSION_COOKIE, parseSessionValue, serializeSessionValue, sessionCookieOptions };
export type { SessionRecord, SessionStrategy } from './cookie';

export async function readSession(): Promise<SessionRecord | null> {
  const store = await cookies();
  return parseSessionValue(store.get(SESSION_COOKIE)?.value);
}

/** True only when a session cookie exists; an empty token is valid (core requires no token). */
export async function hasSession(): Promise<boolean> {
  return (await readSession()) !== null;
}

export async function writeSession(record: SessionRecord): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, serializeSessionValue(record), sessionCookieOptions);
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
