/**
 * W9d — silent truncation removed from the Pendle read surface.
 *
 * Three `.slice()` caps sat on the SAME question: which categories does this
 * market carry, and which did the caller ask to exclude? Each one dropped
 * values with no echo, and their combined effect was a market the agent had
 * explicitly excluded coming back in the result set — a filter that reports
 * success while doing less than it says. A bound the caller can be told about
 * is a contract; a bound that silently drops values is a bug.
 */

import { describe, expect, it } from "vitest";

import { readDisplayStringList } from "@tools/pendle/read/validation/_shared.js";
import { validateMarkets } from "@tools/pendle/validation.js";
import {
  MAX_CATEGORY_FILTERS,
  parsePendleYieldsParams,
} from "@vex-agent/tools/protocols/pendle/read-params.js";
import { trustedCategoryIds } from "@vex-agent/tools/protocols/pendle/trusted-fields.js";

function categoryList(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `cat-${i}`);
}

describe("readCsv — rejects by name instead of slicing", () => {
  it.each(["categories", "excludeCategories"])("refuses an over-long `%s` BY NAME", (param) => {
    const result = parsePendleYieldsParams({ [param]: categoryList(MAX_CATEGORY_FILTERS + 4).join(",") });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.rejection.param).toBe(param);
    expect(result.rejection.message).toContain(String(MAX_CATEGORY_FILTERS));
    expect(result.rejection.message).toContain(String(MAX_CATEGORY_FILTERS + 4));
    expect(result.rejection.message).toContain("will not silently drop");
  });

  it("keeps every value at the bound — nothing is dropped up to it", () => {
    const result = parsePendleYieldsParams({ excludeCategories: categoryList(MAX_CATEGORY_FILTERS).join(",") });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.excludeCategories).toHaveLength(MAX_CATEGORY_FILTERS);
  });
});

describe("category labels — no hidden cap on the values the filter matches against", () => {
  it("trustedCategoryIds keeps every valid id past the old 16-entry break", () => {
    expect(trustedCategoryIds(categoryList(40))).toHaveLength(40);
  });

  it("trustedCategoryIds still dedupes and still drops ids outside the vocabulary", () => {
    expect(trustedCategoryIds(["eth", "ETH", "not a category!", "x".repeat(41), "lst"])).toEqual(["eth", "lst"]);
  });

  it("the read-lane list keeps every label past the old 32-entry cap", () => {
    expect(readDisplayStringList(categoryList(64))).toHaveLength(64);
  });

  it("the money-path market rows keep every label past the old 32-entry cap", () => {
    const markets = validateMarkets({
      markets: [
        {
          address: "0x34280882267ffa6383b363e278b027be083bbe3b",
          categoryIds: categoryList(50),
        },
      ],
    });

    expect(markets.at(0)?.categoryIds).toHaveLength(50);
  });
});
