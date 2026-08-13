import "./HostEditor.css";
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Checkbox, Select } from "../../components/controls";
import { ipcInvoke } from "../../ipc/client";
import type { Host, HostFieldError, HostForward } from "../../ipc/contract";
import { ruleKeyOf, useForwards } from "../../state/forwards";
import { duplicatesOf, emptyHostDraft, useHosts } from "../../state/hosts";
import { isHardwareKey, useKeys } from "../../state/keys";
import { useToast } from "../../state/toast";

/** The 8 identity hues (§7) — indices into the `--hue-N` tokens. */
const HUES = [0, 1, 2, 3, 4, 5, 6, 7] as const;

/** The three forward kinds, for the rule editor's select (F7). */
const FORWARD_KINDS: HostForward["type"][] = ["L", "R", "D"];

/**
 * The HostEditor drawer (F1): create or edit a `hosts.toml` record with
 * inline validation. Client-side checks mirror the cheap rules live
 * (label/hostname required, port 1–65535); the Rust store re-validates on
 * save — including identity-path existence — and its field errors land on
 * the same inputs. A duplicate `user@hostname:port` shows a non-blocking
 * warning (F1: warn, don't forbid).
 *
 * The forwards section (F7, Phase 6) edits the host's rules — kind, spec,
 * auto-start — with one lockout: a rule whose child is running must be
 * toggled off before it can be edited or removed (its key would silently
 * detach from the live tunnel otherwise).
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
  const liveForwards = useForwards((s) => s.byRuleKey);

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
  // Keychain state for the SFTP password row (F8). The secret itself lives
  // only in `passwordInput` between typing and the keychain_set call — it
  // never enters `draft` (hosts.toml's schema forbids secret fields).
  const [passwordStored, setPasswordStored] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [keychainError, setKeychainError] = useState<string | null>(null);
  // The mosh toggle's inline preflight (F3 mosh row): warn at edit time,
  // don't block the save — the record stores intent either way.
  const [moshMissing, setMoshMissing] = useState(false);

  useEffect(() => {
    setDraft(original);
    setTagInput("");
    setErrors([]);
    setPasswordInput("");
    setPasswordStored(false);
    setKeychainError(null);
    setMoshMissing(false);
    if (original.id === "") return;
    let cancelled = false;
    ipcInvoke("keychain_has", { kind: "password", hostId: original.id })
      .then((result) => {
        if (!cancelled) setPasswordStored(result.exists);
      })
      .catch((error: unknown) => {
        if (!cancelled) setKeychainError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [original]);

  if (editorTarget === null) return null;

  const errorFor = (field: string): string | undefined =>
    errors.find((e) => e.field === field)?.message;

  const duplicates = duplicatesOf(hosts, draft);

  const patch = (changes: Partial<Host>): void =>
    setDraft((previous) => ({ ...previous, ...changes }));

  const patchForward = (index: number, changes: Partial<HostForward>): void =>
    patch({
      forwards: draft.forwards.map((rule, i) =>
        i === index ? { ...rule, ...changes } : rule,
      ),
    });

  /**
   * Whether a rule's child is running right now — editing it is locked
   * until it's toggled off (F7 edge case, enforced in the UI).
   *
   * @param rule - The rule row.
   */
  const forwardLocked = (rule: HostForward): boolean => {
    if (draft.id === "") return false;
    const status = liveForwards[ruleKeyOf(draft.id, rule)];
    return status !== undefined && status.state !== "red";
  };

  const addTag = (): void => {
    const tag = tagInput.trim();
    if (tag !== "" && !draft.tags.includes(tag)) {
      patch({ tags: [...draft.tags, tag] });
    }
    setTagInput("");
  };

  /** Stores the typed SFTP password in the Keychain and forgets it here. */
  const storePassword = async (): Promise<void> => {
    setKeychainError(null);
    try {
      await ipcInvoke("keychain_set", {
        kind: "password",
        hostId: draft.id,
        secret: passwordInput,
      });
      setPasswordInput("");
      setPasswordStored(true);
      useToast.getState().show("SFTP password stored in Keychain", "success");
    } catch (error) {
      setKeychainError(String(error));
    }
  };

  /** Removes the host's SFTP password from the Keychain. */
  const clearPassword = async (): Promise<void> => {
    setKeychainError(null);
    try {
      await ipcInvoke("keychain_delete", { kind: "password", hostId: draft.id });
      setPasswordStored(false);
      useToast.getState().show("SFTP password removed from Keychain");
    } catch (error) {
      setKeychainError(String(error));
    }
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

          <div className="hosteditor-field">
            <span className="hosteditor-label" id="hosteditor-identity-label">
              Identity
            </span>
            <input
              className="hosteditor-input hosteditor-input--mono"
              value={draft.identity}
              placeholder='"agent" or a key path'
              aria-labelledby="hosteditor-identity-label"
              onChange={(event) => patch({ identity: event.target.value })}
            />
            {errorFor("identity") && (
              <span className="hosteditor-fielderror">{errorFor("identity")}</span>
            )}
            {isHardwareKey(draft.identity) && (
              <span className="hosteditor-hint">
                Hardware-backed key — system ssh will ask for a touch when connecting
                (F8).
              </span>
            )}
            <button
              className="hosteditor-keyslink"
              type="button"
              onClick={() => useKeys.getState().openPanel()}
            >
              Manage SSH keys…
            </button>
          </div>

          <div className="hosteditor-field">
            <span className="hosteditor-label" id="hosteditor-password-label">
              SFTP password
            </span>
            {draft.id === "" ? (
              <p className="hosteditor-hint">
                Save the host first, then store a password here. It goes to the macOS
                Keychain — never to disk — and is used for SFTP only; terminal ssh stays
                agent-first (F8).
              </p>
            ) : passwordStored ? (
              <div
                className="hosteditor-keychain"
                aria-labelledby="hosteditor-password-label"
              >
                <span className="hosteditor-keychain-state">Stored in Keychain</span>
                <button
                  className="hosteditor-keychain-button"
                  type="button"
                  onClick={() => void clearPassword()}
                >
                  Clear
                </button>
              </div>
            ) : (
              <div
                className="hosteditor-keychain"
                aria-labelledby="hosteditor-password-label"
              >
                <input
                  className="hosteditor-input hosteditor-keychain-input"
                  type="password"
                  value={passwordInput}
                  placeholder="For SFTP only — stored in Keychain"
                  autoComplete="new-password"
                  aria-label="SFTP password"
                  onChange={(event) => setPasswordInput(event.target.value)}
                />
                <button
                  className="hosteditor-keychain-button"
                  type="button"
                  disabled={passwordInput === ""}
                  onClick={() => void storePassword()}
                >
                  Store
                </button>
              </div>
            )}
            {keychainError !== null && (
              <span className="hosteditor-fielderror">{keychainError}</span>
            )}
          </div>

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

          <div className="hosteditor-field">
            <span className="hosteditor-label" id="hosteditor-forwards-label">
              Port forwards
            </span>
            <div aria-labelledby="hosteditor-forwards-label">
              {draft.forwards.map((rule, index) => {
                const locked = forwardLocked(rule);
                return (
                  <div
                    className="hosteditor-forward"
                    key={index}
                    title={locked ? "Toggle the forward off first to edit it" : undefined}
                  >
                    <Select
                      className="hosteditor-forward-kind"
                      value={rule.type}
                      disabled={locked}
                      aria-label={`Forward ${index + 1} type`}
                      options={FORWARD_KINDS.map((kind) => ({
                        value: kind,
                        label: kind,
                      }))}
                      onChange={(kind) =>
                        patchForward(index, {
                          type: kind as HostForward["type"],
                        })
                      }
                    />
                    <input
                      className="hosteditor-input hosteditor-input--mono hosteditor-forward-spec"
                      value={rule.spec}
                      disabled={locked}
                      placeholder={rule.type === "D" ? "1080" : "8080:localhost:8080"}
                      aria-label={`Forward ${index + 1} spec`}
                      onChange={(event) =>
                        patchForward(index, { spec: event.target.value })
                      }
                    />
                    <label className="hosteditor-forward-auto">
                      <Checkbox
                        checked={rule.auto}
                        disabled={locked}
                        onChange={(auto) => patchForward(index, { auto })}
                      />
                      auto
                    </label>
                    <button
                      className="hosteditor-forward-remove"
                      type="button"
                      disabled={locked}
                      aria-label={`Remove forward ${index + 1}`}
                      onClick={() =>
                        patch({
                          forwards: draft.forwards.filter((_, i) => i !== index),
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
            <button
              className="hosteditor-forward-add"
              type="button"
              onClick={() =>
                patch({
                  forwards: [...draft.forwards, { type: "L", spec: "", auto: false }],
                })
              }
            >
              Add forward
            </button>
            {errorFor("forwards") && (
              <span className="hosteditor-fielderror">{errorFor("forwards")}</span>
            )}
          </div>

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
              <Checkbox
                checked={draft.favorite}
                onChange={(favorite) => patch({ favorite })}
              />
              Favorite
            </label>
            <label className="hosteditor-toggle">
              <Checkbox
                checked={draft.reachability}
                onChange={(reachability) => patch({ reachability })}
              />
              Reachability LED (Phase 4)
            </label>
            <label className="hosteditor-toggle">
              <Checkbox
                checked={draft.use_mosh}
                onChange={(useMosh) => {
                  patch({ use_mosh: useMosh });
                  if (!useMosh) {
                    setMoshMissing(false);
                    return;
                  }
                  void ipcInvoke("binary_check", { name: "mosh" })
                    .then((result) => setMoshMissing(!result.found))
                    .catch(() => setMoshMissing(true));
                }}
              />
              Prefer mosh
            </label>
          </div>
          {moshMissing && (
            <p className="hosteditor-hint" role="status">
              mosh isn't installed (<code>brew install mosh</code>). The toggle can stay
              on, but connects will fail until it is.
            </p>
          )}

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
