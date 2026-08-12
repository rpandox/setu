import "./TabBar.css";

/**
 * Props for the {@link TabBar} component.
 */
export interface TabBarProps {
  /**
   * When true, pad the left edge so tabs clear the macOS traffic lights —
   * needed while the sidebar (which normally sits under them) is collapsed.
   */
  trafficLightInset: boolean;
}

/**
 * The 38px tab strip (PLAN.md §7 wireframe). The whole bar is a window drag
 * region. Phase 0 renders two static tabs; the active one carries the 2px
 * neon underline with glow — one of the three legal uses of `--glow`.
 *
 * @param props - {@link TabBarProps}
 * @returns The tab bar element.
 */
export function TabBar({ trafficLightInset }: TabBarProps) {
  return (
    <header
      className={`tabbar${trafficLightInset ? " tabbar--inset" : ""}`}
      data-tauri-drag-region
    >
      <button className="tab tab--active" type="button" aria-current="true">
        hermes
      </button>
      <button className="tab" type="button">
        local
      </button>
      <button className="tab-new" type="button" aria-label="New tab">
        +
      </button>
    </header>
  );
}
