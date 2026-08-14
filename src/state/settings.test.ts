import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsDocument } from "../ipc/contract";
import { defaultSettings, useSettings } from "./settings";

const ipcInvoke = vi.hoisted(() => vi.fn());
const onSettingsChanged = vi.hoisted(() => vi.fn());
vi.mock("../ipc/client", () => ({ ipcInvoke, onSettingsChanged }));

/** A loaded document distinct from the defaults. */
function customDoc(): SettingsDocument {
  const doc = defaultSettings();
  doc.terminal.font_size = 16;
  doc.tailnet.default_user = "ops";
  doc.flags.semantic_terminal = false;
  return doc;
}

beforeEach(() => {
  useSettings.setState({
    doc: defaultSettings(),
    loaded: false,
    errors: [],
    saving: false,
    loadError: null,
  });
  ipcInvoke.mockReset();
});

describe("defaultSettings", () => {
  it("mirrors the Rust defaults", () => {
    const doc = defaultSettings();
    expect(doc.terminal).toEqual({ font_size: 13, scrollback_lines: 10_000 });
    expect(doc.snapshots).toEqual({ enabled: true, interval_days: 7, keep: 10 });
    expect(doc.reachability.interval_s).toBe(60);
    expect(doc.sync.auto_sync_on_quit).toBe(false);
  });
});

describe("load", () => {
  it("adopts the fetched document", async () => {
    const doc = customDoc();
    ipcInvoke.mockResolvedValueOnce(doc);
    await useSettings.getState().load();
    expect(ipcInvoke).toHaveBeenCalledWith("settings_get", {});
    expect(useSettings.getState().doc).toEqual(doc);
    expect(useSettings.getState().loaded).toBe(true);
    expect(useSettings.getState().loadError).toBeNull();
  });

  it("keeps the defaults and records the error on failure", async () => {
    ipcInvoke.mockRejectedValueOnce("failed to parse settings.toml");
    await useSettings.getState().load();
    expect(useSettings.getState().doc).toEqual(defaultSettings());
    expect(useSettings.getState().loaded).toBe(true);
    expect(useSettings.getState().loadError).toContain("failed to parse");
  });
});

describe("save", () => {
  it("updates the document and clears errors on success", async () => {
    const doc = customDoc();
    ipcInvoke.mockResolvedValueOnce({ settings: doc, errors: [] });
    const saved = await useSettings.getState().save(doc);
    expect(saved).toBe(true);
    expect(ipcInvoke).toHaveBeenCalledWith("settings_set", { document: doc });
    expect(useSettings.getState().doc).toEqual(doc);
    expect(useSettings.getState().errors).toEqual([]);
    expect(useSettings.getState().saving).toBe(false);
  });

  it("surfaces field errors and leaves the document alone", async () => {
    const before = useSettings.getState().doc;
    ipcInvoke.mockResolvedValueOnce({
      errors: [{ field: "terminal.font_size", message: "font size must be 8–32 px" }],
    });
    const saved = await useSettings.getState().save(customDoc());
    expect(saved).toBe(false);
    expect(useSettings.getState().doc).toBe(before);
    expect(useSettings.getState().errors[0]?.field).toBe("terminal.font_size");
  });

  it("turns an infrastructure rejection into a document-level error", async () => {
    ipcInvoke.mockRejectedValueOnce("failed to write settings.toml");
    const saved = await useSettings.getState().save(customDoc());
    expect(saved).toBe(false);
    expect(useSettings.getState().errors[0]?.field).toBe("");
    expect(useSettings.getState().errors[0]?.message).toContain("failed to write");
  });
});

describe("recordChanged", () => {
  it("converges on a document broadcast from another window", () => {
    const doc = customDoc();
    useSettings.getState().recordChanged(doc);
    expect(useSettings.getState().doc).toEqual(doc);
    expect(useSettings.getState().loaded).toBe(true);
  });
});
