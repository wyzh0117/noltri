import { resolveAuthStrategy } from '@/lib/auth';
import { invalidRequestError, ProxyError, readJsonBody, runHandler } from '@/lib/core';
import { writeSession } from '@/lib/session';

/**
 * POST /api/web/auth/session — the browser hands the Supabase access token to the server once, after
 * the PKCE handshake. From then on only the httpOnly session cookie travels, mirroring the proxies.
 */
export async function POST(request: Request): Promise<Response> {
  return runHandler(async () => {
    if (resolveAuthStrategy() !== 'supabase') {
      throw new ProxyError(400, 'invalid_request', '当前未启用 Supabase Auth，请使用本地开发登录。');
    }
    const body = await readJsonBody(request);
    const token = typeof body === 'object' && body !== null ? String((body as Record<string, unknown>).token ?? '') : '';
    if (token.trim().length === 0) throw invalidRequestError('缺少 Supabase 访问令牌。');
    await writeSession({ strategy: 'supabase', token: token.trim() });
    return Response.json({ ok: true });
  });
}
