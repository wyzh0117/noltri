import { proxyCore } from '@/lib/core';

/** GET /api/web/health → Knowledge Core GET /api/health, for the connection state in the top bar. */
export async function GET(request: Request): Promise<Response> {
  return proxyCore(request, ({ client }) => client.health());
}
