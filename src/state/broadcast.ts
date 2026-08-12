/**
 * Broadcast — the cssh (F4). Type once, land everywhere.
 *
 * Model: per tab, a "selection" of panes (click-to-toggle badges) and an
 * "armed" flag (⇧⌘B). While armed, input typed into any selected pane fans
 * out to every selected, running pane — implemented entirely in the
 * frontend at the pty-write boundary (PLAN.md §5: broadcast is frontend
 * fan-out). Typing into a deselected pane stays normal input.
 *
 * Multi-line pastes while broadcasting never fan out silently: the paste
 * is intercepted at the DOM level (xterm normalizes newlines before
 * `onData`, so detection must happen before xterm sees it) and routed
 * through the {@link PendingPaste} guard dialog. Phase 4 extends this
 * minimal guard to all pastes with dangerous-pattern detection (§5 log).
 */

import { create } from "zustand";
import { useSessions } from "./sessions";
import { findLeafBySession, leavesOf } from "./splits";
import { getSessionTerminal } from "../features/terminal/registry";
import { useToast } from "./toast";
import type { SessionMeta, Tab } from "./sessions";

/** A multi-line paste awaiting confirmation in the guard dialog (F4). */
export interface PendingPaste {
  /** The pane the paste landed in (fan-out re-resolves from it). */
  sessionId: string;
  /** The exact clipboard text. */
  text: string;
  /** How many sessions the paste will reach ("N sessions" warning). */
  targetCount: number;
}

/** Store shape + actions for broadcast selection, arming, and paste guard. */
export interface BroadcastState {
  /** Selected pane ids per tab (the broadcast set once armed). */
  selected: Record<string, string[]>;
  /** Whether broadcast is armed, per tab. */
  active: Record<string, boolean>;
  /** Disarm when the active tab changes (F4 safety, default on). */
  autoDisarm: boolean;
  /** The paste awaiting confirmation, or `null`. */
  pendingPaste: PendingPaste | null;
  /** Toggles a pane in the tab's selection (badge click; opt-out works mid-broadcast). */
  togglePaneSelected(tabId: string, paneId: string): void;
  /**
   * ⇧⌘B on the active tab: arms broadcast (selecting all panes when the
   * selection is empty — "all in tab"), or disarms if already armed. The
   * selection survives disarming, so re-arming reuses it.
   */
  toggleBroadcast(): void;
  /** Disarms a tab (auto-disarm on tab switch, or programmatic). */
  disarmTab(tabId: string): void;
  /** Sets the auto-disarm-on-tab-switch flag (persisted via state.json). */
  setAutoDisarm(value: boolean): void;
  /** Drops selection/armed entries for tabs and panes that no longer exist. */
  pruneAgainst(tabs: Tab[]): void;
  /** Opens the paste-guard dialog for a multi-line broadcast paste. */
  requestPasteGuard(pending: PendingPaste): void;
  /** Closes the dialog without pasting. */
  cancelPasteGuard(): void;
  /**
   * Confirms the guarded paste: the (possibly edited) text goes through the
   * focused pane's normal xterm paste path, so bracketed paste and the
   * fan-out resolver apply exactly as if it were typed.
   */
  confirmPasteGuard(text: string): void;
}

/** The broadcast store hook. */
export const useBroadcast = create<BroadcastState>((set, get) => ({
  selected: {},
  active: {},
  autoDisarm: true,
  pendingPaste: null,

  togglePaneSelected(tabId: string, paneId: string): void {
    set((state) => {
      const current = state.selected[tabId] ?? [];
      const next = current.includes(paneId)
        ? current.filter((id) => id !== paneId)
        : [...current, paneId];
      return { ...state, selected: { ...state.selected, [tabId]: next } };
    });
  },

  toggleBroadcast(): void {
    const sessions = useSessions.getState();
    const tab = sessions.tabs.find((t) => t.tabId === sessions.activeTabId);
    if (!tab) return;
    const isActive = get().active[tab.tabId] ?? false;
    if (isActive) {
      get().disarmTab(tab.tabId);
      return;
    }
    set((state) => {
      const current = state.selected[tab.tabId] ?? [];
      const selected =
        current.length > 0 ? current : leavesOf(tab.layout).map((l) => l.paneId);
      return {
        ...state,
        selected: { ...state.selected, [tab.tabId]: selected },
        active: { ...state.active, [tab.tabId]: true },
      };
    });
  },

  disarmTab(tabId: string): void {
    set((state) =>
      state.active[tabId]
        ? { ...state, active: { ...state.active, [tabId]: false } }
        : state,
    );
  },

  setAutoDisarm(value: boolean): void {
    set((state) => ({ ...state, autoDisarm: value }));
  },

  pruneAgainst(tabs: Tab[]): void {
    set((state) => {
      const selected: Record<string, string[]> = {};
      const active: Record<string, boolean> = {};
      let changed = false;
      for (const [tabId, paneIds] of Object.entries(state.selected)) {
        const tab = tabs.find((t) => t.tabId === tabId);
        if (!tab) {
          changed = true;
          continue;
        }
        const alive = new Set(leavesOf(tab.layout).map((l) => l.paneId));
        const kept = paneIds.filter((id) => alive.has(id));
        if (kept.length !== paneIds.length) changed = true;
        selected[tabId] = kept;
      }
      for (const [tabId, flag] of Object.entries(state.active)) {
        if (tabs.some((t) => t.tabId === tabId)) {
          active[tabId] = flag;
        } else {
          changed = true;
        }
      }
      return changed ? { ...state, selected, active } : state;
    });
  },

  requestPasteGuard(pending: PendingPaste): void {
    set((state) => ({ ...state, pendingPaste: pending }));
  },

  cancelPasteGuard(): void {
    set((state) => ({ ...state, pendingPaste: null }));
  },

  confirmPasteGuard(text: string): void {
    const pending = get().pendingPaste;
    if (!pending) return;
    set((state) => ({ ...state, pendingPaste: null }));
    getSessionTerminal(pending.sessionId)?.term.paste(text);
  },
}));

/** Minimum ms between "skipped dead panes" toasts (one per burst, F4). */
const DEAD_SKIP_TOAST_MS = 2000;

let lastDeadToastAt = 0;

/**
 * Whether pasted text needs the broadcast guard: any newline counts —
 * even a trailing one, since that would *execute* in every armed pane.
 *
 * @param text - The raw clipboard text (before xterm normalizes it).
 * @returns True when the paste is multi-line.
 */
export function pasteNeedsGuard(text: string): boolean {
  return /[\r\n]/.test(text);
}

/**
 * Resolves where a pane's input goes (the F4 fan-out): the pane itself
 * normally; every selected, running pane in its tab while broadcast is
 * armed and the source pane is selected. Skipped dead panes surface one
 * rate-limited toast per burst.
 *
 * Wired into the pty-write boundary by the terminal registry.
 *
 * @param sessionId - The session whose terminal received input.
 * @param options - `silent` suppresses the dead-pane toast (used by the
 * paste guard's dry resolution).
 * @returns Session ids to write to (always at least the source).
 */
export function resolvePtyWriteTargets(
  sessionId: string,
  options: { silent?: boolean } = {},
): string[] {
  const sessionsState = useSessions.getState();
  const tab = sessionsState.tabs.find((t) => findLeafBySession(t.layout, sessionId));
  if (!tab) return [sessionId];
  const broadcast = useBroadcast.getState();
  if (!(broadcast.active[tab.tabId] ?? false)) return [sessionId];
  const selected = broadcast.selected[tab.tabId] ?? [];
  const source = findLeafBySession(tab.layout, sessionId);
  if (!source || !selected.includes(source.paneId)) return [sessionId];
  const targets: string[] = [];
  let dead = 0;
  for (const paneLeaf of leavesOf(tab.layout)) {
    if (!selected.includes(paneLeaf.paneId)) continue;
    const meta = sessionsState.sessions.find((s) => s.sessionId === paneLeaf.sessionId);
    if (!meta || meta.status !== "running") {
      dead += 1;
      continue;
    }
    targets.push(paneLeaf.sessionId);
  }
  if (dead > 0 && !options.silent) {
    const now = Date.now();
    if (now - lastDeadToastAt >= DEAD_SKIP_TOAST_MS) {
      lastDeadToastAt = now;
      useToast
        .getState()
        .show(`Broadcast skipped ${dead} disconnected ${dead === 1 ? "pane" : "panes"}`);
    }
  }
  return targets.length > 0 ? targets : [sessionId];
}

/**
 * Counts the sessions an armed broadcast reaches in a tab (the status-bar
 * "Broadcasting to N" figure). Pure — callers pass subscribed slices.
 *
 * @param tab - The tab.
 * @param sessions - The open sessions.
 * @param selected - The tab's selected pane ids.
 * @returns Selected panes with running sessions.
 */
export function countBroadcastTargets(
  tab: Tab,
  sessions: SessionMeta[],
  selected: string[],
): number {
  return leavesOf(tab.layout).filter(
    (l) =>
      selected.includes(l.paneId) &&
      sessions.some((s) => s.sessionId === l.sessionId && s.status === "running"),
  ).length;
}

let autoDisarmWired = false;

/**
 * Subscribes broadcast housekeeping to the sessions store: auto-disarm on
 * tab switch (when the flag is on) and pruning of closed tabs/panes.
 * Idempotent; App calls it once on mount (a lazy hook avoids a
 * module-evaluation cycle with the sessions store).
 */
export function wireBroadcastHousekeeping(): void {
  if (autoDisarmWired) return;
  autoDisarmWired = true;
  let prevActiveTabId = useSessions.getState().activeTabId;
  let prevTabs = useSessions.getState().tabs;
  useSessions.subscribe((state) => {
    if (state.tabs !== prevTabs) {
      prevTabs = state.tabs;
      useBroadcast.getState().pruneAgainst(state.tabs);
    }
    if (state.activeTabId !== prevActiveTabId) {
      const left = prevActiveTabId;
      prevActiveTabId = state.activeTabId;
      if (left && useBroadcast.getState().autoDisarm) {
        useBroadcast.getState().disarmTab(left);
      }
    }
  });
}
