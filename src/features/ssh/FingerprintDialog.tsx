import "./FingerprintDialog.css";
import { useEffect, useRef } from "react";

/**
 * Splits an OpenSSH-style fingerprint (`"SHA256:base64…"`) into its hash
 * prefix and digest for display. Unprefixed strings come back with an
 * empty `hash` and the input as `digest`.
 *
 * @param fingerprint - The fingerprint string as ssh reports it.
 * @returns The hash name and the digest.
 * @example
 * ```ts
 * splitFingerprint("SHA256:abc"); // { hash: "SHA256", digest: "abc" }
 * ```
 */
export function splitFingerprint(fingerprint: string): { hash: string; digest: string } {
  const colon = fingerprint.indexOf(":");
  if (colon <= 0) return { hash: "", digest: fingerprint };
  return { hash: fingerprint.slice(0, colon), digest: fingerprint.slice(colon + 1) };
}

/** Props for {@link FingerprintDialog}. */
export interface FingerprintDialogProps {
  /** The host being connected to (its label, for the title). */
  hostLabel: string;
  /** The key algorithm, e.g. `"ssh-ed25519"`. */
  algorithm: string;
  /** The key fingerprint, e.g. `"SHA256:…"` — shown selectable, in mono. */
  fingerprint: string;
  /** Trusts the key: the caller appends it to `known_hosts`. */
  onTrust(): void;
  /** Rejects the key; nothing is written and the connection stops. */
  onCancel(): void;
}

/**
 * The host-key trust dialog (§7 component inventory, built in Phase 4 —
 * PLAN.md §5). Interactive ssh keeps its prompts in the terminal by
 * design; this dialog fronts the **SFTP** connection flow, which has no
 * terminal — Phase 5 wires it to the `hostkey:prompt` event. Until then
 * it is presentational and unreferenced.
 *
 * Keyboard-first: focus lands on Cancel (trusting a key is the deliberate
 * action, never the default), Esc cancels, Tab walks the buttons.
 *
 * @param props - {@link FingerprintDialogProps}
 * @returns The dialog element.
 */
export function FingerprintDialog({
  hostLabel,
  algorithm,
  fingerprint,
  onTrust,
  onCancel,
}: FingerprintDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const { hash, digest } = splitFingerprint(fingerprint);

  useEffect(() => {
    requestAnimationFrame(() => cancelRef.current?.focus());
  }, []);

  return (
    <div className="fingerprint-scrim" onMouseDown={onCancel}>
      <div
        className="fingerprint"
        role="dialog"
        aria-modal="true"
        aria-label={`Verify ${hostLabel}'s host key`}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 className="fingerprint-title">First connection to {hostLabel}</h2>
        <p className="fingerprint-hint">
          The host's identity can't be verified yet. Compare this fingerprint with one you
          got from the machine itself (for example{" "}
          <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on the host)
          before trusting it.
        </p>
        <dl className="fingerprint-key">
          <dt>Key</dt>
          <dd>{algorithm}</dd>
          <dt>{hash === "" ? "Fingerprint" : hash}</dt>
          <dd className="fingerprint-digest">{digest}</dd>
        </dl>
        <div className="fingerprint-actions">
          <button
            ref={cancelRef}
            className="fingerprint-cancel"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button className="fingerprint-trust" type="button" onClick={onTrust}>
            Trust this key
          </button>
        </div>
      </div>
    </div>
  );
}
