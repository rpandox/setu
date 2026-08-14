import { describe, expect, it } from "vitest";
import type { GitSyncStatus } from "../../ipc/contract";
import { lastCommitPhrase, syncStateLabel } from "./syncPresentation";

/** A status fixture. */
function status(overrides: Partial<GitSyncStatus> = {}): GitSyncStatus {
  return {
    state: "clean",
    dirty: false,
    ahead: 0,
    behind: 0,
    conflictFiles: [],
    ...overrides,
  };
}

describe("syncStateLabel", () => {
  it("speaks each dot state plainly", () => {
    expect(syncStateLabel(null)).toBe("checking…");
    expect(syncStateLabel(status())).toBe("synced");
    expect(syncStateLabel(status({ state: "ahead", ahead: 2 }))).toBe(
      "2 commits to push",
    );
    expect(syncStateLabel(status({ state: "ahead", ahead: 1 }))).toBe("1 commit to push");
    expect(syncStateLabel(status({ state: "ahead", dirty: true }))).toBe(
      "unsynced changes",
    );
    expect(syncStateLabel(status({ state: "behind", behind: 3 }))).toBe(
      "3 behind — sync to rebase",
    );
    expect(syncStateLabel(status({ state: "conflict" }))).toBe(
      "conflict — resolve or cancel",
    );
    expect(syncStateLabel(status({ state: "local" }))).toBe("local only — no remote");
  });
});

describe("lastCommitPhrase", () => {
  const now = 1_760_000_000_000; // ms

  it("is null without a commit", () => {
    expect(lastCommitPhrase(null, now)).toBeNull();
    expect(lastCommitPhrase(status(), now)).toBeNull();
  });

  it("buckets the age readably", () => {
    const at = (secondsAgo: number) =>
      lastCommitPhrase(status({ lastCommitTs: now / 1000 - secondsAgo }), now);
    expect(at(10)).toBe("just now");
    expect(at(14 * 60)).toBe("14m ago");
    expect(at(3 * 3600)).toBe("3h ago");
    expect(at(5 * 86_400)).toBe("5d ago");
  });
});
