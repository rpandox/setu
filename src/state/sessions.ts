/**
 * Session/tab state (F2, F3, F4) — the Zustand store behind the tab bar and
 * terminal area. Since Phase 3, a tab is a binary split tree of panes
 * ({@link Tab}); every pane renders one PTY session. State shape maps to
 * PLAN.md §9 F2/F3/F4.
 *
 * Terminal instances themselves live in the terminal registry, not here:
 * store state stays serializable metadata, and xterm objects survive React
 * re-renders on their own terms.
 */

import { create } from "zustand";
import type { Host } from "../ipc/contract";
import { ipcInvoke, onPtyExit } from "../ipc/client";
import { useToast } from "./toast";
import {
  createSessionTerminal,
  disposeSessionTerminal,
  getSessionTerminal,
  rebindSessionTerminal,
} from "../features/terminal/registry";
import {
  clampRatio,
  findLeaf,
  findLeafBySession,
  leaf,
  leavesOf,
  neighborPaneId,
  removeLeaf,
  setRatioAt,
  splitLeaf,
  swapSessionId,
  type FocusDirection,
  type SplitDir,
  type SplitNode,
  type SplitPath,
} from "./splits";

/**
 * A resolved restore plan for one tab (F4 session restore): the saved tree
 * with every leaf's host already looked up — `null` means a fresh local
 * shell. Built by the uiState module from `state.json` after pruning hosts
 * that no longer exist (or aren't `source="setu"`, per the §5 decision log).
 */
export type RestoreNode =
  | {
      /** One pane to respawn. */
      kind: "leaf";
      /** The host to reconnect, or `null` for a local shell. */
      host: Host | null;
    }
  | {
      /** Two children sharing the rectangle at `ratio`. */
      kind: "split";
      /** Orientation of the divide. */
      dir: SplitDir;
      /** Share of the rectangle given to `a`. */
      ratio: number;
      /** First child. */
      a: RestoreNode;
      /** Second child. */
      b: RestoreNode;
    };

/** Metadata for one open session (one pane). */
export interface SessionMeta {
  /** The PTY session id from `pty_spawn`. */
  sessionId: string;
  /**
   * Pane title; seeded from the host label (or "local"), then follows the
   * child's OSC 0/2 title escapes (F3). The tab shows its active pane's.
   */
  title: string;
  /** Session kind. */
  kind: "local" | "ssh";
  /** The connected host's id — `undefined` for local panes. */
  hostId?: string;
  /** The host label at connect time (reconnect/duplicate/split reuse it). */
  hostLabel?: string;
  /** The host's identity hue 0–7 (tab underline); `undefined` for local. */
  hue?: number;
  /** Whether the child is still running. */
  status: "running" | "exited";
  /** Exit code once exited (`null` = signal death). */
  exitCode: number | null;
  /**
   * True when the session's host was deleted mid-session (F1: sessions
   * stay alive, tabs mark "(orphaned)").
   */
  orphaned?: boolean;
}

/** One tab: a split tree of panes and the pane holding keyboard focus (F4). */
export interface Tab {
  /** Stable tab identity (tab strip keys, activation). */
  tabId: string;
  /** The binary split tree; every leaf is one pane. */
  layout: SplitNode;
  /** The focused pane — ⌥⌘-arrows move it, input routes to it. */
  activePaneId: string;
}

/** Store shape + actions for sessions, tabs, panes, and tab UI state. */
export interface SessionsState {
  /** Every open session (pane), across all tabs. */
  sessions: SessionMeta[];
  /** Open tabs, in tab-strip order. */
  tabs: Tab[];
  /** The focused tab, or `null` when none are open. */
  activeTabId: string | null;
  /** Whether the find bar (⇧⌘F) is showing for the active pane. */
  findOpen: boolean;
  /**
   * Bumped every time ⇧⌘F fires — including while the bar is already open,
   * where the bar refocuses and reselects instead of closing.
   */
  findFocusSeq: number;
  /** Spawns a local shell in a fresh tab and focuses it. */
  /**
   * Opens a fresh local shell tab.
   *
   * @returns The new session's id (so helpers like ssh-copy-id can write
   * a command into the pane — the Phase 6 `openSshTab` precedent).
   */
  openLocalTab(): Promise<string>;
  /**
   * Spawns `ssh` (or `mosh`, per the host's toggle — Phase 7) to a host in
   * a fresh tab and focuses it. Returns the new session's id so callers
   * can write into the pane — the F6 "run snippet as new tabs" path
   * (PLAN.md §5, Phase 6 row) — or `null` when the mosh preflight blocked
   * the connect (a toast already explained why).
   */
  openSshTab(host: Host): Promise<string | null>;
  /**
   * Reconnects an exited SSH pane in place: fresh PTY, same xterm and same
   * pane (scrollback survives). No-op for running panes, local panes, and
   * unknown ids (F3).
   */
  reconnect(sessionId: string): Promise<void>;
  /** Reconnects every exited SSH pane ("Reconnect all", F3). */
  reconnectAll(): Promise<void>;
  /**
   * Opens a new tab with a second session to the tab's active pane's host
   * ("Duplicate tab", F3). SSH panes only; orphaned panes refuse.
   */
  duplicateTab(tabId: string): Promise<void>;
  /** Flags every session on `hostId` as orphaned (its host was deleted). */
  markOrphaned(hostId: string): void;
  /** Closes a whole tab: kills every pane's PTY and removes them all. */
  closeTab(tabId: string): void;
  /**
   * Splits the active pane (⌘D right, ⇧⌘D down): spawns a sibling session —
   * same host for SSH panes, a fresh shell for local ones — and focuses the
   * new pane. Orphaned SSH panes refuse (their host is gone).
   */
  splitPane(dir: SplitDir): Promise<void>;
  /**
   * Closes the active pane (⌘W): kills its PTY; the layout heals around it
   * (F4). Closing a tab's last pane closes the tab.
   */
  closePane(): void;
  /** Focuses a pane (and its tab). No-op for unknown ids. */
  focusPane(tabId: string, paneId: string): void;
  /** Moves pane focus within the active tab (⌥⌘-arrows, F4). */
  movePaneFocus(direction: FocusDirection): void;
  /** Sets a split's ratio (divider drag). `path` addresses the split. */
  setSplitRatio(tabId: string, path: SplitPath, ratio: number): void;
  /**
   * Rebuilds one saved tab (F4 session restore): spawns a session per leaf
   * and reassembles the split tree with its saved ratios. A pane whose
   * spawn fails opens exited — showing the normal exit/Reconnect notice —
   * so one unreachable host never blocks the launch.
   */
  restoreTab(spec: RestoreNode): Promise<void>;
  /** Focuses a tab by id (no-op for unknown ids). */
  setActive(tabId: string): void;
  /** Focuses a tab by position (⌘1–9); out-of-range is a no-op. */
  activateByIndex(index: number): void;
  /** Cycles the active tab (⌃Tab / ⌃⇧Tab). */
  cycleActive(direction: 1 | -1): void;
  /** Opens the find bar — or, when already open, refocuses it (⇧⌘F). */
  openFind(): void;
  /** Closes the find bar (Esc or the ✕ button). */
  closeFind(): void;
}

/** Exit unsubscribers by session — imperative handles, kept out of state. */
const exitUnsubscribers = new Map<string, () => void>();

let idSeq = 0;

/**
 * Mints a unique pane/tab id — unique within and across sessions (restore
 * regenerates ids, so only collision-freedom matters, not stability).
 *
 * @param prefix - "tab" or "pane", for debuggability.
 * @returns The id.
 */
function newId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The active tab, derived. Exported for components and the keyboard map.
 *
 * @param state - The sessions store state.
 * @returns The active tab, or `undefined` when no tabs are open.
 */
export function activeTabOf(state: SessionsState): Tab | undefined {
  return state.tabs.find((t) => t.tabId === state.activeTabId);
}

/**
 * A tab's active pane's session metadata, derived (tab title, hue, and the
 * tab context menu all follow the active pane). Takes the sessions array —
 * not the whole state — so components can keep their selections narrow.
 *
 * @param sessions - The open sessions ({@link SessionsState.sessions}).
 * @param tab - The tab.
 * @returns The active pane's metadata, or `undefined` when the tab is gone.
 */
export function tabSessionOf(sessions: SessionMeta[], tab: Tab): SessionMeta | undefined {
  const paneLeaf = findLeaf(tab.layout, tab.activePaneId);
  if (!paneLeaf) return undefined;
  return sessions.find((s) => s.sessionId === paneLeaf.sessionId);
}

/**
 * The focused session (active pane of the active tab), derived.
 *
 * @param state - The sessions store state.
 * @returns The focused session's metadata, or `undefined`.
 */
export function activeSessionOf(state: SessionsState): SessionMeta | undefined {
  const tab = activeTabOf(state);
  return tab ? tabSessionOf(state.sessions, tab) : undefined;
}

/**
 * The sessions store hook. Select narrowly in components
 * (`useSessions((s) => s.tabs)`) to keep re-renders scoped.
 */
export const useSessions = create<SessionsState>((set, get) => {
  /**
   * Removes a pane's session everywhere: terminal + listeners torn down,
   * meta dropped, and its leaf pruned from the owning tab — the layout
   * heals; a tab losing its last pane closes (F4).
   *
   * @param sessionId - The session to remove.
   */
  const removePane = (sessionId: string): void => {
    exitUnsubscribers.get(sessionId)?.();
    exitUnsubscribers.delete(sessionId);
    disposeSessionTerminal(sessionId);
    set((state) => {
      const sessions = state.sessions.filter((s) => s.sessionId !== sessionId);
      const tabIndex = state.tabs.findIndex((t) =>
        findLeafBySession(t.layout, sessionId),
      );
      if (tabIndex === -1) return { ...state, sessions };
      const tab = state.tabs[tabIndex];
      const removed = findLeafBySession(tab.layout, sessionId);
      if (!removed) return { ...state, sessions };
      const healed = removeLeaf(tab.layout, removed.paneId);
      if (healed === null) {
        // Last pane: the tab goes with it; focus slides to the next slot.
        const tabs = state.tabs.filter((t) => t.tabId !== tab.tabId);
        let activeTabId = state.activeTabId;
        if (activeTabId === tab.tabId) {
          const next = tabs[tabIndex] ?? tabs[tabs.length - 1];
          activeTabId = next ? next.tabId : null;
        }
        return { ...state, sessions, tabs, activeTabId };
      }
      const activePaneId =
        tab.activePaneId === removed.paneId
          ? leavesOf(healed)[0].paneId
          : tab.activePaneId;
      const tabs = state.tabs.map((t) =>
        t.tabId === tab.tabId ? { ...t, layout: healed, activePaneId } : t,
      );
      return { ...state, sessions, tabs };
    });
  };

  /**
   * Applies a child exit: clean exits close the pane, failures keep it.
   *
   * @param sessionId - The session whose child exited.
   * @param code - Exit code, or `null` for a signal death.
   */
  const handleExit = (sessionId: string, code: number | null): void => {
    if (!get().sessions.some((s) => s.sessionId === sessionId)) return;
    if (code === 0) {
      removePane(sessionId);
      return;
    }
    // Non-zero (or signal) exit: keep the pane so output stays inspectable;
    // the pane shows an exit notice — with Reconnect for SSH (F3).
    set((state) => ({
      ...state,
      sessions: state.sessions.map((s) =>
        s.sessionId === sessionId
          ? { ...s, status: "exited" as const, exitCode: code }
          : s,
      ),
    }));
  };

  /**
   * Shared tail of every spawn: create the terminal, follow title escapes,
   * and subscribe to exit. Placement into a tab happens separately.
   *
   * @param meta - The new session's metadata (already spawned).
   */
  const wireSession = async (meta: SessionMeta): Promise<void> => {
    const { sessionId } = meta;
    const handle = await createSessionTerminal(sessionId);
    handle.term.onTitleChange((title) => {
      set((state) => ({
        ...state,
        sessions: state.sessions.map((s) =>
          s.sessionId === sessionId ? { ...s, title } : s,
        ),
      }));
    });
    const unlisten = await onPtyExit(sessionId, ({ code }) => {
      handleExit(sessionId, code);
    });
    exitUnsubscribers.set(sessionId, unlisten);
  };

  /**
   * Adds a wired session as a fresh single-pane tab and focuses it.
   *
   * @param meta - The session to place.
   */
  const placeAsTab = (meta: SessionMeta): void => {
    set((state) => {
      const paneId = newId("pane");
      const tab: Tab = {
        tabId: newId("tab"),
        layout: leaf(paneId, meta.sessionId),
        activePaneId: paneId,
      };
      return {
        ...state,
        sessions: [...state.sessions, meta],
        tabs: [...state.tabs, tab],
        activeTabId: tab.tabId,
      };
    });
  };

  /**
   * Adds a wired session as a new pane splitting `targetPaneId`, focusing
   * the new pane. If the target vanished while the spawn was in flight
   * (tab closed mid-await), the session falls back to its own tab rather
   * than leaking invisibly.
   *
   * @param meta - The session to place.
   * @param tabId - The tab being split.
   * @param targetPaneId - The pane being split.
   * @param dir - Split orientation.
   */
  const placeAsSplit = (
    meta: SessionMeta,
    tabId: string,
    targetPaneId: string,
    dir: SplitDir,
  ): void => {
    const target = get().tabs.find((t) => t.tabId === tabId);
    if (!target || !findLeaf(target.layout, targetPaneId)) {
      placeAsTab(meta);
      return;
    }
    set((state) => {
      const paneId = newId("pane");
      const tabs = state.tabs.map((t) =>
        t.tabId === tabId
          ? {
              ...t,
              layout: splitLeaf(
                t.layout,
                targetPaneId,
                dir,
                leaf(paneId, meta.sessionId),
              ),
              activePaneId: paneId,
            }
          : t,
      );
      return { ...state, sessions: [...state.sessions, meta], tabs };
    });
  };

  /**
   * Picks the spawn kind for a host: `"mosh"` when the host prefers it
   * AND the binary exists (F3 mosh row, Phase 7). The host record is
   * looked up live, so reconnects/duplicates/splits honor edits made
   * after a session opened. A missing mosh toasts and returns `null` —
   * never a silent fallback to ssh (PLAN.md §5).
   *
   * @param hostId - The host about to be spawned.
   * @returns The pty_spawn kind, or `null` when the connect must not run.
   */
  const spawnKindFor = async (hostId: string): Promise<"ssh" | "mosh" | null> => {
    // Dynamic import: hosts.ts imports this module, so a static import
    // back would be a cycle.
    const { useHosts } = await import("./hosts");
    const host = useHosts.getState().hosts.find((h) => h.id === hostId);
    if (host === undefined || !host.use_mosh) return "ssh";
    try {
      const { found } = await ipcInvoke("binary_check", { name: "mosh" });
      if (found) return "mosh";
    } catch {
      // Treated as not-found; the toast below says what to do.
    }
    useToast
      .getState()
      .show(
        "mosh isn't installed — brew install mosh, or turn the host's mosh toggle off",
        "error",
      );
    return null;
  };

  /**
   * Spawns `ssh` (or `mosh`, per the host's toggle) to a host and opens it
   * in a fresh tab — the shared engine behind
   * {@link SessionsState.openSshTab} and
   * {@link SessionsState.duplicateTab}.
   *
   * @param hostId - The host to connect to.
   * @param hostLabel - Label to seed the pane title with.
   * @param hue - The host's identity hue.
   * @returns The new session's id, or `null` when the mosh preflight
   * blocked the connect (the toast already explained why).
   */
  const openSsh = async (
    hostId: string,
    hostLabel: string,
    hue: number,
  ): Promise<string | null> => {
    const kind = await spawnKindFor(hostId);
    if (kind === null) return null;
    // 80×24 is a placeholder; the pane fits and resizes right after open.
    const { sessionId } = await ipcInvoke("pty_spawn", {
      kind,
      hostId,
      cols: 80,
      rows: 24,
    });
    const meta: SessionMeta = {
      sessionId,
      title: hostLabel,
      kind: "ssh",
      hostId,
      hostLabel,
      hue,
      status: "running",
      exitCode: null,
    };
    await wireSession(meta);
    placeAsTab(meta);
    return sessionId;
  };

  return {
    sessions: [],
    tabs: [],
    activeTabId: null,
    findOpen: false,
    findFocusSeq: 0,

    async openLocalTab(): Promise<string> {
      const { sessionId } = await ipcInvoke("pty_spawn", {
        kind: "local",
        cols: 80,
        rows: 24,
      });
      const meta: SessionMeta = {
        sessionId,
        title: "local",
        kind: "local",
        status: "running",
        exitCode: null,
      };
      await wireSession(meta);
      placeAsTab(meta);
      return sessionId;
    },

    async openSshTab(host: Host): Promise<string | null> {
      return openSsh(host.id, host.label, host.hue);
    },

    async reconnect(sessionId: string): Promise<void> {
      const meta = get().sessions.find((s) => s.sessionId === sessionId);
      if (!meta || meta.status !== "exited" || meta.kind !== "ssh" || !meta.hostId) {
        return;
      }
      const kind = await spawnKindFor(meta.hostId);
      if (kind === null) return; // the pane stays exited; the toast said why
      const handle = getSessionTerminal(sessionId);
      const { sessionId: newSessionId } = await ipcInvoke("pty_spawn", {
        kind,
        hostId: meta.hostId,
        // Reuse the terminal's real size; the pane refits right after anyway.
        cols: handle?.term.cols ?? 80,
        rows: handle?.term.rows ?? 24,
      });
      const rebound = await rebindSessionTerminal(sessionId, newSessionId);
      if (!rebound) return;
      exitUnsubscribers.get(sessionId)?.();
      exitUnsubscribers.delete(sessionId);
      const unlisten = await onPtyExit(newSessionId, ({ code }) => {
        handleExit(newSessionId, code);
      });
      exitUnsubscribers.set(newSessionId, unlisten);
      set((state) => ({
        ...state,
        sessions: state.sessions.map((s) =>
          s.sessionId === sessionId
            ? {
                ...s,
                sessionId: newSessionId,
                status: "running" as const,
                exitCode: null,
              }
            : s,
        ),
        // The pane keeps its id; only the leaf's session changes (F4).
        tabs: state.tabs.map((t) => {
          const layout = swapSessionId(t.layout, sessionId, newSessionId);
          return layout === t.layout ? t : { ...t, layout };
        }),
      }));
      rebound.term.focus();
    },

    async reconnectAll(): Promise<void> {
      const exited = get()
        .sessions.filter((s) => s.status === "exited" && s.kind === "ssh")
        .map((s) => s.sessionId);
      for (const sessionId of exited) {
        await get().reconnect(sessionId);
      }
    },

    async duplicateTab(tabId: string): Promise<void> {
      const state = get();
      const tab = state.tabs.find((t) => t.tabId === tabId);
      if (!tab) return;
      const meta = tabSessionOf(state.sessions, tab);
      if (!meta || meta.kind !== "ssh" || !meta.hostId || meta.orphaned) return;
      await openSsh(meta.hostId, meta.hostLabel ?? meta.title, meta.hue ?? 0);
    },

    markOrphaned(hostId: string): void {
      set((state) => ({
        ...state,
        sessions: state.sessions.map((s) =>
          s.hostId === hostId ? { ...s, orphaned: true } : s,
        ),
      }));
    },

    closeTab(tabId: string): void {
      const tab = get().tabs.find((t) => t.tabId === tabId);
      if (!tab) return;
      // Remove the UI immediately; the backend kill is idempotent, so this
      // can never race the children's own exits.
      for (const paneLeaf of leavesOf(tab.layout)) {
        void ipcInvoke("pty_kill", { sessionId: paneLeaf.sessionId }).catch(
          () => undefined,
        );
        removePane(paneLeaf.sessionId);
      }
    },

    async splitPane(dir: SplitDir): Promise<void> {
      const state = get();
      const tab = activeTabOf(state);
      if (!tab) return;
      const target = findLeaf(tab.layout, tab.activePaneId);
      if (!target) return;
      const meta = state.sessions.find((s) => s.sessionId === target.sessionId);
      if (!meta) return;
      let spawned: SessionMeta;
      if (meta.kind === "ssh") {
        if (!meta.hostId || meta.orphaned) return;
        const kind = await spawnKindFor(meta.hostId);
        if (kind === null) return; // no split; the toast said why
        const { sessionId } = await ipcInvoke("pty_spawn", {
          kind,
          hostId: meta.hostId,
          cols: 80,
          rows: 24,
        });
        spawned = {
          sessionId,
          title: meta.hostLabel ?? meta.title,
          kind: "ssh",
          hostId: meta.hostId,
          hostLabel: meta.hostLabel,
          hue: meta.hue,
          status: "running",
          exitCode: null,
        };
      } else {
        const { sessionId } = await ipcInvoke("pty_spawn", {
          kind: "local",
          cols: 80,
          rows: 24,
        });
        spawned = {
          sessionId,
          title: "local",
          kind: "local",
          status: "running",
          exitCode: null,
        };
      }
      await wireSession(spawned);
      placeAsSplit(spawned, tab.tabId, target.paneId, dir);
    },

    closePane(): void {
      const state = get();
      const tab = activeTabOf(state);
      if (!tab) return;
      const target = findLeaf(tab.layout, tab.activePaneId);
      if (!target) return;
      void ipcInvoke("pty_kill", { sessionId: target.sessionId }).catch(() => undefined);
      removePane(target.sessionId);
    },

    async restoreTab(spec: RestoreNode): Promise<void> {
      const metas: SessionMeta[] = [];
      const build = async (node: RestoreNode): Promise<SplitNode> => {
        if (node.kind === "split") {
          const a = await build(node.a);
          const b = await build(node.b);
          return { kind: "split", dir: node.dir, ratio: clampRatio(node.ratio), a, b };
        }
        let meta: SessionMeta;
        if (node.host) {
          let sessionId: string;
          let status: SessionMeta["status"] = "running";
          // A blocked mosh preflight fails like any dead spawn — no
          // silent ssh fallback; the pane opens exited with the normal
          // Reconnect notice.
          const kind = await spawnKindFor(node.host.id);
          try {
            if (kind === null) throw new Error("mosh preflight blocked the restore");
            ({ sessionId } = await ipcInvoke("pty_spawn", {
              kind,
              hostId: node.host.id,
              cols: 80,
              rows: 24,
            }));
          } catch {
            // Spawn failed (host gone, ssh missing…): the pane opens exited
            // with the normal Reconnect notice instead of blocking launch.
            sessionId = newId("dead");
            status = "exited";
          }
          meta = {
            sessionId,
            title: node.host.label,
            kind: "ssh",
            hostId: node.host.id,
            hostLabel: node.host.label,
            hue: node.host.hue,
            status,
            exitCode: null,
          };
        } else {
          let sessionId: string;
          let status: SessionMeta["status"] = "running";
          try {
            ({ sessionId } = await ipcInvoke("pty_spawn", {
              kind: "local",
              cols: 80,
              rows: 24,
            }));
          } catch {
            sessionId = newId("dead");
            status = "exited";
          }
          meta = { sessionId, title: "local", kind: "local", status, exitCode: null };
        }
        await wireSession(meta);
        metas.push(meta);
        return leaf(newId("pane"), meta.sessionId);
      };
      const layout = await build(spec);
      set((state) => {
        const tab: Tab = {
          tabId: newId("tab"),
          layout,
          activePaneId: leavesOf(layout)[0].paneId,
        };
        return {
          ...state,
          sessions: [...state.sessions, ...metas],
          tabs: [...state.tabs, tab],
          // The first restored tab takes focus; later ones stay behind it.
          activeTabId: state.activeTabId ?? tab.tabId,
        };
      });
    },

    focusPane(tabId: string, paneId: string): void {
      const tab = get().tabs.find((t) => t.tabId === tabId);
      if (!tab || !findLeaf(tab.layout, paneId)) return;
      set((state) => ({
        ...state,
        activeTabId: tabId,
        tabs: state.tabs.map((t) =>
          t.tabId === tabId ? { ...t, activePaneId: paneId } : t,
        ),
      }));
    },

    movePaneFocus(direction: FocusDirection): void {
      const tab = activeTabOf(get());
      if (!tab) return;
      const next = neighborPaneId(tab.layout, tab.activePaneId, direction);
      if (next) get().focusPane(tab.tabId, next);
    },

    setSplitRatio(tabId: string, path: SplitPath, ratio: number): void {
      set((state) => ({
        ...state,
        tabs: state.tabs.map((t) =>
          t.tabId === tabId ? { ...t, layout: setRatioAt(t.layout, path, ratio) } : t,
        ),
      }));
    },

    setActive(tabId: string): void {
      if (get().tabs.some((t) => t.tabId === tabId)) {
        set((state) => ({ ...state, activeTabId: tabId }));
      }
    },

    activateByIndex(index: number): void {
      const tab = get().tabs[index];
      if (tab) {
        set((state) => ({ ...state, activeTabId: tab.tabId }));
      }
    },

    cycleActive(direction: 1 | -1): void {
      const { tabs, activeTabId } = get();
      if (tabs.length === 0) return;
      const current = tabs.findIndex((t) => t.tabId === activeTabId);
      const next = (current + direction + tabs.length) % tabs.length;
      set((state) => ({ ...state, activeTabId: tabs[next].tabId }));
    },

    openFind(): void {
      // Always bump the sequence: a bar that is already open refocuses on
      // the change instead of toggling closed (matching every other find UI).
      set((state) => ({
        ...state,
        findOpen: true,
        findFocusSeq: state.findFocusSeq + 1,
      }));
    },

    closeFind(): void {
      set((state) => ({ ...state, findOpen: false }));
    },
  };
});
