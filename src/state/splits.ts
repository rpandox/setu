/**
 * The binary split tree (F4) — pure types and operations, no store, no DOM.
 *
 * Every tab owns one {@link SplitNode}: a leaf renders a terminal pane, a
 * split divides its rectangle between two children at a ratio. All
 * operations are pure (they return new trees), so the Zustand store can
 * apply them immutably and tests can cover them without React or xterm.
 *
 * Layout math happens in unit space (the tab's viewport is the 1×1 square):
 * {@link layoutRects} turns a tree into pane and divider rectangles, and
 * {@link neighborPaneId} answers "which pane is to the right of this one?"
 * for ⌥⌘-arrow focus routing — both scale-invariant, so the same answers
 * hold at any window size.
 */

/** Split orientation: `row` = panes side by side (⌘D), `col` = stacked (⇧⌘D). */
export type SplitDir = "row" | "col";

/** A direction for ⌥⌘-arrow focus movement. */
export type FocusDirection = "left" | "right" | "up" | "down";

/** The address of a split branch: the a/b turns taken from the root. */
export type SplitPath = ("a" | "b")[];

/** A leaf: one terminal pane. */
export interface PaneLeaf {
  /** Discriminator. */
  kind: "leaf";
  /**
   * Stable pane identity — React keys and focus tracking use this; it
   * never changes, even when the pane's session is swapped on reconnect.
   */
  paneId: string;
  /** The PTY session rendered in this pane. */
  sessionId: string;
}

/** A split: two children sharing this node's rectangle at `ratio`. */
export interface SplitBranch {
  /** Discriminator. */
  kind: "split";
  /** Orientation of the divide. */
  dir: SplitDir;
  /** Share of the rectangle given to child `a` (0–1, exclusive). */
  ratio: number;
  /** First child: left (`row`) or top (`col`). */
  a: SplitNode;
  /** Second child: right (`row`) or bottom (`col`). */
  b: SplitNode;
}

/** A node in a tab's split tree. */
export type SplitNode = PaneLeaf | SplitBranch;

/** Minimum pane width in px (F4); drag clamping enforces it. */
export const MIN_PANE_WIDTH = 240;

/** Minimum pane height in px (F4); drag clamping enforces it. */
export const MIN_PANE_HEIGHT = 120;

/** Hard ratio bounds, protecting degenerate trees when px clamping can't. */
const RATIO_MIN = 0.05;
const RATIO_MAX = 0.95;

/** Tolerance for unit-space edge comparisons. */
const EPS = 1e-6;

/**
 * Creates a leaf node.
 *
 * @param paneId - The stable pane identity.
 * @param sessionId - The PTY session to render.
 * @returns The leaf.
 */
export function leaf(paneId: string, sessionId: string): PaneLeaf {
  return { kind: "leaf", paneId, sessionId };
}

/**
 * Collects the tree's leaves in layout order (a before b).
 *
 * @param node - The tree root.
 * @returns All leaves, left-to-right / top-to-bottom.
 */
export function leavesOf(node: SplitNode): PaneLeaf[] {
  if (node.kind === "leaf") return [node];
  return [...leavesOf(node.a), ...leavesOf(node.b)];
}

/**
 * Finds a leaf by pane id.
 *
 * @param node - The tree root.
 * @param paneId - The pane to find.
 * @returns The leaf, or `undefined` when absent.
 */
export function findLeaf(node: SplitNode, paneId: string): PaneLeaf | undefined {
  return leavesOf(node).find((l) => l.paneId === paneId);
}

/**
 * Finds a leaf by the session it renders.
 *
 * @param node - The tree root.
 * @param sessionId - The session to find.
 * @returns The leaf, or `undefined` when absent.
 */
export function findLeafBySession(
  node: SplitNode,
  sessionId: string,
): PaneLeaf | undefined {
  return leavesOf(node).find((l) => l.sessionId === sessionId);
}

/**
 * Replaces the target leaf with a split of itself and a new leaf at 50/50.
 * The existing pane keeps the `a` slot (left/top); the new pane takes `b`.
 *
 * @param node - The tree root.
 * @param targetPaneId - The pane being split.
 * @param dir - Split orientation.
 * @param added - The new leaf to insert.
 * @returns The new tree; unchanged (same reference) when the target is absent.
 */
export function splitLeaf(
  node: SplitNode,
  targetPaneId: string,
  dir: SplitDir,
  added: PaneLeaf,
): SplitNode {
  if (node.kind === "leaf") {
    if (node.paneId !== targetPaneId) return node;
    return { kind: "split", dir, ratio: 0.5, a: node, b: added };
  }
  const a = splitLeaf(node.a, targetPaneId, dir, added);
  const b = splitLeaf(node.b, targetPaneId, dir, added);
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

/**
 * Removes a leaf; the parent split collapses into the surviving sibling
 * (the layout "heals", F4).
 *
 * @param node - The tree root.
 * @param paneId - The pane to remove.
 * @returns The healed tree, or `null` when the removed leaf was the root
 * (the tab is now empty).
 */
export function removeLeaf(node: SplitNode, paneId: string): SplitNode | null {
  if (node.kind === "leaf") {
    return node.paneId === paneId ? null : node;
  }
  const a = removeLeaf(node.a, paneId);
  if (a === null) return node.b;
  const b = removeLeaf(node.b, paneId);
  if (b === null) return node.a;
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

/**
 * Sets the ratio of the split at `path`, clamped to sane bounds.
 *
 * @param node - The tree root.
 * @param path - The branch address (a/b turns from the root).
 * @param ratio - The requested `a` share.
 * @returns The new tree; unchanged (same reference) when the path misses.
 */
export function setRatioAt(node: SplitNode, path: SplitPath, ratio: number): SplitNode {
  if (node.kind === "leaf") return node;
  if (path.length === 0) {
    return { ...node, ratio: Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio)) };
  }
  const [head, ...rest] = path;
  const child = setRatioAt(node[head], rest, ratio);
  if (child === node[head]) return node;
  return { ...node, [head]: child };
}

/**
 * Swaps a session id in place (reconnect, F3: fresh PTY, same pane).
 *
 * @param node - The tree root.
 * @param oldSessionId - The exited session.
 * @param newSessionId - Its replacement.
 * @returns The new tree; unchanged (same reference) when absent.
 */
export function swapSessionId(
  node: SplitNode,
  oldSessionId: string,
  newSessionId: string,
): SplitNode {
  if (node.kind === "leaf") {
    if (node.sessionId !== oldSessionId) return node;
    return { ...node, sessionId: newSessionId };
  }
  const a = swapSessionId(node.a, oldSessionId, newSessionId);
  const b = swapSessionId(node.b, oldSessionId, newSessionId);
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

/** A rectangle in unit space (the tab viewport is the 1×1 square). */
export interface UnitRect {
  /** Left edge, 0–1. */
  x: number;
  /** Top edge, 0–1. */
  y: number;
  /** Width, 0–1. */
  w: number;
  /** Height, 0–1. */
  h: number;
}

/** A pane's computed rectangle. */
export interface PaneRect {
  /** The pane. */
  paneId: string;
  /** The session it renders. */
  sessionId: string;
  /** Where it sits in unit space. */
  rect: UnitRect;
}

/** A divider between a split's children, for rendering and dragging. */
export interface DividerRect {
  /** Address of the split this divider belongs to. */
  path: SplitPath;
  /** The split's orientation. */
  dir: SplitDir;
  /** The split's own rectangle (drag math converts it to px). */
  branch: UnitRect;
  /** The split's current ratio. */
  ratio: number;
}

/** The full computed layout of a tab. */
export interface TabLayout {
  /** One rect per pane, in layout order. */
  panes: PaneRect[];
  /** One divider per split. */
  dividers: DividerRect[];
}

const UNIT: UnitRect = { x: 0, y: 0, w: 1, h: 1 };

/**
 * Computes every pane's and divider's rectangle.
 *
 * @param node - The tree root.
 * @param rect - The rectangle the tree occupies (defaults to the unit square).
 * @param path - Internal: the address of `node`.
 * @returns Panes and dividers with their unit rects.
 * @example
 * ```ts
 * const { panes } = layoutRects(tab.layout);
 * // panes[0].rect → { x: 0, y: 0, w: 0.5, h: 1 } for the left half
 * ```
 */
export function layoutRects(
  node: SplitNode,
  rect: UnitRect = UNIT,
  path: SplitPath = [],
): TabLayout {
  if (node.kind === "leaf") {
    return {
      panes: [{ paneId: node.paneId, sessionId: node.sessionId, rect }],
      dividers: [],
    };
  }
  const { x, y, w, h } = rect;
  const rectA: UnitRect =
    node.dir === "row" ? { x, y, w: w * node.ratio, h } : { x, y, w, h: h * node.ratio };
  const rectB: UnitRect =
    node.dir === "row"
      ? { x: x + w * node.ratio, y, w: w * (1 - node.ratio), h }
      : { x, y: y + h * node.ratio, w, h: h * (1 - node.ratio) };
  const a = layoutRects(node.a, rectA, [...path, "a"]);
  const b = layoutRects(node.b, rectB, [...path, "b"]);
  return {
    panes: [...a.panes, ...b.panes],
    dividers: [
      { path, dir: node.dir, branch: rect, ratio: node.ratio },
      ...a.dividers,
      ...b.dividers,
    ],
  };
}

/**
 * Finds the pane an ⌥⌘-arrow should focus: the nearest pane in `direction`,
 * preferring panes that overlap the current pane's cross-axis span.
 *
 * @param node - The tree root.
 * @param paneId - The currently focused pane.
 * @param direction - The arrow direction.
 * @returns The neighbor's pane id, or `undefined` at an edge.
 */
export function neighborPaneId(
  node: SplitNode,
  paneId: string,
  direction: FocusDirection,
): string | undefined {
  const { panes } = layoutRects(node);
  const from = panes.find((p) => p.paneId === paneId);
  if (!from) return undefined;
  const fr = from.rect;

  const beyond = (r: UnitRect): boolean => {
    switch (direction) {
      case "right":
        return r.x >= fr.x + fr.w - EPS;
      case "left":
        return r.x + r.w <= fr.x + EPS;
      case "down":
        return r.y >= fr.y + fr.h - EPS;
      case "up":
        return r.y + r.h <= fr.y + EPS;
    }
  };
  const distance = (r: UnitRect): number => {
    switch (direction) {
      case "right":
        return r.x - (fr.x + fr.w);
      case "left":
        return fr.x - (r.x + r.w);
      case "down":
        return r.y - (fr.y + fr.h);
      case "up":
        return fr.y - (r.y + r.h);
    }
  };
  const crossOverlap = (r: UnitRect): number => {
    if (direction === "left" || direction === "right") {
      return Math.min(fr.y + fr.h, r.y + r.h) - Math.max(fr.y, r.y);
    }
    return Math.min(fr.x + fr.w, r.x + r.w) - Math.max(fr.x, r.x);
  };

  const candidates = panes.filter((p) => p.paneId !== paneId && beyond(p.rect));
  if (candidates.length === 0) return undefined;

  const overlapping = candidates.filter((p) => crossOverlap(p.rect) > EPS);
  if (overlapping.length > 0) {
    overlapping.sort(
      (p, q) =>
        distance(p.rect) - distance(q.rect) ||
        crossOverlap(q.rect) - crossOverlap(p.rect),
    );
    return overlapping[0].paneId;
  }
  // Nothing overlaps (L-shaped layouts): fall back to nearest center.
  const center = (r: UnitRect): [number, number] => [r.x + r.w / 2, r.y + r.h / 2];
  const [fx, fy] = center(fr);
  candidates.sort((p, q) => {
    const [px, py] = center(p.rect);
    const [qx, qy] = center(q.rect);
    return (px - fx) ** 2 + (py - fy) ** 2 - ((qx - fx) ** 2 + (qy - fy) ** 2);
  });
  return candidates[0].paneId;
}
