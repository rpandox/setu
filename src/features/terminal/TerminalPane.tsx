import { useEffect, useRef } from "react";
import { getSessionTerminal } from "./registry";

/** Props for {@link TerminalPane}. */
export interface TerminalPaneProps {
  /** The session whose terminal this pane hosts. */
  sessionId: string;
  /** Whether this pane is the visible, focused tab. */
  active: boolean;
}

/**
 * Hosts one session's xterm instance. The terminal itself lives in the
 * registry; this component only attaches it to the DOM on first mount and
 * keeps it fitted — on container resizes (coalesced to animation frames)
 * and on tab activation (fit + focus).
 *
 * @param props - {@link TerminalPaneProps}
 * @returns The pane element the terminal renders into.
 */
export function TerminalPane({ sessionId, active }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

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

  return <div ref={containerRef} className="terminal-pane" />;
}
