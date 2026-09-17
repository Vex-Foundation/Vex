import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dir = resolve(process.cwd(), "src/renderer/styles/global-css");
const css = readdirSync(dir)
  .filter((name) => name.startsWith("lighter-") && name.endsWith(".css"))
  .sort()
  .map((name) => readFileSync(resolve(dir, name), "utf8"))
  .join("\n");

describe("Lighter desk responsive market metrics", () => {
  it("keeps the bottom tabs in a breathable compact cluster", () => {
    expect(css).toMatch(/\.lit-bottom-tabs\s*\{[^}]*gap: 8px;/s);
  });

  it("keeps order-behavior choices legible at desk density", () => {
    expect(css).toMatch(/\.lit-tif-tabs button\s*\{[^}]*min-height: 30px;[^}]*font-size: 11px;/s);
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

  it("sizes the market bar to its own column, not the viewport", () => {
    expect(css).toMatch(/\.lit-desk-top\s*\{[^}]*container-type: inline-size;/s);
    expect(css).toContain("@container (max-width: 1100px)");
    expect(css).not.toMatch(/@media \(max-width: 1440px\)/);
  });

  it("keeps the chart, order book, ticket and account dock mounted together", () => {
    expect(css).toMatch(/\.lit-desk-upper\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) 260px 300px;/s);
    expect(css).toMatch(/\.lit-book-column > \.lit-book-panel\s*\{[^}]*min-height: 140px;/s);
    expect(css).toMatch(/\.lit-book-column > \.lit-trades-slot\s*\{[^}]*min-height: 120px;/s);
    expect(css).toMatch(/\.lit-ticket-footer\s*\{[^}]*position: sticky;/s);
    expect(css).toMatch(/\.lit-splitter\[data-axis="x"\]\s*\{[^}]*cursor: ew-resize;/s);
    expect(css).not.toMatch(/\.lit-bottom-panel\s*\{[^}]*display: none/s);
    expect(css).not.toContain(".lit-dialog");
  });

  it("resolves the desk from the shell's aliases without scaling up the chrome", () => {
    expect(css).toContain("--lit-bg: var(--vex-alias-bg-deep);");
    expect(css).toContain("--lit-positive: var(--vex-alias-state-success);");
    expect(css).toContain("--lit-radius: var(--radius-sm);");
    expect(css).not.toContain("data-lighter-environment");
    expect(css).not.toContain("radial-gradient(");
    expect(css).not.toContain("--lit-robin-neon");
    expect(css).not.toContain("--lit-chart-font-size: 18");
  });
});
