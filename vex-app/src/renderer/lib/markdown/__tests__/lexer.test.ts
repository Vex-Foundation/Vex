/**
 * The shared markdown lexer: GFM, except that strikethrough needs `~~`.
 * A single `~` ("approximately" in an assistant reply) stays literal text.
 */

import type { Token } from "marked";
import { describe, expect, it } from "vitest";

import { lexMarkdown } from "../lexer.js";
import { extractMarkdownPlainText } from "../plain-text.js";

function struck(tokens: readonly Token[], out: string[] = []): string[] {
  for (const token of tokens) {
    if (token.type === "del") out.push(token.text);
    if ("tokens" in token && Array.isArray(token.tokens)) struck(token.tokens, out);
  }
  return out;
}

describe("lexMarkdown", () => {
  it("keeps two approximate amounts as text instead of striking between them", () => {
    const reply = "the pools agree within ~$3 of each other (~$45M combined), so the quote holds";
    expect(struck(lexMarkdown(reply))).toEqual([]);
    expect(extractMarkdownPlainText(reply)).toBe(reply);
  });

  it("leaves a single-tilde pair literal", () => {
    expect(struck(lexMarkdown("a ~single~ pair and a ~5-10~ range"))).toEqual([]);
    expect(extractMarkdownPlainText("a ~single~ pair")).toBe("a ~single~ pair");
  });

  it("still strikes through double-tilde text", () => {
    expect(struck(lexMarkdown("this is ~~gone~~ now"))).toEqual(["gone"]);
    expect(extractMarkdownPlainText("this is ~~gone~~ now")).toBe("this is gone now");
  });

  it("still strikes through double-tilde text next to a single tilde", () => {
    expect(struck(lexMarkdown("~$3 is ~~wrong~~ right"))).toEqual(["wrong"]);
  });

  it("leaves tildes inside code untouched", () => {
    const tokens = lexMarkdown("code `~x~` stays\n\n~~~\n~a~\n~~~");
    expect(struck(tokens)).toEqual([]);
    expect(tokens.some((t) => t.type === "code" && t.text === "~a~")).toBe(true);
  });

  it("keeps the rest of GFM", () => {
    const tokens = lexMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n**bold**");
    expect(tokens.map((t) => t.type).filter((t) => t !== "space")).toEqual(["table", "list", "paragraph"]);
  });
});
