import "./Sidebar.css";

/** A host row shown on the LED board. Static placeholder data in Phase 0. */
interface FakeHost {
  /** Display label, the primary identity of the row. */
  label: string;
  /** Dimmed connection detail rendered after the label. */
  detail: string;
}

/** A sidebar section: eyebrow title plus its host rows. */
interface FakeGroup {
  /** Small-caps section title (group eyebrow). */
  title: string;
  /** Hosts listed under this group. */
  hosts: FakeHost[];
}

/**
 * Placeholder board contents for the static Phase 0 shell. Real host data
 * arrives with the `hosts.toml` store in Phase 2 (F1).
 */
const FAKE_GROUPS: FakeGroup[] = [
  {
    title: "Favorites",
    hosts: [{ label: "hermes", detail: "pandox@…ts.net" }],
  },
  {
    title: "Fleet",
    hosts: [
      { label: "atlas", detail: "deploy@atlas.internal" },
      { label: "ganymede", detail: "ops@ganymede.internal" },
    ],
  },
  {
    title: "Tailnet",
    hosts: [{ label: "iris", detail: "pandox@…ts.net" }],
  },
];

/**
 * Props for the {@link Sidebar} component.
 */
export interface SidebarProps {
  /** When true the sidebar is collapsed to zero width (⌘/ toggles this). */
  collapsed: boolean;
}

/**
 * The LED patch-bay sidebar (PLAN.md §7): a 260px rack of host rows, each led
 * by a status LED. In Phase 0 every LED is a hollow ring — the "probing /
 * reachability off" state — because the reachability prober lands in Phase 4.
 * The top spacer keeps content clear of the macOS traffic lights and doubles
 * as a window drag region.
 *
 * @param props - {@link SidebarProps}
 * @returns The sidebar element.
 */
export function Sidebar({ collapsed }: SidebarProps) {
  return (
    <aside
      className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`}
      aria-hidden={collapsed}
    >
      <div className="sidebar-inner">
        <div className="sidebar-titlebar-spacer" data-tauri-drag-region />
        <input
          className="sidebar-search"
          type="search"
          placeholder="Search hosts…"
          aria-label="Search hosts"
          readOnly
        />
        <nav className="sidebar-groups" aria-label="Hosts">
          {FAKE_GROUPS.map((group) => (
            <section className="sidebar-group" key={group.title}>
              <h2 className="group-eyebrow">{group.title}</h2>
              <ul className="group-hosts">
                {group.hosts.map((host) => (
                  <li key={host.label}>
                    <button className="host-row" type="button">
                      <span className="host-led" aria-hidden="true" />
                      <span className="host-label">{host.label}</span>
                      <span className="host-detail">{host.detail}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
      </div>
    </aside>
  );
}
