import "./Toast.css";
import { useEffect } from "react";
import { useToast } from "../state/toast";

/** How long a toast stays up before auto-dismissing. */
const TOAST_MS = 3000;

/**
 * The single app toast: a quiet bottom-center notice that auto-dismisses
 * after a few seconds; click dismisses early. Variants tint the leading
 * edge — info (default), success, error — without shouting (§7: color is
 * status, glow stays on its three legal uses). The fade-in respects
 * `prefers-reduced-motion`.
 *
 * @returns The toast element, or nothing when no message is showing.
 */
export function Toast() {
  const message = useToast((s) => s.message);
  const variant = useToast((s) => s.variant);
  const seq = useToast((s) => s.seq);
  const clear = useToast((s) => s.clear);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(clear, TOAST_MS);
    return () => clearTimeout(timer);
  }, [message, seq, clear]);

  if (!message) return null;
  return (
    <button
      className={`toast toast--${variant}`}
      type="button"
      role="status"
      onClick={clear}
    >
      {message}
    </button>
  );
}
