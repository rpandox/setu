import "./SplitContainer.css";
import {
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { TerminalPane } from "../terminal/TerminalPane";
import {
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  layoutRects,
  type DividerRect,
  type UnitRect,
} from "../../state/splits";
import { useSessions, type Tab } from "../../state/sessions";
import { useBroadcast } from "../../state/broadcast";

/** Props for {@link SplitContainer}. */
export interface SplitContainerProps {
  /** The tab whose split tree this container renders. */
  tab: Tab;
  /** Whether the tab is hidden (inactive tab — kept mounted, `visibility`). */
  hidden: boolean;
}

/**
 * Converts a unit rect into absolute percentage positioning.
 *
 * @param rect - The unit rect.
 * @returns The style.
 */
function rectStyle(rect: UnitRect): CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.w * 100}%`,
    height: `${rect.h * 100}%`,
  };
}

/**
 * Positions a divider: a 6px grab strip centered on its split's boundary.
 *
 * @param divider - The divider.
 * @returns The style.
 */
function dividerStyle(divider: DividerRect): CSSProperties {
  const { branch, dir, ratio } = divider;
  if (dir === "row") {
    const x = branch.x + branch.w * ratio;
    return {
      left: `calc(${x * 100}% - 3px)`,
      top: `${branch.y * 100}%`,
      width: "6px",
      height: `${branch.h * 100}%`,
    };
  }
  const y = branch.y + branch.h * ratio;
  return {
    left: `${branch.x * 100}%`,
    top: `calc(${y * 100}% - 3px)`,
    width: `${branch.w * 100}%`,
    height: "6px",
  };
}

/**
 * One tab's split layout (F4): every pane rendered as an absolutely
 * positioned sibling — the React tree stays flat no matter how the split
 * tree reshapes, so terminal DOM never re-parents on split/close — plus one
 * draggable divider per split.
 *
 * Drag clamps ratios so both sides keep the F4 minimum pane size
 * (240×120). Panes of hidden tabs stay mounted with `visibility: hidden`,
 * exactly like Phase 1 tabs did.
 *
 * @param props - {@link SplitContainerProps}
 * @returns The tab's layout element.
 */
export function SplitContainer({ tab, hidden }: SplitContainerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sessions = useSessions((s) => s.sessions);
  const focusPane = useSessions((s) => s.focusPane);
  const setSplitRatio = useSessions((s) => s.setSplitRatio);
  const reconnect = useSessions((s) => s.reconnect);
  const broadcastArmed = useBroadcast((s) => s.active[tab.tabId] ?? false);
  const selectedPanes = useBroadcast((s) => s.selected[tab.tabId]);
  const togglePaneSelected = useBroadcast((s) => s.togglePaneSelected);

  const { panes, dividers } = layoutRects(tab.layout);
  const multiPane = panes.length > 1;

  /**
   * Starts a divider drag: ratio follows the pointer, clamped so both
   * children keep the minimum pane size; too-small branches refuse to drag.
   *
   * @param divider - The divider being dragged.
   * @returns The pointerdown handler.
   */
  const onDividerDown =
    (divider: DividerRect) =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const root = rootRef.current;
      if (!root) return;
      event.preventDefault();
      const rootRect = root.getBoundingClientRect();
      const isRow = divider.dir === "row";
      const branchStart = isRow
        ? rootRect.left + divider.branch.x * rootRect.width
        : rootRect.top + divider.branch.y * rootRect.height;
      const branchSize = isRow
        ? divider.branch.w * rootRect.width
        : divider.branch.h * rootRect.height;
      if (branchSize <= 0) return;
      const minRatio = (isRow ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT) / branchSize;
      const maxRatio = 1 - minRatio;
      if (maxRatio <= minRatio) return;
      const strip = event.currentTarget;
      strip.setPointerCapture(event.pointerId);
      const onMove = (move: PointerEvent): void => {
        const pointer = isRow ? move.clientX : move.clientY;
        const ratio = Math.min(
          maxRatio,
          Math.max(minRatio, (pointer - branchStart) / branchSize),
        );
        setSplitRatio(tab.tabId, divider.path, ratio);
      };
      const onUp = (): void => {
        strip.removeEventListener("pointermove", onMove);
        strip.removeEventListener("pointerup", onUp);
        strip.removeEventListener("pointercancel", onUp);
      };
      strip.addEventListener("pointermove", onMove);
      strip.addEventListener("pointerup", onUp);
      strip.addEventListener("pointercancel", onUp);
    };

  return (
    <div ref={rootRef} className={`split-root${hidden ? " split-root--hidden" : ""}`}>
      {panes.map((pane) => {
        const meta = sessions.find((s) => s.sessionId === pane.sessionId);
        const active = pane.paneId === tab.activePaneId;
        const selected = selectedPanes?.includes(pane.paneId) ?? false;
        const broadcasting = broadcastArmed && selected;
        const reconnectable =
          meta?.status === "exited" && meta.kind === "ssh" && !meta.orphaned;
        const classes = [
          "split-pane",
          multiPane && active ? "split-pane--active" : "",
          broadcasting ? "split-pane--broadcast" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div
            key={pane.paneId}
            className={classes}
            style={rectStyle(pane.rect)}
            onMouseDownCapture={() => {
              if (!active) focusPane(tab.tabId, pane.paneId);
            }}
          >
            <TerminalPane sessionId={pane.sessionId} active={!hidden && active} />
            {multiPane && active && (
              // Keyed by pane: re-mounts on every focus move, replaying the
              // brief focus glow (F4). Reduced motion disables it in CSS.
              <div key={tab.activePaneId} className="split-pane-flash" />
            )}
            {multiPane && (
              <button
                className={`split-pane-toggle${selected ? " split-pane-toggle--on" : ""}`}
                type="button"
                aria-pressed={selected}
                aria-label={
                  selected ? "Remove pane from broadcast" : "Include pane in broadcast"
                }
                title={
                  selected
                    ? "In the broadcast set — click to opt out (⇧⌘B arms)"
                    : "Click to include in broadcast (⇧⌘B arms)"
                }
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => togglePaneSelected(tab.tabId, pane.paneId)}
              />
            )}
            {meta?.status === "exited" && (
              <div className="terminal-exit-notice" role="status">
                {meta.kind === "ssh" ? "connection closed" : "exited"}
                {meta.exitCode !== null ? ` (code ${meta.exitCode})` : ""}
                {reconnectable && (
                  <>
                    {" — "}
                    <button
                      className="terminal-reconnect"
                      type="button"
                      onClick={() => void reconnect(pane.sessionId)}
                    >
                      Reconnect
                    </button>{" "}
                    <kbd>⏎</kbd>
                  </>
                )}
                {" — "}
                <kbd>⌘W</kbd> to close
              </div>
            )}
          </div>
        );
      })}
      {dividers.map((divider) => (
        <div
          key={divider.path.join("-") || "root"}
          className={`split-divider split-divider--${divider.dir}`}
          style={dividerStyle(divider)}
          onPointerDown={onDividerDown(divider)}
          role="separator"
          aria-orientation={divider.dir === "row" ? "vertical" : "horizontal"}
        />
      ))}
    </div>
  );
}
