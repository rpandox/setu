/**
 * The transfer queue strip (F5) at the panel's bottom edge: one row per
 * transfer with a progress bar, live speed and ETA (derived in the store
 * from progress deltas), cancel while queued/running, retry when failed,
 * and a clear button for the finished. Hidden while the queue is empty.
 */

import "./TransferQueue.css";

import { type TransferItem, useSftp } from "../../state/sftp";
import { formatEta, formatSize, formatSpeed } from "./listing";

/**
 * The status cell text for one row.
 *
 * @param item - The queue row.
 */
function statusOf(item: TransferItem): string {
  switch (item.state) {
    case "queued":
      return "queued";
    case "running":
      return `${formatSpeed(item.speedBps)} · ${formatEta(item.bytes, item.total, item.speedBps)}`;
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    case "failed":
      return item.error ?? "failed";
  }
}

/**
 * The queue strip; renders nothing while no transfers exist.
 *
 * @returns The queue element, or `null`.
 */
export function TransferQueue() {
  const transfers = useSftp((s) => s.transfers);
  const store = useSftp.getState();
  if (transfers.length === 0) return null;

  const finished = transfers.some(
    (t) => t.state === "done" || t.state === "failed" || t.state === "cancelled",
  );

  return (
    <section className="sftp-queue" aria-label="Transfers">
      <header className="sftp-queue-head">
        <span className="sftp-queue-title">
          Transfers (
          {transfers.filter((t) => t.state === "running" || t.state === "queued").length}{" "}
          active)
        </span>
        {finished && (
          <button type="button" onClick={() => store.clearFinished()}>
            Clear finished
          </button>
        )}
      </header>
      <ul className="sftp-queue-rows">
        {transfers.map((item) => {
          const percent =
            item.state === "done"
              ? 100
              : item.total > 0
                ? Math.min(100, Math.round((item.bytes / item.total) * 100))
                : 0;
          return (
            <li
              key={item.clientId}
              className={`sftp-queue-row sftp-queue-row--${item.state}`}
            >
              <span className="sftp-queue-dir">
                {item.direction === "upload" ? "↑" : "↓"}
              </span>
              <span className="sftp-queue-name" title={item.name}>
                {item.name}
              </span>
              <span className="sftp-queue-bar" role="progressbar" aria-valuenow={percent}>
                <span className="sftp-queue-fill" style={{ width: `${percent}%` }} />
              </span>
              <span className="sftp-queue-bytes">
                {item.state === "running"
                  ? `${formatSize(item.bytes)} / ${item.total > 0 ? formatSize(item.total) : "?"}`
                  : formatSize(item.total)}
              </span>
              <span className="sftp-queue-status" title={item.error}>
                {statusOf(item)}
              </span>
              {(item.state === "queued" || item.state === "running") && (
                <button
                  type="button"
                  aria-label={`Cancel ${item.name}`}
                  onClick={() => store.cancelTransfer(item.clientId)}
                >
                  ✕
                </button>
              )}
              {item.state === "failed" && (
                <button
                  type="button"
                  aria-label={`Retry ${item.name}`}
                  onClick={() => store.retryTransfer(item.clientId)}
                >
                  ⟳
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
