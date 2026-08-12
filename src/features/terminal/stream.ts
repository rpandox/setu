/**
 * The batched PTY→xterm data pipeline (PLAN.md §3 performance requirements).
 *
 * The Rust core batches PTY reads into ≤16 KB base64 chunks. On this side,
 * chunks land in a per-session queue and are flushed to `term.write` once
 * per animation frame. Backpressure honors xterm's write callback: bytes
 * handed to xterm but not yet processed count as "outstanding", and the
 * flush loop stops above {@link HIGH_WATERMARK_BYTES} until the callbacks
 * drain it below {@link LOW_WATERMARK_BYTES} — so a `cat` of a 50 MB file
 * never floods the parser or freezes the UI.
 */

import type { Terminal } from "@xterm/xterm";
import { ipcInvoke, onPtyData } from "../../ipc/client";

/** Stop feeding xterm when this many written bytes are still unprocessed. */
export const HIGH_WATERMARK_BYTES = 256_000;

/** Resume feeding once outstanding bytes drain below this. */
export const LOW_WATERMARK_BYTES = 64_000;

/**
 * Schedules a queued flush. The default coalesces to animation frames while
 * the document is visible and falls back to a timer when it is hidden
 * (rAF pauses in hidden windows, and output must keep draining).
 */
export type FlushScheduler = (flush: () => void) => void;

/** Where flushed chunks go — in production, `term.write`. */
export interface ChunkSink {
  /**
   * Write one chunk. `onProcessed` must fire when the sink has consumed it
   * (xterm's write callback); the buffer uses it to meter outstanding bytes.
   */
  write(chunk: Uint8Array, onProcessed: () => void): void;
}

/** A per-session buffer between IPC events and the terminal parser. */
export interface PtyStreamBuffer {
  /** Queue a decoded chunk for the next flush. */
  push(chunk: Uint8Array): void;
  /** Bytes queued and not yet handed to the sink (test/diagnostic hook). */
  queuedBytes(): number;
  /** Bytes handed to the sink whose callbacks are pending. */
  outstandingBytes(): number;
}

/**
 * The default {@link FlushScheduler}: animation frames while visible, a
 * ~2-frame timer while hidden.
 *
 * @param flush - The flush to schedule.
 */
export function defaultFlushScheduler(flush: () => void): void {
  if (typeof document !== "undefined" && document.hidden) {
    setTimeout(flush, 32);
  } else {
    requestAnimationFrame(() => flush());
  }
}

/**
 * Creates the queue + watermark machinery described in the module docs.
 *
 * @param sink - Consumer of flushed chunks (xterm in production).
 * @param schedule - Flush scheduler; injectable for tests.
 * @returns The buffer handle.
 * @example
 * ```ts
 * const buffer = createPtyStreamBuffer({
 *   write: (chunk, done) => term.write(chunk, done),
 * });
 * buffer.push(decodeBase64(chunkFromIpc));
 * ```
 */
export function createPtyStreamBuffer(
  sink: ChunkSink,
  schedule: FlushScheduler = defaultFlushScheduler,
): PtyStreamBuffer {
  const queue: Uint8Array[] = [];
  let queued = 0;
  let outstanding = 0;
  let flushScheduled = false;

  /** Hands queued chunks to the sink until empty or the high-water mark. */
  const flush = (): void => {
    flushScheduled = false;
    while (queue.length > 0 && outstanding < HIGH_WATERMARK_BYTES) {
      const chunk = queue.shift();
      if (!chunk) break;
      queued -= chunk.byteLength;
      outstanding += chunk.byteLength;
      sink.write(chunk, () => {
        outstanding -= chunk.byteLength;
        // Below the low-water mark with work left: resume on the next frame.
        if (queue.length > 0 && outstanding <= LOW_WATERMARK_BYTES) {
          scheduleFlush();
        }
      });
    }
  };

  /** Coalesces flush requests: at most one scheduled at a time. */
  const scheduleFlush = (): void => {
    if (!flushScheduled) {
      flushScheduled = true;
      schedule(flush);
    }
  };

  return {
    push(chunk: Uint8Array): void {
      queue.push(chunk);
      queued += chunk.byteLength;
      scheduleFlush();
    },
    queuedBytes: () => queued,
    outstandingBytes: () => outstanding,
  };
}

/**
 * Decodes a base64 chunk from a `pty:data` event into raw bytes.
 *
 * Output is bytes, not text: a chunk boundary may split a UTF-8 sequence,
 * which is why the transport is base64 and the terminal receives
 * `Uint8Array` (xterm's parser reassembles sequences across writes).
 *
 * @param chunkBase64 - The event payload.
 * @returns The decoded bytes.
 */
export function decodeBase64(chunkBase64: string): Uint8Array {
  const binary = atob(chunkBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Wires a session's full I/O: `pty:data` events through a
 * {@link PtyStreamBuffer} into the terminal, and terminal input/resizes back
 * over IPC.
 *
 * @param sessionId - The PTY session to connect.
 * @param term - The xterm instance rendering it.
 * @param resolveTargets - Maps input to the sessions it should reach —
 * `[sessionId]` normally; the broadcast resolver returns every armed pane's
 * session while broadcasting (F4 fan-out happens here, at the write
 * boundary, so keystrokes, single-line pastes, and IME commits all fan out
 * identically).
 * @returns A disposer that detaches all listeners (call before disposing
 * the terminal).
 */
export async function connectPtyStream(
  sessionId: string,
  term: Terminal,
  resolveTargets: (sessionId: string) => string[] = (id) => [id],
): Promise<() => void> {
  const buffer = createPtyStreamBuffer({
    write: (chunk, onProcessed) => term.write(chunk, onProcessed),
  });
  const unlistenData = await onPtyData(sessionId, (chunkBase64) => {
    buffer.push(decodeBase64(chunkBase64));
  });
  const dataDisposable = term.onData((data) => {
    for (const target of resolveTargets(sessionId)) {
      // Rejections are benign here: the session may have exited a beat ago.
      void ipcInvoke("pty_write", { sessionId: target, data }).catch(() => undefined);
    }
  });
  const resizeDisposable = term.onResize(({ cols, rows }) => {
    void ipcInvoke("pty_resize", { sessionId, cols, rows }).catch(() => undefined);
  });
  return () => {
    unlistenData();
    dataDisposable.dispose();
    resizeDisposable.dispose();
  };
}
