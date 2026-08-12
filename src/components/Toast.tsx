import "./Toast.css";
import { useEffect } from "react";
import { useToast } from "../state/toast";

/** How long a toast stays up before auto-dismissing. */
const TOAST_MS = 3000;

/**
 * The single app toast (minimal Phase 3 version — see the §5 decision log):
 * a quiet bottom-center notice that auto-dismisses, used by broadcast to
 * report skipped dead panes (F4). Click dismisses early.
 *
 * @returns The toast element, or nothing when no message is showing.
 */
export function Toast() {
  const message = useToast((s) => s.message);
  const seq = useToast((s) => s.seq);
  const clear = useToast((s) => s.clear);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(clear, TOAST_MS);
    return () => clearTimeout(timer);
  }, [message, seq, clear]);

  if (!message) return null;
  return (
    <button className="toast" type="button" role="status" onClick={clear}>
      {message}
    </button>
  );
}
