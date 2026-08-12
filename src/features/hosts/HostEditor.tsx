import "./HostEditor.css";
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type { Host, HostFieldError } from "../../ipc/contract";
import { duplicatesOf, emptyHostDraft, useHosts } from "../../state/hosts";

/** The 8 identity hues (§7) — indices into the `--hue-N` tokens. */
const HUES = [0, 1, 2, 3, 4, 5, 6, 7] as const;

/**
 * The HostEditor drawer (F1): create or edit a `hosts.toml` record with
 * inline validation. Client-side checks mirror the cheap rules live
 * (label/hostname required, port 1–65535); the Rust store re-validates on
 * save — including identity-path existence — and its field errors land on
 * the same inputs. A duplicate `user@hostname:port` shows a non-blocking
 * warning (F1: warn, don't forbid).
 *
 * Rendered only while `useHosts.editorTarget` is set; Esc or ✕ closes
 * without saving.
 *
 * @returns The drawer element, or `null` while closed.
 */
export function HostEditor() {
  const editorTarget = useHosts((s) => s.editorTarget);
  const hosts = useHosts((s) => s.hosts);
  const closeEditor = useHosts((s) => s.closeEditor);
  const saveHost = useHosts((s) => s.saveHost);

  const original = useMemo(() => {
    if (editorTarget === null || editorTarget === "new") return emptyHostDraft();
    return hosts.find((h) => h.id === editorTarget) ?? emptyHostDraft();
    // Deps deliberately exclude `hosts`: the draft resets when the drawer
    // targets a different host, not on every list refresh, which would eat
    // in-progress edits.
  }, [editorTarget]);

  const [draft, setDraft] = useState<Host>(original);
  const [tagInput, setTagInput] = useState("");
  const [errors, setErrors] = useState<HostFieldError[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(original);
    setTagInput("");
    setErrors([]);
  }, [original]);

  if (editorTarget === null) return null;

  const errorFor = (field: string): string | undefined =>
    errors.find((e) => e.field === field)?.message;

  const duplicates = duplicatesOf(hosts, draft);

  const patch = (changes: Partial<Host>): void =>
    setDraft((previous) => ({ ...previous, ...changes }));

  const addTag = (): void => {
    const tag = tagInput.trim();
    if (tag !== "" && !draft.tags.includes(tag)) {
      patch({ tags: [...draft.tags, tag] });
    }
    setTagInput("");
  };

  const submit = async (): Promise<void> => {
    setSaving(true);
    try {
      setErrors(await saveHost(draft));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="hosteditor-scrim">
      <aside
        className="hosteditor"
        role="dialog"
        aria-label={editorTarget === "new" ? "Add host" : `Edit ${original.label}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            closeEditor();
          }
        }}
      >
        <header className="hosteditor-header">
          <h2 className="hosteditor-title">
            {editorTarget === "new" ? "Add host" : "Edit host"}
          </h2>
          <button
            className="hosteditor-close"
            type="button"
            aria-label="Close editor"
            onClick={closeEditor}
          >
            <X size={16} aria-hidden />
          </button>
        </header>

        <form
          className="hosteditor-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="hosteditor-field">
            <span className="hosteditor-label">Label</span>
            <input
              className="hosteditor-input"
              value={draft.label}
              autoFocus
              onChange={(event) => patch({ label: event.target.value })}
            />
            {errorFor("label") && (
              <span className="hosteditor-fielderror">{errorFor("label")}</span>
            )}
          </label>

          <label className="hosteditor-field">
            <span className="hosteditor-label">Hostname</span>
            <input
              className="hosteditor-input"
              value={draft.hostname}
              placeholder="host.example.net"
              onChange={(event) => patch({ hostname: event.target.value })}
            />
            {errorFor("hostname") && (
              <span className="hosteditor-fielderror">{errorFor("hostname")}</span>
            )}
          </label>

          <div className="hosteditor-row">
            <label className="hosteditor-field">
              <span className="hosteditor-label">User</span>
              <input
                className="hosteditor-input"
                value={draft.user}
                onChange={(event) => patch({ user: event.target.value })}
              />
            </label>
            <label className="hosteditor-field hosteditor-field--port">
              <span className="hosteditor-label">Port</span>
              <input
                className="hosteditor-input"
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(event) => patch({ port: Number(event.target.value) || 0 })}
              />
              {errorFor("port") && (
                <span className="hosteditor-fielderror">{errorFor("port")}</span>
              )}
            </label>
          </div>

          {duplicates.length > 0 && (
            <p className="hosteditor-warning" role="alert">
              Duplicate of “{duplicates[0].label}” (same user@host:port). Saving is still
              allowed.
            </p>
          )}

          <label className="hosteditor-field">
            <span className="hosteditor-label">Identity</span>
            <input
              className="hosteditor-input hosteditor-input--mono"
              value={draft.identity}
              placeholder='"agent" or a key path'
              onChange={(event) => patch({ identity: event.target.value })}
            />
            {errorFor("identity") && (
              <span className="hosteditor-fielderror">{errorFor("identity")}</span>
            )}
          </label>

          <label className="hosteditor-field">
            <span className="hosteditor-label">Group</span>
            <input
              className="hosteditor-input"
              value={draft.group}
              placeholder="fleet"
              onChange={(event) => patch({ group: event.target.value })}
            />
          </label>

          <div className="hosteditor-field">
            <span className="hosteditor-label" id="hosteditor-tags-label">
              Tags
            </span>
            <div className="hosteditor-chips" aria-labelledby="hosteditor-tags-label">
              {draft.tags.map((tag) => (
                <span className="hosteditor-chip" key={tag}>
                  {tag}
                  <button
                    className="hosteditor-chip-remove"
                    type="button"
                    aria-label={`Remove tag ${tag}`}
                    onClick={() => patch({ tags: draft.tags.filter((t) => t !== tag) })}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                className="hosteditor-chip-input"
                value={tagInput}
                placeholder={draft.tags.length === 0 ? "prod, ubuntu, …" : ""}
                onChange={(event) => setTagInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addTag();
                  } else if (
                    event.key === "Backspace" &&
                    tagInput === "" &&
                    draft.tags.length > 0
                  ) {
                    patch({ tags: draft.tags.slice(0, -1) });
                  }
                }}
                onBlur={addTag}
              />
            </div>
          </div>

          <div className="hosteditor-field">
            <span className="hosteditor-label" id="hosteditor-hue-label">
              Hue
            </span>
            <div
              className="hosteditor-hues"
              role="radiogroup"
              aria-labelledby="hosteditor-hue-label"
            >
              {HUES.map((hue) => (
                <button
                  key={hue}
                  type="button"
                  role="radio"
                  aria-checked={draft.hue === hue}
                  aria-label={`Hue ${hue}`}
                  className={`hosteditor-hue${draft.hue === hue ? " hosteditor-hue--selected" : ""}`}
                  data-hue={hue}
                  onClick={() => patch({ hue })}
                />
              ))}
            </div>
          </div>

          <label className="hosteditor-field">
            <span className="hosteditor-label">Startup command</span>
            <input
              className="hosteditor-input hosteditor-input--mono"
              value={draft.startup}
              placeholder="tmux new -A -s main"
              onChange={(event) => patch({ startup: event.target.value })}
            />
          </label>

          <label className="hosteditor-field">
            <span className="hosteditor-label">Notes</span>
            <textarea
              className="hosteditor-input hosteditor-notes"
              value={draft.notes}
              rows={3}
              onChange={(event) => patch({ notes: event.target.value })}
            />
          </label>

          <div className="hosteditor-toggles">
            <label className="hosteditor-toggle">
              <input
                type="checkbox"
                checked={draft.favorite}
                onChange={(event) => patch({ favorite: event.target.checked })}
              />
              Favorite
            </label>
            <label className="hosteditor-toggle">
              <input
                type="checkbox"
                checked={draft.reachability}
                onChange={(event) => patch({ reachability: event.target.checked })}
              />
              Reachability LED (Phase 4)
            </label>
          </div>

          <footer className="hosteditor-footer">
            <button className="hosteditor-cancel" type="button" onClick={closeEditor}>
              Cancel
            </button>
            <button className="hosteditor-save" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  );
}
