import "./CommandPalette.css";
import { useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";
import { HostLed, ReachChip } from "../../components/HostLed";
import type { Host } from "../../ipc/contract";
import { paletteEntries, type PaletteActionEntry } from "../../state/actions";
import { actionSubject, hostSubject } from "../../state/frecency";
import { rankHosts, sshCommandOf, useHosts } from "../../state/hosts";
import { ledInfoOf, useReach } from "../../state/reach";
import { findLeafBySession } from "../../state/splits";
import { useSessions } from "../../state/sessions";
import { useUiChrome } from "../../state/ui";
import { useUiPrefs } from "../../state/uiState";

/** Result rows shown per section; ranking makes more never necessary. */
const MAX_HOSTS = 8;

/** One selectable palette row: a §8 action or a host. */
type PaletteItem =
  { kind: "action"; entry: PaletteActionEntry } | { kind: "host"; host: Host };

/**
 * The F11 command palette. One component, two surfaces from the chrome
 * store: ⌘K (`"commands"`) lists Actions — every implemented §8 command
 * with its shortcut — above Hosts; ⌘T (`"hosts"`) is the same palette
 * pre-filtered to hosts (quick connect). Renders nothing while closed.
 *
 * Hosts rank by fuzzy match blended with frecency and carry their live
 * LED. Selected-host actions: ⏎ connect (focuses an existing running tab,
 * else opens one) · ⌘⏎ always a new tab · ⌘E edit · ⌘C copy ssh command.
 * ⌥⏎ SFTP joins in Phase 5. Actions run on ⏎ and record frecency.
 *
 * @returns The palette overlay, or `null` when closed.
 */
export function CommandPalette() {
  const mode = useUiChrome((s) => s.paletteMode);
  const closePalette = useUiChrome((s) => s.closePalette);
  const hosts = useHosts((s) => s.hosts);
  const openEditor = useHosts((s) => s.openEditor);
  const frecency = useUiPrefs((s) => s.frecency);
  const recordUse = useUiPrefs((s) => s.recordUse);
  const reachByHost = useReach((s) => s.byHost);
  const probing = useReach((s) => s.probing);
  const sessions = useSessions((s) => s.sessions);
  const tabs = useSessions((s) => s.tabs);
  const openSshTab = useSessions((s) => s.openSshTab);
  const activateByIndex = useSessions((s) => s.activateByIndex);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Reset per open so a reopened palette starts clean.
  useEffect(() => {
    if (mode !== null) {
      setQuery("");
      setSelected(0);
      inputRef.current?.focus();
    }
  }, [mode]);

  const actionRows = useMemo<PaletteActionEntry[]>(() => {
    if (mode !== "commands") return [];
    const all = paletteEntries();
    const trimmed = query.trim();
    if (trimmed === "") return all;
    return new Fuse(all, { keys: ["title"], threshold: 0.35, ignoreLocation: true })
      .search(trimmed)
      .map((result) => result.item);
  }, [mode, query]);

  const hostRows = useMemo<Host[]>(
    () => (mode === null ? [] : rankHosts(hosts, query, frecency).slice(0, MAX_HOSTS)),
    [mode, hosts, query, frecency],
  );

  const items = useMemo<PaletteItem[]>(
    () => [
      ...actionRows.map((entry): PaletteItem => ({ kind: "action", entry })),
      ...hostRows.map((host): PaletteItem => ({ kind: "host", host })),
    ],
    [actionRows, hostRows],
  );
  const clamped = Math.min(selected, Math.max(items.length - 1, 0));

  useEffect(() => {
    // Keep the selected row in view while ↑↓ moves it.
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [clamped, items.length]);

  if (mode === null) return null;

  /**
   * Focuses an existing running tab for the host; false when none.
   *
   * @param host - The host whose tab to look for.
   */
  const focusExistingTab = (host: Host): boolean => {
    const index = tabs.findIndex((tab) =>
      sessions.some(
        (s) =>
          s.hostId === host.id &&
          s.status === "running" &&
          !s.orphaned &&
          findLeafBySession(tab.layout, s.sessionId),
      ),
    );
    if (index === -1) return false;
    activateByIndex(index);
    return true;
  };

  const connectHost = (host: Host, alwaysNewTab: boolean): void => {
    recordUse(hostSubject(host.id));
    closePalette();
    if (!alwaysNewTab && focusExistingTab(host)) return;
    void openSshTab(host);
  };

  const runItem = (item: PaletteItem, event?: { metaKey: boolean }): void => {
    if (item.kind === "action") {
      recordUse(actionSubject(item.entry.id.split(":")[0]));
      closePalette();
      item.entry.perform();
      return;
    }
    connectHost(item.host, event?.metaKey ?? false);
  };

  const selectedItem = items[clamped];

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closePalette();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected(Math.min(clamped + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected(Math.max(clamped - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (selectedItem) runItem(selectedItem, event);
    } else if (
      selectedItem?.kind === "host" &&
      event.metaKey &&
      event.key.toLowerCase() === "e"
    ) {
      // ⌘E edits the selected host (imported rows adopt first — F1 keeps
      // them read-only, so the editor is the wrong door for them).
      if (selectedItem.host.source !== "ssh_config") {
        event.preventDefault();
        closePalette();
        openEditor(selectedItem.host.id);
      }
    } else if (
      selectedItem?.kind === "host" &&
      event.metaKey &&
      event.key.toLowerCase() === "c" &&
      event.currentTarget.selectionStart === event.currentTarget.selectionEnd
    ) {
      // ⌘C copies the ssh command — unless the user is copying selected
      // text from the input, which native copy must keep owning.
      event.preventDefault();
      void navigator.clipboard
        .writeText(sshCommandOf(selectedItem.host))
        .catch(() => undefined);
      closePalette();
    }
  };

  const rowDetail = (host: Host): string => {
    if (host.hostname === "") return "ssh alias";
    return host.user === "" ? host.hostname : `${host.user}@${host.hostname}`;
  };

  return (
    <div className="palette-scrim" onClick={closePalette}>
      <div
        className="palette"
        role="dialog"
        aria-label={mode === "hosts" ? "Quick connect" : "Command palette"}
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={mode === "hosts" ? "Connect to…" : "Type a command or host…"}
          aria-label={
            mode === "hosts" ? "Search hosts to connect" : "Search commands and hosts"
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul className="palette-results" role="listbox" aria-label="Results" ref={listRef}>
          {actionRows.length > 0 && <li className="palette-eyebrow">Actions</li>}
          {actionRows.map((entry) => {
            const index = items.findIndex(
              (i) => i.kind === "action" && i.entry.id === entry.id,
            );
            return (
              <li key={`action:${entry.id}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === clamped}
                  className={`palette-row${index === clamped ? " palette-row--selected" : ""}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => runItem({ kind: "action", entry })}
                >
                  <span className="palette-title">{entry.title}</span>
                  {entry.shortcut && (
                    <kbd className="palette-shortcut">{entry.shortcut}</kbd>
                  )}
                </button>
              </li>
            );
          })}
          {hostRows.length > 0 && mode === "commands" && (
            <li className="palette-eyebrow">Hosts</li>
          )}
          {hostRows.map((host) => {
            const index = items.findIndex(
              (i) => i.kind === "host" && i.host.id === host.id,
            );
            const led = ledInfoOf(host, reachByHost, sessions, probing);
            return (
              <li key={`host:${host.id}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === clamped}
                  className={`palette-row${index === clamped ? " palette-row--selected" : ""}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={(event) => runItem({ kind: "host", host }, event)}
                >
                  <HostLed led={led} />
                  <span className="palette-title">{host.label}</span>
                  <span className="palette-detail">{rowDetail(host)}</span>
                  <ReachChip led={led} />
                </button>
              </li>
            );
          })}
          {items.length === 0 && (
            <li className="palette-none">
              {mode === "hosts" ? "No matching hosts" : "No matching commands or hosts"}
            </li>
          )}
        </ul>
        {selectedItem?.kind === "host" && (
          <footer className="palette-hints">
            <span>⏎ connect</span>
            <span>⌘⏎ new tab</span>
            {selectedItem.host.source !== "ssh_config" && <span>⌘E edit</span>}
            <span>⌘C copy ssh command</span>
          </footer>
        )}
      </div>
    </div>
  );
}
