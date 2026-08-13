import "./SnippetDrawer.css";
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Snippet, SnippetFieldError } from "../../ipc/contract";
import { rankSnippets, useSnippets } from "../../state/snippets";
import { useToast } from "../../state/toast";
import { extractTokens } from "./variables";

/**
 * A blank draft for the "new snippet" editor.
 *
 * @returns A fresh {@link Snippet} with an empty id (upsert assigns the UUID).
 */
export function emptySnippetDraft(): Snippet {
  return { id: "", label: "", command: "", tags: [], variables: [] };
}

/**
 * The SnippetDrawer (F6, ⌘J): a right-side panel listing every snippet
 * with search, Run/Edit/Delete per row, pack Import/Export through the
 * native file dialogs, and an inline editor pane for create/edit — label,
 * command, tags, and the variables table (name, default, choices). The
 * command's `{{tokens}}` drive a one-click "Declare" helper for variables
 * not yet listed; the Rust store re-validates on save and its field errors
 * land inline.
 *
 * Rendered only while `useSnippets.drawerOpen` is set; Esc or ✕ closes.
 *
 * @returns The drawer element, or `null` while closed.
 */
export function SnippetDrawer() {
  const drawerOpen = useSnippets((s) => s.drawerOpen);
  const snippets = useSnippets((s) => s.snippets);
  const loadError = useSnippets((s) => s.loadError);
  const editorTarget = useSnippets((s) => s.editorTarget);
  const toggleDrawer = useSnippets((s) => s.toggleDrawer);
  const openEditor = useSnippets((s) => s.openEditor);

  const [query, setQuery] = useState("");

  if (!drawerOpen) return null;

  return (
    <div className="snippetdrawer-scrim">
      <aside
        className="snippetdrawer"
        role="dialog"
        aria-label="Snippets"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            toggleDrawer();
          }
        }}
      >
        <header className="snippetdrawer-header">
          <h2 className="snippetdrawer-title">Snippets</h2>
          <button
            className="snippetdrawer-close"
            type="button"
            aria-label="Close snippets"
            onClick={toggleDrawer}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        {loadError !== null && (
          <p className="snippetdrawer-error" role="alert">
            {loadError}
          </p>
        )}
        {editorTarget === null ? (
          <SnippetList query={query} onQueryChange={setQuery} />
        ) : (
          <SnippetEditorForm
            key={editorTarget}
            target={editorTarget}
            original={
              editorTarget === "new"
                ? emptySnippetDraft()
                : (snippets.find((s) => s.id === editorTarget) ?? emptySnippetDraft())
            }
          />
        )}
        {editorTarget === null && (
          <footer className="snippetdrawer-footer">
            <button
              className="snippetdrawer-secondary"
              type="button"
              onClick={() => openEditor("new")}
            >
              New snippet
            </button>
            <PackButtons />
          </footer>
        )}
      </aside>
    </div>
  );
}

/** Props for {@link SnippetList}. */
interface SnippetListProps {
  /** The live search query. */
  query: string;
  /** Called as the user types in the search field. */
  onQueryChange(query: string): void;
}

/**
 * The drawer's list view: search + one row per snippet with Run, Edit,
 * and a two-click Delete (first click arms, second deletes).
 *
 * @param props - {@link SnippetListProps}
 * @returns The list element.
 */
function SnippetList({ query, onQueryChange }: SnippetListProps) {
  const snippets = useSnippets((s) => s.snippets);
  const openEditor = useSnippets((s) => s.openEditor);
  const deleteSnippet = useSnippets((s) => s.deleteSnippet);
  const requestRun = useSnippets((s) => s.requestRun);
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null);

  const rows = useMemo(() => rankSnippets(snippets, query, {}), [snippets, query]);

  return (
    <div className="snippetdrawer-list">
      <input
        className="snippetdrawer-search"
        value={query}
        placeholder="Search snippets…"
        aria-label="Search snippets"
        onChange={(event) => onQueryChange(event.target.value)}
      />
      {rows.length === 0 && (
        <p className="snippetdrawer-empty">
          {snippets.length === 0
            ? "No snippets yet — create one, or import a pack."
            : "No matches."}
        </p>
      )}
      <ul className="snippetdrawer-rows">
        {rows.map((snippet) => (
          <li className="snippetdrawer-row" key={snippet.id}>
            <div className="snippetdrawer-rowmain">
              <span className="snippetdrawer-rowlabel">{snippet.label}</span>
              <span className="snippetdrawer-rowcommand">{snippet.command}</span>
              {snippet.tags.length > 0 && (
                <span className="snippetdrawer-rowtags">{snippet.tags.join(" · ")}</span>
              )}
            </div>
            <div className="snippetdrawer-rowactions">
              <button
                className="snippetdrawer-run"
                type="button"
                onClick={() => requestRun(snippet)}
              >
                Run
              </button>
              <button
                className="snippetdrawer-secondary"
                type="button"
                onClick={() => openEditor(snippet.id)}
              >
                Edit
              </button>
              <button
                className={`snippetdrawer-delete${
                  deleteArmedId === snippet.id ? " snippetdrawer-delete--armed" : ""
                }`}
                type="button"
                onClick={() => {
                  if (deleteArmedId === snippet.id) {
                    setDeleteArmedId(null);
                    void deleteSnippet(snippet.id);
                  } else {
                    setDeleteArmedId(snippet.id);
                  }
                }}
                onBlur={() => setDeleteArmedId(null)}
              >
                {deleteArmedId === snippet.id ? "Really?" : "Delete"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The pack Import/Export buttons: native open/save dialogs (the picked
 * paths cross IPC; the Rust core does the file I/O — PLAN.md §5).
 *
 * @returns The button group.
 */
function PackButtons() {
  const snippets = useSnippets((s) => s.snippets);
  const importPack = useSnippets((s) => s.importPack);
  const exportPack = useSnippets((s) => s.exportPack);
  const [overwrite, setOverwrite] = useState(false);

  const doImport = async (): Promise<void> => {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Snippet pack", extensions: ["toml"] }],
    });
    if (typeof path !== "string") return;
    try {
      const { imported, skipped } = await importPack(
        path,
        overwrite ? "replace" : "keep",
      );
      useToast
        .getState()
        .show(
          skipped > 0
            ? `Imported ${imported}, skipped ${skipped} existing`
            : `Imported ${imported} ${imported === 1 ? "snippet" : "snippets"}`,
        );
    } catch (error) {
      useToast.getState().show(String(error));
    }
  };

  const doExport = async (): Promise<void> => {
    const path = await save({
      defaultPath: "setu-snippets.toml",
      filters: [{ name: "Snippet pack", extensions: ["toml"] }],
    });
    if (typeof path !== "string") return;
    try {
      await exportPack(
        snippets.map((s) => s.id),
        path,
      );
      useToast.getState().show(`Exported ${snippets.length} snippets`);
    } catch (error) {
      useToast.getState().show(String(error));
    }
  };

  return (
    <div className="snippetdrawer-pack">
      <button
        className="snippetdrawer-secondary"
        type="button"
        onClick={() => void doImport()}
      >
        Import pack…
      </button>
      <button
        className="snippetdrawer-secondary"
        type="button"
        disabled={snippets.length === 0}
        onClick={() => void doExport()}
      >
        Export all…
      </button>
      <label className="snippetdrawer-overwrite">
        <input
          type="checkbox"
          checked={overwrite}
          onChange={(event) => setOverwrite(event.target.checked)}
        />
        Overwrite on id collision
      </label>
    </div>
  );
}

/** Props for {@link SnippetEditorForm}. */
interface SnippetEditorFormProps {
  /** `"new"` or the id being edited. */
  target: "new" | string;
  /** The record being edited (a blank draft for `"new"`). */
  original: Snippet;
}

/**
 * The drawer's editor pane: label, command, tags, and the variables table.
 * Undeclared `{{tokens}}` in the command surface as one-click "Declare"
 * chips so the token ⇄ variable match the store enforces is easy to reach.
 *
 * @param props - {@link SnippetEditorFormProps}
 * @returns The form element.
 */
function SnippetEditorForm({ target, original }: SnippetEditorFormProps) {
  const closeEditor = useSnippets((s) => s.closeEditor);
  const saveSnippet = useSnippets((s) => s.saveSnippet);

  const [draft, setDraft] = useState<Snippet>(original);
  const [tagInput, setTagInput] = useState("");
  const [errors, setErrors] = useState<SnippetFieldError[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(original);
    setTagInput("");
    setErrors([]);
    // The key on the form remounts per target; this covers list refreshes.
  }, [original]);

  const errorFor = (field: string): string | undefined =>
    errors.find((e) => e.field === field)?.message;

  const patch = (changes: Partial<Snippet>): void =>
    setDraft((previous) => ({ ...previous, ...changes }));

  const patchVariable = (
    index: number,
    changes: Partial<Snippet["variables"][number]>,
  ): void =>
    patch({
      variables: draft.variables.map((v, i) => (i === index ? { ...v, ...changes } : v)),
    });

  const addTag = (): void => {
    const tag = tagInput.trim();
    if (tag !== "" && !draft.tags.includes(tag)) {
      patch({ tags: [...draft.tags, tag] });
    }
    setTagInput("");
  };

  const undeclared = extractTokens(draft.command).tokens.filter(
    (token) => !draft.variables.some((v) => v.name === token),
  );

  const submit = async (): Promise<void> => {
    setSaving(true);
    try {
      setErrors(await saveSnippet(draft));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="snippetdrawer-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="snippetdrawer-subtitle">
        {target === "new" ? "New snippet" : "Edit snippet"}
      </h3>

      <label className="snippetdrawer-field">
        <span className="snippetdrawer-label">Label</span>
        <input
          className="snippetdrawer-input"
          value={draft.label}
          autoFocus
          onChange={(event) => patch({ label: event.target.value })}
        />
        {errorFor("label") && (
          <span className="snippetdrawer-fielderror">{errorFor("label")}</span>
        )}
      </label>

      <label className="snippetdrawer-field">
        <span className="snippetdrawer-label">Command</span>
        <textarea
          className="snippetdrawer-input snippetdrawer-command"
          value={draft.command}
          rows={3}
          placeholder="journalctl -u {{service}} -f"
          onChange={(event) => patch({ command: event.target.value })}
        />
        {errorFor("command") && (
          <span className="snippetdrawer-fielderror">{errorFor("command")}</span>
        )}
      </label>

      {undeclared.length > 0 && (
        <div className="snippetdrawer-declare">
          {undeclared.map((token) => (
            <button
              key={token}
              className="snippetdrawer-declarechip"
              type="button"
              onClick={() => patch({ variables: [...draft.variables, { name: token }] })}
            >
              Declare {`{{${token}}}`}
            </button>
          ))}
        </div>
      )}

      <div className="snippetdrawer-field">
        <span className="snippetdrawer-label">Variables</span>
        {draft.variables.length === 0 && (
          <span className="snippetdrawer-hint">
            None — add {"{{tokens}}"} to the command to prompt at run.
          </span>
        )}
        {draft.variables.map((variable, index) => (
          <div className="snippetdrawer-variable" key={index}>
            <input
              className="snippetdrawer-input snippetdrawer-varname"
              value={variable.name}
              placeholder="name"
              aria-label={`Variable ${index + 1} name`}
              onChange={(event) => patchVariable(index, { name: event.target.value })}
            />
            <input
              className="snippetdrawer-input"
              value={variable.default ?? ""}
              placeholder="default"
              aria-label={`Variable ${index + 1} default`}
              onChange={(event) =>
                patchVariable(index, {
                  default: event.target.value === "" ? undefined : event.target.value,
                })
              }
            />
            <input
              className="snippetdrawer-input"
              value={(variable.choices ?? []).join(",")}
              placeholder="choices (a,b,c)"
              aria-label={`Variable ${index + 1} choices`}
              onChange={(event) => {
                const parts = event.target.value
                  .split(",")
                  .map((part) => part.trim())
                  .filter((part) => part !== "");
                patchVariable(index, {
                  choices: parts.length === 0 ? undefined : parts,
                });
              }}
            />
            <button
              className="snippetdrawer-varremove"
              type="button"
              aria-label={`Remove variable ${variable.name || index + 1}`}
              onClick={() =>
                patch({ variables: draft.variables.filter((_, i) => i !== index) })
              }
            >
              ×
            </button>
          </div>
        ))}
        {errorFor("variables") && (
          <span className="snippetdrawer-fielderror">{errorFor("variables")}</span>
        )}
      </div>

      <div className="snippetdrawer-field">
        <span className="snippetdrawer-label" id="snippetdrawer-tags-label">
          Tags
        </span>
        <div className="snippetdrawer-chips" aria-labelledby="snippetdrawer-tags-label">
          {draft.tags.map((tag) => (
            <span className="snippetdrawer-chip" key={tag}>
              {tag}
              <button
                className="snippetdrawer-chipremove"
                type="button"
                aria-label={`Remove tag ${tag}`}
                onClick={() => patch({ tags: draft.tags.filter((t) => t !== tag) })}
              >
                ×
              </button>
            </span>
          ))}
          <input
            className="snippetdrawer-chipinput"
            value={tagInput}
            placeholder={draft.tags.length === 0 ? "logs, deploy, …" : ""}
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

      <footer className="snippetdrawer-formfooter">
        <button className="snippetdrawer-secondary" type="button" onClick={closeEditor}>
          Cancel
        </button>
        <button className="snippetdrawer-save" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </footer>
    </form>
  );
}
