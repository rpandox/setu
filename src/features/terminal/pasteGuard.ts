/**
 * Paste classification (F2, Phase 4) — the #1 defense against clipboard
 * disasters. Phase 3 shipped the guard dialog for multi-line broadcast
 * pastes; this module is the full detection logic behind it, applied to
 * **every** pane: multi-line pastes (each line would execute on landing)
 * and single lines carrying dangerous command patterns stop at the
 * preview; single-line safe pastes go straight through.
 *
 * Detection is deliberately conservative about false positives — `sudo`
 * and `rm` must sit in command position (line start or after `|`, `;`,
 * `&&`, `$(`), so prose like "reforms" or a URL mentioning sudo pastes
 * clean. The user can always edit in the dialog before pasting, and the
 * guarded paste goes through the terminal's normal paste path (bracketed
 * paste included) once confirmed.
 */

/** Command-position prefix: line start, a pipe/separator, or `$(`. */
const CMD = String.raw`(?:^|[|;&]\s*|\$\(\s*)`;

/** One detection rule: a pattern and the reason shown in the dialog. */
interface GuardRule {
  /** Matches dangerous text (applied per whole paste, `m` = per line). */
  pattern: RegExp;
  /** Human-readable reason, shown in the guard dialog. */
  reason: string;
}

/** The F2 danger patterns (checked case-insensitively, per line). */
const RULES: GuardRule[] = [
  {
    pattern: new RegExp(`${CMD}sudo\\s`, "im"),
    reason: "Runs sudo",
  },
  {
    // rm in command position (a sudo/doas prefix still counts) with -r/-f
    // anywhere in its flags.
    pattern: new RegExp(
      `${CMD}(?:sudo\\s+|doas\\s+)?rm\\s+(?:-{1,2}[^\\s]*\\s+)*-{1,2}[^\\s]*[rf]`,
      "im",
    ),
    reason: "Contains a destructive rm",
  },
  {
    // A download piped into any shell (optionally via sudo).
    pattern: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|fi)?sh\b/i,
    reason: "Pipes a download into a shell",
  },
  {
    pattern: new RegExp(`${CMD}(?:mkfs\\b|dd\\s[^|;&\\n]*\\bof=/dev/)`, "im"),
    reason: "Writes to a raw device or formats a filesystem",
  },
];

/** What {@link classifyPaste} decided about a clipboard payload. */
export interface PasteVerdict {
  /** `"safe"` pastes go straight through; `"guard"` opens the preview. */
  verdict: "safe" | "guard";
  /** Why the paste was guarded, in display order; empty when safe. */
  reasons: string[];
}

/**
 * Classifies clipboard text against the F2 guard rules: any newline
 * (including a trailing one — that would *execute* the line on landing),
 * or any line matching a danger pattern.
 *
 * @param text - The raw clipboard text, before xterm normalizes newlines.
 * @returns The verdict plus human-readable reasons.
 * @example
 * ```ts
 * classifyPaste("ls -la").verdict; // "safe"
 * classifyPaste("curl https://x.sh | sh").verdict; // "guard"
 * ```
 */
export function classifyPaste(text: string): PasteVerdict {
  const reasons: string[] = [];
  if (/[\r\n]/.test(text)) {
    reasons.push("Pastes more than one line");
  }
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      reasons.push(rule.reason);
    }
  }
  return { verdict: reasons.length > 0 ? "guard" : "safe", reasons };
}
