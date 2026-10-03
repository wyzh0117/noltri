/**
 * Session cookie primitives, free of any Next.js import so the /api/web/* proxies stay unit-testable
 * with plain Node (they read cookies straight off the request).
 *
 * The cookie carries the bearer token forwarded to Knowledge Core; the browser never holds it directly.
 * Value format is `<strategy>:<token>` and the token part may be empty when the core requires no token.
 */

export const SESSION_COOKIE = 'noltri_session';
export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type SessionStrategy = 'supabase' | 'dev-token';

export interface SessionRecord {
  strategy: SessionStrategy;
  /** Bearer token for Knowledge Core. Empty string means "the core needs no token". */
  token: string;
}

export interface CookieOptions {
  httpOnly: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  secure: boolean;
  path: string;
  maxAge: number;
}

export const sessionCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
};

export function serializeSessionValue(record: SessionRecord): string {
  return `${record.strategy}:${record.token}`;
}

export function parseSessionValue(raw: string | null | undefined): SessionRecord | null {
  if (!raw) return null;
  const separator = raw.indexOf(':');
  if (separator < 0) return null;
  const strategy = raw.slice(0, separator);
  if (strategy !== 'supabase' && strategy !== 'dev-token') return null;
  return { strategy, token: raw.slice(separator + 1) };
}

export function parseCookieHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name.length === 0) continue;
    out[name] = decodeCookieValue(part.slice(separator + 1).trim());
  }
  return out;
}

export function readSessionFromCookieHeader(header: string | null): SessionRecord | null {
  return parseSessionValue(parseCookieHeader(header)[SESSION_COOKIE]);
}

export function readSessionFromRequest(request: Request): SessionRecord | null {
  return readSessionFromCookieHeader(request.headers.get('cookie'));
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const segments = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path}`, `Max-Age=${options.maxAge}`];
  if (options.httpOnly) segments.push('HttpOnly');
  if (options.sameSite !== 'lax') segments.push(`SameSite=${capitalize(options.sameSite)}`);
  if (options.secure) segments.push('Secure');
  return segments.join('; ');
}

export function serializeClearCookie(name: string, options: CookieOptions): string {
  return serializeCookie(name, '', { ...options, maxAge: 0 });
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
