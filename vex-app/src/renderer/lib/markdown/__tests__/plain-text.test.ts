/**
 * The copy projection strips exactly the markup the renderer draws — links
 * keep labels, images keep alt text, code keeps source — and never returns
 * nothing for non-empty input.
 */

import { describe, expect, it } from "vitest";
import { extractMarkdownPlainText } from "../plain-text.js";

describe("extractMarkdownPlainText strips markup but keeps every word", () => {
  it("drops emphasis, link and heading markup while keeping their text", () => {
    expect(
      extractMarkdownPlainText(
        "# Plan\n\nSwap **1.5 ETH** via [Kyber](https://kyber.network) _now_.",
      ),
    ).toBe("Plan\n\nSwap 1.5 ETH via Kyber now.");
  });
  it("keeps code source text verbatim, fenced and inline", () => {
    expect(extractMarkdownPlainText("Run `pnpm test`:\n\n```ts\nconst a = 1;\n```")).toBe(
      "Run pnpm test:\n\nconst a = 1;",
    );
  });
  it("keeps an image's alt text and a task list's item text", () => {
    expect(
      extractMarkdownPlainText("![vex logo](https://x/y.png)\n\n- [x] fund wallet\n- [ ] swap"),
    ).toBe("vex logo\n\nfund wallet\nswap");
  });
  it("flattens a table to tab-separated rows", () => {
    expect(
      extractMarkdownPlainText("| a | b |\n| - | - |\n| 1 | 2 |"),
    ).toBe("a\tb\n1\t2");
  });
  it("collapses blank-line runs and trims the ends", () => {
    expect(extractMarkdownPlainText("\n\none\n\n\n\ntwo\n\n")).toBe("one\n\ntwo");
  });
  it("returns plain input unchanged", () => {
    expect(extractMarkdownPlainText("just words")).toBe("just words");
  });
});
