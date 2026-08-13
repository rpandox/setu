/**
 * Pure helpers behind the SFTP dual-pane browser (F5): sorting, hidden
 * filtering, POSIX path arithmetic for remote paths, and the formatting
 * for size/mtime/permissions/speed columns. Everything here is
 * pane-agnostic — both panes share the `SftpEntry` shape — and unit-tested.
 */

import type { SftpEntry } from "../../ipc/contract";

/** A sortable column of the pane listing. */
export type SortKey = "name" | "size" | "mtimeMs" | "mode";

/** One pane's sort state: the column and its direction. */
export interface SortSpec {
  /** The column being sorted. */
  key: SortKey;
  /** Ascending or descending. */
  dir: "asc" | "desc";
}

/** The default sort: names ascending (directories always group first). */
export const DEFAULT_SORT: SortSpec = { key: "name", dir: "asc" };

/**
 * The next sort state after clicking a column header: a new column starts
 * ascending, the same column flips direction.
 *
 * @param current - The pane's current sort.
 * @param key - The clicked column.
 * @returns The new sort spec.
 */
export function cycleSort(current: SortSpec, key: SortKey): SortSpec {
  if (current.key !== key) return { key, dir: "asc" };
  return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}

/**
 * Sorts a listing for display: directories group before files regardless
 * of direction (the file-manager convention), then the sort key applies.
 * Ties break on case-insensitive names, always ascending — flipping a
 * size sort shouldn't scramble equal-sized files.
 *
 * @param entries - The listing to sort (not mutated).
 * @param sort - The pane's sort spec.
 * @returns A new sorted array.
 */
export function sortEntries(entries: readonly SftpEntry[], sort: SortSpec): SftpEntry[] {
  const factor = sort.dir === "asc" ? 1 : -1;
  const byName = (a: SftpEntry, b: SftpEntry) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (sort.key === "name") return byName(a, b) * factor;
    const cmp = (a[sort.key] - b[sort.key]) * factor;
    return cmp !== 0 ? cmp : byName(a, b);
  });
}

/**
 * Applies the hidden-file toggle: dotfiles drop out unless shown.
 *
 * @param entries - The full listing (the backend never filters).
 * @param showHidden - The panel's toggle.
 * @returns The visible entries.
 */
export function filterHidden(
  entries: readonly SftpEntry[],
  showHidden: boolean,
): SftpEntry[] {
  if (showHidden) return [...entries];
  return entries.filter((entry) => !entry.name.startsWith("."));
}

/**
 * POSIX join for remote paths (`/`-separated strings — never
 * `path.join`, which is platform-dependent): absolute names replace,
 * everything else appends with exactly one separator.
 *
 * @param dir - The base directory.
 * @param name - The child name (or an absolute path).
 * @returns The joined path.
 */
export function joinPath(dir: string, name: string): string {
  if (name.startsWith("/")) return name;
  const base = dir.replace(/\/+$/, "");
  return base === "" ? `/${name}` : `${base}/${name}`;
}

/**
 * The parent of a POSIX path; the root is its own parent.
 *
 * @param path - An absolute path.
 * @returns The parent path.
 */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return "/";
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

/**
 * Splits a path-bar draft for completion: the directory to list and the
 * partial final segment to prefix-match (empty after a trailing slash).
 *
 * @param input - The path bar's current text.
 * @returns The listing target and the prefix.
 * @example
 * ```ts
 * splitForCompletion("/var/lo"); // { dir: "/var", prefix: "lo" }
 * splitForCompletion("/var/");   // { dir: "/var", prefix: "" }
 * ```
 */
export function splitForCompletion(input: string): { dir: string; prefix: string } {
  const cut = input.lastIndexOf("/");
  if (cut < 0) return { dir: "/", prefix: input };
  return { dir: cut === 0 ? "/" : input.slice(0, cut), prefix: input.slice(cut + 1) };
}

/**
 * Human-readable byte size, file-manager style: bytes below 1 KB, one
 * decimal from MB up.
 *
 * @param bytes - The size in bytes.
 * @returns The formatted size, e.g. `"312 B"`, `"4.2 MB"`.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? Math.round(value).toString() : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

/**
 * The mtime column: local `YYYY-MM-DD HH:mm`, or `"—"` when unknown.
 *
 * @param mtimeMs - Epoch milliseconds (`0` = unknown).
 * @returns The formatted timestamp.
 */
export function formatMtime(mtimeMs: number): string {
  if (mtimeMs === 0) return "—";
  const d = new Date(mtimeMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The permissions column, `ls -l` style: type char + three rwx triads
 * (setuid/setgid/sticky render as `s`/`t` in the usual positions).
 *
 * @param entry - The listing entry.
 * @returns The mode string, e.g. `"drwxr-xr-x"`.
 */
export function formatMode(entry: SftpEntry): string {
  const type = entry.isSymlink ? "l" : entry.isDir ? "d" : "-";
  const { mode } = entry;
  const triad = (shift: number, special: number, specialChar: string): string => {
    const bits = (mode >> shift) & 0b111;
    const r = bits & 0b100 ? "r" : "-";
    const w = bits & 0b010 ? "w" : "-";
    let x = bits & 0b001 ? "x" : "-";
    if (mode & special) x = x === "x" ? specialChar : specialChar.toUpperCase();
    return `${r}${w}${x}`;
  };
  return type + triad(6, 0o4000, "s") + triad(3, 0o2000, "s") + triad(0, 0o1000, "t");
}

/**
 * The permission bits as a display octal string.
 *
 * @param mode - The numeric mode.
 * @returns Three or four octal digits, e.g. `"755"`, `"4755"`.
 */
export function toOctal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, "0");
}

/**
 * Parses the chmod dialog's octal field.
 *
 * @param text - The user's input, 3–4 octal digits.
 * @returns The numeric mode, or `null` when the input isn't valid octal.
 */
export function parseOctal(text: string): number | null {
  if (!/^[0-7]{3,4}$/.test(text.trim())) return null;
  return parseInt(text.trim(), 8);
}

/**
 * Transfer speed for the queue row.
 *
 * @param bytesPerSecond - The current rate.
 * @returns e.g. `"4.2 MB/s"`; `"—"` when idle.
 */
export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return "—";
  return `${formatSize(bytesPerSecond)}/s`;
}

/**
 * Remaining-time estimate for the queue row.
 *
 * @param bytes - Bytes moved so far.
 * @param total - Total bytes (`0` = unknown).
 * @param bytesPerSecond - The current rate.
 * @returns e.g. `"2m 14s"`, `"8s"`; `"—"` when it can't be estimated.
 */
export function formatEta(bytes: number, total: number, bytesPerSecond: number): string {
  if (total <= 0 || bytesPerSecond <= 0 || bytes >= total) return "—";
  const seconds = Math.ceil((total - bytes) / bytesPerSecond);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
