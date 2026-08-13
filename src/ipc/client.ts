/**
 * Typed helpers over Tauri's raw `invoke`/`listen` — the only place the
 * untyped Tauri API is touched. Everything else in the frontend calls these,
 * so the compiler enforces the contract in `./contract`.
 */

import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type {
  HostkeyPromptEvent,
  IpcCommands,
  PtyExitEvent,
  ReachUpdate,
  SftpProgressEvent,
} from "./contract";

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

/**
 * Subscribes to `reach:update` — one probe result per event, every host on
 * the one channel (F1 LED board). Wired once at app start by the reach
 * store; the payload's `hostId` routes it.
 *
 * @param onUpdate - Called with each probe result, in arrival order.
 * @returns A promise resolving to the unlisten function.
 */
export function onReachUpdate(
  onUpdate: (update: ReachUpdate) => void,
): Promise<UnlistenFn> {
  return listen<ReachUpdate>("reach:update", (event) => {
    onUpdate(event.payload);
  });
}

/**
 * Subscribes to `hostkey:prompt` — an unknown host key awaiting the user's
 * FingerprintDialog verdict (F5). One channel for all hosts; the payload's
 * `hostId` routes it. Answer with `ipcInvoke("hostkey_trust", …)`; the
 * pending `sftp_connect` stays parked until then.
 *
 * @param onPrompt - Called with each prompt, in arrival order.
 * @returns A promise resolving to the unlisten function.
 */
export function onHostkeyPrompt(
  onPrompt: (prompt: HostkeyPromptEvent) => void,
): Promise<UnlistenFn> {
  return listen<HostkeyPromptEvent>("hostkey:prompt", (event) => {
    onPrompt(event.payload);
  });
}

/**
 * Subscribes to `sftp:progress:{transferId}` — throttled progress for one
 * transfer, closed by exactly one terminal `done`/`failed`/`cancelled`
 * event (F5). Speed and ETA derive from successive `bytes` readings.
 *
 * @param transferId - The transfer to listen to.
 * @param onProgress - Called with each progress payload, in arrival order.
 * @returns A promise resolving to the unlisten function.
 */
export function onSftpProgress(
  transferId: string,
  onProgress: (progress: SftpProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<SftpProgressEvent>(`sftp:progress:${transferId}`, (event) => {
    onProgress(event.payload);
  });
}

/**
 * The user's home directory, for the SFTP local pane's starting path —
 * wrapped here so the rest of the frontend never touches the raw Tauri
 * path API (and tests mock this module alone).
 *
 * @returns The absolute home path, without a trailing slash.
 */
export async function localHomeDir(): Promise<string> {
  const home = await homeDir();
  return home.replace(/\/+$/, "");
}

/**
 * Subscribes to OS file drops on the window (Tauri's drag-drop layer —
 * webviews never see dropped files as HTML5 events). The SFTP panel uses
 * it for Finder→app drop-to-upload (F5).
 *
 * @param onDrop - Called with the dropped absolute paths.
 * @returns A promise resolving to the unlisten function.
 */
export function onOsFileDrop(onDrop: (paths: string[]) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop" && event.payload.paths.length > 0) {
      onDrop(event.payload.paths);
    }
  });
}
