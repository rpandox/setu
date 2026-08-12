// The batched pipeline's contract: ordered delivery, frame-coalesced
// flushing, and watermark backpressure honoring the write callback (§3).
import { describe, expect, it } from "vitest";
import {
  createPtyStreamBuffer,
  decodeBase64,
  HIGH_WATERMARK_BYTES,
  LOW_WATERMARK_BYTES,
  type ChunkSink,
} from "./stream";

/** A sink that records writes and releases callbacks on demand. */
function recordingSink() {
  const writes: { chunk: Uint8Array; onProcessed: () => void }[] = [];
  const sink: ChunkSink = {
    write(chunk, onProcessed) {
      writes.push({ chunk, onProcessed });
    },
  };
  return {
    sink,
    writes,
    release(count: number) {
      for (let i = 0; i < count; i++) {
        const next = writes.shift();
        next?.onProcessed();
      }
    },
  };
}

/** A scheduler the test steps manually, like a controllable rAF. */
function manualScheduler() {
  const pending: (() => void)[] = [];
  return {
    schedule: (flush: () => void) => {
      pending.push(flush);
    },
    runNext: () => {
      pending.shift()?.();
    },
    get pendingCount() {
      return pending.length;
    },
  };
}

const bytes = (length: number, fill = 0) => new Uint8Array(length).fill(fill);

describe("createPtyStreamBuffer", () => {
  it("coalesces pushes into one scheduled flush and preserves order", () => {
    const { sink, writes } = recordingSink();
    const scheduler = manualScheduler();
    const buffer = createPtyStreamBuffer(sink, scheduler.schedule);

    buffer.push(bytes(10, 1));
    buffer.push(bytes(20, 2));
    buffer.push(bytes(30, 3));
    // Nothing reaches the sink until the frame fires, and three pushes
    // request only one flush.
    expect(writes).toHaveLength(0);
    expect(scheduler.pendingCount).toBe(1);

    scheduler.runNext();
    expect(writes.map((w) => w.chunk.byteLength)).toEqual([10, 20, 30]);
    expect(writes[0].chunk[0]).toBe(1);
    expect(writes[2].chunk[0]).toBe(3);
    expect(buffer.queuedBytes()).toBe(0);
  });

  it("stops at the high-water mark and resumes below the low-water mark", () => {
    const { sink, writes, release } = recordingSink();
    const scheduler = manualScheduler();
    const buffer = createPtyStreamBuffer(sink, scheduler.schedule);

    // 6 × 64 KB = 384 KB queued; the high-water mark is 256 KB.
    const chunk = HIGH_WATERMARK_BYTES / 4;
    for (let i = 0; i < 6; i++) buffer.push(bytes(chunk, i));
    scheduler.runNext();

    // Exactly 4 chunks fit under the mark; 2 stay queued.
    expect(writes).toHaveLength(4);
    expect(buffer.outstandingBytes()).toBe(HIGH_WATERMARK_BYTES);
    expect(buffer.queuedBytes()).toBe(2 * chunk);

    // Draining above the low-water mark schedules nothing…
    release(1);
    release(1);
    expect(scheduler.pendingCount).toBe(0);
    // …reaching it (64 KB outstanding) resumes the flush.
    release(1);
    expect(scheduler.pendingCount).toBe(1);
    expect(buffer.outstandingBytes()).toBe(LOW_WATERMARK_BYTES);

    scheduler.runNext();
    expect(buffer.queuedBytes()).toBe(0);
  });
});

describe("decodeBase64", () => {
  it("round-trips arbitrary bytes", () => {
    const original = new Uint8Array([0, 1, 127, 128, 255, 42]);
    const encoded = btoa(String.fromCharCode(...original));
    expect(decodeBase64(encoded)).toEqual(original);
  });

  it("preserves a UTF-8 sequence split across two chunks", () => {
    // "🔱" is F0 9F 94 B1; a PTY read may split it anywhere.
    const trident = new TextEncoder().encode("🔱");
    const half1 = trident.slice(0, 2);
    const half2 = trident.slice(2);
    const decoded = new Uint8Array([
      ...decodeBase64(btoa(String.fromCharCode(...half1))),
      ...decodeBase64(btoa(String.fromCharCode(...half2))),
    ]);
    expect(decoded).toEqual(trident);
    expect(new TextDecoder().decode(decoded)).toBe("🔱");
  });
});
