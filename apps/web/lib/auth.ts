/**
 * Auth strategies, selected by environment and never guessed at runtime.
 *
 * - `supabase`: NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY are present. Email sign-in and
 *   Google/GitHub providers run through Supabase Auth with the PKCE flow; the resulting access token
 *   becomes the Knowledge Core bearer via /api/web/auth/session.
 * - `dev-token`: those variables are absent. A clearly labelled local card accepts NOLTRI_DEV_TOKEN
 *   (or nothing, when the core requires no token) and stores it in an httpOnly cookie, while the UI
 *   keeps showing "当前为本地开发登录，未接入 Supabase Auth" so it can never be mistaken for real auth.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { SessionStrategy } from './cookie';

export type AuthStrategy = SessionStrategy;
export type OAuthProvider = 'google' | 'github';

export interface AuthEnv {
  NEXT_PUBLIC_SUPABASE_URL?: string | undefined;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string | undefined;
}

export function resolveAuthStrategy(env: AuthEnv | NodeJS.ProcessEnv = process.env): AuthStrategy {
  const url = readEnv(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = readEnv(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  return url !== null && anonKey !== null ? 'supabase' : 'dev-token';
}

export function supabasePublicConfig(env: AuthEnv | NodeJS.ProcessEnv = process.env): { url: string; anonKey: string } | null {
  const url = readEnv(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = readEnv(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (url === null || anonKey === null) return null;
  return { url, anonKey };
}

let browserClient: SupabaseClient | null = null;

/** Browser-side Supabase client. Returns null outside the strategy's environment so UI can fall back. */
export function getSupabaseClient(): SupabaseClient | null {
  if (typeof window === 'undefined') return null;
  const config = supabasePublicConfig();
  if (!config) return null;
  browserClient ??= createClient(config.url, config.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, flowType: 'pkce' },
  });
  return browserClient;
}

export interface AuthActionOutcome {
  error: string | null;
}

export async function signInWithEmail(email: string, password: string): Promise<AuthActionOutcome> {
  const client = getSupabaseClient();
  if (!client) return { error: 'Supabase Auth 未配置，请使用本地开发登录。' };
  const { error } = await client.auth.signInWithPassword({ email, password });
  return { error: error ? error.message : null };
}

export async function startOAuthSignIn(provider: OAuthProvider): Promise<AuthActionOutcome> {
  const client = getSupabaseClient();
  if (!client) return { error: 'Supabase Auth 未配置，请使用本地开发登录。' };
  const { error } = await client.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${window.location.origin}/auth/callback?provider=${provider}` },
  });
  return { error: error ? error.message : null };
}

/** Finish the PKCE handshake on the redirect back from Supabase and return the access token. */
export async function completeOAuthCallback(code: string): Promise<{ token: string | null; error: string | null }> {
  const client = getSupabaseClient();
  if (!client) return { token: null, error: 'Supabase Auth 未配置。' };
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  if (error) return { token: null, error: error.message };
  const token = data.session?.access_token ?? null;
  return { token, error: token ? null : 'Supabase 未返回会话。' };
}

export async function readAccessToken(): Promise<string | null> {
  const client = getSupabaseClient();
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Push the Supabase access token to the server so it becomes the session cookie. */
export async function publishServerSession(token: string): Promise<AuthActionOutcome> {
  const response = await fetch('/api/web/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) return { error: `无法建立服务端会话（${response.status}）。` };
  return { error: null };
}

export async function clearServerSession(): Promise<AuthActionOutcome> {
  const response = await fetch('/api/web/auth/logout', { method: 'POST' });
  const client = getSupabaseClient();
  if (client) await client.auth.signOut();
  return { error: response.ok ? null : `退出失败（${response.status}）。` };
}

function readEnv(env: AuthEnv | NodeJS.ProcessEnv, key: 'NEXT_PUBLIC_SUPABASE_URL' | 'NEXT_PUBLIC_SUPABASE_ANON_KEY'): string | null {
  const value = (env as Record<string, string | undefined>)[key];
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}
