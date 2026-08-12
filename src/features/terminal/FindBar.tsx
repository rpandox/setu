import { useEffect, useRef, useState } from "react";
import { getSessionTerminal } from "./registry";

/** Props for {@link FindBar}. */
export interface FindBarProps {
  /** The session whose terminal is searched. */
  sessionId: string;
  /**
   * Focus sequence from the store: every change (each ⇧⌘F press) refocuses
   * the input and selects its text, so repeat presses re-enter the search
   * instead of doing nothing.
   */
  focusSeq: number;
  /** Called when the bar should close (Esc or the ✕ button). */
  onClose: () => void;
}

/**
 * The ⇧⌘F find bar over the active terminal — Phase 1 minimal: incremental
 * search-as-you-type, Enter/⇧Enter for next/previous, Esc to close. Regex
 * toggle and match counts are Phase 4 polish (F2).
 *
 * @param props - {@link FindBarProps}
 * @returns The find bar overlay element.
 */
export function FindBar({ sessionId, focusSeq, onClose }: FindBarProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Runs on mount and again on every ⇧⌘F while open — select the previous
  // query so typing replaces it, the way every other find field behaves.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSeq]);

  /**
   * Runs a search step in the terminal.
   *
   * @param direction - `"next"` or `"previous"` match.
   * @param text - The query to search for.
   */
  const find = (direction: "next" | "previous", text: string): void => {
    const search = getSessionTerminal(sessionId)?.search;
    if (!search || text.length === 0) return;
    if (direction === "next") {
      search.findNext(text, { incremental: false });
    } else {
      search.findPrevious(text);
    }
  };

  /** Closes the bar and hands focus back to the terminal. */
  const close = (): void => {
    onClose();
    const handle = getSessionTerminal(sessionId);
    // Drop the last match's selection — otherwise it lingers as a stray
    // reverse-video patch in the scrollback after the bar is gone.
    handle?.term.clearSelection();
    handle?.term.focus();
  };

  return (
    <div className="findbar" role="search">
      <input
        ref={inputRef}
        className="findbar-input"
        type="text"
        placeholder="Find"
        value={query}
        onChange={(event) => {
          const text = event.target.value;
          setQuery(text);
          const search = getSessionTerminal(sessionId)?.search;
          if (search && text.length > 0) {
            search.findNext(text, { incremental: true });
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            find(event.shiftKey ? "previous" : "next", query);
          } else if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      />
      <button
        className="findbar-button"
        type="button"
        aria-label="Previous match"
        onClick={() => find("previous", query)}
      >
        ‹
      </button>
      <button
        className="findbar-button"
        type="button"
        aria-label="Next match"
        onClick={() => find("next", query)}
      >
        ›
      </button>
      <button
        className="findbar-button"
        type="button"
        aria-label="Close find"
        onClick={close}
      >
        ✕
      </button>
    </div>
  );
}
