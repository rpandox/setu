// Frecency scoring and recording (F11, Phase 4).
import { describe, expect, it } from "vitest";
import type { FrecencyEntry } from "../ipc/contract";
import {
  FRECENCY_CAP,
  actionSubject,
  bumpFrecency,
  frecencyScore,
  hostSubject,
} from "./frecency";

const WEEK = 7 * 24 * 60 * 60 * 1000;

describe("frecencyScore", () => {
  it("is zero for unknown subjects", () => {
    expect(frecencyScore(undefined, 1000)).toBe(0);
  });

  it("equals the use count when just used", () => {
    expect(frecencyScore({ uses: 4, lastUsedAt: 5000 }, 5000)).toBe(4);
  });

  it("halves per idle week", () => {
    const now = 10 * WEEK;
    expect(frecencyScore({ uses: 4, lastUsedAt: now - WEEK }, now)).toBeCloseTo(2);
    expect(frecencyScore({ uses: 4, lastUsedAt: now - 2 * WEEK }, now)).toBeCloseTo(1);
  });

  it("recency beats raw count: today's host outranks last month's habit", () => {
    const now = 10 * WEEK;
    const habit: FrecencyEntry = { uses: 30, lastUsedAt: now - 5 * WEEK };
    const fresh: FrecencyEntry = { uses: 2, lastUsedAt: now };
    expect(frecencyScore(fresh, now)).toBeGreaterThan(frecencyScore(habit, now));
  });
});

describe("bumpFrecency", () => {
  it("creates and increments entries without touching the input", () => {
    const first = bumpFrecency({}, "host:h1", 1000);
    const second = bumpFrecency(first, "host:h1", 2000);
    expect(first["host:h1"]).toEqual({ uses: 1, lastUsedAt: 1000 });
    expect(second["host:h1"]).toEqual({ uses: 2, lastUsedAt: 2000 });
  });

  it("prunes the lowest-scoring entries past the cap", () => {
    let map: Record<string, FrecencyEntry> = {};
    const now = 10 * WEEK;
    for (let i = 0; i < FRECENCY_CAP; i++) {
      // Older, weaker entries first.
      map[`host:old-${i}`] = { uses: 1, lastUsedAt: now - 8 * WEEK };
    }
    map = bumpFrecency(map, "host:fresh", now);
    expect(Object.keys(map)).toHaveLength(FRECENCY_CAP);
    expect(map["host:fresh"]).toBeDefined();
  });
});

describe("subjects", () => {
  it("namespace hosts and actions apart", () => {
    expect(hostSubject("abc")).toBe("host:abc");
    expect(actionSubject("split-right")).toBe("action:split-right");
  });
});
