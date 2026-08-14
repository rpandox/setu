/**
 * Hot-apply wiring (Phase 8, main window only): watches the settings
 * store and pushes changes onto running machinery — terminal options onto
 * every live xterm instance, prober re-tunes onto the reach loop. Lives
 * in its own module (not the settings store) so the store never imports
 * terminal code and the dependency graph stays a tree — the
 * `wireBroadcastHousekeeping` precedent.
 */

import { ipcInvoke } from "../../ipc/client";
import { applyTerminalOptions } from "../terminal/registry";
import { useSettings } from "../../state/settings";

/**
 * Subscribes hot-apply to settings changes — call once at main-window
 * startup, after `initSettings`. Terminal font/scrollback changes reach
 * every open terminal immediately (the F10 acceptance item); reachability
 * changes restart the prober with the new knobs (`reach_start` re-reads
 * the saved settings and re-tunes the running loop) or stop it when the
 * kill switch flips off.
 *
 * @returns The unsubscribe function (tests; the app never unwires).
 */
export function wireSettingsHotApply(): () => void {
  return useSettings.subscribe((state, prev) => {
    if (state.doc === prev.doc) return;
    const next = state.doc.terminal;
    const before = prev.doc.terminal;
    if (
      next.font_size !== before.font_size ||
      next.scrollback_lines !== before.scrollback_lines ||
      !prev.loaded
    ) {
      applyTerminalOptions({
        fontSize: next.font_size,
        scrollback: next.scrollback_lines,
      });
    }
    const reach = state.doc.reachability;
    const reachBefore = prev.doc.reachability;
    const reachChanged =
      reach.enabled !== reachBefore.enabled ||
      reach.interval_s !== reachBefore.interval_s ||
      reach.timeout_ms !== reachBefore.timeout_ms ||
      reach.max_concurrent !== reachBefore.max_concurrent;
    if (reachChanged && prev.loaded) {
      const command = reach.enabled ? "reach_start" : "reach_stop";
      void ipcInvoke(command, {}).catch(() => {
        // The prober will pick the new knobs up on its next natural start.
      });
    }
  });
}
