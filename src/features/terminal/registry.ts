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
   * Attaches the terminal to a container element. Idempotent: the first
   * call opens and renders; later calls are no-ops (xterm instances attach
   * once and stay attached).
   */
  open(container: HTMLElement): void;
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

  const disconnect = await connectPtyStream(sessionId, term);

  let opened = false;
  const handle: TerminalHandle = {
    term,
    fit,
    search,
    open(container: HTMLElement): void {
      if (opened) return;
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
    dispose(): void {
      disconnect();
      term.dispose();
      handles.delete(sessionId);
    },
  };
  handles.set(sessionId, handle);
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
