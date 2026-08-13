/**
 * The snippet variable engine (F6) — pure functions over `{{var}}` command
 * templates: token extraction, prompt assembly, and substitution. No React,
 * no IPC, no stores, so the same engine serves the SnippetRunDialog today
 * and the Phase 12 runbook runner later.
 *
 * There is no escaping: a literal `{{` cannot appear in a snippet command
 * (PLAN.md §5, Phase 6 row). The backend enforces the same grammar on save
 * (`snippets.rs`); this module re-derives it for live editor feedback and
 * run-time resolution.
 */

import type { Snippet, SnippetVariable } from "../../ipc/contract";

/** Result of {@link extractTokens}. */
export interface TokenExtraction {
  /** Token names in order of first appearance, deduplicated. */
  tokens: string[];
  /** The parse problem, or `null` when the command is well-formed. */
  error: string | null;
}

/**
 * Extracts the `{{var}}` token names from a command, in order of first
 * appearance, deduplicated. Mirrors `extract_tokens` in `snippets.rs`.
 *
 * @param command - The command template.
 * @returns The tokens, or a parse error for an unclosed `{{` / empty `{{}}`.
 * @example
 * ```ts
 * extractTokens("journalctl -u {{service}} -f");
 * // → { tokens: ["service"], error: null }
 * ```
 */
export function extractTokens(command: string): TokenExtraction {
  const tokens: string[] = [];
  let rest = command;
  for (let open = rest.indexOf("{{"); open !== -1; open = rest.indexOf("{{")) {
    const after = rest.slice(open + 2);
    const close = after.indexOf("}}");
    if (close === -1) {
      return { tokens, error: "`{{` without a matching `}}`" };
    }
    const name = after.slice(0, close);
    if (name.trim() === "") {
      return { tokens, error: "empty `{{}}` token" };
    }
    if (!tokens.includes(name)) {
      tokens.push(name);
    }
    rest = after.slice(close + 2);
  }
  return { tokens, error: null };
}

/** One prompt row in the SnippetRunDialog. */
export interface VariablePrompt {
  /** The variable's name (the `{{token}}`). */
  name: string;
  /** Pre-filled value; `undefined` means an empty input. */
  default?: string;
  /** When present, the prompt renders a select over these values. */
  choices?: string[];
}

/**
 * Builds the run dialog's prompt list for a snippet: one row per distinct
 * command token, in command order, carrying that variable's declared
 * default and choices. Tokens without a declaration (possible only for
 * drafts that bypassed validation) prompt as plain text inputs.
 *
 * @param snippet - The snippet about to run.
 * @returns Prompt rows in command order; empty when the command has no tokens.
 */
export function promptsFor(snippet: Snippet): VariablePrompt[] {
  const { tokens } = extractTokens(snippet.command);
  return tokens.map((name) => {
    const declared: SnippetVariable | undefined = snippet.variables.find(
      (v) => v.name === name,
    );
    return {
      name,
      default: declared?.default,
      choices: declared?.choices,
    };
  });
}

/** Result of {@link resolveCommand}. */
export interface CommandResolution {
  /** The command with every token substituted. */
  command: string;
  /**
   * Tokens still unresolved — no value, or a blank one. Non-empty means the
   * run must abort (F6: unresolved variables never reach a shell).
   */
  missing: string[];
}

/**
 * Substitutes variable values into a command template. A value that is
 * absent or blank (after trimming) leaves its token unresolved — the F6
 * edge case that aborts the run before anything executes.
 *
 * @param command - The command template.
 * @param values - Variable values keyed by name.
 * @returns The resolved command and any unresolved token names.
 * @example
 * ```ts
 * resolveCommand("journalctl -u {{service}} -f", { service: "sshd" });
 * // → { command: "journalctl -u sshd -f", missing: [] }
 * ```
 */
export function resolveCommand(
  command: string,
  values: Record<string, string>,
): CommandResolution {
  const { tokens } = extractTokens(command);
  const missing = tokens.filter((name) => (values[name] ?? "").trim() === "");
  let resolved = command;
  for (const name of tokens) {
    const value = values[name];
    if (value !== undefined && value.trim() !== "") {
      resolved = resolved.split(`{{${name}}}`).join(value);
    }
  }
  return { command: resolved, missing };
}

/**
 * The initial dialog values for a snippet's prompts: declared defaults where
 * present, empty strings otherwise.
 *
 * @param prompts - The prompt rows from {@link promptsFor}.
 * @returns Values keyed by variable name.
 */
export function initialValues(prompts: VariablePrompt[]): Record<string, string> {
  return Object.fromEntries(prompts.map((p) => [p.name, p.default ?? ""]));
}
