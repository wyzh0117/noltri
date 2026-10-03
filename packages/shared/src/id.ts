const HEX = '0123456789abcdef';

interface RandomValueSource {
  getRandomValues?: (buffer: Uint8Array) => Uint8Array;
}

function randomHex(length: number): string {
  const buffer = new Uint8Array(Math.ceil(length / 2));
  const cryptoApi = (globalThis as { crypto?: RandomValueSource }).crypto;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(buffer);
  } else {
    for (let index = 0; index < buffer.length; index += 1) {
      buffer[index] = Math.floor(Math.random() * 256);
    }
  }
  let out = '';
  for (const byte of buffer) {
    out += HEX[byte >> 4] + HEX[byte & 15];
  }
  return out.slice(0, length);
}

export function createId(): string {
  return `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-a${randomHex(3)}-${randomHex(12)}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
