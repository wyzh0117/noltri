import { CORE_PRODUCT_ID, CORE_PROTOCOL_VERSION, type HealthResponse } from '@noltri/schema';

/**
 * A port answering JSON is not evidence that this product is listening. Local entry points verify the
 * health reply before forwarding a user's text.
 */

export interface CoreIdentity {
  readonly productId: string;
  readonly instanceId: string;
  readonly protocolVersion: string;
  readonly version: string;
}

export type IdentityVerdict =
  | { readonly ok: true; readonly identity: CoreIdentity; readonly restarted: boolean }
  | { readonly ok: false; readonly code: 'core_identity_mismatch' | 'protocol_mismatch'; readonly message: string };

export function verifyCoreIdentity(health: HealthResponse, knownInstanceId?: string): IdentityVerdict {
  if (health.productId !== CORE_PRODUCT_ID) {
    return { ok: false, code: 'core_identity_mismatch', message: '这个端口上运行的不是知序 Noltri Core，内容没有发送' };
  }
  if (health.protocolVersion !== CORE_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: 'protocol_mismatch',
      message: `Core 协议版本 ${String(health.protocolVersion)} 与客户端的 ${CORE_PROTOCOL_VERSION} 不一致`,
    };
  }
  return {
    ok: true,
    identity: {
      productId: health.productId,
      instanceId: health.instanceId,
      protocolVersion: health.protocolVersion,
      version: health.version,
    },
    restarted: knownInstanceId !== undefined && knownInstanceId !== health.instanceId,
  };
}
