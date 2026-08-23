/**
 * The semantic layer's state machine (F12, Phase 10) — pure and
 * terminal-agnostic, so it is unit-testable without xterm.
 *
 * The shell snippet (`assets/shell-integration/`) emits, per prompt cycle:
 *
 * - `OSC 133;A` — prompt starts (a new command cycle begins),
 * - `OSC 133;B` — prompt ends, the command line begins,
 * - `OSC 633;E;<cmd>` — the command text about to run (PLAN.md §5,
 *   command-text transport row),
 * - `OSC 133;C` — command output starts,
 * - `OSC 133;D;<exit>` — command finished,
 * - `OSC 7;file://host/path` — working directory,
 * - `OSC 52;c;<base64>` — clipboard write (honored only when opted in).
 *
 * {@link createSemanticMachine} turns that stream into {@link CommandMark}s
 * and fires hooks the UI layer acts on: a completed command (history,
 * gutter marks, done-notifications), a cwd change (status bar, SFTP
 * follow-mode), a clipboard write. The machine also **dedupes by
 * sequence** (F12 edge case: tmux panes' inner shells all emit marks): a
 * second `A` while still at a prompt replaces the prompt mark instead of
 * stacking one, a `D` with no open command is ignored, and a `C` with no
 * `B` still opens the command.
 *
 * Handler cost is the §3 bar (under 1 ms per flushed chunk): every handler is
 * O(1), allocates at most one small object, and touches no DOM — the
 * `stats` counter lets the review measure it.
 */

/** A line anchor the host terminal keeps stable across scroll (xterm `IMarker`). */
export interface LineAnchor {
  /** The current buffer line (−1 once the line scrolled out of history). */
  readonly line: number;
  /** Releases the anchor. */
  dispose(): void;
}

/** One command cycle as the machine sees it. */
export interface CommandMark {
  /** Monotonic per-session sequence number. */
  seq: number;
  /** Anchor on the prompt line (`133;A`). */
  prompt: LineAnchor;
  /** Anchor on the first output line (`133;C`), once the command ran. */
  output?: LineAnchor;
  /** The command text (`633;E`), when the shell reported it. */
  cmd?: string;
  /** Wall-clock start (ms since epoch) at `133;C`. */
  startedAt?: number;
  /** Exit status from `133;D`, `null` when the shell sent none. */
  exit?: number | null;
  /** Duration in ms, set at `133;D`. */
  durationMs?: number;
  /** Working directory at the time the command ran. */
  cwd?: string;
  /** Whether the alternate screen was active at some point during the run. */
  usedAltScreen?: boolean;
  /** Whether the command finished (`133;D` seen). */
  done: boolean;
}

/** What the machine reports when a command finishes. */
export interface CompletedCommand {
  /** The finished mark. */
  mark: CommandMark;
  /** The bounded line range of its output `[firstOutputLine, lastLine]`, when known. */
  outputLines?: [number, number];
}

/** The host-side hooks the machine drives. */
export interface SemanticHooks {
  /** Current time in ms (injectable for tests). */
  now(): number;
  /** Creates an anchor on the cursor's current line. */
  anchor(): LineAnchor | undefined;
  /** The cursor's absolute buffer line right now (for output ranges). */
  cursorLine(): number;
  /** Whether the alternate screen buffer is active. */
  altScreen(): boolean;
  /** A command finished. */
  onCommandDone?(done: CompletedCommand): void;
  /** The working directory changed. */
  onCwd?(cwd: string): void;
  /** The shell asked to write the clipboard (already gated by the setting). */
  onClipboard?(text: string): void;
  /** The integration was seen for the first time this session. */
  onIntegrationDetected?(): void;
  /** A new or replaced prompt mark exists (for gutter decorations). */
  onMark?(mark: CommandMark): void;
}

/** Per-session handler statistics (the under-1-ms-per-chunk evidence). */
export interface SemanticStats {
  /** Handler invocations. */
  calls: number;
  /** Total handler time in ms (`performance.now()` deltas). */
  totalMs: number;
}

/** The machine's public surface. */
export interface SemanticMachine {
  /** Feed an OSC payload: `code` is 133 / 633 / 7 / 52, `data` the text after `OSC code;`. */
  osc(code: number, data: string): boolean;
  /** All marks, oldest first (the active one last). */
  marks(): readonly CommandMark[];
  /** The current working directory, when known. */
  cwd(): string | undefined;
  /** The most recent *finished* command, when any. */
  lastCompleted(): CommandMark | undefined;
  /** Whether any integration sequence has been seen. */
  integrationSeen(): boolean;
  /** Handler statistics. */
  stats(): SemanticStats;
  /** Records that the alternate screen became active (buffer change hook). */
  noteAltScreen(): void;
  /** Drops marks whose anchors scrolled away; keeps at most `keep`. */
  prune(keep?: number): void;
  /** Disposes every anchor. */
  dispose(): void;
}

/** Marks kept per session before the oldest are pruned. */
export const MAX_MARKS = 2000;

/**
 * Unescapes a `633;E` command payload: the snippet escapes `\`, `;` and
 * newlines as `\\`, `\x3b`, `\x0a` (the VS Code convention).
 *
 * @param raw - The payload after `633;E;`.
 * @returns The command line.
 * @example
 * ```ts
 * unescapeCommand("echo a\\x3b b"); // "echo a; b"
 * ```
 */
export function unescapeCommand(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === "\\") {
      out += "\\";
      i += 1;
    } else if (next === "x" && i + 3 < raw.length) {
      const code = parseInt(raw.slice(i + 2, i + 4), 16);
      if (Number.isNaN(code)) {
        out += ch;
      } else {
        out += String.fromCharCode(code);
        i += 3;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Parses an `OSC 7` payload (`file://host/path`, percent-encoded) into a
 * path. Hosts are ignored — the session already knows where it is.
 *
 * @param raw - The payload after `7;`.
 * @returns The decoded path, or `undefined` for a malformed payload.
 * @example
 * ```ts
 * parseCwd("file://hermes/home/u/My%20Dir"); // "/home/u/My Dir"
 * ```
 */
export function parseCwd(raw: string): string | undefined {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(raw);
  if (!m) return raw.startsWith("/") ? raw : undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * Decodes an `OSC 52` payload (`c;<base64>`) into text. Returns
 * `undefined` for queries (`?`) and malformed data.
 *
 * @param raw - The payload after `52;`.
 * @returns The clipboard text.
 */
export function parseClipboard(raw: string): string | undefined {
  const semi = raw.indexOf(";");
  const payload = semi === -1 ? raw : raw.slice(semi + 1);
  if (payload === "" || payload === "?") return undefined;
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Creates the machine.
 *
 * @param hooks - Host callbacks (xterm adapters in production, fakes in tests).
 * @param options - `clipboard`: whether OSC 52 writes are honored (the
 * `[terminal] osc52_clipboard` setting, read per call so a settings change
 * applies live).
 * @returns The machine.
 * @example
 * ```ts
 * const m = createSemanticMachine(hooks, { clipboard: () => false });
 * m.osc(133, "A"); m.osc(133, "B"); m.osc(633, "E;ls"); m.osc(133, "C"); m.osc(133, "D;0");
 * m.lastCompleted()?.cmd; // "ls"
 * ```
 */
export function createSemanticMachine(
  hooks: SemanticHooks,
  options: { clipboard: () => boolean },
): SemanticMachine {
  const marks: CommandMark[] = [];
  let seq = 0;
  let cwd: string | undefined;
  let pendingCmd: string | undefined;
  let seen = false;
  const stats: SemanticStats = { calls: 0, totalMs: 0 };
  const clock =
    typeof performance !== "undefined" ? () => performance.now() : () => Date.now();

  /** The most recent mark, if it is still at the prompt / running. */
  const active = (): CommandMark | undefined => {
    const last = marks[marks.length - 1];
    return last && !last.done ? last : undefined;
  };

  const detected = (): void => {
    if (!seen) {
      seen = true;
      hooks.onIntegrationDetected?.();
    }
  };

  const onPromptStart = (): void => {
    const current = active();
    if (current && current.output === undefined) {
      // Still at a prompt (tmux inner shells, redraws): replace the anchor
      // rather than stacking marks — the sequence dedupe (F12 edge case).
      const anchor = hooks.anchor();
      if (anchor) {
        current.prompt.dispose();
        current.prompt = anchor;
        hooks.onMark?.(current);
      }
      return;
    }
    if (current) {
      // A prompt arrived while a command is open and no D came: the
      // command ended without a status (killed shell, ^C before the
      // trap). Close it silently — no history row without an exit.
      current.done = true;
      current.exit = null;
    }
    const anchor = hooks.anchor();
    if (!anchor) return;
    const mark: CommandMark = { seq: ++seq, prompt: anchor, done: false };
    marks.push(mark);
    if (marks.length > MAX_MARKS) {
      marks.shift()?.prompt.dispose();
    }
    hooks.onMark?.(mark);
  };

  const onOutputStart = (): void => {
    let current = active();
    if (!current) {
      // C without A/B (a prompt we never saw): open a cycle now.
      const anchor = hooks.anchor();
      if (!anchor) return;
      current = { seq: ++seq, prompt: anchor, done: false };
      marks.push(current);
    }
    if (current.output !== undefined) return; // duplicate C
    current.output = hooks.anchor();
    current.startedAt = hooks.now();
    current.cwd = cwd;
    current.usedAltScreen = hooks.altScreen();
    if (pendingCmd !== undefined) {
      current.cmd = pendingCmd;
      pendingCmd = undefined;
    }
  };

  const onCommandEnd = (data: string): void => {
    const current = active();
    if (!current || current.output === undefined) return; // D with no open command
    const code = data.length > 0 ? Number.parseInt(data, 10) : Number.NaN;
    current.exit = Number.isNaN(code) ? null : code;
    current.durationMs = Math.max(0, hooks.now() - (current.startedAt ?? hooks.now()));
    current.done = true;
    if (hooks.altScreen()) current.usedAltScreen = true;
    const first = current.output.line;
    const last = hooks.cursorLine() - 1;
    hooks.onMark?.(current);
    hooks.onCommandDone?.({
      mark: current,
      outputLines: first >= 0 && last >= first ? [first, last] : undefined,
    });
  };

  return {
    osc(code: number, data: string): boolean {
      const t0 = clock();
      stats.calls += 1;
      try {
        switch (code) {
          case 133: {
            detected();
            const kind = data[0];
            if (kind === "A") onPromptStart();
            else if (kind === "B") {
              /* prompt end: nothing to anchor — the command line follows */
            } else if (kind === "C") onOutputStart();
            else if (kind === "D") onCommandEnd(data.slice(2));
            return true;
          }
          case 633: {
            if (data.startsWith("E;")) {
              detected();
              pendingCmd = unescapeCommand(data.slice(2));
            }
            return true;
          }
          case 7: {
            const next = parseCwd(data);
            if (next !== undefined && next !== cwd) {
              cwd = next;
              hooks.onCwd?.(next);
            }
            return true;
          }
          case 52: {
            if (!options.clipboard()) return true;
            const text = parseClipboard(data);
            if (text !== undefined) hooks.onClipboard?.(text);
            return true;
          }
          default:
            return false;
        }
      } finally {
        stats.totalMs += clock() - t0;
      }
    },
    marks: () => marks,
    cwd: () => cwd,
    lastCompleted(): CommandMark | undefined {
      for (let i = marks.length - 1; i >= 0; i--) {
        if (marks[i].done && marks[i].durationMs !== undefined) return marks[i];
      }
      return undefined;
    },
    integrationSeen: () => seen,
    stats: () => stats,
    noteAltScreen(): void {
      const current = active();
      if (current && current.output !== undefined) current.usedAltScreen = true;
    },
    prune(keep = MAX_MARKS): void {
      let i = 0;
      while (i < marks.length && (marks[i].prompt.line < 0 || marks.length - i > keep)) {
        marks[i].prompt.dispose();
        marks[i].output?.dispose();
        i += 1;
      }
      if (i > 0) marks.splice(0, i);
    },
    dispose(): void {
      for (const mark of marks) {
        mark.prompt.dispose();
        mark.output?.dispose();
      }
      marks.length = 0;
    },
  };
}

/**
 * Finds the prompt to jump to from the viewport's top line.
 *
 * @param marks - The session's marks.
 * @param viewportTop - The first visible buffer line.
 * @param direction - `"up"` for the previous prompt, `"down"` for the next.
 * @returns The target buffer line, or `undefined` when there is none.
 * @example
 * ```ts
 * nextPromptLine(marks, 120, "up"); // the last prompt line < 120
 * ```
 */
export function nextPromptLine(
  marks: readonly CommandMark[],
  viewportTop: number,
  direction: "up" | "down",
): number | undefined {
  if (direction === "up") {
    for (let i = marks.length - 1; i >= 0; i--) {
      const line = marks[i].prompt.line;
      if (line >= 0 && line < viewportTop) return line;
    }
    return undefined;
  }
  for (const mark of marks) {
    const line = mark.prompt.line;
    if (line > viewportTop) return line;
  }
  return undefined;
}

/**
 * Formats a duration for marks, notifications, and history rows.
 *
 * @param ms - Milliseconds.
 * @returns `"850 ms"`, `"4.2 s"`, `"1m 05s"`, `"2h 03m"`.
 * @example
 * ```ts
 * formatDuration(65_000); // "1m 05s"
 * ```
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) {
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
