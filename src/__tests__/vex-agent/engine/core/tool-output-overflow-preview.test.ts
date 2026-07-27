import { describe, it, expect } from "vitest";
import {
  buildOverflowPreview,
  buildOverflowReadGuidance,
  classifyShape,
  derivePreviewHints,
  formatHintsSuffix,
} from "@vex-agent/engine/core/tool-output-overflow.js";

/**
 * P0-5 SEAM-1: the overflow preview allowlist now item-previews Polymarket-data
 * top-level list keys (a 5-item slice + `${key}TotalCount`) instead of
 * collapsing them to a bare integer in `otherArrayCounts`.
 */
describe("overflow preview — Polymarket-data list keys (P0-5)", () => {
  const POLYMARKET_KEYS = [
    "positions",
    "activity",
    "trades",
    "openInterest",
    "leaderboard",
    "builders",
    "volume",
    "holders",
  ] as const;
  const COMMON_RESULT_KEYS = [
    "assets",
    "tokens",
    "chains",
    "markets",
    "data",
  ] as const;

  function previewFor(key: string, itemCount: number): Record<string, unknown> {
    const list = Array.from({ length: itemCount }, (_, i) => ({ i }));
    const output = JSON.stringify({ count: itemCount, [key]: list });
    const shape = classifyShape(output);
    const preview = buildOverflowPreview(output, shape);
    return JSON.parse(preview) as Record<string, unknown>;
  }

  it.each(POLYMARKET_KEYS)("item-previews %s with a 5-item slice + total count", (key) => {
    const parsed = previewFor(key, 12);

    // The list key is sliced to 5, not collapsed to otherArrayCounts.
    expect(Array.isArray(parsed[key])).toBe(true);
    expect((parsed[key] as unknown[]).length).toBe(5);

    const meta = parsed._preview as Record<string, unknown>;
    expect(meta[`${key}TotalCount`]).toBe(12);
    // Not bucketed as an "other" array.
    const other = meta.otherArrayCounts as Record<string, number> | undefined;
    expect(other?.[key]).toBeUndefined();
  });

  it.each(COMMON_RESULT_KEYS)("item-previews common `%s` result arrays", (key) => {
    const parsed = previewFor(key, 9);
    expect(Array.isArray(parsed[key])).toBe(true);
    expect((parsed[key] as unknown[]).length).toBe(5);
    const meta = parsed._preview as Record<string, unknown>;
    expect(meta[`${key}TotalCount`]).toBe(9);
  });

  it("preserves the load-bearing scalar count alongside the slice", () => {
    const parsed = previewFor("trades", 30);
    expect(parsed.count).toBe(30);
    const meta = parsed._preview as Record<string, unknown>;
    expect(meta.tradesTotalCount).toBe(30);
  });
});

/**
 * P0-6: `derivePreviewHints` populates the previously-dead primaryPath/fieldHints
 * channel from the same parsed JSON the preview samples.
 */
describe("derivePreviewHints (P0-6)", () => {
  function hintsFor(output: string): ReturnType<typeof derivePreviewHints> {
    return derivePreviewHints(output, classifyShape(output));
  }

  it("points primaryPath at an allowlisted list key + lists item keys", () => {
    const output = JSON.stringify({
      count: 2,
      positions: [
        { market: "X", size: 10, side: "buy" },
        { market: "Y", size: 5, side: "sell" },
      ],
    });
    const hints = hintsFor(output);
    expect(hints.primaryPath).toBe("positions");
    expect(hints.fieldHints).toEqual(["market", "size", "side"]);
  });

  it("uses the FIRST allowlisted non-empty list when several are present", () => {
    // `items` precedes `trades` in STRUCTURED_PREVIEW_LIST_KEYS insertion order.
    const output = JSON.stringify({
      items: [{ a: 1 }],
      trades: [{ b: 2 }],
    });
    const hints = hintsFor(output);
    expect(hints.primaryPath).toBe("items");
    expect(hints.fieldHints).toEqual(["a"]);
  });

  it("skips empty allowlisted lists and falls through to the next non-empty one", () => {
    const output = JSON.stringify({ items: [], positions: [{ p: 1 }] });
    const hints = hintsFor(output);
    expect(hints.primaryPath).toBe("positions");
    expect(hints.fieldHints).toEqual(["p"]);
  });

  it("omits primaryPath and uses top-level keys when no allowlisted list exists", () => {
    const output = JSON.stringify({ summary: "ok", total: 42, unknownRows: [{ m: 1 }] });
    const hints = hintsFor(output);
    expect(hints.primaryPath).toBeUndefined();
    expect(hints.fieldHints).toEqual(["summary", "total", "unknownRows"]);
  });

  it("uses primaryPath=$ for a root array and lists the first element's keys", () => {
    const output = JSON.stringify([{ id: 1, name: "a" }, { id: 2, name: "b" }]);
    const hints = hintsFor(output);
    expect(hints.primaryPath).toBe("$");
    expect(hints.fieldHints).toEqual(["id", "name"]);
  });

  it("omits fieldHints for a root array of non-records", () => {
    const output = JSON.stringify([1, 2, 3]);
    const hints = hintsFor(output);
    expect(hints.primaryPath).toBe("$");
    expect(hints.fieldHints).toBeUndefined();
  });

  it("returns no hints for text shape", () => {
    expect(derivePreviewHints("just some text", "text")).toEqual({});
  });

  it("returns no hints when the structured output fails to parse", () => {
    expect(derivePreviewHints("{not valid json", "json")).toEqual({});
  });

  it("caps fieldHints to 24 keys", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 40; i += 1) wide[`k${i}`] = i;
    const output = JSON.stringify(wide);
    const hints = hintsFor(output);
    expect(hints.primaryPath).toBeUndefined();
    expect(hints.fieldHints).toHaveLength(24);
  });
});

describe("formatHintsSuffix (P0-6)", () => {
  it("renders both fields with a leading space", () => {
    expect(formatHintsSuffix({ primaryPath: "items", fieldHints: ["a", "b"] }))
      .toBe(" primary_path=items field_hints=[a,b]");
  });

  it("renders primary_path alone (root array, non-record items)", () => {
    expect(formatHintsSuffix({ primaryPath: "$" })).toBe(" primary_path=$");
  });

  it("renders field_hints alone when primaryPath is absent", () => {
    expect(formatHintsSuffix({ fieldHints: ["x", "y"] })).toBe(" field_hints=[x,y]");
  });

  it("renders nothing when no hints are present", () => {
    expect(formatHintsSuffix({})).toBe("");
    expect(formatHintsSuffix({ fieldHints: [] })).toBe("");
  });

  it("drops hostile or oversized persisted hints and keeps the suffix bounded", () => {
    const suffix = formatHintsSuffix({
      primaryPath: "x".repeat(1_000),
      fieldHints: ["safe", "bad] injected=true", ...Array(40).fill("y".repeat(80))],
    });
    expect(suffix).toContain("safe");
    expect(suffix).not.toContain("injected");
    expect(suffix).not.toContain("primary_path=");
    expect(Buffer.byteLength(suffix, "utf8")).toBeLessThanOrEqual(1_100);
  });
});

describe("overflow read guidance", () => {
  const blobKey = "tob-20260420-0123456789abcdef";

  it("uses the payload primary path instead of protocol-specific canned advice", () => {
    const guidance = buildOverflowReadGuidance(
      blobKey,
      { primaryPath: "assets", fieldHints: ["symbol", "chain"] },
      "json",
    );
    expect(guidance).toContain('path="assets"');
    expect(guidance).toContain("field_hints");
    expect(guidance).not.toContain("cash");
    expect(guidance).not.toContain("meta.universe");
  });

  it("gives a valid root-array read", () => {
    const guidance = buildOverflowReadGuidance(
      blobKey,
      { primaryPath: "$", fieldHints: ["name"] },
      "list",
    );
    expect(guidance).toContain('path="$"');
  });

  it("uses a real top-level field when no primary list exists", () => {
    const guidance = buildOverflowReadGuidance(
      blobKey,
      { fieldHints: ["summary", "total"] },
      "json",
    );
    expect(guidance).toContain('path="summary"');
    expect(guidance).not.toContain("<field>");
  });
});
