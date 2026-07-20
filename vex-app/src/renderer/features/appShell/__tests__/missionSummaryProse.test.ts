/**
 * `parseSummaryBullets` — the pure reader for the agent-authored
 * `stopSummary` prose.
 *
 * The prompt asks for `- `-prefixed bullets, but a model is not a parser: it
 * will sometimes emit a bare paragraph, `*` bullets, blank lines, or trailing
 * whitespace. This function is the ONE place that tolerance lives so the
 * component stays a dumb renderer.
 */

import { describe, expect, it } from "vitest";

import { parseSummaryBullets } from "../missionSummaryProse.js";

describe("parseSummaryBullets", () => {
  it("splits a well-formed dash-bulleted summary into its beats", () => {
    const summary = [
      "- Looked at 12 trending coins on Base",
      "- Bought PEPE because it was up 30% on the day with healthy trading",
      "- Put in about $9 (well under your $20 limit)",
      "- Set an automatic take-profit and a safety stop",
      "- Ended about even — down 17 cents to trading fees",
    ].join("\n");

    expect(parseSummaryBullets(summary)).toEqual([
      "Looked at 12 trending coins on Base",
      "Bought PEPE because it was up 30% on the day with healthy trading",
      "Put in about $9 (well under your $20 limit)",
      "Set an automatic take-profit and a safety stop",
      "Ended about even — down 17 cents to trading fees",
    ]);
  });

  it("accepts the other bullet glyphs a model reaches for", () => {
    const summary = "* First beat\n• Second beat\n– Third beat";

    expect(parseSummaryBullets(summary)).toEqual([
      "First beat",
      "Second beat",
      "Third beat",
    ]);
  });

  it("tolerates leading indentation and blank lines", () => {
    const summary = "\n   - First beat\n\n  - Second beat  \n\n";

    expect(parseSummaryBullets(summary)).toEqual(["First beat", "Second beat"]);
  });

  it("falls back to a single beat when the model wrote a paragraph anyway", () => {
    const summary = "Bought PEPE for about $9 and sold it back an hour later, ending down 17 cents.";

    expect(parseSummaryBullets(summary)).toEqual([
      "Bought PEPE for about $9 and sold it back an hour later, ending down 17 cents.",
    ]);
  });

  it("returns no beats for null / blank prose so the card can hide the block", () => {
    expect(parseSummaryBullets(null)).toEqual([]);
    expect(parseSummaryBullets("")).toEqual([]);
    expect(parseSummaryBullets("   \n\t \n ")).toEqual([]);
  });

  it("drops bullet markers that carry no text", () => {
    expect(parseSummaryBullets("- First beat\n-\n-   \n- Second beat")).toEqual([
      "First beat",
      "Second beat",
    ]);
  });
});
