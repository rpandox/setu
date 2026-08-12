// The theme derives every color from tokens — this pins the token names so
// a tokens.css rename can't silently detach the terminal from the system.
import { describe, expect, it } from "vitest";
import { phosphorTheme, terminalTypography } from "./theme";

const readToken = (name: string) => `token(${name})`;

describe("phosphorTheme", () => {
  const theme = phosphorTheme(readToken);

  it("maps chrome colors to the §7 tokens", () => {
    expect(theme.background).toBe("token(--bg-0)");
    expect(theme.foreground).toBe("token(--term-fg)");
    expect(theme.cursor).toBe("token(--neon)");
    expect(theme.cursorAccent).toBe("token(--bg-0)");
    expect(theme.selectionBackground).toBe("token(--term-selection)");
  });

  it.each([
    ["black", "--ansi-black"],
    ["red", "--ansi-red"],
    ["green", "--ansi-green"],
    ["yellow", "--ansi-yellow"],
    ["blue", "--ansi-blue"],
    ["magenta", "--ansi-magenta"],
    ["cyan", "--ansi-cyan"],
    ["white", "--ansi-white"],
    ["brightBlack", "--ansi-bright-black"],
    ["brightRed", "--ansi-bright-red"],
    ["brightGreen", "--ansi-bright-green"],
    ["brightYellow", "--ansi-bright-yellow"],
    ["brightBlue", "--ansi-bright-blue"],
    ["brightMagenta", "--ansi-bright-magenta"],
    ["brightCyan", "--ansi-bright-cyan"],
    ["brightWhite", "--ansi-bright-white"],
  ] as const)("maps ANSI %s to %s", (field, token) => {
    expect(theme[field]).toBe(`token(${token})`);
  });
});

describe("terminalTypography", () => {
  it("parses the pixel size and passes the mono stack through", () => {
    const typography = terminalTypography((name) =>
      name === "--text-base" ? "13px" : "Mono, monospace",
    );
    expect(typography.fontSize).toBe(13);
    expect(typography.fontFamily).toBe("Mono, monospace");
  });

  it("falls back to 13px when the token is unparsable", () => {
    expect(terminalTypography(() => "").fontSize).toBe(13);
  });
});
