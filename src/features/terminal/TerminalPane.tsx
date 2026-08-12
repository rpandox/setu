import { useEffect, useRef, type ClipboardEvent } from "react";
import { getSessionTerminal } from "./registry";
import {
  pasteNeedsGuard,
  resolvePtyWriteTargets,
  useBroadcast,
} from "../../state/broadcast";

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
 * paste from typing): a multi-line paste that would broadcast to several
 * sessions is stopped and routed through the F4 paste-guard dialog.
 * Everything else flows through untouched.
 *
 * @param props - {@link TerminalPaneProps}
 * @returns The pane element the terminal renders into.
 */
export function TerminalPane({ sessionId, active }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  /**
   * Guards multi-line pastes that would fan out (F4).
   *
   * @param event - The DOM paste event, capture phase.
   */
  const onPasteCapture = (event: ClipboardEvent<HTMLDivElement>): void => {
    const text = event.clipboardData?.getData("text") ?? "";
    if (!pasteNeedsGuard(text)) return;
    const targets = resolvePtyWriteTargets(sessionId, { silent: true });
    if (targets.length <= 1) return; // Not broadcasting: Phase 4 owns this path.
    event.preventDefault();
    event.stopPropagation();
    useBroadcast.getState().requestPasteGuard({
      sessionId,
      text,
      targetCount: targets.length,
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
