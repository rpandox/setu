/**
 * Keys store tests (F8, Phase 7): the hardware-key matcher, the
 * ssh-copy-id command builder, and the generate flow's state handling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/client", () => ({
  ipcInvoke: vi.fn(),
}));
vi.mock("./sessions", () => ({
  useSessions: {
    getState: () => ({ openLocalTab: vi.fn().mockResolvedValue("sess-1") }),
  },
}));

import type { Host } from "../ipc/contract";
import { ipcInvoke } from "../ipc/client";
import { copyIdCommandOf, isHardwareKey, resetKeysForTests, useKeys } from "./keys";

/**
 * A minimal Setu host for the command builder.
 *
 * @param overrides - Fields to override on the base host.
 */
function host(overrides: Partial<Host> = {}): Host {
  return {
    id: "h1",
    label: "hermes",
    group: "",
    tags: [],
    hue: 0,
    hostname: "hermes.example.net",
    user: "pandox",
    port: 22,
    identity: "agent",
    use_mosh: false,
    startup: "",
    control_master: false,
    reachability: true,
    forwards: [],
    health: { enabled: false, interval_s: 30 },
    notes: "",
    favorite: false,
    source: "setu",
    ...overrides,
  };
}

beforeEach(() => {
  resetKeysForTests();
  vi.mocked(ipcInvoke).mockReset();
});

describe("isHardwareKey", () => {
  it("matches -sk paths and agent type strings", () => {
    expect(isHardwareKey("~/.ssh/id_ed25519_sk")).toBe(true);
    expect(isHardwareKey("/keys/backup-sk")).toBe(true);
    expect(isHardwareKey("ED25519-SK")).toBe(true);
    expect(isHardwareKey("sk-ssh-ed25519@openssh.com")).toBe(true);
  });

  it("leaves ordinary identities alone", () => {
    expect(isHardwareKey("agent")).toBe(false);
    expect(isHardwareKey("")).toBe(false);
    expect(isHardwareKey("~/.ssh/id_ed25519")).toBe(false);
    expect(isHardwareKey("ED25519")).toBe(false);
    expect(isHardwareKey("~/.ssh/skeleton")).toBe(false);
  });
});

describe("copyIdCommandOf", () => {
  it("builds explicit flags for setu hosts", () => {
    expect(copyIdCommandOf(host({ port: 2222 }), "~/.ssh/id_ed25519.pub")).toBe(
      "ssh-copy-id -i ~/.ssh/id_ed25519.pub -p 2222 pandox@hermes.example.net",
    );
  });

  it("omits default port and empty user", () => {
    expect(copyIdCommandOf(host({ user: "" }), "~/k.pub")).toBe(
      "ssh-copy-id -i ~/k.pub hermes.example.net",
    );
  });

  it("uses the bare alias for ssh_config imports", () => {
    expect(
      copyIdCommandOf(host({ source: "ssh_config", label: "jump" }), "~/k.pub"),
    ).toBe("ssh-copy-id -i ~/k.pub jump");
  });

  it("quotes public-key paths containing spaces", () => {
    expect(copyIdCommandOf(host(), "/Users/p/My Keys/k.pub")).toBe(
      "ssh-copy-id -i '/Users/p/My Keys/k.pub' pandox@hermes.example.net",
    );
  });
});

describe("generate", () => {
  it("keeps the public key and path on success", async () => {
    vi.mocked(ipcInvoke).mockResolvedValueOnce({ publicKey: "ssh-ed25519 AAAA x" });
    const created = await useKeys.getState().generate("~/.ssh/id_test", "secret", "x");
    expect(created).toBe(true);
    expect(useKeys.getState().publicKey).toBe("ssh-ed25519 AAAA x");
    expect(useKeys.getState().publicKeyPath).toBe("~/.ssh/id_test");
    expect(useKeys.getState().keysError).toBeNull();
    // The passphrase went through as-is (to the Keychain, Rust-side).
    expect(vi.mocked(ipcInvoke)).toHaveBeenCalledWith("keys_generate", {
      path: "~/.ssh/id_test",
      passphrase: "secret",
      comment: "x",
    });
  });

  it("surfaces expected refusals inline", async () => {
    vi.mocked(ipcInvoke).mockResolvedValueOnce({
      error: { kind: "file_exists", message: "taken — pick another filename" },
    });
    const created = await useKeys.getState().generate("~/.ssh/id_test", "", "");
    expect(created).toBe(false);
    expect(useKeys.getState().keysError).toContain("taken");
    expect(useKeys.getState().publicKey).toBeNull();
  });

  it("omits empty passphrase and comment from the payload", async () => {
    vi.mocked(ipcInvoke).mockResolvedValueOnce({ publicKey: "k" });
    await useKeys.getState().generate("~/.ssh/id_test", "", "");
    expect(vi.mocked(ipcInvoke)).toHaveBeenCalledWith("keys_generate", {
      path: "~/.ssh/id_test",
      passphrase: undefined,
      comment: undefined,
    });
  });
});
