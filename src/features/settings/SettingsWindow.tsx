import "./SettingsWindow.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  Archive,
  FlaskConical,
  GitBranch,
  Network,
  Terminal as TerminalIcon,
} from "lucide-react";
import { Checkbox } from "../../components/controls";
import { ipcInvoke } from "../../ipc/client";
import type { SettingsDocument } from "../../ipc/contract";
import { initSettings, useSettings } from "../../state/settings";
import { initSync, useSync } from "../../state/sync";
import { syncStateLabel } from "./syncPresentation";

/** One section in the left navigation. */
interface SectionDef {
  /** Stable id (drives the active-section state). */
  id: string;
  /** Row label. */
  label: string;
  /** Row icon. */
  icon: typeof TerminalIcon;
}

/** The window's sections, in display order. */
const SECTIONS: SectionDef[] = [
  { id: "terminal", label: "Terminal", icon: TerminalIcon },
  { id: "sync", label: "Sync", icon: GitBranch },
  { id: "snapshots", label: "Snapshots", icon: Archive },
  { id: "tailnet", label: "Tailnet", icon: Network },
  { id: "reachability", label: "Reachability", icon: Activity },
  { id: "flags", label: "Flags", icon: FlaskConical },
];

/**
 * The advanced-track feature flags (§0.5): definitions live here in code —
 * `settings.toml` only stores the booleans. Until each feature's phase
 * ships, its row renders disabled with the phase label (PLAN.md §5,
 * feature-flags-presentation row: honest UI over dead toggles).
 */
const FLAG_DEFS = [
  { key: "semantic_terminal", label: "Semantic terminal (OSC 133/7)", phase: 10 },
  { key: "instant_connections", label: "Instant connections (ControlMaster)", phase: 11 },
  { key: "fleet_health", label: "Fleet health sparklines", phase: 12 },
  { key: "output_triggers", label: "Output triggers & alerts", phase: 12 },
  { key: "runbooks", label: "Runbooks", phase: 12 },
  { key: "automation", label: "Automation & integrations", phase: 13 },
  { key: "ai_assist", label: "AI assist (claude CLI)", phase: 13 },
  { key: "themes", label: "User themes", phase: 13 },
] as const;

/**
 * The Settings window's root (Phase 8) — rendered in its own webview
 * (label `settings`, routed by `?window=settings` in `main.tsx`; PLAN.md
 * §5). Edits a draft of the whole document and saves it atomically via
 * `settings_set`; the `settings:changed` broadcast then converges every
 * window, which is how the main window hot-applies fonts and prober
 * knobs. Esc or ⌘W closes the window.
 *
 * @returns The window's root element.
 */
export function SettingsWindow() {
  const doc = useSettings((s) => s.doc);
  const loaded = useSettings((s) => s.loaded);
  const loadError = useSettings((s) => s.loadError);
  const errors = useSettings((s) => s.errors);
  const saving = useSettings((s) => s.saving);

  const [active, setActive] = useState("terminal");
  const [draft, setDraft] = useState<SettingsDocument>(doc);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    void initSettings();
    void initSync();
  }, []);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(doc),
    [draft, doc],
  );

  // Follow the store when this window isn't mid-edit: a draft that was
  // clean against the *previous* document (initial load, a save that
  // arrived via settings:changed) adopts the new one; a dirty draft
  // holds its edits.
  const prevDocRef = useRef(doc);
  useEffect(() => {
    const prevDoc = prevDocRef.current;
    prevDocRef.current = doc;
    setDraft((current) =>
      JSON.stringify(current) === JSON.stringify(prevDoc) ? doc : current,
    );
  }, [doc]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const closeCombo = event.key === "Escape" || (event.metaKey && event.key === "w");
      if (closeCombo) {
        event.preventDefault();
        void getCurrentWindow().close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const errorFor = (field: string): string | undefined =>
    errors.find((e) => e.field === field)?.message;

  const patch = (partial: Partial<SettingsDocument>): void => {
    setDraft((current) => ({ ...current, ...partial }));
  };

  const submit = async (): Promise<void> => {
    const saved = await useSettings.getState().save(draft);
    if (saved) {
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
    }
  };

  return (
    <div className="settings-window">
      {/* Overlay titlebar (main-window chrome): drag strip under the
          traffic lights; the h1 below stays clear of them. */}
      <div className="settings-titlebar" data-tauri-drag-region />
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          <h1 className="settings-title">Settings</h1>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`settings-nav-item${active === id ? " is-active" : ""}`}
              onClick={() => setActive(id)}
            >
              <Icon size={14} aria-hidden /> {label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {!loaded ? (
            <p className="settings-note">Loading…</p>
          ) : loadError ? (
            <p className="settings-error" role="alert">
              settings.toml can’t be read: {loadError}
            </p>
          ) : (
            <>
              {active === "terminal" && (
                <TerminalSection draft={draft} patch={patch} errorFor={errorFor} />
              )}
              {active === "sync" && <SyncSection draft={draft} patch={patch} />}
              {active === "snapshots" && (
                <SnapshotsSection draft={draft} patch={patch} errorFor={errorFor} />
              )}
              {active === "tailnet" && <TailnetSection draft={draft} patch={patch} />}
              {active === "reachability" && (
                <ReachabilitySection draft={draft} patch={patch} errorFor={errorFor} />
              )}
              {active === "flags" && <FlagsSection />}
            </>
          )}

          <footer className="settings-footer">
            {errorFor("") ? (
              <span className="settings-error" role="alert">
                {errorFor("")}
              </span>
            ) : savedFlash ? (
              <span className="settings-saved" role="status">
                Saved
              </span>
            ) : (
              <span />
            )}
            <button
              type="button"
              className="settings-save"
              disabled={!dirty || saving}
              onClick={() => void submit()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

/** Props shared by the draft-editing sections. */
interface SectionProps {
  /** The document draft being edited. */
  draft: SettingsDocument;
  /** Merges a partial update into the draft. */
  patch(partial: Partial<SettingsDocument>): void;
  /** Looks up the validation error for a TOML key path, if any. */
  errorFor?(field: string): string | undefined;
}

/**
 * A labeled numeric field with inline validation error.
 *
 * @param props - Label, value, change handler, and optional error/unit.
 * @returns The field element.
 */
function NumberField(props: {
  /** Visible label. */
  label: string;
  /** Current value. */
  value: number;
  /** Change handler with the parsed number (NaN never delivered). */
  onChange(value: number): void;
  /** Validation error to show under the field. */
  error?: string;
  /** Unit hint rendered after the input (`px`, `days`…). */
  unit?: string;
}) {
  return (
    <label className="settings-field">
      <span className="settings-field-label">{props.label}</span>
      <span className="settings-field-control">
        <input
          className="settings-input settings-input--number"
          inputMode="numeric"
          value={String(props.value)}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            props.onChange(Number.isFinite(parsed) ? parsed : 0);
          }}
        />
        {props.unit ? <span className="settings-unit">{props.unit}</span> : null}
      </span>
      {props.error ? <span className="settings-error">{props.error}</span> : null}
    </label>
  );
}

/**
 * The Terminal section: font size and scrollback (hot-applied on save).
 *
 * @param props - {@link SectionProps}
 * @returns The section element.
 */
function TerminalSection({ draft, patch, errorFor }: SectionProps) {
  return (
    <section className="settings-section" aria-label="Terminal">
      <p className="settings-note">
        Applied to every open terminal the moment you save — no restart.
      </p>
      <NumberField
        label="Font size"
        unit="px"
        value={draft.terminal.font_size}
        error={errorFor?.("terminal.font_size")}
        onChange={(font_size) => patch({ terminal: { ...draft.terminal, font_size } })}
      />
      <NumberField
        label="Scrollback"
        unit="lines"
        value={draft.terminal.scrollback_lines}
        error={errorFor?.("terminal.scrollback_lines")}
        onChange={(scrollback_lines) =>
          patch({ terminal: { ...draft.terminal, scrollback_lines } })
        }
      />
    </section>
  );
}

/**
 * The Sync section: remote, status, auto-sync toggle (F10).
 *
 * @param props - {@link SectionProps}
 * @returns The section element.
 */
function SyncSection({ draft, patch }: SectionProps) {
  const status = useSync((s) => s.status);
  const syncing = useSync((s) => s.syncing);
  const lastMessage = useSync((s) => s.lastMessage);
  const [remoteDraft, setRemoteDraft] = useState<string | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);

  const remoteValue = remoteDraft ?? status?.remoteUrl ?? "";

  const applyRemote = async (): Promise<void> => {
    setRemoteBusy(true);
    try {
      const result = await useSync.getState().setRemote(remoteValue.trim());
      if (result.ok) setRemoteDraft(null);
    } finally {
      setRemoteBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-label="Sync">
      <p className="settings-note">
        Your config dir (<code>~/.config/setu</code>) is a git repo. Point it at a private
        remote and “Sync now” commits, rebases, and pushes — hosts, snippets, settings.
        Secrets never belong in it; the lint refuses them.
      </p>
      <label className="settings-field">
        <span className="settings-field-label">Remote (origin)</span>
        <span className="settings-field-control">
          <input
            className="settings-input"
            placeholder="git@github.com:you/setu-config.git"
            value={remoteValue}
            onChange={(event) => setRemoteDraft(event.target.value)}
          />
          <button
            type="button"
            className="settings-minor"
            disabled={remoteBusy || remoteDraft === null}
            onClick={() => void applyRemote()}
          >
            Set remote
          </button>
        </span>
        <span className="settings-hint">
          Leave empty and press “Set remote” to disconnect.
        </span>
      </label>
      <div className="settings-field">
        <span className="settings-field-label">Status</span>
        <span className="settings-field-control">
          <span
            className={`settings-sync-state settings-sync-state--${status?.state ?? "local"}`}
          >
            {syncing ? "syncing…" : syncStateLabel(status)}
          </span>
          <button
            type="button"
            className="settings-minor"
            disabled={syncing}
            onClick={() => void useSync.getState().syncNow()}
          >
            Sync now
          </button>
          <button
            type="button"
            className="settings-minor"
            onClick={() => void useSync.getState().openDir()}
          >
            Open in Finder
          </button>
        </span>
        {lastMessage ? <span className="settings-error">{lastMessage}</span> : null}
      </div>
      <label className="settings-field settings-field--toggle">
        <Checkbox
          checked={draft.sync.auto_sync_on_quit}
          onChange={(auto_sync_on_quit) => patch({ sync: { auto_sync_on_quit } })}
          aria-label="Sync on quit"
        />
        <span>
          Sync on quit
          <span className="settings-hint">Capped at 10 seconds — quit never hangs.</span>
        </span>
      </label>
    </section>
  );
}

/**
 * The Snapshots section: schedule knobs and the manual button (F10).
 *
 * @param props - {@link SectionProps}
 * @returns The section element.
 */
function SnapshotsSection({ draft, patch, errorFor }: SectionProps) {
  const [lastPath, setLastPath] = useState<string | null>(null);
  const [snapError, setSnapError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const takeSnapshot = async (): Promise<void> => {
    setBusy(true);
    setSnapError(null);
    try {
      const { path } = await ipcInvoke("snapshot_now", {});
      setLastPath(path);
    } catch (error) {
      setSnapError(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-label="Snapshots">
      <p className="settings-note">
        A safety net under sync: the config dir is archived on a schedule into the app’s
        data folder as <code>.tar.gz</code>, oldest pruned.
      </p>
      <label className="settings-field settings-field--toggle">
        <Checkbox
          checked={draft.snapshots.enabled}
          onChange={(enabled) => patch({ snapshots: { ...draft.snapshots, enabled } })}
          aria-label="Scheduled snapshots"
        />
        <span>Scheduled snapshots</span>
      </label>
      <NumberField
        label="Every"
        unit="days"
        value={draft.snapshots.interval_days}
        error={errorFor?.("snapshots.interval_days")}
        onChange={(interval_days) =>
          patch({ snapshots: { ...draft.snapshots, interval_days } })
        }
      />
      <NumberField
        label="Keep"
        unit="archives"
        value={draft.snapshots.keep}
        error={errorFor?.("snapshots.keep")}
        onChange={(keep) => patch({ snapshots: { ...draft.snapshots, keep } })}
      />
      <div className="settings-field">
        <span className="settings-field-control">
          <button
            type="button"
            className="settings-minor"
            disabled={busy}
            onClick={() => void takeSnapshot()}
          >
            {busy ? "Archiving…" : "Snapshot now"}
          </button>
        </span>
        {lastPath ? (
          <span className="settings-hint" role="status">
            Saved {lastPath}
          </span>
        ) : null}
        {snapError ? <span className="settings-error">{snapError}</span> : null}
      </div>
    </section>
  );
}

/**
 * The Tailnet section: the default login user (F9).
 *
 * @param props - {@link SectionProps}
 * @returns The section element.
 */
function TailnetSection({ draft, patch }: SectionProps) {
  return (
    <section className="settings-section" aria-label="Tailnet">
      <p className="settings-note">
        The login user for one-click tailnet connects. Empty means your local user.
      </p>
      <label className="settings-field">
        <span className="settings-field-label">Default user</span>
        <span className="settings-field-control">
          <input
            className="settings-input"
            placeholder="$USER"
            value={draft.tailnet.default_user}
            onChange={(event) => patch({ tailnet: { default_user: event.target.value } })}
          />
        </span>
      </label>
    </section>
  );
}

/**
 * The Reachability section: the prober's knobs (F1).
 *
 * @param props - {@link SectionProps}
 * @returns The section element.
 */
function ReachabilitySection({ draft, patch, errorFor }: SectionProps) {
  const reach = draft.reachability;
  return (
    <section className="settings-section" aria-label="Reachability">
      <p className="settings-note">
        The LED board’s probes: bare TCP connects, no banners, no auth. Changes re-tune
        the running prober on save.
      </p>
      <label className="settings-field settings-field--toggle">
        <Checkbox
          checked={reach.enabled}
          onChange={(enabled) => patch({ reachability: { ...reach, enabled } })}
          aria-label="Probe reachability"
        />
        <span>Probe reachability</span>
      </label>
      <NumberField
        label="Sweep every"
        unit="s"
        value={reach.interval_s}
        error={errorFor?.("reachability.interval_s")}
        onChange={(interval_s) => patch({ reachability: { ...reach, interval_s } })}
      />
      <NumberField
        label="Timeout"
        unit="ms"
        value={reach.timeout_ms}
        error={errorFor?.("reachability.timeout_ms")}
        onChange={(timeout_ms) => patch({ reachability: { ...reach, timeout_ms } })}
      />
      <NumberField
        label="Max concurrent"
        value={reach.max_concurrent}
        error={errorFor?.("reachability.max_concurrent")}
        onChange={(max_concurrent) =>
          patch({ reachability: { ...reach, max_concurrent } })
        }
      />
    </section>
  );
}

/**
 * The Flags section: the advanced track's kill switches, rendered
 * disabled until their phases ship (PLAN.md §5 — no dead toggles).
 */
function FlagsSection() {
  return (
    <section className="settings-section" aria-label="Feature flags">
      <p className="settings-note">
        The advanced track ships behind these flags, default-off. Each one unlocks when
        its phase lands — nothing here is live yet.
      </p>
      {FLAG_DEFS.map((flag) => (
        <div key={flag.key} className="settings-field settings-field--toggle is-disabled">
          <Checkbox
            checked={false}
            disabled
            onChange={() => undefined}
            aria-label={flag.label}
          />
          <span>
            {flag.label}
            <span className="settings-hint">arrives in Phase {flag.phase}</span>
          </span>
        </div>
      ))}
    </section>
  );
}
