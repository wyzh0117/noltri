import { describe, expect, it, vi } from 'vitest';
import {
  prepareUpdate,
  updateSignaturePayload,
  verifyEd25519Signature,
} from './update-policy';
import type { SignatureVerificationInput, UpdateMetadata, UpdatePreparationDependencies } from './update-policy';

const abc = new Uint8Array([97, 98, 99]);
const sha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const signatureHex = 'ab'.repeat(64);
const publicKey = new Uint8Array(32).fill(7);
const target = { platform: 'darwin', architecture: 'aarch64' } as const;
const currentVersion = '1.2.3';

function metadata(): UpdateMetadata {
  return {
    version: '1.3.0', ...target,
    artifactUrl: 'https://updates.example.invalid/noltri.bin',
    sha256, size: 3,
    signature: { algorithm: 'Ed25519', keyId: 'provisioned-test-key', hex: signatureHex },
  };
}

// This fixture checks the verifier protocol only. Returning true is not production authenticity.
function dependencies(overrides: Partial<UpdatePreparationDependencies> = {}) {
  return {
    transport: vi.fn(async function* () { yield abc.slice(); }),
    trustedKey: { algorithm: 'Ed25519' as const, keyId: 'provisioned-test-key', publicKey: publicKey.slice() },
    verifySignature: vi.fn(async (input: SignatureVerificationInput) => (
      input.key.keyId === 'provisioned-test-key'
      && input.key.algorithm === 'Ed25519'
      && input.key.publicKey.every((value) => value === 7)
      && input.signature.every((value) => value === 0xab)
      && new TextDecoder().decode(input.message) === '["noltri-update-v1","1.3.0","darwin","aarch64","https://updates.example.invalid/noltri.bin","ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",3,"Ed25519","provisioned-test-key"]'
    )),
    ...overrides,
  };
}

function prepare(value: unknown = metadata(), deps = dependencies(), signal?: AbortSignal) {
  return prepareUpdate({ currentVersion, target, metadata: value, signal }, deps);
}

function unchanged(result: Awaited<ReturnType<typeof prepareUpdate>>) {
  expect(result.installedVersion).toBe(currentVersion);
  expect(result.nativeInstaller).toBe('unsupported');
}

describe('fail-closed update preparation', () => {
  it.each([
    null, [], {},
    { ...metadata(), version: '1.3.0-beta.1' },
    { ...metadata(), version: '01.3.0' },
    { ...metadata(), version: '9007199254740992.0.0' },
    { ...metadata(), artifactUrl: 'http://updates.example.invalid/a' },
    { ...metadata(), artifactUrl: 'https://user:secret@updates.example.invalid/a' },
    { ...metadata(), artifactUrl: 'https://updates.example.invalid/a#fragment' },
    { ...metadata(), artifactUrl: `https://updates.example.invalid/${'x'.repeat(2048)}` },
    { ...metadata(), sha256: 'not-a-digest' },
    { ...metadata(), size: 0 },
    { ...metadata(), size: -1 },
    { ...metadata(), size: 1.5 },
    { ...metadata(), size: Number.MAX_SAFE_INTEGER },
    { ...metadata(), signature: { ...metadata().signature, hex: 'aa' } },
    { ...metadata(), signature: { ...metadata().signature, keyId: 'x'.repeat(65) } },
  ])('rejects malformed or unbounded metadata before download (%#)', async (value) => {
    const deps = dependencies();
    const result = await prepare(value, deps);
    expect(result).toMatchObject({ status: 'blocked', code: 'invalid_metadata' });
    unchanged(result);
    expect(deps.transport).not.toHaveBeenCalled();
  });

  it.each([
    'https://@updates.example.invalid/noltri.bin',
    'https://:@updates.example.invalid/noltri.bin',
    'https:updates.example.invalid/noltri.bin',
  ])('rejects empty userinfo or ambiguous HTTPS syntax before transport (%s)', async (artifactUrl) => {
    const deps = dependencies();
    const result = await prepare({ ...metadata(), artifactUrl }, deps);
    expect(result).toMatchObject({ status: 'blocked', code: 'invalid_metadata' });
    expect(deps.transport).not.toHaveBeenCalled();
  });

  it.each(['1.2.3', '1.2.2', '0.99.99'])('blocks equal or older version %s before download', async (version) => {
    const deps = dependencies();
    const result = await prepare({ ...metadata(), version }, deps);
    expect(result).toMatchObject({ status: 'blocked', code: 'not_newer' });
    unchanged(result);
    expect(deps.transport).not.toHaveBeenCalled();
  });

  it('compares stable versions numerically and rejects a malformed installed version', async () => {
    const deps = dependencies({ verifySignature: vi.fn(async () => true) });
    const newer = await prepare({ ...metadata(), version: '1.10.0' }, deps);
    expect(newer.status).toBe('prepared');
    const malformed = await prepareUpdate({ currentVersion: 'v1.2.3', target, metadata: metadata() }, deps);
    expect(malformed).toMatchObject({ status: 'blocked', code: 'invalid_current_version', installedVersion: 'v1.2.3' });
    expect(deps.transport).toHaveBeenCalledOnce();
  });

  it.each([
    { ...metadata(), platform: 'android' },
    { ...metadata(), platform: 'windows' },
    { ...metadata(), architecture: 'x86_64' },
    { ...metadata(), architecture: 'mips' },
  ])('blocks unsupported or mismatched target before download (%#)', async (value) => {
    const deps = dependencies();
    const result = await prepare(value, deps);
    expect(result).toMatchObject({ status: 'blocked', code: 'unsupported_target' });
    expect(deps.transport).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...metadata(), signature: undefined }, {}, 'signature_missing'],
    [{ ...metadata(), signature: { ...metadata().signature, algorithm: 'unsignedGitHubRelease' } }, {}, 'unsupported_signature'],
    [metadata(), { trustedKey: undefined }, 'trust_unavailable'],
    [metadata(), { verifySignature: undefined }, 'verifier_unavailable'],
    [metadata(), { trustedKey: { keyId: 'manifest-key', algorithm: 'Ed25519', publicKey } }, 'untrusted_key'],
    [metadata(), { trustedKey: { keyId: 'provisioned-test-key', algorithm: 'Ed25519', publicKey: new Uint8Array(1) } }, 'untrusted_key'],
  ])('does not mistake a hash or manifest key for authenticity (%#)', async (value, overrides, code) => {
    const deps = dependencies(overrides as Partial<UpdatePreparationDependencies>);
    const result = await prepare({ ...value, publicKey: [...publicKey] }, deps);
    expect(result).toMatchObject({ status: 'blocked', code });
    unchanged(result);
    expect(deps.transport).not.toHaveBeenCalled();
  });

  it('rejects artifact size above the configured byte budget before transport', async () => {
    const deps = dependencies({ maxArtifactBytes: 2 });
    const result = await prepare(metadata(), deps);
    expect(result).toMatchObject({ status: 'blocked', code: 'artifact_too_large' });
    expect(deps.transport).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])('fails closed for invalid local byte budget %s', async (maxArtifactBytes) => {
    const deps = dependencies({ maxArtifactBytes });
    expect(await prepare(metadata(), deps)).toMatchObject({ status: 'blocked', code: 'invalid_policy' });
    expect(deps.transport).not.toHaveBeenCalled();
  });

  it.each([
    [new Uint8Array([97, 98]), 'size_mismatch'],
    [new Uint8Array([97, 98, 100]), 'hash_mismatch'],
  ] as const)('checks actual bytes independently of the transport and manifest (%#)', async (bytes, code) => {
    const deps = dependencies({ transport: vi.fn(async function* () { yield bytes; }) });
    const result = await prepare(metadata(), deps);
    expect(result).toMatchObject({ status: 'failed', code });
    unchanged(result);
    expect(deps.verifySignature).not.toHaveBeenCalled();
  });

  it('stops an oversized stream, closes it and aborts transport without verification', async () => {
    let closed = false;
    let reads = 0;
    let signal: AbortSignal | undefined;
    const deps = dependencies({ transport: vi.fn(async function* (request) {
      signal = request.signal;
      try {
        reads++;
        yield new Uint8Array([97, 98, 99, 100]);
        reads++;
        yield abc;
      } finally { closed = true; }
    }) });
    const result = await prepare(metadata(), deps);
    expect(result).toMatchObject({ status: 'failed', code: 'download_too_large' });
    unchanged(result);
    expect({ closed, reads, aborted: signal?.aborted }).toEqual({ closed: true, reads: 1, aborted: true });
    expect(deps.verifySignature).not.toHaveBeenCalled();
  });

  it('reports interrupted transport and preserves the installed version', async () => {
    const deps = dependencies({ transport: vi.fn(async function* () { yield abc.subarray(0, 1); throw new Error('synthetic interruption'); }) });
    const result = await prepare(metadata(), deps);
    expect(result).toMatchObject({ status: 'failed', code: 'download_failed' });
    unchanged(result);
    expect(deps.verifySignature).not.toHaveBeenCalled();
  });

  it('supports cancellation before and during download without exposing partial bytes', async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const deps = dependencies();
    expect(await prepare(metadata(), deps, preAborted.signal)).toMatchObject({ status: 'failed', code: 'cancelled' });
    expect(deps.transport).not.toHaveBeenCalled();
    const controller = new AbortController();
    const during = dependencies({ transport: vi.fn(async function* () { yield abc.subarray(0, 1); controller.abort(); yield abc.subarray(1); }) });
    const result = await prepare(metadata(), during, controller.signal);
    expect(result).toMatchObject({ status: 'failed', code: 'cancelled' });
    unchanged(result);
    expect(result).not.toHaveProperty('bytes');
  });

  it.each([false, 'truthy', new Error('synthetic verifier failure')])('fails closed for false, non-boolean or throwing verifier (%#)', async (value) => {
    const deps = dependencies({ verifySignature: vi.fn(async () => { if (value instanceof Error) throw value; return value as boolean; }) });
    const result = await prepare(metadata(), deps);
    expect(result).toMatchObject({ status: 'failed', code: 'signature_invalid' });
    unchanged(result);
    expect(result).not.toHaveProperty('bytes');
  });

  it('passes only the provisioned key and canonical descriptor to the verifier and returns verified copied bytes', async () => {
    const source = abc.slice();
    const deps = dependencies({ transport: vi.fn(async function* () { yield source.subarray(0, 1); yield source.subarray(1); }) });
    const result = await prepare(metadata(), deps);
    expect(result).toMatchObject({ status: 'prepared', bytes: abc });
    unchanged(result);
    expect(deps.transport).toHaveBeenCalledWith({
      url: 'https://updates.example.invalid/noltri.bin', maxBytes: 3,
      signal: expect.any(AbortSignal), redirect: 'error', credentials: 'omit',
    });
    expect(deps.verifySignature).toHaveBeenCalledOnce();
    source.fill(0);
    if (result.status === 'prepared') expect(result.bytes).toEqual(abc);
  });

  it('snapshots metadata and trust before the asynchronous transport can mutate inputs', async () => {
    const value = metadata();
    const deps = dependencies();
    deps.transport = vi.fn(async function* () {
      value.version = '9.9.9';
      value.signature.keyId = 'manifest-key';
      deps.trustedKey!.publicKey.fill(0);
      yield abc;
    });
    const result = await prepare(value, deps);
    expect(result).toMatchObject({ status: 'prepared', metadata: { version: '1.3.0', signature: { keyId: 'provisioned-test-key' } } });
    unchanged(result);
  });

  it('never invokes an installation callback during download, verification, success or failure', async () => {
    const install = vi.fn();
    const deps = {
      ...dependencies({
        transport: vi.fn(async function* () { expect(install).not.toHaveBeenCalled(); yield abc; }),
        verifySignature: vi.fn(async () => { expect(install).not.toHaveBeenCalled(); return true; }),
      }),
      install,
    };
    expect((await prepare(metadata(), deps)).status).toBe('prepared');
    expect((await prepare({ ...metadata(), sha256: '00'.repeat(32) }, deps)).status).toBe('failed');
    expect(install).not.toHaveBeenCalled();
  });

  it('binds version and target into the detached signature payload', () => {
    expect(new TextDecoder().decode(updateSignaturePayload(metadata()))).toBe('["noltri-update-v1","1.3.0","darwin","aarch64","https://updates.example.invalid/noltri.bin","ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",3,"Ed25519","provisioned-test-key"]');
    expect(updateSignaturePayload({ ...metadata(), version: '2.0.0' })).not.toEqual(updateSignaturePayload(metadata()));
    expect(updateSignaturePayload({ ...metadata(), architecture: 'x86_64' })).not.toEqual(updateSignaturePayload(metadata()));
  });
});

describe('platform Ed25519 verification', () => {
  // RFC 8032 section 7.1, TEST 2: public data only; no private key is used or created.
  const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!, (value) => parseInt(value, 16));
  const vector: SignatureVerificationInput = {
    key: { algorithm: 'Ed25519', keyId: 'public-vector-only', publicKey: fromHex('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c') },
    message: new Uint8Array([0x72]),
    signature: fromHex('92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'),
  };

  it('accepts the fixed public vector with real cryptography', async () => {
    await expect(verifyEd25519Signature(vector)).resolves.toBe(true);
  });

  it('rejects modified message, signature and key with real cryptography', async () => {
    await expect(verifyEd25519Signature({ ...vector, message: new Uint8Array([0x73]) })).resolves.toBe(false);
    await expect(verifyEd25519Signature({ ...vector, signature: new Uint8Array(64) })).resolves.toBe(false);
    await expect(verifyEd25519Signature({ ...vector, key: { ...vector.key, publicKey: new Uint8Array(32) } })).resolves.toBe(false);
  });
});
