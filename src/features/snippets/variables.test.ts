// The variable engine is pure: extraction grammar, prompt assembly, and
// substitution — including the F6 abort-on-unresolved contract.
import { describe, expect, it } from "vitest";
import type { Snippet } from "../../ipc/contract";
import { extractTokens, initialValues, promptsFor, resolveCommand } from "./variables";

/**
 * A snippet fixture with the given command and variable declarations.
 *
 * @param command - The command template.
 * @param variables - Variable declarations.
 * @returns The snippet.
 */
function snippet(command: string, variables: Snippet["variables"] = []): Snippet {
  return { id: "s1", label: "test", command, tags: [], variables };
}

describe("extractTokens", () => {
  it("extracts tokens in order of first appearance, deduplicated", () => {
    expect(extractTokens("a {{x}} b {{y}} c {{x}}")).toEqual({
      tokens: ["x", "y"],
      error: null,
    });
  });

  it("returns no tokens for a plain command", () => {
    expect(extractTokens("uptime")).toEqual({ tokens: [], error: null });
  });

  it("reports an unclosed token", () => {
    expect(extractTokens("echo {{oops").error).toContain("without a matching");
  });

  it("reports an empty token", () => {
    expect(extractTokens("echo {{}}").error).toContain("empty");
  });
});

describe("promptsFor", () => {
  it("merges command order with declared defaults and choices", () => {
    const prompts = promptsFor(
      snippet("deploy {{env}} {{tag}}", [
        { name: "tag", default: "latest" },
        { name: "env", choices: ["staging", "prod"], default: "staging" },
      ]),
    );
    expect(prompts).toEqual([
      { name: "env", default: "staging", choices: ["staging", "prod"] },
      { name: "tag", default: "latest", choices: undefined },
    ]);
  });

  it("prompts undeclared tokens as plain inputs", () => {
    expect(promptsFor(snippet("ping {{host}}"))).toEqual([
      { name: "host", default: undefined, choices: undefined },
    ]);
  });

  it("is empty for a token-free command", () => {
    expect(promptsFor(snippet("uptime"))).toEqual([]);
  });
});

describe("resolveCommand", () => {
  it("substitutes every occurrence of a token", () => {
    expect(resolveCommand("echo {{x}} and {{x}} then {{y}}", { x: "1", y: "2" })).toEqual(
      { command: "echo 1 and 1 then 2", missing: [] },
    );
  });

  it("reports absent values as missing", () => {
    const { missing } = resolveCommand("journalctl -u {{service}} -f", {});
    expect(missing).toEqual(["service"]);
  });

  it("treats blank values as missing (unresolved aborts the run)", () => {
    const { missing } = resolveCommand("journalctl -u {{service}} -f", {
      service: "   ",
    });
    expect(missing).toEqual(["service"]);
  });

  it("leaves unresolved tokens literal so previews stay honest", () => {
    const { command } = resolveCommand("a {{x}} {{y}}", { x: "1" });
    expect(command).toBe("a 1 {{y}}");
  });
});

describe("initialValues", () => {
  it("seeds defaults and empty strings", () => {
    expect(
      initialValues([
        { name: "env", default: "staging", choices: ["staging", "prod"] },
        { name: "tag" },
      ]),
    ).toEqual({ env: "staging", tag: "" });
  });
});
