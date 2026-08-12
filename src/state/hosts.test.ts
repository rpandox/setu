// Host store behavior: search ranking, sections, drafts, dedupe, and the
// IPC round-trips behind save/delete/adopt. IPC is mocked — this tests the
// state machine and the pure helpers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Host } from "../ipc/contract";

const ipcInvoke = vi.hoisted(() => vi.fn());
const markOrphaned = vi.hoisted(() => vi.fn());

vi.mock("../ipc/client", () => ({ ipcInvoke }));
// hosts → sessions is a one-way dependency (orphan marking on delete);
// mocking it keeps xterm and the registry out of this test.
vi.mock("./sessions", () => ({
  useSessions: { getState: () => ({ markOrphaned }) },
}));

import {
  duplicatesOf,
  emptyHostDraft,
  rankHosts,
  searchHosts,
  sidebarSections,
  sshCommandOf,
  useHosts,
} from "./hosts";

/**
 * A host with overrides — keeps fixtures terse.
 *
 * @param overrides - Fields to override on the blank draft.
 * @returns The host.
 */
function host(overrides: Partial<Host>): Host {
  return {
    ...emptyHostDraft(),
    id: "id",
    label: "host",
    hostname: "host.net",
    ...overrides,
  };
}

const hermes = host({
  id: "1",
  label: "hermes",
  hostname: "hermes.tailnet.ts.net",
  user: "pandox",
  favorite: true,
});
const atlas = host({
  id: "2",
  label: "atlas",
  hostname: "atlas.internal",
  user: "deploy",
  group: "fleet",
});
const ganymede = host({
  id: "3",
  label: "ganymede",
  hostname: "ganymede.internal",
  user: "ops",
  group: "fleet",
  tags: ["prod", "hermes-adjacent"],
});
const imported = host({
  id: "sshcfg:jump",
  label: "jump",
  hostname: "jump.example.net",
  source: "ssh_config",
});

beforeEach(() => {
  useHosts.setState({
    hosts: [],
    loadError: null,
    query: "",
    editorTarget: null,
  });
  ipcInvoke.mockReset();
});

describe("searchHosts", () => {
  it("returns all hosts unchanged for an empty query", () => {
    const all = [hermes, atlas];
    expect(searchHosts(all, "  ")).toEqual(all);
  });

  it("ranks a label match above a tag match", () => {
    const results = searchHosts([ganymede, hermes], "hermes");
    expect(results[0]).toEqual(hermes);
    expect(results).toContain(ganymede);
  });

  it("matches with a 3-char prefix (the ⌘T flow)", () => {
    const results = searchHosts([atlas, ganymede, hermes], "her");
    expect(results[0]).toEqual(hermes);
  });

  it("tolerates a typo", () => {
    const results = searchHosts([atlas, hermes], "hemres");
    expect(results[0]).toEqual(hermes);
  });
});

describe("rankHosts", () => {
  const now = 1_700_000_000_000;

  it("『her』 puts hermes first — the F11 acceptance flow", () => {
    const results = rankHosts([atlas, ganymede, hermes], "her", {}, now);
    expect(results[0]).toEqual(hermes);
  });

  it("frecency breaks fuzzy near-ties", () => {
    const herald = host({ id: "4", label: "herald", hostname: "herald.internal" });
    // Both "her*" labels match; the recently-used one must win either way
    // the plain fuse scores fall.
    const results = rankHosts(
      [herald, hermes],
      "her",
      { "host:4": { uses: 6, lastUsedAt: now } },
      now,
    );
    expect(results[0]).toEqual(herald);
  });

  it("an empty query orders by frecency, then favorites", () => {
    const results = rankHosts(
      [atlas, ganymede, hermes],
      "",
      { "host:3": { uses: 5, lastUsedAt: now } },
      now,
    );
    expect(results[0]).toEqual(ganymede); // frecency first
    expect(results[1]).toEqual(hermes); // favorite beats the rest
    expect(results[2]).toEqual(atlas);
  });

  it("frecency cannot resurrect a non-match", () => {
    const results = rankHosts(
      [atlas, hermes],
      "hermes",
      { "host:2": { uses: 50, lastUsedAt: now } },
      now,
    );
    expect(results).toEqual([hermes]);
  });
});

describe("sidebarSections", () => {
  it("orders favorites, named groups, ungrouped, then ssh config", () => {
    const ungrouped = host({ id: "4", label: "solo" });
    const sections = sidebarSections([ungrouped, imported, atlas, hermes, ganymede], "");
    expect(sections.map((s) => s.key)).toEqual([
      "favorites",
      "group:fleet",
      "ungrouped",
      "ssh-config",
    ]);
    expect(sections[0].hosts).toEqual([hermes]);
    expect(sections[1].hosts).toEqual([atlas, ganymede]);
    expect(sections[2].hosts).toEqual([ungrouped]);
    expect(sections[3].hosts).toEqual([imported]);
  });

  it("drops empty sections and never duplicates favorites into groups", () => {
    const sections = sidebarSections([hermes], "");
    expect(sections.map((s) => s.key)).toEqual(["favorites"]);
  });

  it("collapses to one ranked Results section while searching", () => {
    const sections = sidebarSections([atlas, hermes], "her");
    expect(sections.map((s) => s.key)).toEqual(["results"]);
    expect(sections[0].hosts[0]).toEqual(hermes);
  });
});

describe("sshCommandOf", () => {
  it("spells out flags for setu hosts", () => {
    const full = host({
      label: "hermes",
      hostname: "hermes.example.net",
      user: "pandox",
      port: 2222,
      identity: "~/.ssh/id_ed25519",
    });
    expect(sshCommandOf(full)).toBe(
      "ssh -p 2222 -i ~/.ssh/id_ed25519 pandox@hermes.example.net",
    );
  });

  it("omits default port, agent identity, and empty user", () => {
    expect(sshCommandOf(host({ user: "", hostname: "h.net" }))).toBe("ssh h.net");
  });

  it("uses the bare alias for imported rows", () => {
    expect(sshCommandOf(imported)).toBe("ssh jump");
  });
});

describe("duplicatesOf", () => {
  it("flags another host with the same user@hostname:port", () => {
    const draft = host({ id: "", user: "pandox", hostname: "hermes.tailnet.ts.net" });
    expect(duplicatesOf([hermes, atlas], draft)).toEqual([hermes]);
  });

  it("never flags the host being edited", () => {
    expect(duplicatesOf([hermes], { ...hermes })).toEqual([]);
  });
});

describe("store actions", () => {
  it("load fetches hosts and clears the error", async () => {
    ipcInvoke.mockResolvedValueOnce([hermes]);
    await useHosts.getState().load();
    expect(ipcInvoke).toHaveBeenCalledWith("hosts_list", {});
    expect(useHosts.getState().hosts).toEqual([hermes]);
    expect(useHosts.getState().loadError).toBeNull();
  });

  it("load keeps the old list and records the error on failure", async () => {
    useHosts.setState({ hosts: [hermes] });
    ipcInvoke.mockRejectedValueOnce("failed to parse hosts.toml");
    await useHosts.getState().load();
    expect(useHosts.getState().hosts).toEqual([hermes]);
    expect(useHosts.getState().loadError).toContain("hosts.toml");
  });

  it("saveHost returns validation errors and keeps the editor open", async () => {
    useHosts.setState({ editorTarget: "new" });
    ipcInvoke.mockResolvedValueOnce({
      errors: [{ field: "hostname", message: "Hostname is required" }],
    });
    const errors = await useHosts.getState().saveHost(emptyHostDraft());
    expect(errors).toHaveLength(1);
    expect(useHosts.getState().editorTarget).toBe("new");
  });

  it("saveHost closes the editor and reloads on success", async () => {
    useHosts.setState({ editorTarget: "new" });
    ipcInvoke
      .mockResolvedValueOnce({ host: hermes }) // host_upsert
      .mockResolvedValueOnce([hermes]); // hosts_list reload
    const errors = await useHosts.getState().saveHost({ ...hermes, id: "" });
    expect(errors).toEqual([]);
    expect(useHosts.getState().editorTarget).toBeNull();
    expect(useHosts.getState().hosts).toEqual([hermes]);
  });

  it("deleteHost orphans live sessions, closes the editor, and reloads", async () => {
    useHosts.setState({ hosts: [hermes], editorTarget: hermes.id });
    ipcInvoke
      .mockResolvedValueOnce(null) // host_delete
      .mockResolvedValueOnce([]); // hosts_list reload
    await useHosts.getState().deleteHost(hermes.id);
    expect(ipcInvoke).toHaveBeenCalledWith("host_delete", { hostId: hermes.id });
    expect(markOrphaned).toHaveBeenCalledWith(hermes.id);
    expect(useHosts.getState().editorTarget).toBeNull();
    expect(useHosts.getState().hosts).toEqual([]);
  });

  it("adoptHost adopts then reloads", async () => {
    ipcInvoke
      .mockResolvedValueOnce({ ...imported, id: "new-uuid", source: "setu" }) // host_adopt
      .mockResolvedValueOnce([{ ...imported, id: "new-uuid", source: "setu" }]); // reload
    await useHosts.getState().adoptHost(imported.id);
    expect(ipcInvoke).toHaveBeenCalledWith("host_adopt", { hostId: imported.id });
    expect(useHosts.getState().hosts[0].source).toBe("setu");
  });
});
