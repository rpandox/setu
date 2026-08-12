/**
 * Ephemeral window chrome state (Phase 4): sidebar collapse and the command
 * palette overlay. Lives in a store — not component state — so keyboard
 * shortcuts and palette actions (`src/state/actions.ts`) can drive the same
 * toggles the components render. Deliberately not persisted: a fresh window
 * opens with the sidebar showing and no overlay.
 */

import { create } from "zustand";

/** Which palette surface is open: F11's ⌘K (commands) or ⌘T (hosts). */
export type PaletteMode = "commands" | "hosts";

/** Store shape + actions for window chrome. */
export interface UiChromeState {
  /** Whether the sidebar is collapsed to zero width (⌘/). */
  sidebarCollapsed: boolean;
  /** The open palette surface, or `null` when closed. */
  paletteMode: PaletteMode | null;
  /** Toggles the sidebar (⌘/). */
  toggleSidebar(): void;
  /**
   * Toggles the palette: opens `mode`, switches an open palette to `mode`,
   * closes it when already showing `mode` (matching the Phase 2 ⌘T toggle).
   */
  togglePalette(mode: PaletteMode): void;
  /** Closes the palette (Esc, scrim click, or after running an entry). */
  closePalette(): void;
}

/** The window-chrome store hook. */
export const useUiChrome = create<UiChromeState>((set) => ({
  sidebarCollapsed: false,
  paletteMode: null,

  toggleSidebar(): void {
    set((state) => ({ ...state, sidebarCollapsed: !state.sidebarCollapsed }));
  },

  togglePalette(mode: PaletteMode): void {
    set((state) => ({
      ...state,
      paletteMode: state.paletteMode === mode ? null : mode,
    }));
  },

  closePalette(): void {
    set((state) => (state.paletteMode === null ? state : { ...state, paletteMode: null }));
  },
}));
