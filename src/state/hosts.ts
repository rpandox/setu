/**
 * Host state (F1) — the Zustand store behind the sidebar, the HostEditor
 * drawer, and ⌘T quick connect. Wraps the `hosts_*` IPC family; every
 * mutation refetches `hosts_list` so imported `~/.ssh/config` rows stay in
 * sync with what the Rust core sees.
 */

import Fuse, { type IFuseOptions } from "fuse.js";
import { create } from "zustand";
import { ipcInvoke } from "../ipc/client";
import type { FrecencyEntry, Host, HostFieldError } from "../ipc/contract";
import { frecencyScore, hostSubject } from "./frecency";
import { useSessions } from "./sessions";

/**
 * What the HostEditor drawer is doing: closed, creating, or editing the
 * host with the given id.
 */
export type EditorTarget = null | "new" | string;

/** Store shape + actions for hosts and the editor drawer. */
export interface HostsState {
  /** All known hosts: persisted records plus live `~/.ssh/config` rows. */
  hosts: Host[];
  /** Error from the last `hosts_list` (e.g. a corrupt `hosts.toml`). */
  loadError: string | null;
  /** Sidebar search query (fuzzy, via fuse.js). */
  query: string;
  /** What the HostEditor drawer is showing. */
  editorTarget: EditorTarget;
  /** Loads (or reloads) the host list from the core. */
  load(): Promise<void>;
  /** Sets the sidebar search query. */
  setQuery(query: string): void;
  /** Opens the editor drawer to create (`"new"`) or edit (a host id). */
  openEditor(target: Exclude<EditorTarget, null>): void;
  /** Closes the editor drawer. */
  closeEditor(): void;
  /**
   * Validates and saves a draft. On success the drawer closes and the list
   * reloads; on validation failure the errors come back for inline display.
   */
  saveHost(draft: Host): Promise<HostFieldError[]>;
  /** Deletes a host (idempotent) and reloads the list. */
  deleteHost(hostId: string): Promise<void>;
  /** Adopts an `sshcfg:` row into `hosts.toml` and reloads the list. */
  adoptHost(hostId: string): Promise<void>;
}

/**
 * The hosts store hook. Select narrowly in components
 * (`useHosts((s) => s.hosts)`) to keep re-renders scoped.
 */
export const useHosts = create<HostsState>((set, get) => ({
  hosts: [],
  loadError: null,
  query: "",
  editorTarget: null,

  async load(): Promise<void> {
    try {
      const hosts = await ipcInvoke("hosts_list", {});
      set((state) => ({ ...state, hosts, loadError: null }));
    } catch (error) {
      set((state) => ({ ...state, loadError: String(error) }));
    }
  },

  setQuery(query: string): void {
    set((state) => ({ ...state, query }));
  },

  openEditor(target: Exclude<EditorTarget, null>): void {
    set((state) => ({ ...state, editorTarget: target }));
  },

  closeEditor(): void {
    set((state) => ({ ...state, editorTarget: null }));
  },

  async saveHost(draft: Host): Promise<HostFieldError[]> {
    const result = await ipcInvoke("host_upsert", { host: draft });
    if (result.errors && result.errors.length > 0) {
      return result.errors;
    }
    set((state) => ({ ...state, editorTarget: null }));
    await get().load();
    return [];
  },

  async deleteHost(hostId: string): Promise<void> {
    await ipcInvoke("host_delete", { hostId });
    // Live sessions to the host keep running; their tabs mark "(orphaned)"
    // (F1 edge case).
    useSessions.getState().markOrphaned(hostId);
    set((state) => ({
      ...state,
      editorTarget: state.editorTarget === hostId ? null : state.editorTarget,
    }));
    await get().load();
  },

  async adoptHost(hostId: string): Promise<void> {
    await ipcInvoke("host_adopt", { hostId });
    await get().load();
  },
}));

/**
 * A blank draft for the "new host" editor, matching the Rust defaults.
 *
 * @returns A fresh {@link Host} with an empty id (upsert assigns the UUID).
 */
export function emptyHostDraft(): Host {
  return {
    id: "",
    label: "",
    group: "",
    tags: [],
    hue: 0,
    hostname: "",
    user: "",
    port: 22,
    identity: "agent",
    use_mosh: false,
    startup: "",
    control_master: false,
    reachability: true,
    forwards: [],
    health: { enabled: false, interval_s: 30 },
    notes: "",
    favorite: false,
    source: "setu",
  };
}

/**
 * The tuned fuse.js options (Phase 4): match ranking label \> hostname \>
 * tags \> user (F1), threshold tightened from the Phase 2 seed's 0.4 so
 * short queries stop matching everything vaguely similar.
 */
const FUSE_OPTIONS: IFuseOptions<Host> = {
  keys: [
    { name: "label", weight: 1 },
    { name: "hostname", weight: 0.6 },
    { name: "tags", weight: 0.4 },
    { name: "user", weight: 0.3 },
  ],
  threshold: 0.35,
  ignoreLocation: true,
  includeScore: true,
};

/**
 * Fuzzy-searches hosts, ranking matches label \> hostname \> tags \> user
 * (F1). Pure so ranking is unit-testable. The sidebar filter uses this;
 * the palette blends in frecency via {@link rankHosts}.
 *
 * @param hosts - The hosts to search.
 * @param query - The user's query; empty returns `hosts` unchanged.
 * @returns Matches, best first.
 * @example
 * ```ts
 * searchHosts(hosts, "her"); // → [hermes, ...]
 * ```
 */
export function searchHosts(hosts: Host[], query: string): Host[] {
  const trimmed = query.trim();
  if (trimmed === "") return hosts;
  return new Fuse(hosts, FUSE_OPTIONS).search(trimmed).map((result) => result.item);
}

/**
 * Palette host ranking (F11): fuzzy match blended with frecency. With a
 * query, each fuse score (lower = better) shrinks by the host's frecency
 * boost, so the machines you actually connect to win near-ties; with an
 * empty query, hosts order by frecency (favorites break ties), which makes
 * ⌘T's initial list your most-used hosts.
 *
 * @param hosts - The hosts to rank.
 * @param query - The palette query; may be empty.
 * @param frecency - Frecency records from `state.json` (F11).
 * @param now - Epoch ms of "now" (injectable for tests).
 * @returns Hosts, best first.
 */
export function rankHosts(
  hosts: Host[],
  query: string,
  frecency: Record<string, FrecencyEntry>,
  now: number = Date.now(),
): Host[] {
  const boostOf = (host: Host): number => frecencyScore(frecency[hostSubject(host.id)], now);
  const trimmed = query.trim();
  if (trimmed === "") {
    return [...hosts].sort((a, b) => {
      const boost = boostOf(b) - boostOf(a);
      if (boost !== 0) return boost;
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }
  return new Fuse(hosts, FUSE_OPTIONS)
    .search(trimmed)
    .map((result) => ({
      host: result.item,
      // Fuse scores are 0 (perfect) … 1 (barely); dividing by 1 + log2(1 +
      // boost) pulls frequently-used hosts up without letting a huge use
      // count overrule a clearly better textual match.
      score: (result.score ?? 0) / (1 + Math.log2(1 + boostOf(result.item))),
    }))
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.host);
}

/**
 * The plain `ssh` invocation for a host — the "Copy ssh command" row action
 * (F1). Imported rows are their alias; Setu rows spell out the flags.
 *
 * @param host - The host to render.
 * @returns A shell-ready command string.
 * @example
 * ```ts
 * sshCommandOf(host); // "ssh -p 2222 pandox@hermes.example.net"
 * ```
 */
export function sshCommandOf(host: Host): string {
  if (host.source === "ssh_config") {
    return `ssh ${host.label}`;
  }
  const parts = ["ssh"];
  if (host.port !== 22) parts.push("-p", String(host.port));
  if (host.identity !== "agent" && host.identity.trim() !== "") {
    parts.push("-i", host.identity);
  }
  parts.push(host.user ? `${host.user}@${host.hostname}` : host.hostname);
  return parts.join(" ");
}

/**
 * Finds hosts that would collide with `draft` on `user@hostname:port` — the
 * F1 duplicate warning (non-blocking; the editor shows it, saving is still
 * allowed).
 *
 * @param hosts - Existing hosts to check against.
 * @param draft - The draft being edited (its own id is excluded).
 * @returns The colliding hosts, possibly empty.
 */
export function duplicatesOf(hosts: Host[], draft: Host): Host[] {
  const key = (h: Host): string => `${h.user}@${h.hostname}:${h.port}`;
  return hosts.filter((h) => h.id !== draft.id && key(h) === key(draft));
}

/** One sidebar section: a stable key, its eyebrow title, and its hosts. */
export interface SidebarSection {
  /** Stable key for collapse-state persistence. */
  key: string;
  /** Small-caps eyebrow title. */
  title: string;
  /** Hosts listed under this section, in display order. */
  hosts: Host[];
}

/**
 * Builds the sidebar sections (F1): while searching, one flat ranked
 * "Results" section; otherwise Favorites first, then each named group
 * (alphabetical), then ungrouped hosts, then the read-only "ssh config"
 * imports. Favorites appear only in Favorites — no duplication.
 *
 * @param hosts - All hosts, as returned by `hosts_list`.
 * @param query - The live search query; empty means "not searching".
 * @returns Sections in display order; empty sections are dropped.
 */
export function sidebarSections(hosts: Host[], query: string): SidebarSection[] {
  if (query.trim() !== "") {
    return [{ key: "results", title: "Results", hosts: searchHosts(hosts, query) }];
  }
  const favorites = hosts.filter((h) => h.favorite);
  const rest = hosts.filter((h) => !h.favorite);
  const imported = rest.filter((h) => h.source === "ssh_config");
  const own = rest.filter((h) => h.source !== "ssh_config");
  const groupNames = [...new Set(own.map((h) => h.group).filter((g) => g !== ""))].sort();

  const sections: SidebarSection[] = [
    { key: "favorites", title: "Favorites", hosts: favorites },
    ...groupNames.map((name) => ({
      key: `group:${name}`,
      title: name,
      hosts: own.filter((h) => h.group === name),
    })),
    { key: "ungrouped", title: "Hosts", hosts: own.filter((h) => h.group === "") },
    { key: "ssh-config", title: "ssh config", hosts: imported },
  ];
  return sections.filter((section) => section.hosts.length > 0);
}
