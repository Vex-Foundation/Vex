import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(process.cwd(), "src/renderer/styles/global-css/lighter-trading.css"),
  "utf8",
);

describe("Light it up responsive market metrics", () => {
  it("uses explicit product and metric identities instead of DOM positions", () => {
    expect(css).toContain(
      '.lit-market-bar[data-market-type="perp"] .lit-market-metric[data-metric="funding"]',
    );
    expect(css).toContain(
      '.lit-market-bar[data-market-type="spot"] .lit-market-metric[data-metric="mid"]',
    );
    expect(css).toContain(
      '.lit-market-bar[data-market-type="perp"] .lit-market-metric[data-metric="open-interest"]',
    );
    expect(css).toContain(
      '.lit-market-bar[data-market-type="spot"] .lit-market-metric[data-metric="high"]',
    );
    expect(css).not.toMatch(/\.lit-market-metric:nth-of-type/);
  });

  it("contains the market picker within the narrow viewport", () => {
    expect(css).toContain(".lit-market-picker-layer { position: fixed; inset: 12px; width: auto; }");
    expect(css).toContain(".lit-market-picker { max-height: calc(100dvh - 24px); border-radius: 14px; }");
  });
});
