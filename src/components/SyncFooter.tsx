import "./SyncFooter.css";
import { useState } from "react";
import { FolderOpen, RefreshCw, X } from "lucide-react";
import { lastCommitPhrase, syncStateLabel } from "../features/settings/syncPresentation";
import { useSync } from "../state/sync";
import { useToast } from "../state/toast";

/**
 * The sidebar footer (F10): the sync status dot and its popover. The dot
 * speaks the five F10 states — clean / ahead / behind / conflict / local —
 * plus a pulse while a sync runs; clicking it opens the popover with the
 * full story (remote, last commit, lint blocks with the offending lines,
 * conflicted files) and the actions: Sync now, Open in Finder, and — in
 * conflict — Cancel sync (`git rebase --abort`). Conflicts are never
 * auto-resolved; the hint says exactly that.
 *
 * @returns The footer element.
 */
export function SyncFooter() {
  const status = useSync((s) => s.status);
  const syncing = useSync((s) => s.syncing);
  const lastMessage = useSync((s) => s.lastMessage);
  const lastBlocked = useSync((s) => s.lastBlocked);
  const [open, setOpen] = useState(false);

  const dotState = syncing ? "syncing" : (status?.state ?? "local");
  const conflicted = status?.state === "conflict";

  const runSync = async (): Promise<void> => {
    const result = await useSync.getState().syncNow();
    const toast = useToast.getState();
    if (!result) {
      toast.show(useSync.getState().lastMessage ?? "Sync failed", "error");
      return;
    }
    if (result.ok) {
      toast.show(
        result.status.remoteUrl ? "Synced" : "Committed locally — no remote configured",
        "success",
      );
    } else if (result.blocked.length > 0) {
      const n = result.blocked.length;
      toast.show(`Sync refused — ${n} secret-looking line${n === 1 ? "" : "s"}`, "error");
      setOpen(true);
    } else if (result.conflictFiles.length > 0) {
      toast.show("Sync conflict — resolve or cancel", "error");
      setOpen(true);
    } else if (result.message) {
      toast.show(result.message, "error");
    }
  };

  const cancelSync = async (): Promise<void> => {
    await useSync.getState().abortSync();
    useToast.getState().show("Sync cancelled — back to the pre-sync state", "info");
  };

  return (
    <footer className="syncfooter">
      <button
        type="button"
        className="syncfooter-summary"
        aria-expanded={open}
        aria-label="Sync status"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`syncfooter-dot syncfooter-dot--${dotState}`} aria-hidden />
        <span className="syncfooter-label">
          {syncing ? "syncing…" : syncStateLabel(status)}
        </span>
      </button>

      {open && (
        <div className="syncfooter-popover" role="dialog" aria-label="Sync">
          <div className="syncfooter-row syncfooter-row--head">
            <span className="syncfooter-title">Sync</span>
            <button
              type="button"
              className="syncfooter-icon"
              aria-label="Close sync popover"
              onClick={() => setOpen(false)}
            >
              <X size={13} aria-hidden />
            </button>
          </div>

          <div className="syncfooter-detail">
            {status?.remoteUrl ? (
              <span className="syncfooter-mono" title={status.remoteUrl}>
                {status.remoteUrl}
              </span>
            ) : (
              <span className="syncfooter-hint">
                No remote — commits stay on this Mac. Add one in Settings → Sync.
              </span>
            )}
            {lastCommitPhrase(status) && (
              <span className="syncfooter-hint">
                last commit {lastCommitPhrase(status)}
              </span>
            )}
            {lastMessage && <span className="syncfooter-error">{lastMessage}</span>}
          </div>

          {lastBlocked.length > 0 && (
            <div className="syncfooter-blocked" role="alert">
              <span className="syncfooter-hint">The secrets lint refused to commit:</span>
              {lastBlocked.map((line) => (
                <div
                  key={`${line.file}:${line.lineNo}`}
                  className="syncfooter-blocked-line"
                >
                  <span className="syncfooter-mono">
                    {line.file}:{line.lineNo}
                  </span>
                  <code className="syncfooter-code">{line.line}</code>
                </div>
              ))}
              <span className="syncfooter-hint">
                Move secrets to the Keychain (host editor), then sync again.
              </span>
            </div>
          )}

          {conflicted && (
            <div className="syncfooter-conflict" role="alert">
              <span className="syncfooter-hint">
                Two machines edited the same lines. Fix the markers in these files, then
                Sync now — or Cancel sync to undo. Nothing is resolved for you.
              </span>
              {status.conflictFiles.map((file) => (
                <span key={file} className="syncfooter-mono">
                  {file}
                </span>
              ))}
            </div>
          )}

          <div className="syncfooter-actions">
            <button
              type="button"
              className="syncfooter-action"
              disabled={syncing}
              onClick={() => void runSync()}
            >
              <RefreshCw size={12} aria-hidden /> Sync now
            </button>
            <button
              type="button"
              className="syncfooter-action"
              onClick={() => void useSync.getState().openDir()}
            >
              <FolderOpen size={12} aria-hidden /> Open in Finder
            </button>
            {conflicted && (
              <button
                type="button"
                className="syncfooter-action syncfooter-action--danger"
                onClick={() => void cancelSync()}
              >
                Cancel sync
              </button>
            )}
          </div>
        </div>
      )}
    </footer>
  );
}
