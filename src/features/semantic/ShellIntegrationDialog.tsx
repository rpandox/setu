import "./ShellIntegrationDialog.css";
import { useEffect, useState } from "react";
import { Select } from "../../components/controls";
import { ipcInvoke } from "../../ipc/client";
import type {
  IntegrationShell,
  ShellIntegrationPreview,
  ShellIntegrationStatus,
  ShellIntegrationTarget,
} from "../../ipc/contract";
import { useSemantic, type InstallerTarget } from "../../state/semantic";
import { useSftp } from "../../state/sftp";
import { useToast } from "../../state/toast";
import { FingerprintDialog } from "../ssh/FingerprintDialog";
import { SecretPromptDialog } from "../ssh/SecretPromptDialog";

/** Labels for the shell picker. */
const SHELL_LABELS: Record<IntegrationShell, string> = {
  zsh: "zsh — ~/.zshrc",
  bash: "bash — ~/.bashrc",
  fish: "fish — ~/.config/fish/config.fish",
};

/** Props for {@link ShellIntegrationDialog}. */
export interface ShellIntegrationDialogProps {
  /** Where to install: this Mac, or a saved host. */
  target: InstallerTarget;
  /** Closes the dialog. */
  onClose(): void;
}

/**
 * The F12 shell-integration installer: detects the target's shell, shows
 * the **exact rc diff** an install (or uninstall) would make, and applies
 * it only on confirm. The fenced block is reversible — the same dialog
 * offers "Remove" once installed.
 *
 * Remote targets ride the Phase 5 SFTP engine: the dialog makes sure a
 * session to the host exists (same auth ladder; the fingerprint and
 * secret prompts render here when the SFTP panel is hidden) and operates
 * on the remote rc through it. SFTP cannot run `$SHELL`, so the remote
 * shell is inferred from which rc files exist, with a picker defaulting to
 * bash (PLAN.md §5, remote-installer row).
 *
 * @param props - {@link ShellIntegrationDialogProps}
 * @returns The dialog.
 */
export function ShellIntegrationDialog({ target, onClose }: ShellIntegrationDialogProps) {
  const sftp = useSftp();
  const [status, setStatus] = useState<ShellIntegrationStatus | null>(null);
  const [shell, setShell] = useState<IntegrationShell | null>(null);
  const [preview, setPreview] = useState<ShellIntegrationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);

  // Remote: make sure a session exists (no panel toggle).
  useEffect(() => {
    if (target.kind === "remote") sftp.ensureConnected(target.hostId, target.hostLabel);
  }, [target]);

  const ipcTarget: ShellIntegrationTarget | null =
    target.kind === "local"
      ? { kind: "local" }
      : sftp.hostId === target.hostId &&
          sftp.connState === "connected" &&
          sftp.sftpSessionId !== null
        ? { kind: "remote", sftpSessionId: sftp.sftpSessionId }
        : null;
  const ipcTargetKey = ipcTarget === null ? "" : JSON.stringify(ipcTarget);

  // Status once the target is reachable.
  useEffect(() => {
    if (ipcTarget === null) return;
    let cancelled = false;
    setError(null);
    void ipcInvoke("shell_integration_status", { target: ipcTarget })
      .then((result) => {
        if (cancelled) return;
        setStatus(result);
        setShell(result.shell ?? (target.kind === "remote" ? "bash" : null));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [ipcTargetKey]);

  const action: "install" | "uninstall" = status?.installed ? "uninstall" : "install";

  // Preview whenever shell/action settle.
  useEffect(() => {
    if (ipcTarget === null || shell === null) return;
    let cancelled = false;
    setPreview(null);
    void ipcInvoke("shell_integration_preview", {
      change: { target: ipcTarget, shell, action },
    })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [ipcTargetKey, shell, action]);

  const apply = async (): Promise<void> => {
    if (ipcTarget === null || shell === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await ipcInvoke("shell_integration_apply", {
        change: { target: ipcTarget, shell, action },
      });
      setApplied(
        result.installed
          ? `Installed in ${result.rcPath}. Open a new shell (or run \`exec $SHELL\`) to activate.`
          : `Removed from ${result.rcPath}.`,
      );
      setStatus((prev) => (prev ? { ...prev, installed: result.installed } : prev));
      setPreview(null);
      useToast
        .getState()
        .show(
          result.installed ? "Shell integration installed" : "Shell integration removed",
          "info",
        );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const where = target.kind === "local" ? "this Mac" : target.hostLabel;
  const title = `Shell integration on ${where}`;
  const connecting =
    target.kind === "remote" && ipcTarget === null && sftp.connState !== "error";
  const showPrompts = target.kind === "remote" && !sftp.open;

  return (
    <div className="shellint-scrim" onMouseDown={onClose}>
      <div
        className="shellint"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 className="shellint-title">{title}</h2>
        <p className="shellint-detail">
          A fenced block in your shell’s rc file teaches the terminal where commands begin
          and end (OSC 133), the working directory (OSC 7), and the command text —
          unlocking gutter marks, prompt jumps, copy-last-output, re-run, the cwd chip,
          done-notifications, and history. Nothing is written until you confirm the diff
          below; “Remove” takes the block out again cleanly.
        </p>

        {connecting && (
          <p className="shellint-status">Connecting to {where} over SFTP…</p>
        )}
        {target.kind === "remote" && sftp.connState === "error" && (
          <p className="shellint-error">
            {sftp.connError}{" "}
            <button type="button" onClick={() => sftp.retryConnect()}>
              Retry
            </button>
          </p>
        )}

        {status !== null && (
          <div className="shellint-row">
            <span className="shellint-label">Shell</span>
            <Select
              value={shell ?? ""}
              aria-label="Shell"
              options={(["zsh", "bash", "fish"] as IntegrationShell[]).map((s) => ({
                value: s,
                label: `${SHELL_LABELS[s]}${status.candidates.includes(s) ? "" : " (rc missing — will be created)"}`,
              }))}
              onChange={(value) => setShell(value as IntegrationShell)}
            />
            <span className="shellint-hint">
              {status.shell !== null
                ? `Detected ${status.shell}${target.kind === "remote" ? " from the rc files present" : " from $SHELL"}.`
                : "Could not detect the shell — pick one."}
            </span>
          </div>
        )}

        {preview !== null && (
          <div className="shellint-preview">
            <div className="shellint-preview-head">
              <code>{preview.rcPath}</code>
              <span className="shellint-hint">
                {preview.exists ? "" : "new file · "}
                {preview.diff.length === 0
                  ? "no change"
                  : `${preview.diff.filter((l) => l.kind === "+").length} added, ${preview.diff.filter((l) => l.kind === "-").length} removed`}
              </span>
            </div>
            <pre className="shellint-diff" aria-label="rc file diff">
              {preview.diff.map((line, i) => (
                <span
                  key={i}
                  className={`shellint-diff-line shellint-diff-line--${lineClass(line.kind)}`}
                >
                  {line.kind} {line.text}
                  {"\n"}
                </span>
              ))}
            </pre>
          </div>
        )}

        {applied !== null && <p className="shellint-status">{applied}</p>}
        {error !== null && <p className="shellint-error">{error}</p>}

        <div className="shellint-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button
            className={`shellint-confirm${action === "uninstall" ? " shellint-confirm--remove" : ""}`}
            type="button"
            disabled={
              busy || preview === null || preview.diff.length === 0 || shell === null
            }
            onClick={() => void apply()}
          >
            {action === "install" ? "Install — write this diff" : "Remove the block"}
          </button>
        </div>
      </div>

      {showPrompts && sftp.hostkeyPrompt !== null && (
        <FingerprintDialog
          hostLabel={sftp.hostkeyPrompt.hostLabel}
          algorithm={sftp.hostkeyPrompt.algorithm}
          fingerprint={sftp.hostkeyPrompt.fingerprint}
          onTrust={() => sftp.respondHostkey(true)}
          onCancel={() => sftp.respondHostkey(false)}
        />
      )}
      {showPrompts && sftp.secretPrompt !== null && (
        <SecretPromptDialog
          hostLabel={sftp.hostLabel}
          prompt={sftp.secretPrompt}
          onSubmit={(secret) => void sftp.submitSecret(secret)}
          onCancel={() => sftp.cancelSecret()}
        />
      )}
    </div>
  );
}

/**
 * CSS modifier for a diff line kind.
 *
 * @param kind - The diff marker.
 */
function lineClass(kind: "+" | "-" | " "): string {
  return kind === "+" ? "add" : kind === "-" ? "del" : "ctx";
}

/**
 * Mounts the installer dialog when the semantic store points it somewhere
 * (palette "Shell integration…", the status bar's cwd chip).
 *
 * @returns The dialog, or `null` when closed.
 */
export function ShellIntegrationHost() {
  const target = useSemantic((s) => s.installer);
  const close = useSemantic((s) => s.closeInstaller);
  if (target === null) return null;
  return <ShellIntegrationDialog target={target} onClose={close} />;
}
