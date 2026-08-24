/**
 * The line tokenizer's invariants: every character survives into exactly one
 * run (reassembly is lossless), classes land where they should, and an
 * unknown language declines instead of guessing.
 */

import { describe, expect, it } from "vitest";
import { highlightLines, type HighlightSpan } from "../highlight.js";

function reassemble(lines: HighlightSpan[][]): string {
  return lines.map((spans) => spans.map((s) => s.text).join("")).join("\n");
}

function kindsOf(lines: HighlightSpan[][], kind: HighlightSpan["kind"]): string[] {
  return lines.flat().filter((s) => s.kind === kind).map((s) => s.text);
}

describe("highlightLines", () => {
  it("returns null for an unknown or absent language (caller renders plain)", () => {
    expect(highlightLines("code", "brainfuck")).toBe(null);
    expect(highlightLines("code", undefined)).toBe(null);
    // Hostile fence label that is an inherited object property must miss.
    expect(highlightLines("code", "constructor")).toBe(null);
  });

  it("reassembles the source losslessly, line count preserved", () => {
    const src = 'const a = "x\\"y"; // trailing\nlet b = 0xFF;';
    const lines = highlightLines(src, "ts");
    expect(lines).not.toBe(null);
    expect(reassemble(lines ?? [])).toBe(src);
    expect(lines?.length).toBe(2);
  });

  it("classes ts keywords, strings with escapes, numbers and comments", () => {
    const lines = highlightLines(
      'const a = "x\\"y"; // trailing\nreturn 0xFF;',
      "typescript",
    ) ?? [];
    expect(kindsOf(lines, "keyword")).toEqual(["const", "return"]);
    expect(kindsOf(lines, "string")).toEqual(['"x\\"y"']);
    expect(kindsOf(lines, "comment")).toEqual(["// trailing"]);
    expect(kindsOf(lines, "number")).toEqual(["0xFF"]);
  });

  it("does not class a keyword embedded in a longer identifier", () => {
    const lines = highlightLines("const constant = doReturn;", "js") ?? [];
    expect(kindsOf(lines, "keyword")).toEqual(["const"]);
  });

  it("distinguishes JSON keys from string values", () => {
    const lines = highlightLines('{ "amount": "1.5", "ok": true }', "json") ?? [];
    expect(kindsOf(lines, "property")).toEqual(['"amount"', '"ok"']);
    expect(kindsOf(lines, "string")).toEqual(['"1.5"']);
    expect(kindsOf(lines, "keyword")).toEqual(["true"]);
  });

  it("json has no line comments: // stays plain text", () => {
    const lines = highlightLines('"a" // not a comment', "json") ?? [];
    expect(kindsOf(lines, "comment")).toEqual([]);
  });

  it("an unclosed string runs to end of line without swallowing the next line", () => {
    const lines = highlightLines('x = "unclosed\ny = 1', "python") ?? [];
    expect(kindsOf(lines, "string")).toEqual(['"unclosed']);
    expect(kindsOf(lines, "number")).toEqual(["1"]);
  });

  it("matches sql keywords case-insensitively", () => {
    const lines = highlightLines("SELECT id FROM sessions", "sql") ?? [];
    expect(kindsOf(lines, "keyword")).toEqual(["SELECT", "FROM"]);
  });
});
