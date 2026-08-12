import "./PasteGuardDialog.css";
import { useEffect, useRef, useState } from "react";
import { useBroadcast } from "../../state/broadcast";

/**
 * The broadcast paste guard (F4): a multi-line paste while broadcasting
 * never reaches any session silently. The dialog shows the exact text —
 * editable in place — with the session count in the confirm button, so
 * what lands where is never a surprise. Esc or the scrim cancels.
 *
 * This is the minimal Phase 3 version scoped to the broadcast path; the
 * full F2 paste guard (dangerous-pattern detection, single-pane pastes)
 * extends it in Phase 4 (§5 decision log).
 *
 * @returns The dialog, or nothing when no paste is pending.
 */
export function PasteGuardDialog() {
  const pending = useBroadcast((s) => s.pendingPaste);
  const cancel = useBroadcast((s) => s.cancelPasteGuard);
  const confirm = useBroadcast((s) => s.confirmPasteGuard);
  const [text, setText] = useState("");
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setText(pending?.text ?? "");
    // Focus the confirm button so Esc/⏎ work immediately — the paste was a
    // keyboard action and the guard must stay on the keyboard.
    if (pending) requestAnimationFrame(() => confirmRef.current?.focus());
  }, [pending]);

  if (!pending) return null;
  return (
    <div className="pasteguard-scrim" onMouseDown={cancel}>
      <div
        className="pasteguard"
        role="dialog"
        aria-modal="true"
        aria-label={`Paste to ${pending.targetCount} sessions`}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            cancel();
          }
        }}
      >
        <h2 className="pasteguard-title">Paste to {pending.targetCount} sessions?</h2>
        <p className="pasteguard-hint">
          Broadcast is armed — every line below goes to every armed pane. Edit it here
          first if needed.
        </p>
        <textarea
          className="pasteguard-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          rows={Math.min(12, Math.max(3, text.split("\n").length))}
        />
        <div className="pasteguard-actions">
          <button className="pasteguard-cancel" type="button" onClick={cancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            className="pasteguard-confirm"
            type="button"
            onClick={() => confirm(text)}
          >
            Paste to {pending.targetCount} sessions
          </button>
        </div>
      </div>
    </div>
  );
}
