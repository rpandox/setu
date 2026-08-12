import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Minimal markdown for host notes (F1, Phase 4) — a tiny renderer for the
 * popover, safe by construction: it emits React elements only, never
 * HTML strings, so pasted `<script>` in a note renders as literal text.
 *
 * The subset (documented in `docs/features/F01-hosts.md`):
 * - `**bold**`, `*italic*`, and backtick code spans
 * - `[label](https://…)` links — http(s) only, opened in the system
 *   browser via the opener plugin
 * - `- ` bullet lists; everything else is a paragraph per line
 *
 * Deliberately no headings, images, raw HTML, or nesting — notes are a
 * few lines of "what is this box", not documents.
 */

/** Inline tokens: code first (its content is verbatim), then links, bold, italic. */
const INLINE =
  /(`[^`]+`)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)/g;

/**
 * Renders one line's inline markdown.
 *
 * @param line - The raw line.
 * @param keyPrefix - React key namespace for this line.
 * @returns The line's inline nodes.
 */
function renderInline(line: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(line)) !== null) {
    if (match.index > cursor) {
      nodes.push(line.slice(cursor, match.index));
    }
    const key = `${keyPrefix}:${index++}`;
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const label = token.slice(1, token.indexOf("]"));
      const url = match[3];
      nodes.push(
        <a
          key={key}
          href={url}
          onClick={(event) => {
            // The system browser owns external links, not the WebView.
            event.preventDefault();
            void openUrl(url).catch(() => undefined);
          }}
        >
          {label}
        </a>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    cursor = match.index + token.length;
  }
  if (cursor < line.length) {
    nodes.push(line.slice(cursor));
  }
  return nodes;
}

/**
 * Renders a note's markdown subset into React nodes.
 *
 * @param text - The raw note text.
 * @returns Paragraphs and bullet lists, ready to drop into the popover.
 * @example
 * ```tsx
 * <div>{renderMiniMarkdown("**prod** box\n- nginx\n- postgres")}</div>
 * ```
 */
export function renderMiniMarkdown(text: string): ReactNode[] {
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let bullets: ReactNode[] = [];

  const flushBullets = (key: string): void => {
    if (bullets.length === 0) return;
    blocks.push(<ul key={key}>{bullets}</ul>);
    bullets = [];
  };

  lines.forEach((line, i) => {
    const bullet = /^\s*-\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push(<li key={`li:${i}`}>{renderInline(bullet[1], `li:${i}`)}</li>);
      return;
    }
    flushBullets(`ul:${i}`);
    if (line.trim() === "") return;
    blocks.push(<p key={`p:${i}`}>{renderInline(line, `p:${i}`)}</p>);
  });
  flushBullets("ul:end");
  return blocks;
}
