import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, FrameError, FrameParser, LENGTH_PREFIX_BYTES, MAX_FRAME_BYTES } from '../src/framing';
import { frameErrors, frameValues } from './fixtures';

function framesOf(...values: readonly unknown[]): Buffer {
  return Buffer.concat(values.map((value) => encodeFrame(value)));
}

describe('encodeFrame / decodeFrame', () => {
  it('prefixes the payload length as a little-endian uint32', () => {
    const frame = encodeFrame({ type: 'hello' });
    const body = Buffer.from(JSON.stringify({ type: 'hello' }), 'utf8');

    expect(frame.length).toBe(LENGTH_PREFIX_BYTES + body.length);
    expect(frame.readUInt32LE(0)).toBe(body.length);
    expect(frame.subarray(LENGTH_PREFIX_BYTES).toString('utf8')).toBe(body.toString('utf8'));
  });

  it('round-trips a nested capture payload', () => {
    const value = { type: 'capture', request: { text: '元组是不可变序列', source: { type: 'web' } } };
    expect(decodeFrame(encodeFrame(value))).toEqual(value);
  });

  it('keeps multi-byte text intact instead of counting characters', () => {
    const value = { note: '知序 Noltri 本地采集通道，一段较长的中文选区内容' };
    const frame = encodeFrame(value);
    expect((decodeFrame(frame) as { note: string }).note).toBe(value.note);
  });

  it('refuses to write a frame the browser would kill the host for', () => {
    const oversized = { blob: 'a'.repeat(MAX_FRAME_BYTES + 16) };
    try {
      encodeFrame(oversized);
      throw new Error('expected encodeFrame to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(FrameError);
      expect((error as FrameError).code).toBe('frame_too_large');
    }
  });

  it('rejects a frame shorter than its own length prefix', () => {
    expect(() => decodeFrame(Buffer.from([1, 2]))).toThrowError(/length prefix/);
  });

  it('rejects a frame whose body never arrived', () => {
    const frame = encodeFrame({ type: 'hello' });
    expect(() => decodeFrame(frame.subarray(0, frame.length - 1))).toThrowError(/body is missing/);
  });

  it('rejects a declared length over the cap before allocating for it', () => {
    const fake = Buffer.alloc(LENGTH_PREFIX_BYTES);
    fake.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
    try {
      decodeFrame(Buffer.concat([fake, Buffer.from('{}')]));
      throw new Error('expected decodeFrame to throw');
    } catch (error) {
      expect((error as FrameError).code).toBe('frame_too_large');
    }
  });

  it('reports a corrupt body as invalid JSON, not as a crash', () => {
    const body = Buffer.from('{not json', 'utf8');
    const frame = Buffer.alloc(LENGTH_PREFIX_BYTES + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, LENGTH_PREFIX_BYTES);
    try {
      decodeFrame(frame);
      throw new Error('expected decodeFrame to throw');
    } catch (error) {
      expect((error as FrameError).code).toBe('frame_invalid_json');
    }
  });
});

describe('FrameParser', () => {
  it('reassembles frames split at every byte boundary', () => {
    const bytes = framesOf({ type: 'hello' }, { type: 'health' });
    const parser = new FrameParser();
    const collected: unknown[] = [];

    for (let index = 0; index < bytes.length; index += 1) {
      const events = parser.push(bytes.subarray(index, index + 1));
      expect(frameErrors(events)).toEqual([]);
      collected.push(...frameValues(events));
    }

    expect(collected).toEqual([{ type: 'hello' }, { type: 'health' }]);
    expect(parser.pendingBytes).toBe(0);
  });

  it('splits several frames delivered in one chunk', () => {
    const parser = new FrameParser();
    const events = parser.push(framesOf({ type: 'hello' }, { type: 'health' }, { a: 1 }));
    expect(frameErrors(events)).toEqual([]);
    expect(frameValues(events)).toEqual([{ type: 'hello' }, { type: 'health' }, { a: 1 }]);
  });

  it('holds a partial tail until the rest of it arrives', () => {
    const bytes = framesOf({ type: 'capture', requestId: 'abc12345' });
    const parser = new FrameParser();

    expect(parser.push(bytes.subarray(0, bytes.length - 3))).toEqual([]);
    expect(parser.pendingBytes).toBe(bytes.length - 3);

    const second = parser.push(bytes.subarray(bytes.length - 3));
    expect(frameValues(second)).toEqual([{ type: 'capture', requestId: 'abc12345' }]);
    expect(parser.pendingBytes).toBe(0);
  });

  it('answers a corrupt body with an error in its own slot and keeps the frames around it', () => {
    const corrupt = Buffer.from('{oops', 'utf8');
    const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
    header.writeUInt32LE(corrupt.length, 0);
    const parser = new FrameParser();

    const events = parser.push(Buffer.concat([framesOf({ type: 'hello' }), header, corrupt, framesOf({ type: 'health' })]));
    expect(events.map((event) => event.kind)).toEqual(['frame', 'error', 'frame']);
    expect(frameValues(events)).toEqual([{ type: 'hello' }, { type: 'health' }]);
    expect(frameErrors(events).map((error) => error.code)).toEqual(['frame_invalid_json']);
    expect(parser.pendingBytes).toBe(0);
  });

  it('drops the buffer when a frame lies about its length, since the stream cannot be resynchronised', () => {
    const lie = Buffer.alloc(LENGTH_PREFIX_BYTES);
    lie.writeUInt32LE(MAX_FRAME_BYTES + 4_096, 0);
    const parser = new FrameParser();

    const events = parser.push(Buffer.concat([lie, framesOf({ type: 'hello' })]));
    expect(frameErrors(events).map((error) => error.code)).toEqual(['frame_too_large']);
    expect(frameValues(events)).toEqual([]);
    expect(parser.pendingBytes).toBe(0);
  });

  it('treats a length of zero as an empty body rather than an infinite wait', () => {
    const empty = Buffer.alloc(LENGTH_PREFIX_BYTES);
    const parser = new FrameParser();
    const events = parser.push(empty);
    expect(frameErrors(events).map((error) => error.code)).toEqual(['frame_invalid_json']);
    expect(frameValues(events)).toEqual([]);
    expect(parser.pendingBytes).toBe(0);
  });
});
