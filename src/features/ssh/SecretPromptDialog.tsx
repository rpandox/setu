import "./SecretPromptDialog.css";
import { useEffect, useRef, useState } from "react";
import type { SftpNeedsSecret } from "../../ipc/contract";

/** Props for {@link SecretPromptDialog}. */
export interface SecretPromptDialogProps {
  /** The host being connected to (its label, for the title). */
  hostLabel: string;
  /** What stopped the auth ladder — kind, key path, and the reason line. */
  prompt: SftpNeedsSecret;
  /**
   * Called with the typed secret; the caller stores it in the Keychain
   * (`keychain_set`) and retries the connect. The dialog never keeps it.
   */
  onSubmit(secret: string): void;
  /** Closes without storing; the connect fails with the prompt's detail. */
  onCancel(): void;
}

/**
 * The Keychain secret prompt (F8, Phase 7): SFTP auth stopped at a
 * password or key passphrase the Keychain doesn't hold. One field, one
 * store-and-retry button — the secret goes straight to the Keychain and
 * is used for SFTP only (terminal ssh stays agent-first by design).
 *
 * Keyboard-first like its sibling dialogs (FingerprintDialog): the field
 * autofocuses, ⏎ submits, Esc cancels.
 *
 * @param props - {@link SecretPromptDialogProps}
 * @returns The dialog element.
 */
export function SecretPromptDialog({
  hostLabel,
  prompt,
  onSubmit,
  onCancel,
}: SecretPromptDialogProps) {
  const [secret, setSecret] = useState("");
  const fieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => fieldRef.current?.focus());
  }, []);

  const title =
    prompt.kind === "password"
      ? `SFTP password for ${hostLabel}`
      : `Passphrase for ${prompt.keyPath ?? "the key"}`;

  const submit = (): void => {
    if (secret !== "") onSubmit(secret);
  };

  return (
    <div className="secretprompt-scrim" onMouseDown={onCancel}>
      <div
        className="secretprompt"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 className="secretprompt-title">{title}</h2>
        <p className="secretprompt-detail">
          {prompt.detail} It will be stored in the macOS Keychain — never on disk — and
          used for SFTP only.
        </p>
        <input
          ref={fieldRef}
          className="secretprompt-field"
          type="password"
          value={secret}
          autoComplete="off"
          aria-label={prompt.kind === "password" ? "SFTP password" : "Key passphrase"}
          onChange={(event) => setSecret(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
        <div className="secretprompt-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="secretprompt-confirm"
            type="button"
            disabled={secret === ""}
            onClick={submit}
          >
            Store &amp; connect
          </button>
        </div>
      </div>
    </div>
  );
}
