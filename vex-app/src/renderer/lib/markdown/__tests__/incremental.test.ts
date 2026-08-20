/**
 * The incremental lexer's stream invariants: frozen blocks never re-lex,
 * keys stay stable across the freeze boundary, and non-append input resets
 * the generation instead of serving a stale prefix.
 */

import { lexer, type Token } from "marked";
import { describe, expect, it, vi } from "vitest";
import { IncrementalMarkdownLexer } from "../incremental.js";

function makeParser() {
  const lex = vi.fn((text: string): readonly Token[] => lexer(text));
  return { parser: new IncrementalMarkdownLexer(lex), lex };
}

/** Concatenated raws of a result, in order — must reconstruct the source. */
function reassemble(result: {
  frozen: readonly { token: Token }[];
  tail: readonly { token: Token }[];
}): string {
  return [...result.frozen, ...result.tail]
    .map((b) => b.token.raw)
    .join("");
}

describe("IncrementalMarkdownLexer freezes settled blocks and re-lexes only the tail", () => {
  it("keeps every block in the tail while the document has at most the unstable count", () => {
    const { parser } = makeParser();
    // 2 content blocks = UNSTABLE_TAIL_BLOCKS: exactly at the seam, nothing
    // freezes (the interleaved "space" token rides along in the tail).
    const r = parser.update("one\n\ntwo");
    expect(r.frozen).toEqual([]);
    expect(reassemble(r)).toBe("one\n\ntwo");
  });

  it("freezes the first block once a third begins (one past the seam)", () => {
    const { parser } = makeParser();
    const r = parser.update("one\n\ntwo\n\nthree");
    // Frozen = paragraph "one" + its trailing space token (2 tokens, 1 block).
    expect(r.frozen.length).toBe(2);
    expect(r.frozen.filter((b) => b.token.type !== "space").length).toBe(1);
    expect(reassemble(r)).toBe("one\n\ntwo\n\nthree");
  });

  it("never re-lexes a frozen source region: the lexed slice shrinks to the tail", () => {
    const { parser, lex } = makeParser();
    parser.update("one\n\ntwo\n\nthree");
    lex.mockClear();
    parser.update("one\n\ntwo\n\nthree more");
    // "one\n\n" (6 chars) is frozen, so the second lex starts at offset 6.
    expect(lex).toHaveBeenCalledTimes(1);
    expect(lex.mock.calls[0]?.[0]).toBe("two\n\nthree more");
  });

  it("keeps a block's key (its absolute start offset) as it crosses the freeze boundary", () => {
    const { parser } = makeParser();
    // "two" starts at offset 5 ("one\n\n" = 5 chars? no: o,n,e,\n,\n = 5).
    const before = parser.update("one\n\ntwo\n\nthree");
    const twoInTail = before.tail[0];
    const after = parser.update("one\n\ntwo\n\nthree\n\nfour\n\nfive");
    const twoFrozen = after.frozen.find((b) => b.token.raw.startsWith("two"));
    expect(twoFrozen?.key).toBe(twoInTail?.key);
  });

  it("returns the identical cached result for an unchanged input", () => {
    const { parser, lex } = makeParser();
    const a = parser.update("one\n\ntwo\n\nthree");
    lex.mockClear();
    const b = parser.update("one\n\ntwo\n\nthree");
    expect(b).toBe(a);
    expect(lex).not.toHaveBeenCalled();
  });

  it("an unclosed fence stays in the tail and swallows appended lines correctly", () => {
    const { parser } = makeParser();
    parser.update("intro\n\nnext\n\nmore\n\n```ts\nconst a = 1;");
    const r = parser.update("intro\n\nnext\n\nmore\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n");
    const fence = [...r.frozen, ...r.tail].find((b) => b.token.type === "code");
    expect(fence?.token.raw).toContain("const b = 2;");
    expect(reassemble(r)).toBe(
      "intro\n\nnext\n\nmore\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n",
    );
  });

  it("non-append input (an edit) discards the frozen prefix and bumps the generation", () => {
    const { parser } = makeParser();
    const before = parser.update("one\n\ntwo\n\nthree");
    const after = parser.update("ONE\n\ntwo");
    expect(after.generation).toBe(before.generation + 1);
    expect(after.frozen).toEqual([]);
    expect(reassemble(after)).toBe("ONE\n\ntwo");
  });

  it("frozen output grows monotonically across a long synthetic stream", () => {
    const { parser } = makeParser();
    let text = "";
    let lastFrozen = 0;
    for (let i = 0; i < 40; i += 1) {
      text += `paragraph number ${i} with some words\n\n`;
      const r = parser.update(text);
      expect(r.frozen.length).toBeGreaterThanOrEqual(lastFrozen);
      lastFrozen = r.frozen.length;
      expect(reassemble(r)).toBe(text);
    }
    // 40 paragraphs (each with its trailing space token folded into raw):
    // everything but the unstable tail must be frozen by the end.
    expect(lastFrozen).toBeGreaterThan(0);
  });
});
