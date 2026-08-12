/**
 * The "Setu Phosphor" terminal theme (PLAN.md §7), derived from the design
 * tokens in `src/styles/tokens.css` at runtime — no color literals here, so
 * the tokens file stays the single source of truth.
 */

import type { ITheme } from "@xterm/xterm";

/**
 * Reads one CSS custom property (e.g. `--neon`) and returns its value.
 *
 * Injectable so the mapping is testable without a DOM.
 */
export type TokenReader = (name: string) => string;

/**
 * Reads a token from the live document's root element.
 *
 * @param name - The custom property name, including the `--` prefix.
 * @returns The trimmed computed value.
 */
export function documentTokenReader(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Builds the xterm.js theme from the Phosphor tokens: background `--bg-0`,
 * foreground `--term-fg`, cursor `--neon` (per-host hues arrive with the SSH
 * phases), and the 16-color ANSI palette from the `--ansi-*` tokens.
 *
 * @param readToken - Token source; defaults to the live document.
 * @returns A theme object for the `Terminal` constructor.
 */
export function phosphorTheme(readToken: TokenReader = documentTokenReader): ITheme {
  return {
    background: readToken("--bg-0"),
    foreground: readToken("--term-fg"),
    cursor: readToken("--neon"),
    cursorAccent: readToken("--bg-0"),
    selectionBackground: readToken("--term-selection"),
    black: readToken("--ansi-black"),
    red: readToken("--ansi-red"),
    green: readToken("--ansi-green"),
    yellow: readToken("--ansi-yellow"),
    blue: readToken("--ansi-blue"),
    magenta: readToken("--ansi-magenta"),
    cyan: readToken("--ansi-cyan"),
    white: readToken("--ansi-white"),
    brightBlack: readToken("--ansi-bright-black"),
    brightRed: readToken("--ansi-bright-red"),
    brightGreen: readToken("--ansi-bright-green"),
    brightYellow: readToken("--ansi-bright-yellow"),
    brightBlue: readToken("--ansi-bright-blue"),
    brightMagenta: readToken("--ansi-bright-magenta"),
    brightCyan: readToken("--ansi-bright-cyan"),
    brightWhite: readToken("--ansi-bright-white"),
  };
}

/**
 * Terminal typography derived from the tokens: `--font-mono` and
 * `--text-base`.
 */
export interface TerminalTypography {
  /** Font stack for the terminal grid. */
  fontFamily: string;
  /** Font size in CSS pixels. */
  fontSize: number;
}

/**
 * Reads the terminal font settings from the tokens.
 *
 * @param readToken - Token source; defaults to the live document.
 * @returns Font family and pixel size for the `Terminal` constructor.
 */
export function terminalTypography(
  readToken: TokenReader = documentTokenReader,
): TerminalTypography {
  const base = Number.parseFloat(readToken("--text-base"));
  return {
    fontFamily: readToken("--font-mono"),
    fontSize: Number.isFinite(base) ? base : 13,
  };
}
