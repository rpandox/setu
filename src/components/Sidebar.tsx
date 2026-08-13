import "./Sidebar.css";
import { useEffect, useMemo, useState } from "react";
import { Copy, FolderDown, Pencil, Plus, StickyNote, Trash2 } from "lucide-react";
import type { Host } from "../ipc/contract";
import { renderMiniMarkdown } from "../features/hosts/miniMarkdown";
import { sidebarSections, sshCommandOf, useHosts } from "../state/hosts";
import { ledInfoOf, useReach } from "../state/reach";
import { useSessions } from "../state/sessions";
import { splitPeersAgainstHosts, useTailnet } from "../state/tailnet";
import { useUiPrefs } from "../state/uiState";
import { HostLed, ReachChip } from "./HostLed";
import { SelectionBar } from "./SelectionBar";
import { TailnetSection } from "./TailnetSection";

/**
 * Props for the {@link Sidebar} component.
 */
export interface SidebarProps {
  /** When true the sidebar is collapsed to zero width (⌘/ toggles this). */
  collapsed: boolean;
}

/**
 * The LED patch-bay sidebar (PLAN.md §7, F1): real host rows from the
 * hosts store — Favorites first, then named groups, ungrouped hosts, and
 * the read-only `~/.ssh/config` imports. The search field fuzzy-filters
 * into one ranked list. LEDs are live (Phase 4): the reachability prober
 * lights them the moment the app opens, with the latency chip at the row's
 * right edge and a pulse on hosts with a running session.
 *
 * Row actions (hover): connect is the row itself; then Edit / Copy ssh
 * command / Notes popover (minimal markdown) / Adopt (imported rows) /
 * Delete (two-click confirm). Group collapse state persists in
 * `state.json` via the uiState module (Phase 3; previously localStorage —
 * migrated automatically).
 *
 * Bulk actions (F1, Phase 4): ⌘-click toggles a host into the selection,
 * ⇧-click extends it over the visible order, Esc clears it; the
 * SelectionBar under the list applies group/tag/hue/delete to everything
 * selected. Imported rows stay out of selections (read-only until
 * adopted).
 *
 * @param props - {@link SidebarProps}
 * @returns The sidebar element.
 */
export function Sidebar({ collapsed }: SidebarProps) {
  const hosts = useHosts((s) => s.hosts);
  const query = useHosts((s) => s.query);
  const loadError = useHosts((s) => s.loadError);
  const setQuery = useHosts((s) => s.setQuery);
  const openEditor = useHosts((s) => s.openEditor);
  const adoptHost = useHosts((s) => s.adoptHost);
  const deleteHost = useHosts((s) => s.deleteHost);
  const openSshTab = useSessions((s) => s.openSshTab);
  const sessions = useSessions((s) => s.sessions);
  const reachByHost = useReach((s) => s.byHost);
  const probing = useReach((s) => s.probing);

  const selectedIds = useHosts((s) => s.selectedIds);
  const setSelected = useHosts((s) => s.setSelected);
  const clearSelection = useHosts((s) => s.clearSelection);

  const tailnetAvailable = useTailnet((s) => s.available);
  const tailnetPeers = useTailnet((s) => s.peers);

  const collapsedSections = useUiPrefs((s) => s.collapsedSections);
  const setCollapsedSections = useUiPrefs((s) => s.setCollapsedSections);
  const collapsedKeys = useMemo(() => new Set(collapsedSections), [collapsedSections]);
  /** Host id whose delete button is armed (second click deletes). */
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  /** ⇧-click range anchor (the last ⌘-clicked host). */
  const [anchorId, setAnchorId] = useState<string | null>(null);
  /** Host id whose notes popover is open. */
  const [notesOpenId, setNotesOpenId] = useState<string | null>(null);

  const sections = sidebarSections(hosts, query);
  const searching = query.trim() !== "";
  // A peer whose MagicDNS name matches an existing host collapses into
  // that row with a badge (F9 edge case); the rest form the section.
  const { visible: visiblePeers, badged } = useMemo(
    () => splitPeersAgainstHosts(tailnetPeers, hosts),
    [tailnetPeers, hosts],
  );
  /**
   * Selectable = editable; imported rows are read-only until adopted.
   *
   * @param host - The row's host.
   */
  const selectable = (host: Host): boolean => host.source !== "ssh_config";
  /** Visible selectable ids, in render order (for ⇧-click ranges). */
  const visibleIds = sections.flatMap((s) => s.hosts.filter(selectable).map((h) => h.id));

  useEffect(() => {
    // Disarm the delete confirmation shortly after arming it.
    if (armedDelete === null) return;
    const timer = window.setTimeout(() => setArmedDelete(null), 3000);
    return () => window.clearTimeout(timer);
  }, [armedDelete]);

  useEffect(() => {
    // Esc closes the notes popover, then clears the selection. Plain
    // listener without preventDefault: terminal apps keep their Esc.
    const onEsc = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (notesOpenId !== null) {
        setNotesOpenId(null);
      } else {
        clearSelection();
      }
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [notesOpenId, clearSelection]);

  /**
   * Row click: plain = connect; ⌘ = toggle into the selection; ⇧ = extend
   * the selection from the anchor over the visible order (F1 bulk select).
   *
   * @param host - The clicked row's host.
   * @param event - The mouse event (modifier keys decide the meaning).
   */
  const onRowClick = (host: Host, event: React.MouseEvent): void => {
    if (event.metaKey && selectable(host)) {
      const next = selectedIds.includes(host.id)
        ? selectedIds.filter((id) => id !== host.id)
        : [...selectedIds, host.id];
      setSelected(next);
      setAnchorId(host.id);
      return;
    }
    if (event.shiftKey && anchorId !== null && selectable(host)) {
      const from = visibleIds.indexOf(anchorId);
      const to = visibleIds.indexOf(host.id);
      if (from !== -1 && to !== -1) {
        const range = visibleIds.slice(Math.min(from, to), Math.max(from, to) + 1);
        setSelected([...new Set([...selectedIds, ...range])]);
        return;
      }
    }
    if (selectedIds.length > 0) {
      // A plain click while selecting just clears — connecting mid-bulk
      // would be a surprise.
      clearSelection();
      return;
    }
    void openSshTab(host);
  };

  const toggleSection = (key: string): void => {
    const next = new Set(collapsedKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setCollapsedSections([...next]);
  };

  const rowDetail = (host: Host): string => {
    if (host.hostname === "") return "ssh alias";
    return host.user === "" ? host.hostname : `${host.user}@${host.hostname}`;
  };

  return (
    <aside
      className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`}
      aria-hidden={collapsed}
    >
      <div className="sidebar-inner">
        <div className="sidebar-titlebar-spacer" data-tauri-drag-region />
        <div className="sidebar-toolbar">
          <input
            className="sidebar-search"
            type="search"
            placeholder="Search hosts…"
            aria-label="Search hosts"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            className="sidebar-add"
            type="button"
            aria-label="Add host"
            title="Add host"
            onClick={() => openEditor("new")}
          >
            <Plus size={14} aria-hidden />
          </button>
        </div>
        {loadError !== null && (
          <p className="sidebar-error" role="alert">
            {loadError}
          </p>
        )}
        <nav className="sidebar-groups" aria-label="Hosts">
          {hosts.length === 0 && loadError === null && (
            <p className="sidebar-empty">
              No hosts yet — add one, or import happens automatically from ~/.ssh/config.
            </p>
          )}
          {sections.map((section) => {
            const sectionCollapsed = !searching && collapsedKeys.has(section.key);
            return (
              <section className="sidebar-group" key={section.key}>
                <h2 className="group-eyebrow">
                  <button
                    className="group-toggle"
                    type="button"
                    aria-expanded={!sectionCollapsed}
                    onClick={() => toggleSection(section.key)}
                  >
                    <span className="group-chevron" aria-hidden>
                      {sectionCollapsed ? "▸" : "▾"}
                    </span>
                    {section.title}
                  </button>
                </h2>
                {!sectionCollapsed && (
                  <ul className="group-hosts">
                    {section.hosts.map((host) => {
                      const led = ledInfoOf(host, reachByHost, sessions, probing);
                      const isSelected = selectedIds.includes(host.id);
                      return (
                        <li
                          className={`host-item${isSelected ? " host-item--selected" : ""}`}
                          key={host.id}
                        >
                          <button
                            className="host-row"
                            type="button"
                            title={`Connect: ${sshCommandOf(host)} · ⌘-click to select`}
                            aria-pressed={isSelected}
                            onClick={(event) => onRowClick(host, event)}
                          >
                            <HostLed led={led} />
                            <span className="host-label">{host.label}</span>
                            <span className="host-detail">{rowDetail(host)}</span>
                            {badged.has(host.hostname.toLowerCase()) && (
                              <span
                                className="tailnet-badge"
                                title="Also a tailnet peer (same MagicDNS name)"
                              >
                                ts
                              </span>
                            )}
                            <ReachChip led={led} />
                          </button>
                          <span className="host-actions">
                            {host.source === "ssh_config" ? (
                              <button
                                className="host-action"
                                type="button"
                                title="Adopt into hosts.toml"
                                aria-label={`Adopt ${host.label}`}
                                onClick={() => void adoptHost(host.id)}
                              >
                                <FolderDown size={13} aria-hidden />
                              </button>
                            ) : (
                              <>
                                <button
                                  className="host-action"
                                  type="button"
                                  title="Edit"
                                  aria-label={`Edit ${host.label}`}
                                  onClick={() => openEditor(host.id)}
                                >
                                  <Pencil size={13} aria-hidden />
                                </button>
                                <button
                                  className={`host-action${armedDelete === host.id ? " host-action--armed" : ""}`}
                                  type="button"
                                  title={
                                    armedDelete === host.id
                                      ? "Click again to delete"
                                      : "Delete"
                                  }
                                  aria-label={
                                    armedDelete === host.id
                                      ? `Confirm delete ${host.label}`
                                      : `Delete ${host.label}`
                                  }
                                  onClick={() => {
                                    if (armedDelete === host.id) {
                                      setArmedDelete(null);
                                      void deleteHost(host.id);
                                    } else {
                                      setArmedDelete(host.id);
                                    }
                                  }}
                                >
                                  <Trash2 size={13} aria-hidden />
                                </button>
                              </>
                            )}
                            <button
                              className="host-action"
                              type="button"
                              title={`Copy: ${sshCommandOf(host)}`}
                              aria-label={`Copy ssh command for ${host.label}`}
                              onClick={() =>
                                void navigator.clipboard
                                  .writeText(sshCommandOf(host))
                                  .catch(() => undefined)
                              }
                            >
                              <Copy size={13} aria-hidden />
                            </button>
                            {host.notes.trim() !== "" && (
                              <button
                                className={`host-action${notesOpenId === host.id ? " host-action--open" : ""}`}
                                type="button"
                                title="Notes"
                                aria-label={`Notes for ${host.label}`}
                                aria-expanded={notesOpenId === host.id}
                                onClick={() =>
                                  setNotesOpenId((open) =>
                                    open === host.id ? null : host.id,
                                  )
                                }
                              >
                                <StickyNote size={13} aria-hidden />
                              </button>
                            )}
                          </span>
                          {notesOpenId === host.id && (
                            <div className="host-notes" role="note">
                              {renderMiniMarkdown(host.notes)}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
          {tailnetAvailable && <TailnetSection peers={visiblePeers} query={query} />}
        </nav>
        <SelectionBar />
      </div>
    </aside>
  );
}
