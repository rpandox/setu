import "./QuickConnect.css";
import { useEffect, useRef, useState } from "react";
import { searchHosts, useHosts } from "../../state/hosts";
import { useSessions } from "../../state/sessions";

/** Result rows shown at once; ranking makes more never necessary. */
const MAX_RESULTS = 8;

/**
 * Props for the {@link QuickConnect} palette.
 */
export interface QuickConnectProps {
  /** Closes the palette (Esc, connect, or scrim click). */
  onClose: () => void;
}

/**
 *⌘T quick connect (F11, Phase 2 slice): a single fuzzy input over hosts —
 * type a few characters, ⏎ connects the top hit in a new tab. ↑↓ move the
 * selection, Esc dismisses. This component is the seed of the full ⌘K
 * command palette (sections, actions, LED states) that Phase 4 completes.
 *
 * @param props - {@link QuickConnectProps}
 * @returns The palette overlay.
 */
export function QuickConnect({ onClose }: QuickConnectProps) {
  const hosts = useHosts((s) => s.hosts);
  const openSshTab = useSessions((s) => s.openSshTab);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const results = searchHosts(hosts, query).slice(0, MAX_RESULTS);
  const clamped = Math.min(selected, Math.max(results.length - 1, 0));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const connect = (index: number): void => {
    const host = results[index];
    if (!host) return;
    onClose();
    void openSshTab(host);
  };

  return (
    <div className="quickconnect-scrim" onClick={onClose}>
      <div
        className="quickconnect"
        role="dialog"
        aria-label="Quick connect"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="quickconnect-input"
          placeholder="Connect to…"
          aria-label="Search hosts to connect"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onClose();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelected(Math.min(clamped + 1, results.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelected(Math.max(clamped - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              connect(clamped);
            }
          }}
        />
        <ul className="quickconnect-results" role="listbox" aria-label="Hosts">
          {results.map((host, index) => (
            <li key={host.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === clamped}
                className={`quickconnect-result${index === clamped ? " quickconnect-result--selected" : ""}`}
                onMouseEnter={() => setSelected(index)}
                onClick={() => connect(index)}
              >
                <span className="quickconnect-led" aria-hidden />
                <span className="quickconnect-label">{host.label}</span>
                <span className="quickconnect-detail">
                  {host.hostname === ""
                    ? "ssh alias"
                    : host.user === ""
                      ? host.hostname
                      : `${host.user}@${host.hostname}`}
                </span>
              </button>
            </li>
          ))}
          {results.length === 0 && (
            <li className="quickconnect-none">No matching hosts</li>
          )}
        </ul>
      </div>
    </div>
  );
}
