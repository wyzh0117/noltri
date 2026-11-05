/** Preparation only. No transport, trust anchor, verifier or native installer is configured by default. */
export interface UpdateTarget {
  platform: 'darwin' | 'windows' | 'linux';
  architecture: 'aarch64' | 'x86_64';
}

export interface UpdateMetadata extends UpdateTarget {
  /** Stable x.y.z only; prereleases and build labels are rejected. */
  version: string;
  artifactUrl: string;
  sha256: string;
  size: number;
  signature: { algorithm: 'Ed25519'; keyId: string; hex: string };
}

/** Supplied from separately provisioned, pinned configuration; never from release metadata. */
export interface ProvisionedUpdateKey {
  algorithm: 'Ed25519';
  keyId: string;
  publicKey: Uint8Array;
}

export interface SignatureVerificationInput {
  key: ProvisionedUpdateKey;
  message: Uint8Array;
  signature: Uint8Array;
}

export interface UpdateDownloadRequest {
  url: string;
  maxBytes: number;
  signal: AbortSignal;
  redirect: 'error';
  credentials: 'omit';
}

export interface UpdatePreparationDependencies {
  /** Must honor the signal and request constraints; no network implementation is supplied here. */
  transport?: (request: UpdateDownloadRequest) => AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>;
  trustedKey?: ProvisionedUpdateKey;
  /** A callback that simply returns true is protocol test evidence, not production authenticity. */
  verifySignature?: (input: SignatureVerificationInput) => Promise<boolean>;
  /** Optional stricter local limit, at most the 256 MiB hard limit. */
  maxArtifactBytes?: number;
}

export type UpdatePreparationCode =
  | 'invalid_metadata' | 'invalid_current_version' | 'invalid_policy'
  | 'unsupported_target' | 'not_newer' | 'artifact_too_large'
  | 'signature_missing' | 'unsupported_signature' | 'trust_unavailable'
  | 'untrusted_key' | 'verifier_unavailable' | 'transport_unavailable' | 'verification_unsupported'
  | 'cancelled' | 'download_failed' | 'download_too_large' | 'size_mismatch'
  | 'hash_mismatch' | 'hash_failed' | 'signature_invalid';

type PreparationBase = { installedVersion: string; nativeInstaller: 'unsupported' };
export type UpdatePreparationResult = PreparationBase & (
  | { status: 'blocked' | 'failed'; code: UpdatePreparationCode }
  | { status: 'prepared'; metadata: UpdateMetadata; bytes: Uint8Array }
);

const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const HEX_SHA256 = /^[a-fA-F0-9]{64}$/;
const HEX_SIGNATURE = /^[a-fA-F0-9]{128}$/;

function stableVersion(value: unknown): number[] | null {
  if (typeof value !== 'string' || value.length > 32 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every((part) => Number.isSafeInteger(part)) ? parts : null;
}

function supportedTarget(value: { platform: unknown; architecture: unknown }): value is UpdateTarget {
  return ['darwin', 'windows', 'linux'].includes(value.platform as string)
    && ['aarch64', 'x86_64'].includes(value.architecture as string);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateMetadata(value: unknown): UpdateMetadata | UpdatePreparationCode {
  try {
    if (!record(value)) return 'invalid_metadata';
    const { version, platform, architecture, artifactUrl, sha256, size, signature } = value;
    if (!stableVersion(version)
      || typeof artifactUrl !== 'string' || artifactUrl.length > 2048 || artifactUrl.trim() !== artifactUrl
      || typeof sha256 !== 'string' || !HEX_SHA256.test(sha256)
      || typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ARTIFACT_BYTES) return 'invalid_metadata';
    const url = new URL(artifactUrl);
    // Check original authority too: URL removes empty userinfo during normalization.
    if (!/^https:\/\//i.test(artifactUrl) || /^https:\/\/[^/?#]*@/i.test(artifactUrl)
      || url.protocol !== 'https:' || url.username || url.password || url.hash) return 'invalid_metadata';
    const target = { platform, architecture };
    if (!supportedTarget(target)) return 'unsupported_target';
    if (signature === undefined || signature === null) return 'signature_missing';
    if (!record(signature)) return 'invalid_metadata';
    if (signature.algorithm !== 'Ed25519') return 'unsupported_signature';
    if (typeof signature.keyId !== 'string' || !KEY_ID.test(signature.keyId)
      || typeof signature.hex !== 'string' || !HEX_SIGNATURE.test(signature.hex)) return 'invalid_metadata';
    return {
      version: version as string, ...target, artifactUrl: url.href, sha256: sha256.toLowerCase(), size,
      signature: { algorithm: 'Ed25519', keyId: signature.keyId, hex: signature.hex.toLowerCase() },
    };
  } catch { return 'invalid_metadata'; }
}

/** UTF-8 JSON array, normalized by validation, domain-separated and bound to release identity + actual-byte digest. */
export function updateSignaturePayload(metadata: UpdateMetadata): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([
    'noltri-update-v1', metadata.version, metadata.platform, metadata.architecture,
    metadata.artifactUrl, metadata.sha256, metadata.size, metadata.signature.algorithm, metadata.signature.keyId,
  ]));
}

export class UpdateVerificationUnsupportedError extends Error {
  constructor() { super('Web Crypto SHA-256/Ed25519 verification is unavailable; preparation remains blocked.'); }
}

/** Real platform cryptography; still requires a separately provisioned public key. No key is generated or persisted. */
export async function verifyEd25519Signature(input: SignatureVerificationInput): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new UpdateVerificationUnsupportedError();
  if (input.key.algorithm !== 'Ed25519' || input.key.publicKey.byteLength !== 32 || input.signature.byteLength !== 64) return false;
  try {
    const key = await subtle.importKey('raw', input.key.publicKey.slice().buffer, 'Ed25519', false, ['verify']);
    return await subtle.verify('Ed25519', key, input.signature.slice().buffer, input.message.slice().buffer);
  } catch (error) {
    if (error instanceof Error && error.name === 'NotSupportedError') throw new UpdateVerificationUnsupportedError();
    return false;
  }
}

/**
 * Downloads and verifies into memory only. Every result retains the input installed version.
 * Prepared bytes are not an installed update; native installation is unsupported and needs separate review.
 */
export async function prepareUpdate(
  input: { currentVersion: string; target: UpdateTarget; metadata: unknown; signal?: AbortSignal },
  deps: UpdatePreparationDependencies,
): Promise<UpdatePreparationResult> {
  const base: PreparationBase = { installedVersion: input.currentVersion, nativeInstaller: 'unsupported' };
  const blocked = (code: UpdatePreparationCode): UpdatePreparationResult => ({ ...base, status: 'blocked', code });
  const failed = (code: UpdatePreparationCode): UpdatePreparationResult => ({ ...base, status: 'failed', code });
  const current = stableVersion(input.currentVersion);
  if (!current) return blocked('invalid_current_version');
  const maxBytes = deps.maxArtifactBytes ?? MAX_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ARTIFACT_BYTES) return blocked('invalid_policy');
  const metadata = validateMetadata(input.metadata);
  if (typeof metadata === 'string') return blocked(metadata);
  if (!supportedTarget(input.target) || metadata.platform !== input.target.platform || metadata.architecture !== input.target.architecture) return blocked('unsupported_target');
  const next = stableVersion(metadata.version)!;
  const difference = next.map((part, index) => part - current[index]).find((part) => part !== 0) ?? 0;
  if (difference <= 0) return blocked('not_newer');
  if (metadata.size > maxBytes) return blocked('artifact_too_large');
  const trustedKey = deps.trustedKey;
  if (!trustedKey) return blocked('trust_unavailable');
  if (trustedKey.algorithm !== 'Ed25519' || trustedKey.keyId !== metadata.signature.keyId
    || !(trustedKey.publicKey instanceof Uint8Array) || trustedKey.publicKey.byteLength !== 32) return blocked('untrusted_key');
  const key: ProvisionedUpdateKey = { algorithm: 'Ed25519', keyId: trustedKey.keyId, publicKey: trustedKey.publicKey.slice() };
  const verifySignature = deps.verifySignature;
  if (typeof verifySignature !== 'function') return blocked('verifier_unavailable');
  const transport = deps.transport;
  if (typeof transport !== 'function') return blocked('transport_unavailable');
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return blocked('verification_unsupported');
  if (input.signal?.aborted) return failed('cancelled');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  input.signal?.addEventListener('abort', cancel, { once: true });
  try {
    let bytes: Uint8Array<ArrayBuffer>;
    let length = 0;
    try {
      bytes = new Uint8Array(metadata.size);
      const stream = await transport({ url: metadata.artifactUrl, maxBytes: metadata.size, signal: controller.signal, redirect: 'error', credentials: 'omit' });
      for await (const chunk of stream) {
        if (controller.signal.aborted) return failed('cancelled');
        // Reject empty chunks so an unbounded sequence cannot evade the byte budget.
        if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) throw new Error('Invalid update chunk');
        if (chunk.byteLength > metadata.size - length) {
          controller.abort();
          return failed('download_too_large');
        }
        bytes.set(chunk, length);
        length += chunk.byteLength;
      }
    } catch {
      const cancelled = controller.signal.aborted;
      controller.abort();
      return failed(cancelled ? 'cancelled' : 'download_failed');
    }
    if (controller.signal.aborted) return failed('cancelled');
    if (length !== metadata.size) return failed('size_mismatch');
    let digest: ArrayBuffer;
    try { digest = await subtle.digest('SHA-256', bytes.buffer); } catch { return failed('hash_failed'); }
    if (controller.signal.aborted) return failed('cancelled');
    const actualHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (actualHash !== metadata.sha256) return failed('hash_mismatch');
    try {
      const signature = Uint8Array.from(metadata.signature.hex.match(/../g)!, (hex) => parseInt(hex, 16));
      if (await verifySignature({ key, signature, message: updateSignaturePayload(metadata) }) !== true) return failed('signature_invalid');
    } catch (error) {
      return error instanceof UpdateVerificationUnsupportedError ? blocked('verification_unsupported') : failed('signature_invalid');
    }
    if (controller.signal.aborted) return failed('cancelled');
    return { ...base, status: 'prepared', metadata, bytes };
  } finally {
    input.signal?.removeEventListener('abort', cancel);
  }
}
