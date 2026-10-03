import { ApiClient, ApiClientError } from '@noltri/api-client';
import { resolveAuthStrategy } from '@/lib/auth';
import { coreBaseUrl, ProxyError, readJsonBody, runHandler } from '@/lib/core';
import { clearSession, writeSession } from '@/lib/session';

/**
 * POST /api/web/auth/dev-token — local development login, only when Supabase Auth is not configured.
 * The token is probed against the core's /api/health before it is stored, so a typo fails loudly here
 * instead of looking like a broken knowledge service later. An empty token is accepted when the core
 * requires none (NOLTRI_DEV_REQUIRE_TOKEN=false).
 */
export async function POST(request: Request): Promise<Response> {
  return runHandler(async () => {
    if (resolveAuthStrategy() !== 'dev-token') {
      throw new ProxyError(400, 'invalid_request', '已启用 Supabase Auth，本地开发登录不可用。');
    }
    const body = await readJsonBody(request);
    const token = typeof body === 'object' && body !== null ? String((body as Record<string, unknown>).token ?? '').trim() : '';

    try {
      const probe = new ApiClient({
        baseUrl: coreBaseUrl(),
        token: token.length > 0 ? token : undefined,
        timeoutMs: 8_000,
      });
      await probe.health();
    } catch (error) {
      if (error instanceof ApiClientError && (error.code === 'unauthorized' || error.status === 401)) {
        throw new ProxyError(401, 'unauthorized', '令牌被知识服务拒绝，请确认 NOLTRI_DEV_TOKEN 是否一致。');
      }
      if (error instanceof ApiClientError && error.status === 0) {
        // Keep local login usable while the core is offline; the connection pill reports the real state.
        return Response.json({ ok: true, warning: '知识服务当前不可达，登录已保存但暂时无法加载数据。' });
      }
      throw new ProxyError(502, 'internal_error', '无法验证与知识服务的连接。');
    }

    await writeSession({ strategy: 'dev-token', token });
    return Response.json({ ok: true });
  });
}
