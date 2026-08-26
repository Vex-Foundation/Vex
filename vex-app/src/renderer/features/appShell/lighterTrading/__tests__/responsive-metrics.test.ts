import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(process.cwd(), "src/renderer/styles/global-css/lighter-trading.css"),
  "utf8",
);

describe("Light it up responsive market metrics", () => {
  it("keeps the bottom tabs in a breathable compact cluster", () => {
    expect(css).toMatch(/\.lit-bottom-tabs\s*\{[^}]*gap: 8px;/s);
  });

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
    expect(css).toContain(
      ".lit-market-picker-layer { position: fixed; inset: 12px 12px auto; width: auto; }",
    );
    expect(css).toContain(
      ".lit-market-picker { max-height: min(72dvh, 620px); border-radius: 14px; }",
    );
  });

  it("bounds the desktop picker so the live chart remains visible", () => {
    expect(css).toContain("right: auto;");
    expect(css).toContain("width: min(780px, calc(100vw - 24px));");
    expect(css).toContain("width: clamp(860px, 52vw, 960px);");
    expect(css).toContain("max-height: min(640px, calc(100dvh - 300px));");
  });

  it("settles the market catalogue on complete rows so ticker identities stay visible", () => {
    expect(css).toContain("scroll-snap-type: y mandatory;");
    expect(css).toContain("scroll-snap-align: start;");
    expect(css).toContain("overscroll-behavior-y: contain;");
  });
});
