/**
 * The pane path bar (F5): breadcrumbs at rest — every ancestor clickable —
 * flipping into an editable field with directory completion on click or ⌘L
 * style focus. Tab or click applies a suggestion; Enter navigates; Esc
 * returns to breadcrumbs unchanged.
 */

import "./PathBar.css";
import { useEffect, useRef, useState } from "react";

/** Props for {@link PathBar}. */
export interface PathBarProps {
  /** The pane's current absolute path. */
  path: string;
  /** Navigates the pane (Enter, breadcrumb click, suggestion pick). */
  onNavigate(path: string): void;
  /** Directory completions for a draft (the store lists the parent). */
  onComplete(draft: string): Promise<string[]>;
}

/**
 * Breadcrumb segments for a path: `["/", "/home", "/home/pandox"]` with
 * their display names.
 *
 * @param path - An absolute path.
 * @returns One crumb per ancestor, root first.
 */
function crumbsOf(path: string): Array<{ label: string; target: string }> {
  const crumbs = [{ label: "/", target: "/" }];
  let acc = "";
  for (const part of path.split("/").filter(Boolean)) {
    acc += `/${part}`;
    crumbs.push({ label: part, target: acc });
  }
  return crumbs;
}

/**
 * The path bar.
 *
 * @param props - {@link PathBarProps}
 * @returns The path bar element.
 */
export function PathBar({ path, onNavigate, onComplete }: PathBarProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const completionSeq = useRef(0);

  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => {
        fieldRef.current?.focus();
        fieldRef.current?.select();
      });
    }
  }, [editing]);

  const beginEdit = () => {
    setDraft(path);
    setSuggestions([]);
    setEditing(true);
  };

  const endEdit = () => {
    setEditing(false);
    setSuggestions([]);
  };

  const updateDraft = (value: string) => {
    setDraft(value);
    const seq = ++completionSeq.current;
    void onComplete(value).then((list) => {
      // Stale completions (a newer keystroke exists) are dropped.
      if (completionSeq.current === seq) setSuggestions(list);
    });
  };

  if (!editing) {
    return (
      <nav className="sftp-pathbar" aria-label="Current directory">
        {crumbsOf(path).map((crumb, index) => (
          <span key={crumb.target} className="sftp-pathbar-crumbs">
            {index > 1 && <span className="sftp-pathbar-sep">/</span>}
            <button
              type="button"
              className="sftp-pathbar-crumb"
              onClick={() => onNavigate(crumb.target)}
            >
              {crumb.label}
            </button>
          </span>
        ))}
        <button
          type="button"
          className="sftp-pathbar-edit"
          aria-label="Edit path"
          onClick={beginEdit}
        >
          ✎
        </button>
      </nav>
    );
  }

  return (
    <div className="sftp-pathbar sftp-pathbar--editing">
      <input
        ref={fieldRef}
        className="sftp-pathbar-field"
        value={draft}
        spellCheck={false}
        aria-label="Path"
        onChange={(event) => updateDraft(event.target.value)}
        onBlur={endEdit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            onNavigate(draft.trim() === "" ? "/" : draft.trim());
            endEdit();
          } else if (event.key === "Escape") {
            event.stopPropagation();
            endEdit();
          } else if (event.key === "Tab" && suggestions.length > 0) {
            event.preventDefault();
            updateDraft(suggestions[0]);
          }
        }}
      />
      {suggestions.length > 0 && (
        <ul className="sftp-pathbar-suggestions" role="listbox">
          {suggestions.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                // onMouseDown beats the field's blur, which would unmount us.
                onMouseDown={(event) => {
                  event.preventDefault();
                  onNavigate(suggestion);
                  endEdit();
                }}
              >
                {suggestion}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
