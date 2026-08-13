// SFTP listing helpers (F5): sort/filter semantics, POSIX path arithmetic,
// and the column formatters. Pure functions, no mocks.
import { describe, expect, it } from "vitest";

import type { SftpEntry } from "../../ipc/contract";
import {
  cycleSort,
  filterHidden,
  formatEta,
  formatMode,
  formatMtime,
  formatSize,
  formatSpeed,
  joinPath,
  parentPath,
  parseOctal,
  sortEntries,
  splitForCompletion,
  toOctal,
} from "./listing";

/**
 * A listing entry with overridable fields.
 *
 * @param overrides - Fields to override.
 */
function entry(overrides: Partial<SftpEntry> = {}): SftpEntry {
  return {
    name: "file.txt",
    size: 0,
    mtimeMs: 0,
    mode: 0o644,
    isDir: false,
    isSymlink: false,
    ...overrides,
  };
}

describe("sortEntries", () => {
  const listing = [
    entry({ name: "zeta.log", size: 10, mtimeMs: 300 }),
    entry({ name: "Alpha.txt", size: 30, mtimeMs: 100 }),
    entry({ name: "beta", isDir: true, mtimeMs: 200 }),
    entry({ name: "Archive", isDir: true, mtimeMs: 400 }),
  ];

  it("groups directories first regardless of direction", () => {
    const asc = sortEntries(listing, { key: "name", dir: "asc" });
    expect(asc.map((e) => e.name)).toEqual(["Archive", "beta", "Alpha.txt", "zeta.log"]);
    const desc = sortEntries(listing, { key: "name", dir: "desc" });
    expect(desc.map((e) => e.name)).toEqual(["beta", "Archive", "zeta.log", "Alpha.txt"]);
  });

  it("sorts by size with name tiebreak, without mutating the input", () => {
    const bySize = sortEntries(listing, { key: "size", dir: "desc" });
    expect(bySize.map((e) => e.name)).toEqual([
      "Archive",
      "beta",
      "Alpha.txt",
      "zeta.log",
    ]);
    expect(listing[0].name).toBe("zeta.log"); // untouched
  });

  it("sorts by mtime", () => {
    const byTime = sortEntries(listing, { key: "mtimeMs", dir: "asc" });
    expect(byTime.map((e) => e.name)).toEqual([
      "beta",
      "Archive",
      "Alpha.txt",
      "zeta.log",
    ]);
  });
});

describe("cycleSort", () => {
  it("new column starts ascending, same column flips", () => {
    expect(cycleSort({ key: "name", dir: "asc" }, "size")).toEqual({
      key: "size",
      dir: "asc",
    });
    expect(cycleSort({ key: "size", dir: "asc" }, "size")).toEqual({
      key: "size",
      dir: "desc",
    });
    expect(cycleSort({ key: "size", dir: "desc" }, "size")).toEqual({
      key: "size",
      dir: "asc",
    });
  });
});

describe("filterHidden", () => {
  const listing = [entry({ name: ".ssh", isDir: true }), entry({ name: "notes.md" })];

  it("drops dotfiles unless shown", () => {
    expect(filterHidden(listing, false).map((e) => e.name)).toEqual(["notes.md"]);
    expect(filterHidden(listing, true)).toHaveLength(2);
  });
});

describe("path arithmetic", () => {
  it("joinPath appends with one separator; absolute names replace", () => {
    expect(joinPath("/home/pandox", "logs")).toBe("/home/pandox/logs");
    expect(joinPath("/home/pandox/", "logs")).toBe("/home/pandox/logs");
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(joinPath("/anything", "/absolute")).toBe("/absolute");
  });

  it("parentPath walks up and pins at the root", () => {
    expect(parentPath("/home/pandox/logs")).toBe("/home/pandox");
    expect(parentPath("/home")).toBe("/");
    expect(parentPath("/")).toBe("/");
    expect(parentPath("/home/pandox/")).toBe("/home");
  });

  it("splitForCompletion separates the listing dir from the typed prefix", () => {
    expect(splitForCompletion("/var/lo")).toEqual({ dir: "/var", prefix: "lo" });
    expect(splitForCompletion("/var/")).toEqual({ dir: "/var", prefix: "" });
    expect(splitForCompletion("/v")).toEqual({ dir: "/", prefix: "v" });
  });
});

describe("formatters", () => {
  it("formatSize picks sensible units", () => {
    expect(formatSize(312)).toBe("312 B");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(4_400_000)).toBe("4.2 MB");
    expect(formatSize(3_000_000_000)).toBe("2.8 GB");
  });

  it("formatMtime renders local time and dashes the unknown", () => {
    expect(formatMtime(0)).toBe("—");
    // Built from local components so the assertion is timezone-proof.
    expect(formatMtime(new Date(2026, 7, 13, 12, 30).getTime())).toBe("2026-08-13 12:30");
  });

  it("formatMode renders ls -l strings, symlinks and specials included", () => {
    expect(formatMode(entry({ mode: 0o644 }))).toBe("-rw-r--r--");
    expect(formatMode(entry({ mode: 0o755, isDir: true }))).toBe("drwxr-xr-x");
    expect(formatMode(entry({ mode: 0o777, isSymlink: true }))).toBe("lrwxrwxrwx");
    expect(formatMode(entry({ mode: 0o4755 }))).toBe("-rwsr-xr-x");
    expect(formatMode(entry({ mode: 0o1777, isDir: true }))).toBe("drwxrwxrwt");
  });

  it("octal round-trips and rejects garbage", () => {
    expect(toOctal(0o755)).toBe("755");
    expect(toOctal(0o4755)).toBe("4755");
    expect(parseOctal("755")).toBe(0o755);
    expect(parseOctal("4755")).toBe(0o4755);
    expect(parseOctal("79")).toBeNull();
    expect(parseOctal("rwx")).toBeNull();
    expect(parseOctal("")).toBeNull();
  });

  it("speed and ETA guard their undefined cases", () => {
    expect(formatSpeed(0)).toBe("—");
    expect(formatSpeed(4_400_000)).toBe("4.2 MB/s");
    expect(formatEta(0, 0, 100)).toBe("—");
    expect(formatEta(50, 100, 0)).toBe("—");
    expect(formatEta(0, 1000, 100)).toBe("10s");
    expect(formatEta(0, 100 * 90, 100)).toBe("1m 30s");
    expect(formatEta(0, 100 * 3660, 100)).toBe("1h 1m");
  });
});
