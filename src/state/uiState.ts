/**
 * Frontend side of `state.json` (F4): loads the device-local UI state at
 * startup, hydrates the stores that own each piece (sidebar collapse,
 * broadcast auto-disarm, session restore), and persists changes back with a
 * debounce — the whole document, atomically, via `ui_state_set`.
 *
 * One-time migration: the Phase 2 localStorage key `setu.sidebar.collapsed`
 * seeds `state.json` on first load, then is removed (PLAN.md §5 decision
 * log).
 *
 * If `state.json` is corrupt, the app runs on defaults and persistence is
 * disabled for the run — the corrupt file is never overwritten (same
 * discipline as the hosts store).
 */

import { create } from "zustand";
import { ipcInvoke } from "../ipc/client";
import type { Host, SavedSplitNode, SavedTab, UiState } from "../ipc/contract";
import { useBroadcast } from "./broadcast";
import { useSessions, type RestoreNode, type SessionMeta, type Tab } from "./sessions";
import type { SplitNode } from "./splits";

/** The Phase 2 localStorage key migrated into `state.json` (§5 log). */
export const LEGACY_COLLAPSED_KEY = "setu.sidebar.collapsed";

/** Debounce for persisting state changes. */
const PERSIST_DEBOUNCE_MS = 500;

/** A fresh default document (mirrors the Rust `UiState::default`). */
export function defaultUiState(): UiState {
  return {
    version: 1,
    sidebar: { collapsedSections: [] },
    broadcastAutoDisarm: true,
    restoreOnLaunch: false,
    savedLayout: [],
  };
}

/** Store shape + actions for `state.json`-backed UI preferences. */
export interface UiPrefsState {
  /** Collapsed sidebar section keys (view state, device-local). */
  collapsedSections: string[];
  /** Whether the saved layout reopens on launch (F4, default off). */
  restoreOnLaunch: boolean;
  /** True once `state.json` has been loaded and stores are hydrated. */
  hydrated: boolean;
  /** Replaces the collapsed-section set (Sidebar toggles call this). */
  setCollapsedSections(sections: string[]): void;
  /** Sets the restore-on-launch opt-in. */
  setRestoreOnLaunch(value: boolean): void;
}

/** The UI-preferences store hook. */
export const useUiPrefs = create<UiPrefsState>((set) => ({
  collapsedSections: [],
  restoreOnLaunch: false,
  hydrated: false,
  setCollapsedSections(sections: string[]): void {
    set((state) => ({ ...state, collapsedSections: sections }));
  },
  setRestoreOnLaunch(value: boolean): void {
    set((state) => ({ ...state, restoreOnLaunch: value }));
  },
}));

/**
 * Serializes the live tabs into `state.json` layout form. Leaves keep their
 * connection target only: SSH panes save their `hostId`, local panes save
 * `null`. Exited panes save like running ones (restore respawns anyway).
 *
 * @param tabs - The open tabs.
 * @param sessions - The open sessions (to resolve leaves' hosts).
 * @returns The saved layout.
 */
export function serializeLayout(tabs: Tab[], sessions: SessionMeta[]): SavedTab[] {
  const toSaved = (node: SplitNode): SavedSplitNode => {
    if (node.kind === "split") {
      return {
        kind: "split",
        dir: node.dir,
        ratio: node.ratio,
        a: toSaved(node.a),
        b: toSaved(node.b),
      };
    }
    const meta = sessions.find((s) => s.sessionId === node.sessionId);
    return {
      kind: "leaf",
      hostId: meta?.kind === "ssh" ? (meta.hostId ?? null) : null,
    };
  };
  return tabs.map((tab) => ({ layout: toSaved(tab.layout) }));
}

/**
 * Prunes a saved tree against the restorable host set: SSH leaves survive
 * only when their host still exists with `source = "setu"`; local leaves
 * always survive (they restore as fresh shells, §5 log). Splits heal around
 * removed leaves exactly like live pane closes.
 *
 * @param node - The saved tree.
 * @param restorableHostIds - Ids of hosts that may be restored.
 * @returns The pruned tree, or `null` when nothing survived.
 */
export function pruneSavedLayout(
  node: SavedSplitNode,
  restorableHostIds: ReadonlySet<string>,
): SavedSplitNode | null {
  if (node.kind === "leaf") {
    if (node.hostId === null) return node;
    return restorableHostIds.has(node.hostId) ? node : null;
  }
  const a = pruneSavedLayout(node.a, restorableHostIds);
  const b = pruneSavedLayout(node.b, restorableHostIds);
  if (a && b) return { ...node, a, b };
  return a ?? b;
}

/**
 * Resolves a pruned saved tree into a {@link RestoreNode} plan with real
 * `Host` records on the leaves.
 *
 * @param node - The pruned saved tree (every SSH leaf's host must resolve).
 * @param hostsById - Host lookup.
 * @returns The restore plan, or `null` if a host vanished after pruning.
 */
export function toRestorePlan(
  node: SavedSplitNode,
  hostsById: ReadonlyMap<string, Host>,
): RestoreNode | null {
  if (node.kind === "leaf") {
    if (node.hostId === null) return { kind: "leaf", host: null };
    const host = hostsById.get(node.hostId);
    return host ? { kind: "leaf", host } : null;
  }
  const a = toRestorePlan(node.a, hostsById);
  const b = toRestorePlan(node.b, hostsById);
  if (!a || !b) return a ?? b;
  return { kind: "split", dir: node.dir, ratio: node.ratio, a, b };
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistDisabled = false;
let wired = false;

/** Builds the full document from the owning stores. */
function snapshot(): UiState {
  const prefs = useUiPrefs.getState();
  const sessions = useSessions.getState();
  return {
    version: 1,
    sidebar: { collapsedSections: prefs.collapsedSections },
    broadcastAutoDisarm: useBroadcast.getState().autoDisarm,
    restoreOnLaunch: prefs.restoreOnLaunch,
    savedLayout: serializeLayout(sessions.tabs, sessions.sessions),
  };
}

/** Writes the current snapshot now (best-effort; errors are dropped). */
async function persistNow(): Promise<void> {
  if (persistDisabled || !useUiPrefs.getState().hydrated) return;
  await ipcInvoke("ui_state_set", { state: snapshot() }).catch(() => undefined);
}

/** Schedules a debounced persist. */
function schedulePersist(): void {
  if (persistDisabled || !useUiPrefs.getState().hydrated) return;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Reads the legacy localStorage collapse set, if any.
 *
 * @returns The section keys, or `null` when the key is absent/malformed.
 */
function readLegacyCollapsed(): string[] | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(LEGACY_COLLAPSED_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
  } catch {
    return null;
  }
}

/**
 * Loads `state.json`, hydrates the owning stores, wires the debounced
 * persist subscriptions, and — when the opt-in is set — restores the saved
 * layout. Called once from App on mount; later calls are no-ops.
 *
 * Restore only respawns hosts that still exist with `source = "setu"`
 * (ssh_config/tailscale panes are pruned, layouts heal); local panes reopen
 * as fresh shells (§5 decision log).
 */
export async function initUiState(): Promise<void> {
  if (wired) return;
  wired = true;

  let state: UiState;
  try {
    state = await ipcInvoke("ui_state_get", {});
  } catch (error) {
    // Corrupt file: run on defaults, never overwrite it (store discipline).
    console.warn("state.json unreadable; running on defaults", error);
    state = defaultUiState();
    persistDisabled = true;
  }

  // One-time migration off localStorage (Phase 2 → 3, §5 log).
  const legacy = readLegacyCollapsed();
  if (legacy !== null) {
    if (state.sidebar.collapsedSections.length === 0) {
      state = { ...state, sidebar: { collapsedSections: legacy } };
    }
    if (!persistDisabled && typeof window !== "undefined") {
      window.localStorage.removeItem(LEGACY_COLLAPSED_KEY);
    }
  }

  useBroadcast.getState().setAutoDisarm(state.broadcastAutoDisarm);
  useUiPrefs.setState({
    collapsedSections: state.sidebar.collapsedSections,
    restoreOnLaunch: state.restoreOnLaunch,
    hydrated: true,
  });

  // Persist on change — layout (tabs), sidebar collapse, the auto-disarm
  // flag — and flush on the way out so quick quits keep the last layout.
  let prevTabs = useSessions.getState().tabs;
  useSessions.subscribe((s) => {
    if (s.tabs !== prevTabs) {
      prevTabs = s.tabs;
      schedulePersist();
    }
  });
  let prevPrefs = useUiPrefs.getState();
  useUiPrefs.subscribe((s) => {
    if (
      s.collapsedSections !== prevPrefs.collapsedSections ||
      s.restoreOnLaunch !== prevPrefs.restoreOnLaunch
    ) {
      prevPrefs = s;
      schedulePersist();
    }
  });
  let prevAutoDisarm = useBroadcast.getState().autoDisarm;
  useBroadcast.subscribe((s) => {
    if (s.autoDisarm !== prevAutoDisarm) {
      prevAutoDisarm = s.autoDisarm;
      schedulePersist();
    }
  });
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => void persistNow());
  }

  if (state.restoreOnLaunch && state.savedLayout.length > 0) {
    await restoreSavedLayout(state.savedLayout);
  }
}

/**
 * Restores saved tabs: prunes each tree against the current `setu` hosts,
 * resolves hosts, and rebuilds via the sessions store. Tabs whose panes all
 * pruned away are dropped.
 *
 * @param saved - The saved layout from `state.json`.
 */
async function restoreSavedLayout(saved: SavedTab[]): Promise<void> {
  let hosts: Host[];
  try {
    hosts = await ipcInvoke("hosts_list", {});
  } catch {
    return; // No host store, no restore — the empty state invites ⌘T.
  }
  const setuHosts = hosts.filter((h) => h.source === "setu");
  const restorable = new Set(setuHosts.map((h) => h.id));
  const byId = new Map(setuHosts.map((h) => [h.id, h]));
  for (const tab of saved) {
    const pruned = pruneSavedLayout(tab.layout, restorable);
    if (!pruned) continue;
    const plan = toRestorePlan(pruned, byId);
    if (!plan) continue;
    await useSessions.getState().restoreTab(plan);
  }
}

/**
 * Test hook: resets the module's wiring state (subscriptions themselves
 * are harmless to leave behind in tests; the flags gate re-entry).
 */
export function resetUiStateForTests(): void {
  wired = false;
  persistDisabled = false;
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

/** Test hook: whether persistence was disabled by a corrupt file. */
export function isPersistDisabledForTests(): boolean {
  return persistDisabled;
}
