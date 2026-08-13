import "./SnippetRunDialog.css";
import { useEffect, useMemo, useState } from "react";
import type { SnippetRunTarget } from "../../state/snippets";
import { useSnippets } from "../../state/snippets";
import { countBroadcastTargets, useBroadcast } from "../../state/broadcast";
import { useHosts } from "../../state/hosts";
import { activeSessionOf, activeTabOf, useSessions } from "../../state/sessions";
import { initialValues, promptsFor, resolveCommand } from "./variables";

/**
 * The F6 run dialog: one input (or select) per `{{variable}}`, the target
 * radio — current pane / new tab per selected host / broadcast set — and a
 * live preview of the resolved command. Run stays disabled until every
 * variable resolves (unresolved variables never reach a shell) and, for
 * new tabs, at least one host is picked. ⏎ runs, Esc cancels.
 *
 * Rendered only while `useSnippets.pendingRun` is set (palette ⏎ or the
 * drawer's Run button).
 *
 * @returns The dialog overlay, or `null` while closed.
 */
export function SnippetRunDialog() {
  const pendingRun = useSnippets((s) => s.pendingRun);
  const cancelRun = useSnippets((s) => s.cancelRun);
  const runSnippet = useSnippets((s) => s.runSnippet);
  const hosts = useHosts((s) => s.hosts);
  const paneReady = useSessions((s) => {
    const focused = activeSessionOf(s);
    return focused !== undefined && focused.status === "running";
  });
  const activeTab = useSessions(activeTabOf);
  const sessions = useSessions((s) => s.sessions);
  const broadcastArmed = useBroadcast((s) =>
    activeTab ? (s.active[activeTab.tabId] ?? false) : false,
  );
  const selectedPanes = useBroadcast((s) =>
    activeTab ? s.selected[activeTab.tabId] : undefined,
  );
  const broadcastCount =
    activeTab && broadcastArmed
      ? countBroadcastTargets(activeTab, sessions, selectedPanes ?? [])
      : 0;

  const prompts = useMemo(() => (pendingRun ? promptsFor(pendingRun) : []), [pendingRun]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<SnippetRunTarget>("current-pane");
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    // Reset per snippet so a reopened dialog starts clean.
    setValues(initialValues(pendingRun ? promptsFor(pendingRun) : []));
    setTarget("current-pane");
    setHostIds([]);
    setRunning(false);
  }, [pendingRun]);

  if (pendingRun === null) return null;

  const resolution = resolveCommand(pendingRun.command, values);
  const targetReady =
    target === "new-tabs"
      ? hostIds.length > 0
      : target === "broadcast"
        ? broadcastCount > 0
        : paneReady;
  const canRun = resolution.missing.length === 0 && targetReady && !running;

  const toggleHost = (hostId: string): void => {
    setHostIds((previous) =>
      previous.includes(hostId)
        ? previous.filter((id) => id !== hostId)
        : [...previous, hostId],
    );
  };

  const run = async (): Promise<void> => {
    if (!canRun) return;
    setRunning(true);
    try {
      await runSnippet(pendingRun, { target, hostIds, values });
      cancelRun();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="snippetrun-scrim" onMouseDown={cancelRun}>
      <form
        className="snippetrun"
        role="dialog"
        aria-modal="true"
        aria-label={`Run ${pendingRun.label}`}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            cancelRun();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <h2 className="snippetrun-title">Run “{pendingRun.label}”</h2>

        {prompts.map((prompt, index) => (
          <label className="snippetrun-field" key={prompt.name}>
            <span className="snippetrun-label">{prompt.name}</span>
            {prompt.choices ? (
              <select
                className="snippetrun-input"
                value={values[prompt.name] ?? ""}
                autoFocus={index === 0}
                onChange={(event) =>
                  setValues((v) => ({ ...v, [prompt.name]: event.target.value }))
                }
              >
                {(values[prompt.name] ?? "") === "" && <option value="">Choose…</option>}
                {prompt.choices.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="snippetrun-input"
                value={values[prompt.name] ?? ""}
                placeholder={prompt.default}
                autoFocus={index === 0}
                onChange={(event) =>
                  setValues((v) => ({ ...v, [prompt.name]: event.target.value }))
                }
              />
            )}
          </label>
        ))}

        <fieldset className="snippetrun-targets">
          <legend className="snippetrun-label">Run in</legend>
          <label className="snippetrun-target">
            <input
              type="radio"
              name="snippetrun-target"
              checked={target === "current-pane"}
              disabled={!paneReady}
              onChange={() => setTarget("current-pane")}
            />
            Current pane
            {!paneReady && <span className="snippetrun-why">no running pane</span>}
          </label>
          <label className="snippetrun-target">
            <input
              type="radio"
              name="snippetrun-target"
              checked={target === "new-tabs"}
              onChange={() => setTarget("new-tabs")}
            />
            New tab per host
          </label>
          {target === "new-tabs" && (
            <div className="snippetrun-hosts" role="group" aria-label="Hosts">
              {hosts.map((host) => (
                <label className="snippetrun-host" key={host.id}>
                  <input
                    type="checkbox"
                    checked={hostIds.includes(host.id)}
                    onChange={() => toggleHost(host.id)}
                  />
                  {host.label}
                </label>
              ))}
              {hosts.length === 0 && <span className="snippetrun-why">no hosts yet</span>}
            </div>
          )}
          <label className="snippetrun-target">
            <input
              type="radio"
              name="snippetrun-target"
              checked={target === "broadcast"}
              disabled={broadcastCount === 0}
              onChange={() => setTarget("broadcast")}
            />
            Broadcast set
            <span className="snippetrun-why">
              {broadcastCount > 0
                ? `${broadcastCount} ${broadcastCount === 1 ? "session" : "sessions"}`
                : "arm with ⇧⌘B first"}
            </span>
          </label>
        </fieldset>

        <div className="snippetrun-preview" aria-label="Resolved command">
          {resolution.command}
        </div>

        <div className="snippetrun-actions">
          <button className="snippetrun-cancel" type="button" onClick={cancelRun}>
            Cancel
          </button>
          <button className="snippetrun-confirm" type="submit" disabled={!canRun}>
            {running ? "Running…" : "Run"}
          </button>
        </div>
      </form>
    </div>
  );
}
