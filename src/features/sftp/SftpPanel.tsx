/**
 * The SFTP panel (F5): a full-size overlay in the terminal area — ⇧⌘S
 * toggles it for the focused SSH session's host, the terminal keeps
 * running underneath (PLAN.md §5, Phase 5 row). Dual panes (local |
 * remote), the transfer queue along the bottom, the FingerprintDialog
 * over unknown host keys, and the "Open in Cyberduck" escape hatch.
 *
 * While the panel is open, OS file drops (Finder → app) upload into the
 * remote pane's current directory.
 */

import "./SftpPanel.css";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef } from "react";

import { onOsFileDrop } from "../../ipc/client";
import { useHosts } from "../../state/hosts";
import { useSftp } from "../../state/sftp";
import { FingerprintDialog } from "../ssh/FingerprintDialog";
import { SecretPromptDialog } from "../ssh/SecretPromptDialog";
import { PaneView } from "./PaneView";
import { TransferQueue } from "./TransferQueue";

/**
 * The `sftp://` URL for the current connection, for the Cyberduck handoff
 * — built from the host record (the frontend's copy of `hosts.toml`).
 *
 * @param hostId - The connected host.
 * @param remotePath - The remote pane's current directory.
 * @returns The URL, or `null` when the record is gone.
 */
function cyberduckUrl(hostId: string, remotePath: string): string | null {
  const host = useHosts.getState().hosts.find((h) => h.id === hostId);
  if (!host || host.hostname === "") return null;
  const user = host.user === "" ? "" : `${encodeURIComponent(host.user)}@`;
  const port = host.port === 22 ? "" : `:${host.port}`;
  return `sftp://${user}${host.hostname}${port}${remotePath}`;
}

/**
 * The panel overlay; renders nothing while hidden.
 *
 * @returns The panel element, or `null`.
 */
export function SftpPanel() {
  const open = useSftp((s) => s.open);
  const hostId = useSftp((s) => s.hostId);
  const hostLabel = useSftp((s) => s.hostLabel);
  const connState = useSftp((s) => s.connState);
  const connError = useSftp((s) => s.connError);
  const showHidden = useSftp((s) => s.showHidden);
  const remotePath = useSftp((s) => s.panes.remote.path);
  const hostkeyPrompt = useSftp((s) => s.hostkeyPrompt);
  const secretPrompt = useSftp((s) => s.secretPrompt);
  const drag = useSftp((s) => s.drag);
  const store = useSftp.getState();
  const ghostRef = useRef<HTMLDivElement | null>(null);

  // Finder → app drop-to-upload, live while the panel shows a connection.
  useEffect(() => {
    if (!open || connState !== "connected") return;
    let unlisten: (() => void) | undefined;
    let torn = false;
    void onOsFileDrop((paths) => void useSftp.getState().uploadDroppedPaths(paths)).then(
      (fn) => {
        // The effect may have cleaned up before the promise resolved.
        if (torn) fn();
        else unlisten = fn;
      },
    );
    return () => {
      torn = true;
      unlisten?.();
    };
  }, [open, connState]);

  // Mid-drag: the ghost chip trails the pointer (style-only writes, no
  // re-render per move) and Esc abandons the drag.
  useEffect(() => {
    if (drag === null) return;
    const onMove = (event: MouseEvent): void => {
      const ghost = ghostRef.current;
      if (ghost !== null) {
        ghost.style.transform = `translate(${event.clientX + 14}px, ${event.clientY + 12}px)`;
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") useSftp.getState().cancelDrag();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("keydown", onKey);
    };
  }, [drag]);

  if (!open) return null;

  const duckUrl = hostId !== null ? cyberduckUrl(hostId, remotePath) : null;

  return (
    <div
      className={`sftp-panel${drag !== null ? " sftp-panel--dragging" : ""}`}
      role="region"
      aria-label={`SFTP — ${hostLabel}`}
    >
      <header className="sftp-panel-head">
        <h2 className="sftp-panel-title">
          <span className={`sftp-panel-dot sftp-panel-dot--${connState}`} aria-hidden />
          SFTP — {hostLabel}
        </h2>
        <div className="sftp-panel-tools">
          <label className="sftp-panel-hidden">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={() => store.toggleHidden()}
            />
            Hidden files
          </label>
          {duckUrl !== null && (
            <button
              type="button"
              title="Open this location in Cyberduck (or your sftp:// handler)"
              onClick={() => void openUrl(duckUrl).catch(() => undefined)}
            >
              Open in Cyberduck
            </button>
          )}
          <button
            type="button"
            aria-label="Hide SFTP panel"
            title="Hide (⇧⌘S) — transfers keep running"
            onClick={() => store.hide()}
          >
            ✕
          </button>
        </div>
      </header>

      {connState === "connecting" && (
        <div className="sftp-panel-notice">
          <p>Connecting to {hostLabel}…</p>
        </div>
      )}
      {connState === "error" && (
        <div className="sftp-panel-notice">
          <p className="sftp-panel-error">{connError}</p>
          <button type="button" onClick={() => store.retryConnect()}>
            Retry
          </button>
        </div>
      )}
      {connState === "connected" && (
        <>
          <div className="sftp-panel-panes">
            <PaneView side="local" title="This Mac" />
            <PaneView side="remote" title={hostLabel} />
          </div>
          <TransferQueue />
        </>
      )}

      {drag !== null && (
        <div ref={ghostRef} className="sftp-drag-ghost" aria-hidden>
          {drag.count} {drag.count === 1 ? "item" : "items"}
        </div>
      )}

      {hostkeyPrompt !== null && (
        <FingerprintDialog
          hostLabel={hostkeyPrompt.hostLabel}
          algorithm={hostkeyPrompt.algorithm}
          fingerprint={hostkeyPrompt.fingerprint}
          onTrust={() => store.respondHostkey(true)}
          onCancel={() => store.respondHostkey(false)}
        />
      )}

      {secretPrompt !== null && (
        <SecretPromptDialog
          hostLabel={hostLabel}
          prompt={secretPrompt}
          onSubmit={(secret) => void store.submitSecret(secret)}
          onCancel={() => store.cancelSecret()}
        />
      )}
    </div>
  );
}
