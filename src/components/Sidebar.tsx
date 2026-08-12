import "./Sidebar.css";
import { useEffect, useState } from "react";
import { Copy, FolderDown, Pencil, Plus, Trash2 } from "lucide-react";
import type { Host } from "../ipc/contract";
import { sidebarSections, sshCommandOf, useHosts } from "../state/hosts";
import { useSessions } from "../state/sessions";

/** localStorage key holding the collapsed section keys (pure view state). */
const COLLAPSED_KEY = "setu.sidebar.collapsed";

/** Reads the persisted collapse set; malformed storage is an empty set. */
function loadCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [],
    );
  } catch {
    return new Set();
  }
}

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
 * into one ranked list. LEDs stay hollow until the reachability prober
 * lands in Phase 4.
 *
 * Row actions (hover): connect is the row itself; then Edit / Copy ssh
 * command / Adopt (imported rows) / Delete (two-click confirm). Group
 * collapse state persists in localStorage.
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

  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(loadCollapsed);
  /** Host id whose delete button is armed (second click deletes). */
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  const sections = sidebarSections(hosts, query);
  const searching = query.trim() !== "";

  useEffect(() => {
    // Disarm the delete confirmation shortly after arming it.
    if (armedDelete === null) return;
    const timer = window.setTimeout(() => setArmedDelete(null), 3000);
    return () => window.clearTimeout(timer);
  }, [armedDelete]);

  const toggleSection = (key: string): void => {
    setCollapsedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
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
                    {section.hosts.map((host) => (
                      <li className="host-item" key={host.id}>
                        <button
                          className="host-row"
                          type="button"
                          title={`Connect: ${sshCommandOf(host)}`}
                          onClick={() => void openSshTab(host)}
                        >
                          <span className="host-led" aria-hidden="true" />
                          <span className="host-label">{host.label}</span>
                          <span className="host-detail">{rowDetail(host)}</span>
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
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
