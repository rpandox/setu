/**
 * The action registry (F11, Phase 4) — the single source of truth for the
 * PLAN.md §8 keyboard map. Every implemented action is declared once here
 * with its shortcut matcher, palette title, and effect; the App keydown
 * handler dispatches through {@link dispatchShortcut} and the ⌘K palette
 * lists {@link paletteEntries}, so bindings and the palette can never
 * drift apart (a completeness test locks it).
 *
 * §8 rows whose features haven't landed (⇧⌘S SFTP → Phase 5, prompt jumps
 * → Phase 10, the quake hotkey and ⌘, settings → later phases) join the
 * registry in their phases; ⌘C/⌘V stay native to the terminal (PLAN.md §5,
 * Phase 4 row). The plain-⏎ reconnect (F3) is contextual, not a command —
 * it lives in the App handler.
 */

import { useBroadcast } from "./broadcast";
import { activeSessionOf, tabSessionOf, useSessions } from "./sessions";
import { useSftp } from "./sftp";
import type { FocusDirection } from "./splits";
import { useToast } from "./toast";
import { useUiChrome } from "./ui";

/** One §8 action: a palette row and (usually) a keyboard shortcut. */
export interface AppAction {
  /** Stable id (`"split-right"`); frecency keys and tests use it. */
  id: string;
  /** Palette row title, sentence case ("Split right"). */
  title: string;
  /** Display label for the shortcut ("⌘D"); shown, never parsed. */
  shortcut?: string;
  /** Whether a keydown event is this action's shortcut. */
  matches?(event: KeyboardEvent): boolean;
  /** Runs the action. The keydown event is passed for parametric actions. */
  perform(event?: KeyboardEvent): void;
  /**
   * Expands a parametric action into concrete palette rows (e.g. "Go to
   * tab N" per open tab). Actions without `expand` list as themselves.
   */
  expand?(): PaletteActionEntry[];
}

/** One concrete, runnable palette row. */
export interface PaletteActionEntry {
  /** The registry action's id (parametric rows suffix it, `go-to-tab:2`). */
  id: string;
  /** Row title. */
  title: string;
  /** Display label for the shortcut. */
  shortcut?: string;
  /** Runs the row's action. */
  perform(): void;
}

/**
 * True for a plain ⌘-shortcut: meta without ctrl/alt, shift as given.
 *
 * @param event - The keydown event.
 * @param key - The lowercase key to match.
 * @param shift - Whether shift must be held.
 */
function cmd(event: KeyboardEvent, key: string, shift: boolean): boolean {
  return (
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    event.shiftKey === shift &&
    event.key.toLowerCase() === key
  );
}

/** Arrow glyphs for the focus-pane shortcut labels. */
const ARROW_GLYPHS: Record<FocusDirection, string> = {
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
};

/**
 * The focus-pane action for one direction (four registry entries).
 *
 * @param direction - The pane-focus direction.
 * @param key - The arrow `event.key` for the matcher.
 */
function focusPaneAction(direction: FocusDirection, key: string): AppAction {
  return {
    id: `focus-pane-${direction}`,
    title: `Focus pane ${direction}`,
    shortcut: `⌥⌘${ARROW_GLYPHS[direction]}`,
    matches: (event) =>
      event.metaKey && event.altKey && !event.ctrlKey && event.key === key,
    perform: () => useSessions.getState().movePaneFocus(direction),
  };
}

/**
 * The registry: every implemented §8 action, in palette display order.
 * A fresh array per call — matchers and `perform` close over the stores,
 * not over captured state.
 *
 * @returns The action list.
 */
export function actionRegistry(): AppAction[] {
  return [
    {
      id: "quick-connect",
      title: "Quick connect…",
      shortcut: "⌘T",
      matches: (event) => cmd(event, "t", false),
      perform: () => useUiChrome.getState().togglePalette("hosts"),
    },
    {
      id: "command-palette",
      title: "Command palette",
      shortcut: "⌘K",
      matches: (event) => cmd(event, "k", false),
      perform: () => useUiChrome.getState().togglePalette("commands"),
    },
    {
      id: "new-local-tab",
      title: "New local tab",
      shortcut: "⌘N",
      matches: (event) => cmd(event, "n", false),
      perform: () => void useSessions.getState().openLocalTab(),
    },
    {
      id: "split-right",
      title: "Split right",
      shortcut: "⌘D",
      matches: (event) => cmd(event, "d", false),
      perform: () => void useSessions.getState().splitPane("row"),
    },
    {
      id: "split-down",
      title: "Split down",
      shortcut: "⇧⌘D",
      matches: (event) => cmd(event, "d", true),
      perform: () => void useSessions.getState().splitPane("col"),
    },
    {
      id: "close-pane",
      title: "Close pane",
      shortcut: "⌘W",
      matches: (event) => cmd(event, "w", false),
      perform: () => useSessions.getState().closePane(),
    },
    {
      id: "next-tab",
      title: "Next tab",
      shortcut: "⌃Tab",
      matches: (event) =>
        event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "Tab",
      perform: () => useSessions.getState().cycleActive(1),
    },
    {
      id: "previous-tab",
      title: "Previous tab",
      shortcut: "⌃⇧Tab",
      matches: (event) =>
        event.ctrlKey && !event.metaKey && event.shiftKey && event.key === "Tab",
      perform: () => useSessions.getState().cycleActive(-1),
    },
    {
      id: "go-to-tab",
      title: "Go to tab 1–9",
      shortcut: "⌘1–9",
      matches: (event) =>
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        /^[1-9]$/.test(event.key),
      perform: (event) => {
        if (!event) return; // Palette rows come from expand() instead.
        useSessions.getState().activateByIndex(Number(event.key) - 1);
      },
      expand: () => {
        const state = useSessions.getState();
        return state.tabs.slice(0, 9).map((tab, index) => {
          const title = tabSessionOf(state.sessions, tab)?.title;
          return {
            id: `go-to-tab:${index + 1}`,
            title: `Go to tab ${index + 1}${title ? ` — ${title}` : ""}`,
            shortcut: `⌘${index + 1}`,
            perform: () => state.activateByIndex(index),
          };
        });
      },
    },
    focusPaneAction("left", "ArrowLeft"),
    focusPaneAction("right", "ArrowRight"),
    focusPaneAction("up", "ArrowUp"),
    focusPaneAction("down", "ArrowDown"),
    {
      id: "toggle-broadcast",
      title: "Toggle broadcast",
      shortcut: "⇧⌘B",
      matches: (event) => cmd(event, "b", true),
      perform: () => useBroadcast.getState().toggleBroadcast(),
    },
    {
      id: "find-in-terminal",
      title: "Find in terminal",
      shortcut: "⇧⌘F",
      matches: (event) => cmd(event, "f", true),
      perform: () => useSessions.getState().openFind(),
    },
    {
      id: "toggle-sftp",
      title: "Toggle SFTP panel",
      shortcut: "⇧⌘S",
      matches: (event) => cmd(event, "s", true),
      perform: () => {
        const sftp = useSftp.getState();
        // The open panel toggles away regardless of what's focused now.
        if (sftp.open && sftp.hostId !== null) {
          sftp.toggleForHost(sftp.hostId, sftp.hostLabel);
          return;
        }
        const meta = activeSessionOf(useSessions.getState());
        if (!meta || meta.kind !== "ssh" || !meta.hostId || meta.orphaned) {
          useToast.getState().show("SFTP needs a focused SSH session");
          return;
        }
        sftp.toggleForHost(meta.hostId, meta.hostLabel ?? meta.title);
      },
    },
    {
      id: "toggle-sidebar",
      title: "Toggle sidebar",
      shortcut: "⌘/",
      matches: (event) => cmd(event, "/", false),
      perform: () => useUiChrome.getState().toggleSidebar(),
    },
  ];
}

/**
 * Flattens the registry into concrete palette rows: parametric actions
 * expand (one row per open tab), everything else lists as itself.
 *
 * @returns Palette rows in display order.
 */
export function paletteEntries(): PaletteActionEntry[] {
  return actionRegistry().flatMap((action) => {
    if (action.expand) return action.expand();
    return [
      {
        id: action.id,
        title: action.title,
        shortcut: action.shortcut,
        perform: () => action.perform(),
      },
    ];
  });
}

/**
 * Dispatches a keydown through the registry: the first matching action
 * runs. The caller preventDefaults on a hit.
 *
 * @param event - The window keydown (capture phase).
 * @returns Whether an action handled the event.
 */
export function dispatchShortcut(event: KeyboardEvent): boolean {
  for (const action of actionRegistry()) {
    if (action.matches?.(event)) {
      action.perform(event);
      return true;
    }
  }
  return false;
}
