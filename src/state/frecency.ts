/**
 * Frecency (F11, Phase 4) — "frequency × recency" scoring for the palette.
 *
 * Every host connect and palette action run records a use; ranking blends
 * these scores into fuzzy-match order so the hosts and commands you
 * actually reach for float to the top. Records persist in `state.json`
 * (device-local — usage patterns are this machine's, not the fleet's).
 *
 * The model is deliberately small: a use count plus a last-used timestamp
 * per subject, scored as `uses × 2^(-age / 7 days)`. Half of a subject's
 * weight evaporates each idle week, so an old habit never outranks what
 * you connected to this morning by count alone.
 */

import type { FrecencyEntry } from "../ipc/contract";

/**
 * Frecency subject for a host (palette results, quick connect).
 *
 * @param hostId - The host's id.
 * @returns The `host:<id>` subject key.
 */
export function hostSubject(hostId: string): string {
  return `host:${hostId}`;
}

/**
 * Frecency subject for a palette action.
 *
 * @param actionId - The action's registry id.
 * @returns The `action:<id>` subject key.
 */
export function actionSubject(actionId: string): string {
  return `action:${actionId}`;
}

/** Score half-life: one idle week halves a subject's weight. */
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** Kept entries per document; the lowest-scoring records are pruned. */
export const FRECENCY_CAP = 200;

/**
 * A subject's current score: `uses × 2^(-age / half-life)`.
 *
 * @param entry - The subject's record, if any.
 * @param now - Epoch ms of "now" (injectable for tests).
 * @returns A non-negative score; `0` for unknown subjects.
 * @example
 * ```ts
 * frecencyScore({ uses: 4, lastUsedAt: now - HALF_LIFE }, now); // ≈ 2
 * ```
 */
export function frecencyScore(
  entry: FrecencyEntry | undefined,
  now: number = Date.now(),
): number {
  if (entry === undefined || entry.uses <= 0) return 0;
  const age = Math.max(0, now - entry.lastUsedAt);
  return entry.uses * 2 ** (-age / HALF_LIFE_MS);
}

/**
 * Records one use of `subject`, returning a new map (input untouched).
 * When the map exceeds {@link FRECENCY_CAP}, the lowest-scoring entries are
 * pruned so `state.json` never grows unboundedly.
 *
 * @param map - The current frecency records.
 * @param subject - `host:<id>` or `action:<id>`.
 * @param now - Epoch ms of "now" (injectable for tests).
 * @returns The updated records.
 */
export function bumpFrecency(
  map: Record<string, FrecencyEntry>,
  subject: string,
  now: number = Date.now(),
): Record<string, FrecencyEntry> {
  const previous = map[subject];
  const next: Record<string, FrecencyEntry> = {
    ...map,
    [subject]: { uses: (previous?.uses ?? 0) + 1, lastUsedAt: now },
  };
  const keys = Object.keys(next);
  if (keys.length <= FRECENCY_CAP) return next;
  keys.sort((a, b) => frecencyScore(next[b], now) - frecencyScore(next[a], now));
  return Object.fromEntries(keys.slice(0, FRECENCY_CAP).map((k) => [k, next[k]]));
}
