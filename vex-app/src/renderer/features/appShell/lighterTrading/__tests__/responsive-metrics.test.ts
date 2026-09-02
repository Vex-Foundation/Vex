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

  it("keeps order-behavior choices legible and touch-sized", () => {
    expect(css).toMatch(/\.lit-tif-tabs button\s*\{[^}]*min-height: 44px;[^}]*font-size: 11px;/s);
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
    expect(css).toMatch(/\.lit-market-picker-layer\s*\{[^}]*position: fixed;[^}]*inset: 0;[^}]*min-height: 100dvh;[^}]*padding: 12px;/s);
    expect(css).toContain(
      ".lit-market-picker { width: 100%; max-height: min(72dvh, 620px); border-radius: 14px; }",
    );
  });

  it("bounds the desktop picker so the live chart remains visible", () => {
    expect(css).toContain("min-height: calc(100dvh - 140px);");
    expect(css).toContain("width: min(780px, calc(100vw - 24px));");
    expect(css).toContain("width: clamp(860px, 52vw, 960px);");
    expect(css).toContain("max-height: min(640px, calc(100dvh - 300px));");
  });

  it("separates the market catalogue from the live chart with one elevated layer", () => {
    expect(css).toContain("background: var(--lit-market-picker-scrim);");
    expect(css).toContain("backdrop-filter: blur(3px) saturate(0.72);");
    expect(css).toContain("background: var(--lit-market-picker-surface);");
    expect(css).toContain("animation: lit-market-picker-enter 180ms cubic-bezier(0.16, 1, 0.3, 1);");
  });

  it("settles the market catalogue on complete rows so ticker identities stay visible", () => {
    expect(css).toContain("scroll-snap-type: y mandatory;");
    expect(css).toContain("scroll-snap-align: start;");
    expect(css).toContain("overscroll-behavior-y: contain;");
  });
});
