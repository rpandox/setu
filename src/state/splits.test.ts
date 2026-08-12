// Pure split-tree behavior: splitting, healing, ratios, layout, neighbors.
import { describe, expect, it } from "vitest";
import {
  findLeaf,
  findLeafBySession,
  layoutRects,
  leaf,
  leavesOf,
  neighborPaneId,
  removeLeaf,
  setRatioAt,
  splitLeaf,
  swapSessionId,
  type SplitNode,
} from "./splits";

/** `[A | B]` — A left, B right. */
function rowAB(): SplitNode {
  return splitLeaf(leaf("A", "sa"), "A", "row", leaf("B", "sb"));
}

/**
 * A 2×2 grid:
 * ```
 * A C
 * B D
 * ```
 * built the way ⌘D/⇧⌘D would: split A right (col of A/B on the left after
 * ⇧⌘D, then the right column split the same way).
 */
function grid2x2(): SplitNode {
  let tree: SplitNode = leaf("A", "sa");
  tree = splitLeaf(tree, "A", "row", leaf("C", "sc"));
  tree = splitLeaf(tree, "A", "col", leaf("B", "sb"));
  tree = splitLeaf(tree, "C", "col", leaf("D", "sd"));
  return tree;
}

describe("splitLeaf", () => {
  it("replaces the target with a 50/50 split, target in slot a", () => {
    const tree = rowAB();
    expect(tree).toMatchObject({
      kind: "split",
      dir: "row",
      ratio: 0.5,
      a: { paneId: "A" },
      b: { paneId: "B" },
    });
  });

  it("splits nested leaves without touching siblings", () => {
    const tree = grid2x2();
    expect(leavesOf(tree).map((l) => l.paneId)).toEqual(["A", "B", "C", "D"]);
  });

  it("returns the same reference when the target is absent", () => {
    const tree = rowAB();
    expect(splitLeaf(tree, "nope", "row", leaf("X", "sx"))).toBe(tree);
  });
});

describe("removeLeaf", () => {
  it("heals the parent into the surviving sibling", () => {
    const healed = removeLeaf(rowAB(), "A");
    expect(healed).toMatchObject({ kind: "leaf", paneId: "B" });
  });

  it("heals deep removals and keeps the rest of the tree intact", () => {
    const healed = removeLeaf(grid2x2(), "D");
    expect(healed).not.toBeNull();
    expect(leavesOf(healed as SplitNode).map((l) => l.paneId)).toEqual(["A", "B", "C"]);
    // C now owns the whole right half again.
    const { panes } = layoutRects(healed as SplitNode);
    const c = panes.find((p) => p.paneId === "C");
    expect(c?.rect).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it("returns null when removing the root leaf (empty tab)", () => {
    expect(removeLeaf(leaf("A", "sa"), "A")).toBeNull();
  });

  it("returns the same reference when the pane is absent", () => {
    const tree = grid2x2();
    expect(removeLeaf(tree, "nope")).toBe(tree);
  });
});

describe("setRatioAt", () => {
  it("sets the ratio at a path", () => {
    const tree = setRatioAt(grid2x2(), ["a"], 0.3);
    const { panes } = layoutRects(tree);
    const a = panes.find((p) => p.paneId === "A");
    expect(a?.rect.h).toBeCloseTo(0.3);
  });

  it("clamps degenerate ratios", () => {
    const tree = setRatioAt(rowAB(), [], 0.001) as { ratio: number };
    expect(tree.ratio).toBeCloseTo(0.05);
    const tree2 = setRatioAt(rowAB(), [], 2) as { ratio: number };
    expect(tree2.ratio).toBeCloseTo(0.95);
  });

  it("returns the same reference for a missing path", () => {
    const tree = rowAB();
    expect(setRatioAt(tree, ["a", "a"], 0.4)).toBe(tree);
  });
});

describe("swapSessionId / lookups", () => {
  it("swaps a session in place, keeping the pane id", () => {
    const tree = swapSessionId(rowAB(), "sa", "sa2");
    expect(findLeaf(tree, "A")?.sessionId).toBe("sa2");
    expect(findLeafBySession(tree, "sa2")?.paneId).toBe("A");
    expect(findLeafBySession(tree, "sa")).toBeUndefined();
  });

  it("returns the same reference when the session is absent", () => {
    const tree = rowAB();
    expect(swapSessionId(tree, "zz", "yy")).toBe(tree);
  });
});

describe("layoutRects", () => {
  it("computes the 2×2 grid quadrants", () => {
    const { panes, dividers } = layoutRects(grid2x2());
    const byId = Object.fromEntries(panes.map((p) => [p.paneId, p.rect]));
    expect(byId.A).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(byId.B).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    expect(byId.C).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(byId.D).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(dividers).toHaveLength(3);
    // Root divider spans the full square.
    expect(dividers[0]).toMatchObject({
      path: [],
      dir: "row",
      branch: { x: 0, y: 0, w: 1, h: 1 },
    });
  });
});

describe("neighborPaneId", () => {
  it("navigates the 2×2 grid in all four directions", () => {
    const tree = grid2x2();
    expect(neighborPaneId(tree, "A", "right")).toBe("C");
    expect(neighborPaneId(tree, "A", "down")).toBe("B");
    expect(neighborPaneId(tree, "D", "left")).toBe("B");
    expect(neighborPaneId(tree, "D", "up")).toBe("C");
  });

  it("returns undefined at edges", () => {
    const tree = grid2x2();
    expect(neighborPaneId(tree, "A", "left")).toBeUndefined();
    expect(neighborPaneId(tree, "A", "up")).toBeUndefined();
    expect(neighborPaneId(tree, "D", "right")).toBeUndefined();
    expect(neighborPaneId(tree, "D", "down")).toBeUndefined();
  });

  it("prefers the pane with the larger cross-axis overlap", () => {
    // Left pane A full-height; right side split 70/30 into C (top) and D.
    let tree: SplitNode = leaf("A", "sa");
    tree = splitLeaf(tree, "A", "row", leaf("C", "sc"));
    tree = splitLeaf(tree, "C", "col", leaf("D", "sd"));
    tree = setRatioAt(tree, ["b"], 0.7);
    // A overlaps C for 70% of its height, D for 30% — C wins.
    expect(neighborPaneId(tree, "A", "right")).toBe("C");
  });

  it("handles unknown panes", () => {
    expect(neighborPaneId(rowAB(), "nope", "left")).toBeUndefined();
  });
});
