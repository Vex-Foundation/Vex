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

  it("keeps the chart, order book, desk and account panel available on compact screens", () => {
    expect(css).toContain('"trades trades chat"');
    expect(css).toContain('"trades trades"');
    expect(css).toContain("var(--lit-bottom-height, 190px)");
    expect(css).not.toMatch(/\.lit-bottom-panel\s*\{[^}]*display: none/s);
    expect(css).not.toMatch(/\.lit-chat-panel\s*\{[^}]*display: none/s);
  });

  it("shares a neutral canvas across networks without scaling up the chrome", () => {
    expect(css).toContain("--lit-bg: #111214;");
    expect(css).toContain("--lit-positive: #20b7ae;");
    expect(css).not.toContain("radial-gradient(");
    expect(css).not.toContain("--lit-robin-neon");
    expect(css).not.toContain("--lit-chart-font-size: 18");
  });
});
