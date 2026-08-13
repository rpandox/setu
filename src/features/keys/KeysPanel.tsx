import "./KeysPanel.css";
import { useState } from "react";
import { KeyRound, RefreshCw, X } from "lucide-react";
import type { Host } from "../../ipc/contract";
import { useHosts } from "../../state/hosts";
import { isHardwareKey, useKeys } from "../../state/keys";

/** The generate form's starting path — the standard OpenSSH location. */
const DEFAULT_KEY_PATH = "~/.ssh/id_ed25519";

/**
 * The Keys panel (F8, Phase 7; §7 component inventory): agent listing
 * with fingerprints, ed25519 key generation, and the ssh-copy-id helper.
 * Opened from the palette ("Manage SSH keys") and from the HostEditor's
 * identity field — there is no Settings window until Phase 8 (PLAN.md §5).
 *
 * Renders as a right-hand panel over a scrim, HostEditor-style. Esc or ✕
 * closes; the last generated public key survives a close so it can still
 * be copied or installed later in the session.
 *
 * @returns The panel element, or `null` while closed.
 */
export function KeysPanel() {
  const panelOpen = useKeys((s) => s.panelOpen);
  const agent = useKeys((s) => s.agent);
  const agentLoading = useKeys((s) => s.agentLoading);
  const generating = useKeys((s) => s.generating);
  const keysError = useKeys((s) => s.keysError);
  const publicKey = useKeys((s) => s.publicKey);
  const publicKeyPath = useKeys((s) => s.publicKeyPath);
  const hosts = useHosts((s) => s.hosts);

  const [path, setPath] = useState(DEFAULT_KEY_PATH);
  const [passphrase, setPassphrase] = useState("");
  const [comment, setComment] = useState("");
  const [copyIdHostId, setCopyIdHostId] = useState("");
  const [copyIdPath, setCopyIdPath] = useState("");

  if (!panelOpen) return null;

  const store = useKeys.getState();
  const copyIdTargets = hosts;
  const effectiveCopyIdPath =
    copyIdPath !== ""
      ? copyIdPath
      : publicKeyPath !== null
        ? `${publicKeyPath}.pub`
        : `${DEFAULT_KEY_PATH}.pub`;
  const copyIdHost: Host | undefined = copyIdTargets.find((h) => h.id === copyIdHostId);

  const submitGenerate = async (): Promise<void> => {
    const created = await store.generate(path.trim(), passphrase, comment.trim());
    if (created) setPassphrase("");
  };

  return (
    <div className="keyspanel-scrim">
      <aside
        className="keyspanel"
        role="dialog"
        aria-label="SSH keys"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            store.closePanel();
          }
        }}
      >
        <header className="keyspanel-header">
          <h2 className="keyspanel-title">
            <KeyRound size={15} aria-hidden /> SSH keys
          </h2>
          <button
            className="keyspanel-close"
            type="button"
            aria-label="Close keys panel"
            onClick={store.closePanel}
          >
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className="keyspanel-body">
          <section aria-label="ssh-agent">
            <div className="keyspanel-eyebrow-row">
              <span className="keyspanel-eyebrow">Agent</span>
              <button
                className="keyspanel-refresh"
                type="button"
                aria-label="Refresh agent list"
                disabled={agentLoading}
                onClick={() => void store.refreshAgent()}
              >
                <RefreshCw size={12} aria-hidden />
              </button>
            </div>
            {agent === null || agentLoading ? (
              <p className="keyspanel-hint">Checking the ssh-agent…</p>
            ) : !agent.available ? (
              <div className="keyspanel-banner" role="status">
                <p>{agent.note ?? "No ssh-agent is reachable."}</p>
                <p>
                  macOS starts one per login session — try{" "}
                  <code>ssh-add ~/.ssh/id_ed25519</code> in a terminal, or{" "}
                  <code>eval $(ssh-agent)</code> in shells without one.
                </p>
              </div>
            ) : agent.keys.length === 0 ? (
              <p className="keyspanel-hint">
                The agent is running but holds no identities — load one with{" "}
                <code>ssh-add</code>.
              </p>
            ) : (
              <ul className="keyspanel-agentlist">
                {agent.keys.map((key) => (
                  <li className="keyspanel-agentkey" key={key.fingerprint}>
                    <span className="keyspanel-keytype">
                      {key.algorithm || "KEY"}
                      {isHardwareKey(key.algorithm) && (
                        <span
                          className="keyspanel-hwbadge"
                          title="Hardware-backed key — expect a touch prompt"
                        >
                          hw
                        </span>
                      )}
                    </span>
                    <span className="keyspanel-fingerprint">{key.fingerprint}</span>
                    <span className="keyspanel-comment">{key.comment}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Generate a key">
            <span className="keyspanel-eyebrow">Generate</span>
            <form
              className="keyspanel-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitGenerate();
              }}
            >
              <label className="keyspanel-field">
                <span className="keyspanel-label">Path</span>
                <input
                  className="keyspanel-input keyspanel-input--mono"
                  value={path}
                  spellCheck={false}
                  onChange={(event) => setPath(event.target.value)}
                />
              </label>
              <label className="keyspanel-field">
                <span className="keyspanel-label">Passphrase (optional)</span>
                <input
                  className="keyspanel-input"
                  type="password"
                  value={passphrase}
                  autoComplete="new-password"
                  placeholder="Stored in the Keychain"
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </label>
              <label className="keyspanel-field">
                <span className="keyspanel-label">Comment (optional)</span>
                <input
                  className="keyspanel-input"
                  value={comment}
                  placeholder="you@this-mac"
                  onChange={(event) => setComment(event.target.value)}
                />
              </label>
              <button
                className="keyspanel-generate"
                type="submit"
                disabled={generating || path.trim() === ""}
              >
                {generating ? "Generating…" : "Generate ed25519 key"}
              </button>
            </form>
            {keysError !== null && (
              <p className="keyspanel-error" role="alert">
                {keysError}
              </p>
            )}
            {publicKey !== null && (
              <div className="keyspanel-pubkey">
                <code className="keyspanel-pubkey-text">{publicKey}</code>
                <button
                  className="keyspanel-copy"
                  type="button"
                  onClick={() => void store.copyPublicKey()}
                >
                  Copy public key
                </button>
              </div>
            )}
          </section>

          <section aria-label="Install a key on a host">
            <span className="keyspanel-eyebrow">Install on a host</span>
            <p className="keyspanel-hint">
              Runs <code>ssh-copy-id</code> in a new terminal tab — you'll see every
              prompt (F8: never hidden).
            </p>
            <div className="keyspanel-copyid">
              <input
                className="keyspanel-input keyspanel-input--mono"
                value={effectiveCopyIdPath}
                aria-label="Public key file"
                spellCheck={false}
                onChange={(event) => setCopyIdPath(event.target.value)}
              />
              <select
                className="keyspanel-input"
                value={copyIdHostId}
                aria-label="Target host"
                onChange={(event) => setCopyIdHostId(event.target.value)}
              >
                <option value="">Pick a host…</option>
                {copyIdTargets.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.label}
                  </option>
                ))}
              </select>
              <button
                className="keyspanel-copyid-run"
                type="button"
                disabled={copyIdHost === undefined || effectiveCopyIdPath.trim() === ""}
                onClick={() => {
                  if (copyIdHost !== undefined) {
                    void store.runCopyId(copyIdHost, effectiveCopyIdPath.trim());
                  }
                }}
              >
                Run in terminal
              </button>
            </div>
          </section>

          <p className="keyspanel-footnote">
            Passwords and passphrases live in the macOS Keychain, used for SFTP only —
            interactive ssh stays agent-first.
          </p>
        </div>
      </aside>
    </div>
  );
}
