// The notes renderer (F1, Phase 4): subset coverage and — critically —
// safety: input is never interpreted as HTML.
import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderMiniMarkdown } from "./miniMarkdown";

/**
 * Narrows a node to a ReactElement, failing the test otherwise.
 *
 * @param node - The node to narrow.
 */
function el(node: ReactNode): ReactElement {
  if (!isValidElement(node)) throw new Error(`expected an element, got ${String(node)}`);
  return node;
}

/**
 * The element's children as an array.
 *
 * @param element - The element.
 */
function childrenOf(element: ReactElement): ReactNode[] {
  const children = (element.props as { children?: ReactNode | ReactNode[] }).children;
  return Array.isArray(children) ? children : [children];
}

describe("renderMiniMarkdown", () => {
  it("renders paragraphs and drops blank lines", () => {
    const blocks = renderMiniMarkdown("first\n\nsecond");
    expect(blocks).toHaveLength(2);
    expect(el(blocks[0]).type).toBe("p");
    expect(el(blocks[1]).type).toBe("p");
  });

  it("renders bold, italic, and code inline", () => {
    const [p] = renderMiniMarkdown("**prod** *box* with `nginx`");
    const kinds = childrenOf(el(p))
      .filter((n): n is ReactElement => isValidElement(n))
      .map((n) => n.type);
    expect(kinds).toEqual(["strong", "em", "code"]);
  });

  it("groups bullets into one list", () => {
    const blocks = renderMiniMarkdown("services:\n- nginx\n- postgres\ndone");
    expect(blocks.map((b) => el(b).type)).toEqual(["p", "ul", "p"]);
    expect(childrenOf(el(blocks[1]))).toHaveLength(2);
  });

  it("renders http(s) links as anchors with the url as href", () => {
    const [p] = renderMiniMarkdown("[runbook](https://wiki.example.com/db)");
    const a = el(childrenOf(el(p))[0]);
    expect(a.type).toBe("a");
    expect((a.props as { href: string }).href).toBe("https://wiki.example.com/db");
  });

  it("never interprets HTML — script tags render as literal text", () => {
    const [p] = renderMiniMarkdown('<script>alert("x")</script>');
    const children = childrenOf(el(p));
    expect(children).toEqual(['<script>alert("x")</script>']);
  });

  it("ignores non-http link schemes", () => {
    const [p] = renderMiniMarkdown("[boom](javascript:alert(1))");
    // The token doesn't match the http(s)-only pattern, so it stays text.
    const children = childrenOf(el(p));
    expect(children.every((c) => typeof c === "string")).toBe(true);
  });
});
