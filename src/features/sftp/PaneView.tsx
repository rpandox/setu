/**
 * One pane of the SFTP dual-pane browser (F5): toolbar (up, path bar,
 * actions), sortable column headers, and a virtualized listing —
 * `@tanstack/react-virtual` keeps 10k-entry directories at 60fps (§5,
 * Phase 5 row). Selection takes ⌘ (toggle) and ⇧ (range); double-click
 * enters directories, follows symlinks, and sends files to the other
 * pane; rows drag across panes.
 */

import "./PaneView.css";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, useState } from "react";

import type { SftpEntry } from "../../ipc/contract";
import { type PaneSide, useSftp } from "../../state/sftp";
import { ChmodDialog, ConfirmDialog, InputDialog } from "./dialogs";
import { PathBar } from "./PathBar";
import {
  filterHidden,
  formatMode,
  formatMtime,
  formatSize,
  sortEntries,
  type SortKey,
} from "./listing";

/** Which dialog the pane has open, if any. */
type PaneDialog = "mkdir" | "rename" | "delete" | "chmod" | null;

/** Row height in px — fixed so the virtualizer never measures. */
const ROW_HEIGHT = 26;

/** The MIME type carrying cross-pane drags. */
const DRAG_MIME = "application/x-setu-sftp";

/** Props for {@link PaneView}. */
export interface PaneViewProps {
  /** Which side this pane renders. */
  side: PaneSide;
  /** The pane header label ("This Mac" / the host label). */
  title: string;
}

/** The sortable columns, in header order. */
const COLUMNS: Array<{ key: SortKey; label: string; className: string }> = [
  { key: "name", label: "Name", className: "sftp-col-name" },
  { key: "size", label: "Size", className: "sftp-col-size" },
  { key: "mtimeMs", label: "Modified", className: "sftp-col-mtime" },
  { key: "mode", label: "Mode", className: "sftp-col-mode" },
];

/**
 * One browser pane.
 *
 * @param props - {@link PaneViewProps}
 * @returns The pane element.
 */
export function PaneView({ side, title }: PaneViewProps) {
  const pane = useSftp((s) => s.panes[side]);
  const sort = useSftp((s) => s.sorts[side]);
  const showHidden = useSftp((s) => s.showHidden);
  const store = useSftp.getState();

  const [dialog, setDialog] = useState<PaneDialog>(null);
  const [dropTarget, setDropTarget] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const visible = sortEntries(filterHidden(pane.entries, showHidden), sort);
  const selected = new Set(pane.selected);
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  /**
   * Applies click-selection semantics: plain, ⌘ toggle, ⇧ range.
   *
   * @param entry - The clicked entry.
   * @param event - The mouse event carrying the modifiers.
   */
  function clickSelect(entry: SftpEntry, event: React.MouseEvent): void {
    if (event.metaKey) {
      const next = new Set(selected);
      if (next.has(entry.name)) next.delete(entry.name);
      else next.add(entry.name);
      store.setSelection(side, [...next]);
      return;
    }
    if (event.shiftKey && pane.selected.length > 0) {
      const anchor = visible.findIndex((e) => e.name === pane.selected[0]);
      const here = visible.findIndex((e) => e.name === entry.name);
      if (anchor >= 0 && here >= 0) {
        const [from, to] = anchor < here ? [anchor, here] : [here, anchor];
        store.setSelection(side, [
          pane.selected[0],
          ...visible
            .slice(from, to + 1)
            .map((e) => e.name)
            .filter((name) => name !== pane.selected[0]),
        ]);
        return;
      }
    }
    store.setSelection(side, [entry.name]);
  }

  /**
   * Moves the single selection with arrow keys.
   *
   * @param delta - Rows to move by (�1).
   */
  function moveSelection(delta: number): void {
    if (visible.length === 0) return;
    const current = visible.findIndex((e) => selected.has(e.name));
    const next = Math.min(visible.length - 1, Math.max(0, current + delta));
    store.setSelection(side, [visible[next].name]);
    virtualizer.scrollToIndex(next);
  }

  const singleSelected =
    pane.selected.length === 1
      ? pane.entries.find((e) => e.name === pane.selected[0])
      : undefined;

  const sendLabel = side === "local" ? "Upload →" : "← Download";
  const send = side === "local" ? store.sendLocalSelection : store.sendRemoteSelection;

  return (
    <section
      className={`sftp-pane${dropTarget ? " sftp-pane--drop" : ""}`}
      aria-label={`${title} files`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(DRAG_MIME)) {
          event.preventDefault();
          setDropTarget(true);
        }
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(event) => {
        setDropTarget(false);
        const raw = event.dataTransfer.getData(DRAG_MIME);
        if (raw === "") return;
        event.preventDefault();
        const { pane: source } = JSON.parse(raw) as { pane: PaneSide };
        // A cross-pane drop transfers the source pane's selection here.
        if (source === "local" && side === "remote") void store.sendLocalSelection();
        if (source === "remote" && side === "local") void store.sendRemoteSelection();
      }}
    >
      <header className="sftp-pane-head">
        <span className="sftp-pane-title">{title}</span>
        <div className="sftp-pane-tools">
          <button
            type="button"
            title="Up one directory"
            onClick={() => void store.up(side)}
          >
            ↑
          </button>
          <button type="button" title="Refresh" onClick={() => void store.refresh(side)}>
            ⟳
          </button>
          <button type="button" title="New folder" onClick={() => setDialog("mkdir")}>
            +▸
          </button>
          <button
            type="button"
            title="Rename"
            disabled={!singleSelected}
            onClick={() => setDialog("rename")}
          >
            ✎
          </button>
          <button
            type="button"
            title="Permissions"
            disabled={pane.selected.length === 0}
            onClick={() => setDialog("chmod")}
          >
            rwx
          </button>
          <button
            type="button"
            title="Delete"
            disabled={pane.selected.length === 0}
            onClick={() => setDialog("delete")}
          >
            ✕
          </button>
          <button
            type="button"
            className="sftp-pane-send"
            disabled={pane.selected.length === 0}
            onClick={() => void send()}
          >
            {sendLabel}
          </button>
        </div>
      </header>

      <PathBarSlot side={side} path={pane.path} />

      <div className="sftp-pane-columns" role="row">
        {COLUMNS.map((column) => (
          <button
            key={column.key}
            type="button"
            className={`sftp-pane-column ${column.className}`}
            onClick={() => store.setSort(side, column.key)}
          >
            {column.label}
            {sort.key === column.key && (
              <span className="sftp-pane-sortmark">{sort.dir === "asc" ? "▲" : "▼"}</span>
            )}
          </button>
        ))}
      </div>

      <div
        ref={scrollRef}
        className="sftp-pane-scroll"
        role="listbox"
        aria-label={`${title} entries`}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveSelection(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            moveSelection(-1);
          } else if (event.key === "Enter" && singleSelected) {
            void store.openEntry(side, singleSelected);
          } else if (event.key === "Backspace") {
            void store.up(side);
          }
        }}
      >
        {pane.error !== null && <p className="sftp-pane-error">{pane.error}</p>}
        {pane.error === null && visible.length === 0 && !pane.loading && (
          <p className="sftp-pane-empty">Empty directory</p>
        )}
        <div
          className="sftp-pane-rows"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((row) => {
            const entry = visible[row.index];
            const isSelected = selected.has(entry.name);
            return (
              <div
                key={entry.name}
                role="option"
                aria-selected={isSelected}
                draggable
                className={`sftp-row${isSelected ? " sftp-row--selected" : ""}`}
                style={{ transform: `translateY(${row.start}px)` }}
                onMouseDown={(event) => clickSelect(entry, event)}
                onDoubleClick={() => void store.openEntry(side, entry)}
                onDragStart={(event) => {
                  if (!selected.has(entry.name)) store.setSelection(side, [entry.name]);
                  event.dataTransfer.setData(DRAG_MIME, JSON.stringify({ pane: side }));
                  event.dataTransfer.effectAllowed = "copy";
                }}
              >
                <span className="sftp-col-name">
                  <span className="sftp-row-glyph">
                    {entry.isSymlink ? "⤷" : entry.isDir ? "▸" : "·"}
                  </span>
                  {entry.name}
                  {entry.linkTarget !== undefined && (
                    <span className="sftp-row-target"> → {entry.linkTarget}</span>
                  )}
                </span>
                <span className="sftp-col-size">
                  {entry.isDir ? "—" : formatSize(entry.size)}
                </span>
                <span className="sftp-col-mtime">{formatMtime(entry.mtimeMs)}</span>
                <span className="sftp-col-mode">{formatMode(entry)}</span>
              </div>
            );
          })}
        </div>
      </div>

      {dialog === "mkdir" && (
        <InputDialog
          title="New folder"
          confirmLabel="Create"
          initial=""
          onConfirm={(name) => {
            setDialog(null);
            void store.mkdir(side, name);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "rename" && singleSelected && (
        <InputDialog
          title={`Rename ${singleSelected.name}`}
          confirmLabel="Rename"
          initial={singleSelected.name}
          onConfirm={(name) => {
            setDialog(null);
            void store.renameSelected(side, name);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title={
            pane.selected.length === 1
              ? `Delete ${pane.selected[0]}?`
              : `Delete ${pane.selected.length} items?`
          }
          body="Folders are deleted with everything in them. There is no undo."
          confirmLabel="Delete"
          onConfirm={() => {
            setDialog(null);
            void store.deleteSelected(side);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "chmod" && (
        <ChmodDialog
          subject={
            pane.selected.length === 1
              ? pane.selected[0]
              : `${pane.selected.length} items`
          }
          initialMode={singleSelected?.mode ?? 0o644}
          onConfirm={(mode) => {
            setDialog(null);
            void store.chmodSelected(side, mode);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
    </section>
  );
}

/**
 * The pane's path bar, bound to the store.
 *
 * @param props - The pane side and its current path.
 * @returns The path bar element.
 */
function PathBarSlot({ side, path }: { side: PaneSide; path: string }) {
  const store = useSftp.getState();
  return (
    <PathBar
      path={path}
      onNavigate={(target) => void store.navigate(side, target)}
      onComplete={(draft) => store.completePath(side, draft)}
    />
  );
}
