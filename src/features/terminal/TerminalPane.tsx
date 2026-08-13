import { useEffect, useRef, type ClipboardEvent } from "react";
import { getSessionTerminal } from "./registry";
import { classifyPaste } from "./pasteGuard";
import { resolvePtyWriteTargets, useBroadcast } from "../../state/broadcast";

/** Props for {@link TerminalPane}. */
export interface TerminalPaneProps {
  /** The session whose terminal this pane hosts. */
  sessionId: string;
  /** Whether this pane is the visible, focused pane. */
  active: boolean;
}

/**
 * Hosts one session's xterm instance. The terminal itself lives in the
 * registry; this component only attaches it to the DOM on first mount and
 * keeps it fitted — on container resizes (coalesced to animation frames)
 * and on pane activation (fit + focus).
 *
 * Pastes are inspected here, in the DOM capture phase *before* xterm sees
 * them (xterm normalizes newlines, so `onData` can't tell a multi-line
 * paste from typing): multi-line or dangerous-pattern pastes stop at the
 * F2 guard dialog on every pane — with the "N sessions" warning when the
 * pane is broadcasting (F4). Single-line safe pastes flow through
 * untouched.
 *
 * @param props - {@link TerminalPaneProps}
 * @returns The pane element the terminal renders into.
 */
export function TerminalPane({ sessionId, active }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  /**
   * Guards risky pastes (F2 patterns; F4 fan-out count).
   *
   * @param event - The DOM paste event, capture phase.
   */
  const onPasteCapture = (event: ClipboardEvent<HTMLDivElement>): void => {
    const text = event.clipboardData?.getData("text") ?? "";
    const { verdict, reasons } = classifyPaste(text);
    if (verdict === "safe") return;
    const targets = resolvePtyWriteTargets(sessionId, { silent: true });
    event.preventDefault();
    event.stopPropagation();
    useBroadcast.getState().requestPasteGuard({
      sessionId,
      text,
      targetCount: targets.length,
      reasons,
    });
  };

  useEffect(() => {
    const handle = getSessionTerminal(sessionId);
    const container = containerRef.current;
    if (!handle || !container) return;
    handle.open(container);

    let fitQueued = false;
    const observer = new ResizeObserver(() => {
      // Coalesce bursts (live window drags) to one fit per frame.
      if (fitQueued) return;
      fitQueued = true;
      requestAnimationFrame(() => {
        fitQueued = false;
        // The handle may be gone if the tab closed mid-frame.
        getSessionTerminal(sessionId)?.fit.fit();
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [sessionId]);

  useEffect(() => {
    if (!active) return;
    const handle = getSessionTerminal(sessionId);
    handle?.fit.fit();
    // Deferred for the same WKWebView reason as in the registry's open():
    // a focus() inside the commit can silently not take.
    const frame = requestAnimationFrame(() => {
      getSessionTerminal(sessionId)?.term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, sessionId]);

  return (
    <div ref={containerRef} className="terminal-pane" onPasteCapture={onPasteCapture} />
  );
}
