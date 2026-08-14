import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, useSettings } from "../../state/settings";
import { wireSettingsHotApply } from "./hotApply";

const ipcInvoke = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("../../ipc/client", () => ({ ipcInvoke }));
const applyTerminalOptions = vi.hoisted(() => vi.fn());
vi.mock("../terminal/registry", () => ({ applyTerminalOptions }));

let unwire: () => void = () => undefined;

beforeEach(() => {
  useSettings.setState({
    doc: defaultSettings(),
    loaded: true,
    errors: [],
    saving: false,
    loadError: null,
  });
  ipcInvoke.mockClear();
  applyTerminalOptions.mockClear();
  unwire = wireSettingsHotApply();
});

afterEach(() => {
  unwire();
});

describe("wireSettingsHotApply", () => {
  it("pushes font and scrollback changes onto live terminals", () => {
    const doc = defaultSettings();
    doc.terminal.font_size = 16;
    doc.terminal.scrollback_lines = 20_000;
    useSettings.getState().recordChanged(doc);
    expect(applyTerminalOptions).toHaveBeenCalledWith({
      fontSize: 16,
      scrollback: 20_000,
    });
  });

  it("applies on the initial load too, correcting early terminals", () => {
    useSettings.setState({ loaded: false });
    const doc = defaultSettings();
    doc.terminal.font_size = 15;
    useSettings.getState().recordChanged(doc);
    expect(applyTerminalOptions).toHaveBeenCalledWith({
      fontSize: 15,
      scrollback: 10_000,
    });
  });

  it("re-tunes the running prober when reachability knobs change", () => {
    const doc = defaultSettings();
    doc.reachability.interval_s = 30;
    useSettings.getState().recordChanged(doc);
    expect(ipcInvoke).toHaveBeenCalledWith("reach_start", {});
  });

  it("stops the prober when the kill switch flips off", () => {
    const doc = defaultSettings();
    doc.reachability.enabled = false;
    useSettings.getState().recordChanged(doc);
    expect(ipcInvoke).toHaveBeenCalledWith("reach_stop", {});
  });

  it("leaves the terminal and prober alone for unrelated changes", () => {
    const doc = defaultSettings();
    doc.tailnet.default_user = "ops";
    useSettings.getState().recordChanged(doc);
    expect(applyTerminalOptions).not.toHaveBeenCalled();
    expect(ipcInvoke).not.toHaveBeenCalled();
  });
});
