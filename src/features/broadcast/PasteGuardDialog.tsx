import "./PasteGuardDialog.css";
import { useEffect, useRef, useState } from "react";
import { useBroadcast } from "../../state/broadcast";

/**
 * The paste guard (F2): a risky paste — multi-line, or matching a
 * dangerous command pattern — never reaches any session silently. The
 * dialog shows the exact text, editable in place, with the reasons it was
 * stopped; a paste that would broadcast (F4) says how many sessions it
 * will hit in the confirm button. Esc or the scrim cancels.
 *
 * Phase 3 shipped this scoped to broadcast; Phase 4 replaced the detection
 * (`src/features/terminal/pasteGuard.ts`) and kept the dialog (§5 log).
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
  const broadcasting = pending.targetCount > 1;
  const title = broadcasting
    ? `Paste to ${pending.targetCount} sessions?`
    : "Review this paste";
  const confirmLabel = broadcasting
    ? `Paste to ${pending.targetCount} sessions`
    : "Paste";
  return (
    <div className="pasteguard-scrim" onMouseDown={cancel}>
      <div
        className="pasteguard"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            cancel();
          }
        }}
      >
        <h2 className="pasteguard-title">{title}</h2>
        {pending.reasons.length > 0 && (
          <ul className="pasteguard-reasons">
            {pending.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        <p className="pasteguard-hint">
          {broadcasting
            ? "Broadcast is armed — every line below goes to every armed pane. Edit it here first if needed."
            : "Exactly this text will be pasted. Edit it here first if needed."}
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
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
