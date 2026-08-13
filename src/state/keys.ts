/**
 * Keys panel state (F8, Phase 7): the ssh-agent listing, key generation,
 * and the ssh-copy-id helper.
 *
 * Secrets never live here: a typed passphrase goes straight into
 * `keys_generate` (which stores it in the Keychain) and is forgotten.
 * The ssh-copy-id helper runs in a **visible** local tab — the command is
 * typed into a fresh pane exactly like a snippet run, never hidden.
 */

import { create } from "zustand";

import { ipcInvoke } from "../ipc/client";
import type { AgentListResult, Host } from "../ipc/contract";
import { useSessions } from "./sessions";
import { useToast } from "./toast";

/**
 * Whether an identity looks hardware-backed (FIDO2 `*-sk`) — the F8 hint
 * ("system ssh will ask for a touch"). Matches both path spellings
 * (`id_ed25519_sk`) and agent type strings (`ED25519-SK`,
 * `sk-ssh-ed25519@openssh.com`).
 *
 * @param identity - A key path or an algorithm/type string.
 * @returns `true` when the value names a hardware-backed key.
 * @example
 * ```ts
 * isHardwareKey("~/.ssh/id_ed25519_sk"); // true
 * isHardwareKey("agent"); // false
 * ```
 */
export function isHardwareKey(identity: string): boolean {
  const value = identity.trim().toLowerCase();
  if (value === "" || value === "agent") return false;
  return value.startsWith("sk-") || /[-_]sk([-_.]|$)/.test(value);
}

/**
 * Builds the ssh-copy-id command the helper types into a local tab.
 * Imported `ssh_config` rows go by bare alias (system ssh applies the
 * real config); Setu rows get explicit flags — the `sshCommandOf` shape.
 *
 * @param host - The target host.
 * @param publicKeyPath - The `.pub` file to install.
 * @returns The full command line, without a trailing newline.
 * @example
 * ```ts
 * copyIdCommandOf(host, "~/.ssh/id_ed25519.pub");
 * // "ssh-copy-id -i ~/.ssh/id_ed25519.pub -p 2222 pandox@hermes.example.net"
 * ```
 */
export function copyIdCommandOf(host: Host, publicKeyPath: string): string {
  const quoted = publicKeyPath.includes(" ") ? `'${publicKeyPath}'` : publicKeyPath;
  const parts = ["ssh-copy-id", "-i", quoted];
  if (host.source === "ssh_config") {
    parts.push(host.label);
    return parts.join(" ");
  }
  if (host.port !== 22) parts.push("-p", String(host.port));
  parts.push(host.user ? `${host.user}@${host.hostname}` : host.hostname);
  return parts.join(" ");
}

/** Store shape + actions for the Keys panel. */
export interface KeysState {
  /** Whether the panel is showing. */
  panelOpen: boolean;
  /** The last `agent_list` answer, or `null` before the first load. */
  agent: AgentListResult | null;
  /** Whether an agent refresh is in flight. */
  agentLoading: boolean;
  /** Whether a generation is in flight. */
  generating: boolean;
  /** The last generation/copy problem, for inline display. */
  keysError: string | null;
  /** The last generated public key line, or `null`. */
  publicKey: string | null;
  /** The private-key path behind {@link KeysState.publicKey}. */
  publicKeyPath: string | null;

  /** Opens the panel and refreshes the agent listing. */
  openPanel(): void;
  /** Closes the panel (state like the last public key survives). */
  closePanel(): void;
  /** Re-queries `ssh-add -l`. */
  refreshAgent(): Promise<void>;
  /**
   * Generates a key via `keys_generate`.
   *
   * @param path - Private-key destination (`~` allowed).
   * @param passphrase - Optional; goes to the Keychain, never kept here.
   * @param comment - Optional `-C` comment.
   * @returns `true` when the keypair was created.
   */
  generate(path: string, passphrase: string, comment: string): Promise<boolean>;
  /** Copies the last generated public key to the clipboard. */
  copyPublicKey(): Promise<void>;
  /**
   * Opens a local tab and runs `ssh-copy-id` in it — visible, per F8.
   *
   * @param host - The target host.
   * @param publicKeyPath - The `.pub` file to install.
   */
  runCopyId(host: Host, publicKeyPath: string): Promise<void>;
}

/** The Keys panel store hook. */
export const useKeys = create<KeysState>((set, get) => ({
  panelOpen: false,
  agent: null,
  agentLoading: false,
  generating: false,
  keysError: null,
  publicKey: null,
  publicKeyPath: null,

  openPanel(): void {
    set({ panelOpen: true, keysError: null });
    void get().refreshAgent();
  },

  closePanel(): void {
    set({ panelOpen: false });
  },

  async refreshAgent(): Promise<void> {
    set({ agentLoading: true });
    try {
      const agent = await ipcInvoke("agent_list", {});
      set({ agent, agentLoading: false });
    } catch (error) {
      set({
        agent: { available: false, keys: [], note: String(error) },
        agentLoading: false,
      });
    }
  },

  async generate(path: string, passphrase: string, comment: string): Promise<boolean> {
    set({ generating: true, keysError: null });
    try {
      const result = await ipcInvoke("keys_generate", {
        path,
        passphrase: passphrase === "" ? undefined : passphrase,
        comment: comment === "" ? undefined : comment,
      });
      if (result.error !== undefined) {
        set({ keysError: result.error.message, generating: false });
        return false;
      }
      set({
        publicKey: result.publicKey ?? null,
        publicKeyPath: path,
        generating: false,
      });
      useToast.getState().show("Key generated", "success");
      return true;
    } catch (error) {
      set({ keysError: String(error), generating: false });
      return false;
    }
  },

  async copyPublicKey(): Promise<void> {
    const { publicKey } = get();
    if (publicKey === null) return;
    try {
      await navigator.clipboard.writeText(publicKey);
      useToast.getState().show("Public key copied", "success");
    } catch (error) {
      set({ keysError: String(error) });
    }
  },

  async runCopyId(host: Host, publicKeyPath: string): Promise<void> {
    const command = copyIdCommandOf(host, publicKeyPath);
    try {
      const sessionId = await useSessions.getState().openLocalTab();
      // Lands in the PTY's stdin buffer; the shell runs it on start —
      // the snippet-run precedent. The pane stays visible for the remote
      // password prompt ssh-copy-id may show.
      await ipcInvoke("pty_write", { sessionId, data: `${command}\n` });
      set({ panelOpen: false });
    } catch (error) {
      set({ keysError: String(error) });
    }
  },
}));

/** Test-only reset (mirrors the other stores' reset helpers). */
export function resetKeysForTests(): void {
  useKeys.setState({
    panelOpen: false,
    agent: null,
    agentLoading: false,
    generating: false,
    keysError: null,
    publicKey: null,
    publicKeyPath: null,
  });
}
