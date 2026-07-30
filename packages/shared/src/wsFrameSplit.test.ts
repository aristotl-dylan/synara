import { describe, expect, it } from "vitest";

import { makeWsFrameSplitter, WsFrameSplitError } from "./wsFrameSplit";

/** Builds a frame the way a real peer would, so the splitter is never fed a shape it will not see. */
function frame(input: {
  opcode: number;
  payload: Uint8Array;
  masked?: boolean;
  rsv1?: boolean;
}): Uint8Array {
  const { opcode, payload } = input;
  const lengthBytes = payload.byteLength < 126 ? 0 : payload.byteLength <= 0xffff ? 2 : 8;
  const maskBytes = input.masked ? 4 : 0;
  const out = new Uint8Array(2 + lengthBytes + maskBytes + payload.byteLength);
  out[0] = 0x80 | opcode | (input.rsv1 ? 0x40 : 0);
  const marker = lengthBytes === 0 ? payload.byteLength : lengthBytes === 2 ? 126 : 127;
  out[1] = (input.masked ? 0x80 : 0) | marker;
  const view = new DataView(out.buffer);
  if (lengthBytes === 2) view.setUint16(2, payload.byteLength);
  if (lengthBytes === 8) view.setBigUint64(2, BigInt(payload.byteLength));
  const maskOffset = 2 + lengthBytes;
  if (input.masked) out.set([0xa1, 0xb2, 0xc3, 0xd4], maskOffset);
  out.set(payload, maskOffset + maskBytes);
  return out;
}

const text = (value: string) => new TextEncoder().encode(value);
const splitter = () => makeWsFrameSplitter({ maxFrameBytes: 1024 * 1024 });

describe("WebSocket frame splitting for the environment proxy", () => {
  it("re-emits every frame byte for byte", () => {
    // The single most important property: what comes out is the exact input
    // slice, header included. Anything else and the proxy is no longer
    // byte-for-byte and both endpoints see a stream neither produced.
    const first = frame({ opcode: 0x1, payload: text("hello"), masked: true });
    const second = frame({ opcode: 0x2, payload: text("binary payload") });
    const frames = splitter().push(new Uint8Array([...first, ...second]));
    expect(frames).toHaveLength(2);
    expect(frames[0]!.bytes).toEqual(first);
    expect(frames[1]!.bytes).toEqual(second);
  });

  it("preserves the RSV1 bit that carries a permessage-deflate payload", () => {
    // RSV1 set means "this payload is DEFLATE-compressed". The splitter must
    // pass it through untouched and never try to inflate it — that is exactly
    // what lets compression negotiate end to end through the proxy.
    const compressed = frame({ opcode: 0x1, payload: text("compressed"), rsv1: true });
    const [only] = splitter().push(compressed);
    expect(only!.bytes).toEqual(compressed);
    expect(only!.bytes[0]! & 0x40).toBe(0x40);
    expect(only!.isControl).toBe(false);
  });

  it("does not unmask a masked client frame", () => {
    // Unmasking would change the bytes. A server that received an unmasked
    // client frame would close the connection per RFC 6455 §5.1.
    const payload = text("client says hi");
    const masked = frame({ opcode: 0x1, payload, masked: true });
    const [only] = splitter().push(masked);
    expect(only!.bytes).toEqual(masked);
    // The mask bit survives, and the payload bytes are still the masked ones.
    expect(only!.bytes[1]! & 0x80).toBe(0x80);
  });

  it("classifies control frames so they can overtake data frames", () => {
    // 0x8 Close, 0x9 Ping, 0xA Pong are control; 0x0/0x1/0x2 are not. A
    // misclassified Pong queues behind a snapshot and the peer's heartbeat
    // times out on a healthy link.
    for (const opcode of [0x8, 0x9, 0xa]) {
      const [only] = splitter().push(frame({ opcode, payload: text("x") }));
      expect(only!.isControl, `opcode ${opcode}`).toBe(true);
      expect(only!.opcode).toBe(opcode);
    }
    for (const opcode of [0x0, 0x1, 0x2]) {
      const [only] = splitter().push(frame({ opcode, payload: text("x") }));
      expect(only!.isControl, `opcode ${opcode}`).toBe(false);
    }
  });

  it("reassembles frames split across arbitrary chunk boundaries", () => {
    // TCP gives no frame alignment whatsoever. A splitter that assumed one
    // chunk was one frame would desynchronise on the first fragmented read and
    // relay garbage from then on.
    const big = frame({ opcode: 0x2, payload: new Uint8Array(70_000).fill(7) });
    const small = frame({ opcode: 0x9, payload: text("ping") });
    const stream = new Uint8Array([...big, ...small]);
    for (const chunkSize of [1, 2, 3, 5, 1024, 65_536]) {
      const instance = splitter();
      const collected: Uint8Array[] = [];
      for (let offset = 0; offset < stream.byteLength; offset += chunkSize) {
        for (const produced of instance.push(stream.slice(offset, offset + chunkSize))) {
          collected.push(produced.bytes);
        }
      }
      expect(collected.length, `chunk ${chunkSize}`).toBe(2);
      expect(collected[0], `chunk ${chunkSize}`).toEqual(big);
      expect(collected[1], `chunk ${chunkSize}`).toEqual(small);
      expect(instance.pendingBytes, `chunk ${chunkSize}`).toBe(0);
    }
  });

  it("handles each of the three length encodings", () => {
    // 7-bit, 16-bit and 64-bit lengths have different header sizes. Reading the
    // wrong one shifts every subsequent frame boundary.
    for (const size of [0, 1, 125, 126, 127, 65_535, 65_536, 70_000]) {
      const built = frame({ opcode: 0x2, payload: new Uint8Array(size).fill(3) });
      const [only] = splitter().push(built);
      expect(only?.bytes, `size ${size}`).toEqual(built);
    }
  });

  it("refuses a frame larger than the proxy's ceiling instead of buffering it", () => {
    // A peer that announces a huge payload and then trickles it must not be
    // able to pin memory while we wait for the tail.
    const small = makeWsFrameSplitter({ maxFrameBytes: 1_000 });
    const header = new Uint8Array(10);
    header[0] = 0x82;
    header[1] = 127;
    new DataView(header.buffer).setBigUint64(2, 9_000_000_000n);
    expect(() => small.push(header)).toThrow(WsFrameSplitError);
    // ...and the ordinary 16-bit path is bounded too.
    const medium = makeWsFrameSplitter({ maxFrameBytes: 100 });
    expect(() => medium.push(frame({ opcode: 0x2, payload: new Uint8Array(500) }))).toThrow(
      WsFrameSplitError,
    );
  });

  it("refuses an oversized control frame", () => {
    // RFC 6455 caps a control payload at 125 bytes. Accepting a larger one
    // would let control-priority traffic carry megabytes to the FRONT of the
    // queue, defeating the head-of-line protection it exists to provide.
    const oversized = new Uint8Array(4 + 200);
    oversized[0] = 0x89; // Ping
    oversized[1] = 126;
    new DataView(oversized.buffer).setUint16(2, 200);
    expect(() => splitter().push(oversized)).toThrow(WsFrameSplitError);
  });

  it("emits frames that own their memory rather than viewing the source chunk", () => {
    // `Buffer.prototype.slice` is `subarray`, NOT a copy. A 5-byte frame carved
    // out of a 64 KiB socket read would report byteLength 5 while retaining the
    // whole 65536-byte ArrayBuffer — so the bounded queue's accounting says N
    // bytes while true retention is thousands of times larger, and the memory
    // ceiling that exists to bound the proxy can be overshot before it fires.
    const built = frame({ opcode: 0x1, payload: text("small") });
    const chunk = Buffer.alloc(64 * 1024);
    built.forEach((byte, index) => (chunk[index] = byte));

    // The FAST path: nothing retained beforehand, so `concat` takes its
    // empty-left shortcut and `#takeOne` slices straight out of the input.
    const fast = splitter();
    const [fastFrame] = fast.push(chunk.subarray(0, built.byteLength));
    expect(fastFrame!.bytes.buffer.byteLength).toBe(fastFrame!.bytes.byteLength);

    // The SLOW path: a retained tail forces a real concat first. It already
    // copied, which is exactly why no existing test caught the fast path.
    const slow = splitter();
    slow.push(chunk.subarray(0, 1));
    const [slowFrame] = slow.push(chunk.subarray(1, built.byteLength));
    expect(slowFrame!.bytes.buffer.byteLength).toBe(slowFrame!.bytes.byteLength);
  });

  it("leaves already-emitted frames unchanged when the source chunk is overwritten", () => {
    // The consequence of aliasing that a byte-for-byte proxy cannot survive:
    // Node reuses socket read buffers, so a frame that views one changes bytes
    // after it was handed to the queue.
    const built = frame({ opcode: 0x1, payload: text("hello") });
    for (const label of ["fast", "slow"] as const) {
      const chunk = Buffer.from(built);
      const instance = splitter();
      const frames =
        label === "fast"
          ? instance.push(chunk)
          : (instance.push(chunk.subarray(0, 2)), instance.push(chunk.subarray(2)));
      expect(frames, label).toHaveLength(1);
      const emitted = frames[0]!.bytes;
      const before = Uint8Array.prototype.slice.call(emitted);
      chunk.fill(0xff);
      expect(emitted, label).toEqual(before);
    }
  });

  it("retains a partial tail that does not view the source chunk either", () => {
    // The retained tail is held across pushes, so a view over the socket's read
    // buffer both mutates under us and pins that buffer for as long as the
    // frame is incomplete — the exact leak the frame ceiling exists to bound.
    const built = frame({ opcode: 0x1, payload: text("incomplete payload") });
    const chunk = Buffer.alloc(64 * 1024);
    built.forEach((byte, index) => (chunk[index] = byte));
    const instance = splitter();
    instance.push(chunk.subarray(0, built.byteLength - 1));
    chunk.fill(0xff);
    const [completed] = instance.push(built.slice(built.byteLength - 1));
    expect(completed!.bytes).toEqual(built);
  });

  it("retains a partial frame rather than emitting it early", () => {
    const built = frame({ opcode: 0x1, payload: text("incomplete payload") });
    const instance = splitter();
    expect(instance.push(built.slice(0, built.byteLength - 1))).toHaveLength(0);
    expect(instance.pendingBytes).toBe(built.byteLength - 1);
    const [completed] = instance.push(built.slice(built.byteLength - 1));
    expect(completed!.bytes).toEqual(built);
  });
});
