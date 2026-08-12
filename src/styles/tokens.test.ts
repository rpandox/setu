// Guards the token contract: the required Phosphor tokens exist, and no
// component smuggles in a color literal (the CI grep gate, as a unit test).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(stylesDir, "..");
const tokensCss = readFileSync(path.join(stylesDir, "tokens.css"), "utf8");

const REQUIRED_TOKENS = [
  "--bg-0",
  "--bg-1",
  "--bg-2",
  "--bg-3",
  "--line",
  "--line-strong",
  "--ink-1",
  "--ink-2",
  "--ink-3",
  "--neon",
  "--neon-ink",
  "--glow",
  "--ok",
  "--warn",
  "--err",
  "--info",
  "--hue-0",
  "--hue-1",
  "--hue-2",
  "--hue-3",
  "--hue-4",
  "--hue-5",
  "--hue-6",
  "--hue-7",
  "--font-ui",
  "--font-mono",
  "--font-display",
  "--r-1",
  "--r-2",
  "--pad",
  "--t-fast",
  "--t-med",
];

/** Matches hex and functional color notation literals. */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;

/**
 * Recursively collects files under `dir` with the given extensions.
 *
 * @param dir - Directory to walk.
 * @param exts - File extensions to keep (with dot).
 * @returns Absolute file paths.
 */
function collectFiles(dir: string, exts: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(full, exts);
    return exts.includes(path.extname(entry.name)) ? [full] : [];
  });
}

describe("tokens.css", () => {
  it.each(REQUIRED_TOKENS)("defines %s", (token) => {
    expect(tokensCss).toMatch(new RegExp(`${token}\\s*:`));
  });
});

describe("token discipline", () => {
  // tokens.css defines the colors; this test file matches them by design.
  const EXCLUDED = [
    path.join("styles", "tokens.css"),
    path.join("styles", "tokens.test.ts"),
  ];
  const files = collectFiles(srcDir, [".css", ".ts", ".tsx"]).filter(
    (file) => !EXCLUDED.includes(path.relative(srcDir, file)),
  );

  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [path.relative(srcDir, file), file]))(
    "%s has no color literals",
    (_rel, file) => {
      const lines = readFileSync(file, "utf8").split("\n");
      const offending = lines.filter((line) => COLOR_LITERAL.test(line));
      expect(offending).toEqual([]);
    },
  );
});
