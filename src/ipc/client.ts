/**
 * Typed helpers over Tauri's raw `invoke`/`listen` — the only place the
 * untyped Tauri API is touched. Everything else in the frontend calls these,
 * so the compiler enforces the contract in `./contract`.
 */

import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { IpcCommands, PtyExitEvent } from "./contract";

/**
 * Invokes a Tauri command with its contract-typed payload and result.
 *
 * @param command - A command name from {@link IpcCommands}.
 * @param payload - The payload type the contract assigns to that command.
 * @returns The contract-typed result.
 * @example
 * ```ts
 * const { sessionId } = await ipcInvoke("pty_spawn", {
 *   kind: "local",
 *   cols: 80,
 *   rows: 24,
 * });
 * ```
 */
export function ipcInvoke<K extends keyof IpcCommands>(
  command: K,
  payload: IpcCommands[K]["payload"],
): Promise<IpcCommands[K]["result"]> {
  return invoke(command, payload as unknown as InvokeArgs);
}

/**
 * Subscribes to `pty:data:{sessionId}` — base64-encoded chunks of raw PTY
 * output for one session.
 *
 * @param sessionId - The session to listen to.
 * @param onChunk - Called with each base64 chunk, in arrival order.
 * @returns A promise resolving to the unlisten function.
 */
export function onPtyData(
  sessionId: string,
  onChunk: (chunkBase64: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`pty:data:${sessionId}`, (event) => {
    onChunk(event.payload);
  });
}

/**
 * Subscribes to `pty:exit:{sessionId}` — fired once when the session's child
 * exits; no further events follow for that session.
 *
 * @param sessionId - The session to listen to.
 * @param onExit - Called with the exit payload.
 * @returns A promise resolving to the unlisten function.
 */
export function onPtyExit(
  sessionId: string,
  onExit: (exit: PtyExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<PtyExitEvent>(`pty:exit:${sessionId}`, (event) => {
    onExit(event.payload);
  });
}
