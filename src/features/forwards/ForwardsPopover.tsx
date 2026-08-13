import "./ForwardsPopover.css";
import { useState } from "react";
import type { ForwardStartError, Host, HostForward } from "../../ipc/contract";
import { ruleFromKey, ruleKeyOf, useForwards, withBindPort } from "../../state/forwards";
import { useHosts } from "../../state/hosts";
import { useToast } from "../../state/toast";

/** One row the popover renders: a configured or transient rule. */
interface PopoverRow {
  /** The owning host's id. */
  hostId: string;
  /** The owning host's label ("unknown host" for orphaned statuses). */
  hostLabel: string;
  /** The rule (reconstructed from the key for transient overrides). */
  rule: HostForward;
  /** The rule's registry key. */
  ruleKey: string;
  /** Whether this row came from a one-shot port override, not hosts.toml. */
  transient: boolean;
}

/** Props for {@link ForwardsPopover}. */
export interface ForwardsPopoverProps {
  /** Closes the popover (scrim click, Esc, or the chip again). */
  onClose(): void;
}

/**
 * The F7 forwards popover, anchored above the status-bar chip: every
 * configured rule grouped by host — kind badge, spec, health dot, toggle —
 * plus any one-shot port overrides currently running. Red rows show their
 * reason; `D` rules get a copyable SOCKS string once running; a port
 * conflict shows the owning process and a "Use N" one-shot retry on the
 * next free port (the stored rule is never rewritten — PLAN.md §5).
 *
 * Rule CRUD lives in the HostEditor; this surface only toggles.
 *
 * @param props - {@link ForwardsPopoverProps}
 * @returns The popover element.
 */
export function ForwardsPopover({ onClose }: ForwardsPopoverProps) {
  const hosts = useHosts((s) => s.hosts);
  const byRuleKey = useForwards((s) => s.byRuleKey);
  const start = useForwards((s) => s.start);
  const stop = useForwards((s) => s.stop);
  /** Row-local conflict helpers, keyed by ruleKey. */
  const [conflicts, setConflicts] = useState<Record<string, ForwardStartError>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const configured: PopoverRow[] = hosts.flatMap((host: Host) =>
    host.forwards.map((rule) => ({
      hostId: host.id,
      hostLabel: host.label,
      rule,
      ruleKey: ruleKeyOf(host.id, rule),
      transient: false,
    })),
  );
  const configuredKeys = new Set(configured.map((row) => row.ruleKey));
  const transient: PopoverRow[] = Object.values(byRuleKey)
    .filter((status) => !configuredKeys.has(status.ruleKey))
    .flatMap((status) => {
      const rule = ruleFromKey(status.ruleKey, status.hostId);
      if (rule === null) return [];
      return [
        {
          hostId: status.hostId,
          hostLabel: hosts.find((h) => h.id === status.hostId)?.label ?? "unknown host",
          rule,
          ruleKey: status.ruleKey,
          transient: true,
        },
      ];
    });
  const rows = [...configured, ...transient];
  const groups = [...new Set(rows.map((row) => row.hostLabel))];

  const startRule = async (row: PopoverRow, rule: HostForward): Promise<void> => {
    const key = ruleKeyOf(row.hostId, rule);
    setBusyKey(key);
    try {
      const result = await start(row.hostId, rule);
      if (!result.started && result.error) {
        setConflicts((previous) => ({
          ...previous,
          [row.ruleKey]: result.error as ForwardStartError,
        }));
      } else {
        setConflicts((previous) => {
          const next = { ...previous };
          delete next[row.ruleKey];
          return next;
        });
      }
    } catch (error) {
      useToast.getState().show(String(error));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="fwdpop-scrim" onMouseDown={onClose}>
      <section
        className="fwdpop"
        role="dialog"
        aria-label="Port forwards"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 className="fwdpop-title">Port forwards</h2>
        {rows.length === 0 && (
          <p className="fwdpop-empty">
            No rules yet — add forwards to a host in its editor.
          </p>
        )}
        {groups.map((label) => (
          <div className="fwdpop-group" key={label}>
            <h3 className="fwdpop-host">{label}</h3>
            {rows
              .filter((row) => row.hostLabel === label)
              .map((row) => {
                const status = byRuleKey[row.ruleKey];
                const running = status !== undefined && status.state !== "red";
                const conflict = conflicts[row.ruleKey];
                return (
                  <div className="fwdpop-rule" key={row.ruleKey}>
                    <div className="fwdpop-ruleline">
                      <span
                        className={`fwdpop-dot fwdpop-dot--${status?.state ?? "off"}`}
                        aria-label={status?.state ?? "off"}
                      />
                      <span className="fwdpop-kind">{row.rule.type}</span>
                      <span className="fwdpop-spec">{row.rule.spec}</span>
                      {row.transient && (
                        <span className="fwdpop-transient">one-shot</span>
                      )}
                      <button
                        className="fwdpop-toggle"
                        type="button"
                        disabled={busyKey !== null}
                        onClick={() => {
                          if (running) {
                            void stop(row.ruleKey);
                          } else {
                            void startRule(row, row.rule);
                          }
                        }}
                      >
                        {running ? "Stop" : "Start"}
                      </button>
                    </div>
                    {status?.state === "red" && status.reason !== undefined && (
                      <p className="fwdpop-reason">{status.reason}</p>
                    )}
                    {status?.proxyString !== undefined && running && (
                      <button
                        className="fwdpop-socks"
                        type="button"
                        title="Copy proxy string"
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(status.proxyString ?? "")
                            .then(() => useToast.getState().show("Proxy string copied"))
                            .catch(() => undefined);
                        }}
                      >
                        SOCKS on localhost:{row.rule.spec.split(":").pop()} ·{" "}
                        {status.proxyString}
                      </button>
                    )}
                    {conflict !== undefined && (
                      <p className="fwdpop-conflict">
                        {conflict.message}
                        {conflict.suggestedPort !== undefined && (
                          <button
                            className="fwdpop-useport"
                            type="button"
                            disabled={busyKey !== null}
                            onClick={() =>
                              void startRule(
                                row,
                                withBindPort(row.rule, conflict.suggestedPort as number),
                              )
                            }
                          >
                            Use {conflict.suggestedPort}
                          </button>
                        )}
                      </p>
                    )}
                  </div>
                );
              })}
          </div>
        ))}
      </section>
    </div>
  );
}
