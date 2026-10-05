/**
 * Chrome Native Messaging framing: a 4-byte unsigned length in the platform's native byte order
 * (little-endian on every Chrome platform today) followed by that many bytes of UTF-8 JSON.
 *
 * Both directions are capped at 1 MiB, and the cap is not cosmetic: a host that writes an oversized
 * frame has its process killed by the browser, so the limit is enforced here with a readable error
 * instead of being discovered as a mysterious disconnect.
 */

export const LENGTH_PREFIX_BYTES = 4;
export const MAX_FRAME_BYTES = 1_024 * 1_024;

export class FrameError extends Error {
  readonly code: 'frame_incomplete' | 'frame_too_large' | 'frame_invalid_json';

  constructor(code: FrameError['code'], message: string) {
    super(message);
    this.name = 'FrameError';
    this.code = code;
  }
}

export function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > MAX_FRAME_BYTES) {
    throw new FrameError('frame_too_large', `native frame is ${String(payload.length)} bytes, over the ${String(MAX_FRAME_BYTES)} byte limit`);
  }
  const frame = Buffer.alloc(LENGTH_PREFIX_BYTES + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, LENGTH_PREFIX_BYTES);
  return frame;
}

export function decodeFrame(bytes: Readonly<Uint8Array>): unknown {
  if (bytes.length < LENGTH_PREFIX_BYTES) throw new FrameError('frame_incomplete', 'native frame is shorter than its length prefix');
  const view = Buffer.from(bytes.slice());
  const length = view.readUInt32LE(0);
  if (length > MAX_FRAME_BYTES) throw new FrameError('frame_too_large', `native frame declares ${String(length)} bytes`);
  if (view.length < LENGTH_PREFIX_BYTES + length) throw new FrameError('frame_incomplete', 'native frame body is missing');
  const body = view.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length).toString('utf8');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new FrameError('frame_invalid_json', 'native frame body is not valid JSON');
  }
}

/**
 * Frames and failures in the order they appeared on the wire. Chrome pairs a reply with a request by
 * position, so a parser that returned "all the frames, then any error" would answer a later request
 * before an earlier one and desynchronise the whole connection.
 */
export type ParseEvent =
  | { readonly kind: 'frame'; readonly value: unknown }
  | { readonly kind: 'error'; readonly error: FrameError };

/**
 * stdin hands us arbitrary chunks, never whole messages, so the parser keeps whatever is left over
 * until the rest arrives. One bad frame must not cost the user the good ones: a body that is not JSON
 * still declares where the next frame starts, so parsing continues after it, and only a length that
 * lies (which cannot be trusted to delimit anything) abandons the buffer.
 */
export class FrameParser {
  private buffered: Buffer = Buffer.alloc(0);

  push(chunk: Readonly<Uint8Array>): ParseEvent[] {
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const events: ParseEvent[] = [];
    for (;;) {
      if (this.buffered.length < LENGTH_PREFIX_BYTES) return events;
      const length = this.buffered.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        // The stream cannot be resynchronised after a lie about its own length.
        this.buffered = Buffer.alloc(0);
        events.push({ kind: 'error', error: new FrameError('frame_too_large', `native frame declares ${String(length)} bytes`) });
        return events;
      }
      if (this.buffered.length < LENGTH_PREFIX_BYTES + length) return events;
      const body = this.buffered.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length).toString('utf8');
      this.buffered = this.buffered.subarray(LENGTH_PREFIX_BYTES + length);
      try {
        events.push({ kind: 'frame', value: JSON.parse(body) as unknown });
      } catch {
        events.push({ kind: 'error', error: new FrameError('frame_invalid_json', 'native frame body is not valid JSON') });
      }
    }
  }

  get pendingBytes(): number {
    return this.buffered.length;
  }
}
