/**
 * The terminal registry: one live xterm.js instance per PTY session, owned
 * outside React so tab switches keep scrollback and parser state. React
 * components mount and reveal these instances; they never create them.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { phosphorTheme, terminalTypography } from "./theme";
import { connectPtyStream } from "./stream";

/** Scrollback kept per terminal (PLAN.md §3). */
export const SCROLLBACK_LINES = 10_000;

/** A registered terminal and the handles components need. */
export interface TerminalHandle {
  /** The xterm instance. */
  term: Terminal;
  /** Fit addon — call `fit()` on container resize/reveal. */
  fit: FitAddon;
  /** Search addon backing the find bar (⇧⌘F). */
  search: SearchAddon;
  /**
   * Attaches the terminal to a container element. The first call opens and
   * renders; later calls with a *different* container move the terminal's
   * existing DOM there (React may remount a pane wrapper — e.g. strict-mode
   * double-mounts — and xterm state must survive the move).
   */
  open(container: HTMLElement): void;
  /**
   * Moves this terminal to a new PTY session (reconnect, F3): disconnects
   * the old session's stream and attaches the new one, keeping scrollback.
   * Use {@link rebindSessionTerminal}, which also re-keys the registry.
   */
  rebind(newSessionId: string): Promise<void>;
  /** Detaches IPC listeners and disposes the terminal. */
  dispose(): void;
}

const handles = new Map<string, TerminalHandle>();

/**
 * Creates the terminal for a freshly spawned session, loads the Phase 1
 * addon set (fit, search, unicode11, web-links; WebGL at `open` time), and
 * connects its PTY stream.
 *
 * WebGL is attempted per §3 with automatic fallback: WKWebView commonly
 * lacks usable WebGL2, so failures and context losses quietly fall back to
 * xterm's DOM renderer.
 *
 * @param sessionId - The session returned by `pty_spawn`.
 * @returns The registered handle (also retrievable via
 * {@link getSessionTerminal}).
 */
export async function createSessionTerminal(sessionId: string): Promise<TerminalHandle> {
  const { fontFamily, fontSize } = terminalTypography();
  const term = new Terminal({
    theme: phosphorTheme(),
    fontFamily,
    fontSize,
    scrollback: SCROLLBACK_LINES,
    cursorBlink: true,
    allowProposedApi: true,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      // ⌘-click opens URLs (F2); plain clicks stay in the terminal.
      if (event.metaKey) {
        event.preventDefault();
        void openUrl(uri).catch(() => undefined);
      }
    }),
  );

  // Both mutate on rebind: the stream disconnect swaps to the new session's,
  // and the current id keeps dispose() deleting the right map entry.
  let disconnect = await connectPtyStream(sessionId, term);
  let currentId = sessionId;

  let opened = false;
  const handle: TerminalHandle = {
    term,
    fit,
    search,
    open(container: HTMLElement): void {
      if (opened) {
        // Re-mounted into a new wrapper: move the existing terminal DOM —
        // xterm state (scrollback, parser, renderer) lives in memory and
        // survives the reparent; a refit repaints at the new geometry.
        const element = term.element;
        if (element && element.parentElement !== container) {
          container.appendChild(element);
          fit.fit();
        }
        return;
      }
      opened = true;
      term.open(container);
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // No usable WebGL context — xterm's DOM renderer carries on (§3).
      }
      fit.fit();
      // Focus after layout settles: a synchronous focus() during the mount
      // commit does not reliably stick in WKWebView, leaving a fresh tab
      // deaf to the keyboard until clicked.
      requestAnimationFrame(() => term.focus());
    },
    async rebind(newSessionId: string): Promise<void> {
      disconnect();
      disconnect = await connectPtyStream(newSessionId, term);
      currentId = newSessionId;
    },
    dispose(): void {
      disconnect();
      term.dispose();
      handles.delete(currentId);
    },
  };
  handles.set(sessionId, handle);
  return handle;
}

/**
 * Moves a session's terminal to a new PTY session id (reconnect, F3): the
 * PTY stream is re-wired and the registry re-keyed, while the xterm
 * instance — scrollback included — stays alive.
 *
 * @param oldId - The exited session the terminal currently belongs to.
 * @param newId - The freshly spawned session to attach.
 * @returns The moved handle, or `undefined` when `oldId` is unknown.
 */
export async function rebindSessionTerminal(
  oldId: string,
  newId: string,
): Promise<TerminalHandle | undefined> {
  const handle = handles.get(oldId);
  if (!handle) return undefined;
  await handle.rebind(newId);
  handles.delete(oldId);
  handles.set(newId, handle);
  return handle;
}

/**
 * Looks up a session's terminal handle.
 *
 * @param sessionId - The session id.
 * @returns The handle, or `undefined` after disposal.
 */
export function getSessionTerminal(sessionId: string): TerminalHandle | undefined {
  return handles.get(sessionId);
}

/**
 * Disposes a session's terminal (if it still exists) and forgets it.
 *
 * @param sessionId - The session id.
 */
export function disposeSessionTerminal(sessionId: string): void {
  handles.get(sessionId)?.dispose();
}
