/**
 * Shared presentation helpers for the sync status (F10): the sidebar
 * footer, the StatusBar chip, and the Settings sync section all speak the
 * same words for the same states.
 */

import type { GitSyncStatus } from "../../ipc/contract";

/**
 * One plain phrase for the footer/settings status line.
 *
 * @param status - The last known status, or `null` before the first read.
 * @returns A short, sentence-case description.
 */
export function syncStateLabel(status: GitSyncStatus | null): string {
  if (!status) return "checking…";
  switch (status.state) {
    case "clean":
      return "synced";
    case "ahead":
      return status.dirty && status.ahead === 0
        ? "unsynced changes"
        : `${status.ahead || "local"} commit${status.ahead === 1 ? "" : "s"} to push`;
    case "behind":
      return `${status.behind} behind — sync to rebase`;
    case "conflict":
      return "conflict — resolve or cancel";
    case "local":
      return status.remoteUrl ? "local" : "local only — no remote";
  }
}

/**
 * When the last commit happened, as a relative phrase for the popover.
 *
 * @param status - The last known status.
 * @param now - The current time in ms (injectable for tests).
 * @returns `"just now"`, `"14m ago"`, … or `null` without a commit.
 */
export function lastCommitPhrase(
  status: GitSyncStatus | null,
  now: number = Date.now(),
): string | null {
  const ts = status?.lastCommitTs;
  if (!ts) return null;
  const seconds = Math.max(0, Math.floor(now / 1000 - ts));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
