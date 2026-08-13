import "./SelectionBar.css";
import { useEffect, useRef, useState } from "react";
import { useHosts } from "../state/hosts";
import { useToast } from "../state/toast";

/** Which mini-form the bar is showing. */
type BarMode = "actions" | "group" | "tag" | "hue";

/** The eight identity hues (indices into `--hue-0…7`, §7). */
const HUES = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * The sidebar's bulk-action bar (F1, Phase 4): appears while hosts are
 * multi-selected (⌘-click / ⇧-click) and applies one edit to the whole
 * selection — set group, add tag, set hue, or delete (two-click confirm).
 * Esc clears the selection; imported rows are never edited (they're
 * read-only until adopted).
 *
 * @returns The bar element, or nothing without a selection.
 */
export function SelectionBar() {
  const selectedIds = useHosts((s) => s.selectedIds);
  const hosts = useHosts((s) => s.hosts);
  const clearSelection = useHosts((s) => s.clearSelection);
  const bulkEdit = useHosts((s) => s.bulkEdit);
  const bulkDelete = useHosts((s) => s.bulkDelete);
  const showToast = useToast((s) => s.show);

  const [mode, setMode] = useState<BarMode>("actions");
  const [value, setValue] = useState("");
  const [deleteArmed, setDeleteArmed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const editable = hosts.filter(
    (h) => selectedIds.includes(h.id) && h.source === "setu",
  ).length;

  useEffect(() => {
    // A changed selection resets the bar to its action row.
    setMode("actions");
    setValue("");
    setDeleteArmed(false);
  }, [selectedIds]);

  useEffect(() => {
    if (mode === "group" || mode === "tag") inputRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    if (!deleteArmed) return;
    const timer = window.setTimeout(() => setDeleteArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [deleteArmed]);

  if (selectedIds.length === 0) return null;

  const applyText = (kind: "group" | "tag"): void => {
    const trimmed = value.trim();
    if (kind === "tag" && trimmed === "") return; // an empty tag is meaningless
    void bulkEdit(
      kind === "group" ? { kind, group: trimmed } : { kind, tag: trimmed },
    ).then(() =>
      showToast(
        kind === "group"
          ? `Moved ${editable} ${editable === 1 ? "host" : "hosts"} to ${trimmed === "" ? "no group" : trimmed}`
          : `Tagged ${editable} ${editable === 1 ? "host" : "hosts"} with ${trimmed}`,
        "success",
      ),
    );
  };

  return (
    <div className="selectionbar" role="toolbar" aria-label="Bulk host actions">
      <div className="selectionbar-summary">
        <span>
          {selectedIds.length} selected
          {editable < selectedIds.length ? ` · ${editable} editable` : ""}
        </span>
        <button className="selectionbar-clear" type="button" onClick={clearSelection}>
          Clear
        </button>
      </div>
      {mode === "actions" && (
        <div className="selectionbar-actions">
          <button type="button" onClick={() => setMode("group")}>
            Group…
          </button>
          <button type="button" onClick={() => setMode("tag")}>
            Tag…
          </button>
          <button type="button" onClick={() => setMode("hue")}>
            Hue…
          </button>
          <button
            type="button"
            className={deleteArmed ? "selectionbar-delete--armed" : undefined}
            onClick={() => {
              if (!deleteArmed) {
                setDeleteArmed(true);
                return;
              }
              const count = editable;
              void bulkDelete().then(() =>
                showToast(
                  `Deleted ${count} ${count === 1 ? "host" : "hosts"}`,
                  "success",
                ),
              );
            }}
          >
            {deleteArmed ? `Delete ${editable}?` : "Delete"}
          </button>
        </div>
      )}
      {(mode === "group" || mode === "tag") && (
        <div className="selectionbar-form">
          <input
            ref={inputRef}
            type="text"
            placeholder={mode === "group" ? "Group name (empty = ungrouped)" : "Tag"}
            aria-label={mode === "group" ? "Group name" : "Tag"}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyText(mode);
              if (event.key === "Escape") {
                event.stopPropagation();
                setMode("actions");
              }
            }}
          />
          <button type="button" onClick={() => applyText(mode)}>
            Apply
          </button>
        </div>
      )}
      {mode === "hue" && (
        <div className="selectionbar-hues">
          {HUES.map((hue) => (
            <button
              key={hue}
              type="button"
              className="selectionbar-hue"
              style={{ background: `var(--hue-${hue})` }}
              aria-label={`Set hue ${hue}`}
              title={`Hue ${hue}`}
              onClick={() =>
                void bulkEdit({ kind: "hue", hue }).then(() =>
                  showToast(
                    `Set hue for ${editable} ${editable === 1 ? "host" : "hosts"}`,
                    "success",
                  ),
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
