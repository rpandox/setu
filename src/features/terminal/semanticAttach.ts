/**
 * Wires the semantic machine (`semantic.ts`) to a live xterm instance
 * (F12, Phase 10): OSC handler registration, gutter-mark decorations,
 * prompt jumps, copy-last-output, re-run-last, done-notifications, and
 * the history write.
 *
 * Handlers are registered on every terminal at creation and stay
 * registered; every *effect* checks `semanticEnabled()` at event time, so
 * flipping the `semantic_terminal` flag in Settings applies to open
 * terminals without a restart. With the flag off, or with no integration
 * installed on the shell, nothing here produces a visible side effect —
 * the F12 "integration absent → features hide, zero errors" edge case.
 */

import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { ipcInvoke } from "../../ipc/client";
import { semanticEnabled, useSemantic } from "../../state/semantic";
import { activeSessionOf, useSessions } from "../../state/sessions";
import { followCwdFromSession } from "../../state/sftp";
import { useSettings } from "../../state/settings";
import { useToast } from "../../state/toast";
import {
  createSemanticMachine,
  formatDuration,
  nextPromptLine,
  type CommandMark,
  type CompletedCommand,
  type SemanticMachine,
} from "./semantic";
import "./semantic.css";

/** A command running at least this long fires a done-notification (F12). */
export const NOTIFY_AFTER_MS = 30_000;

/** Everything attached to one terminal. */
interface Attachment {
  machine: SemanticMachine;
  term: Terminal;
  decorations: Map<number, IDecoration>;
  /** Points the attachment at a new session id (reconnect). */
  rekey(id: string): void;
  dispose(): void;
}

const attachments = new Map<string, Attachment>();

/**
 * Registers the OSC 133 / 633 / 7 / 52 handlers on `term` for `sessionId`.
 * Call once per terminal, right after creation; `rebindSemantic` moves the
 * attachment on reconnect.
 *
 * @param sessionId - The PTY session the terminal renders.
 * @param term - The xterm instance.
 * @returns A disposer (also run by {@link detachSemantic}).
 */
export function attachSemantic(sessionId: string, term: Terminal): () => void {
  const decorations = new Map<number, IDecoration>();
  let currentId = sessionId;

  const decorate = (mark: CommandMark): void => {
    const existing = decorations.get(mark.seq);
    existing?.dispose();
    const marker = mark.prompt as unknown as IMarker;
    if (marker.isDisposed || marker.line < 0) return;
    let decoration: IDecoration | undefined;
    try {
      decoration = term.registerDecoration({ marker, x: 0, width: 1 });
    } catch {
      return; // no renderer yet (not opened) — marks are cosmetic
    }
    if (!decoration) return;
    decoration.onRender((element) => {
      const state = !mark.done
        ? "run"
        : mark.exit === 0
          ? "ok"
          : mark.exit === null
            ? "run"
            : "err";
      element.className = `semantic-mark semantic-mark--${state}`;
      element.title =
        mark.durationMs !== undefined
          ? `${mark.cmd ?? "command"} · ${formatDuration(mark.durationMs)} · exit ${mark.exit ?? "?"}`
          : (mark.cmd ?? "");
    });
    decorations.set(mark.seq, decoration);
    marker.onDispose(() => {
      decorations.get(mark.seq)?.dispose();
      decorations.delete(mark.seq);
    });
  };

  const machine = createSemanticMachine(
    {
      now: () => Date.now(),
      anchor: () => term.registerMarker(0),
      cursorLine: () => term.buffer.active.baseY + term.buffer.active.cursorY,
      altScreen: () => term.buffer.active.type === "alternate",
      onIntegrationDetected: () => {
        if (semanticEnabled())
          useSemantic.getState().patch(currentId, { integration: true });
      },
      onMark: (mark) => {
        if (semanticEnabled()) decorate(mark);
      },
      onCwd: (cwd) => {
        if (!semanticEnabled()) return;
        useSemantic.getState().patch(currentId, { cwd });
        const meta = useSessions
          .getState()
          .sessions.find((s) => s.sessionId === currentId);
        if (meta?.kind === "ssh") followCwdFromSession(meta.hostId, cwd);
      },
      onClipboard: (text) => {
        if (!semanticEnabled()) return;
        void navigator.clipboard?.writeText(text).catch(() => undefined);
      },
      onCommandDone: (done) => {
        if (!semanticEnabled()) return;
        onCommandDone(currentId, done);
      },
    },
    {
      clipboard: () =>
        semanticEnabled() && useSettings.getState().doc.terminal.osc52_clipboard,
    },
  );

  const handlers = [
    term.parser.registerOscHandler(133, (data) => machine.osc(133, data)),
    term.parser.registerOscHandler(633, (data) => machine.osc(633, data)),
    term.parser.registerOscHandler(7, (data) => machine.osc(7, data)),
    term.parser.registerOscHandler(52, (data) => machine.osc(52, data)),
    term.buffer.onBufferChange((buffer) => {
      if (buffer.type === "alternate") machine.noteAltScreen();
    }),
  ];

  const attachment: Attachment = {
    machine,
    term,
    decorations,
    rekey(id: string): void {
      currentId = id;
    },
    dispose(): void {
      for (const handler of handlers) handler.dispose();
      for (const decoration of decorations.values()) decoration.dispose();
      decorations.clear();
      machine.dispose();
      attachments.delete(currentId);
      useSemantic.getState().forget(currentId);
    },
  };
  attachments.set(sessionId, attachment);
  return () => attachment.dispose();
}

/**
 * Moves a session's attachment to a new session id (reconnect, F3) —
 * marks and scrollback survive together.
 *
 * @param oldId - The exited session.
 * @param newId - The new session.
 */
export function rebindSemantic(oldId: string, newId: string): void {
  const attachment = attachments.get(oldId);
  if (!attachment) return;
  attachments.delete(oldId);
  attachments.set(newId, attachment);
  attachment.rekey(newId);
  const facts = useSemantic.getState().bySession[oldId];
  useSemantic.getState().forget(oldId);
  if (facts) useSemantic.getState().patch(newId, facts);
}

/**
 * Detaches a session's semantic layer (call before disposing its terminal).
 *
 * @param sessionId - The session.
 */
export function detachSemantic(sessionId: string): void {
  attachments.get(sessionId)?.dispose();
}

/**
 * The machine behind a session, for tests and the perf probe.
 *
 * @param sessionId - The session.
 * @returns The machine, or `undefined` when none is attached.
 */
export function getSemanticMachine(sessionId: string): SemanticMachine | undefined {
  return attachments.get(sessionId)?.machine;
}

/** Permission is asked once per app run, on the first long command. */
let permissionAsked = false;

/**
 * Sends the F12 done-notification when a long command finishes in a tab
 * that isn't in front (PLAN.md §5, done-notification-click row: the
 * notification names the tab; a click activates the app).
 *
 * @param sessionId - The session.
 * @param mark - The finished command.
 */
async function notifyIfBackground(sessionId: string, mark: CommandMark): Promise<void> {
  const sessions = useSessions.getState();
  const focused = activeSessionOf(sessions);
  const inFront =
    !document.hidden && document.hasFocus() && focused?.sessionId === sessionId;
  if (inFront) return;
  const meta = sessions.sessions.find((s) => s.sessionId === sessionId);
  const where = meta?.kind === "ssh" ? (meta.hostLabel ?? meta.title) : "local";
  const tabIndex = sessions.tabs.findIndex(
    (t) => t.layout && tabHasSession(t.layout, sessionId),
  );
  try {
    let granted = await isPermissionGranted();
    if (!granted && !permissionAsked) {
      permissionAsked = true;
      granted = (await requestPermission()) === "granted";
    }
    if (!granted) return;
    sendNotification({
      title: `${mark.exit === 0 ? "✓" : "✕"} ${mark.cmd ?? "command"}`,
      body: `${formatDuration(mark.durationMs ?? 0)} · exit ${mark.exit ?? "?"} · ${where}${
        tabIndex >= 0 ? ` · tab ${tabIndex + 1} (⌘${tabIndex + 1})` : ""
      }`,
    });
  } catch {
    // Notification center unavailable: nothing to do, never an error.
  }
}

/**
 * Whether a split tree contains a pane for `sessionId`.
 *
 * @param node - A split-tree node (leaf or split).
 * @param sessionId - The session to look for.
 */
function tabHasSession(node: unknown, sessionId: string): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as { sessionId?: string; a?: unknown; b?: unknown };
  if (n.sessionId === sessionId) return true;
  return tabHasSession(n.a, sessionId) || tabHasSession(n.b, sessionId);
}

/**
 * The completed-command effects: store facts, history row, notification.
 *
 * @param sessionId - The session the command ran in.
 * @param done - The machine's completion report.
 */
function onCommandDone(sessionId: string, done: CompletedCommand): void {
  const { mark } = done;
  const store = useSemantic.getState();
  const facts = store.bySession[sessionId];
  store.patch(sessionId, {
    lastCmd: mark.cmd,
    lastExit: mark.exit ?? null,
    lastDurationMs: mark.durationMs,
    completed: (facts?.completed ?? 0) + 1,
  });
  if ((mark.durationMs ?? 0) >= NOTIFY_AFTER_MS) {
    void notifyIfBackground(sessionId, mark);
  }
  // History (F12): never for alt-screen commands; the core re-checks the
  // global toggle and the host's incognito flag before writing.
  if (mark.cmd === undefined || mark.usedAltScreen) return;
  if (!useSettings.getState().doc.history.enabled) return;
  const meta = useSessions.getState().sessions.find((s) => s.sessionId === sessionId);
  void ipcInvoke("history_add", {
    entry: {
      hostId: meta?.kind === "ssh" ? meta.hostId : undefined,
      hostLabel: meta?.kind === "ssh" ? (meta.hostLabel ?? meta.title) : "local",
      cwd: mark.cwd ?? "",
      cmd: mark.cmd,
      exit: mark.exit ?? null,
      durationMs: mark.durationMs ?? 0,
      ts: Date.now(),
    },
  }).catch(() => undefined);
}

/**
 * ⌘↑ / ⌘↓ — scrolls the focused terminal to the previous / next prompt.
 *
 * @param sessionId - The focused session.
 * @param direction - Which way.
 * @returns True when a prompt was found and scrolled to.
 */
export function jumpToPrompt(sessionId: string, direction: "up" | "down"): boolean {
  const attachment = attachments.get(sessionId);
  if (!attachment || !semanticEnabled()) return false;
  const { term, machine } = attachment;
  const line = nextPromptLine(machine.marks(), term.buffer.active.viewportY, direction);
  if (line === undefined) return false;
  term.scrollToLine(line);
  return true;
}

/**
 * ⇧⌘C — copies exactly the last command's output (the lines between its
 * `133;C` and `133;D`) to the clipboard.
 *
 * @param sessionId - The focused session.
 * @returns The copied text, or `undefined` when there is no finished command.
 */
export function copyLastOutput(sessionId: string): string | undefined {
  const attachment = attachments.get(sessionId);
  if (!attachment || !semanticEnabled()) return undefined;
  const { term, machine } = attachment;
  const last = machine.lastCompleted();
  if (!last || last.output === undefined || last.output.line < 0) return undefined;
  // The output runs from the C line up to (not including) the next prompt.
  const marks = machine.marks();
  const next = marks.find((m) => m.seq > last.seq);
  const first = last.output.line;
  const end =
    next && next.prompt.line >= 0 ? next.prompt.line : term.buffer.active.length;
  const lines: string[] = [];
  for (let i = first; i < end; i++) {
    const line = term.buffer.active.getLine(i);
    if (!line) break;
    lines.push(line.translateToString(true));
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const text = lines.join("\n");
  void navigator.clipboard?.writeText(text).catch(() => undefined);
  useToast
    .getState()
    .show(`Copied ${lines.length} line${lines.length === 1 ? "" : "s"}`, "info");
  return text;
}

/**
 * ⌥⌘R — re-runs the last completed command by writing it to the PTY with
 * a carriage return (the user explicitly asked; this is not an AI
 * suggestion, so the insert-only rule doesn't apply).
 *
 * @param sessionId - The focused session.
 * @returns The command sent, or `undefined` when none is known.
 */
export function rerunLastCommand(sessionId: string): string | undefined {
  const attachment = attachments.get(sessionId);
  if (!attachment || !semanticEnabled()) return undefined;
  const last = attachment.machine.lastCompleted();
  if (!last?.cmd) return undefined;
  void ipcInvoke("pty_write", { sessionId, data: `${last.cmd}\r` }).catch(
    () => undefined,
  );
  return last.cmd;
}
