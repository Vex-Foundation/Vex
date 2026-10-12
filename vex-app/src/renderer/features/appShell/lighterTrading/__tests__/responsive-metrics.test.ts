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
  it("uses a compact top navigation bar with an overlay drawer", () => {
    expect(css).toMatch(/\.lit-desk-topbar-header\s*\{[^}]*height: 100%;[^}]*align-items: center;/s);
    expect(css).toMatch(/\.lit-desk-nav-drawer\s*\{[^}]*position: absolute;[^}]*top: calc\(100% \+ 6px\);/s);
    expect(css).toMatch(/\.lit-desk-nav-drawer\s*\{[^}]*width: min\(420px, calc\(100vw - 16px\)\);/s);
  });

  it("carries the selected environment into native top-layer dialogs", () => {
    expect(css).toMatch(/\.lit-environment-dialog\.vex-dialog\s*\{[^}]*border-color: var\(--lit-line-strong\);[^}]*background: var\(--lit-panel\);/s);
    expect(css).toMatch(/\.lit-environment-dialog\.vex-dialog::backdrop\s*\{[^}]*var\(--lit-bg\)/s);
    expect(css).toMatch(/\.lit-environment-dialog \[data-vex-button="primary"\]:enabled\s*\{[^}]*background: var\(--lit-action\);[^}]*color: var\(--lit-action-ink\);/s);
    expect(css).toMatch(/\.lit-environment-dialog input\[type="range"\]\s*\{ accent-color: var\(--lit-focus\); \}/s);
  });

  it("keeps the bottom tabs in a breathable compact cluster", () => {
    expect(css).toMatch(/\.lit-bottom-tabs\s*\{[^}]*gap: 8px;/s);
  });

  it("shows all agent prompts without a hidden horizontal scroll", () => {
    expect(css).toMatch(/\.lit-desk-scope\s*\{[^}]*flex-direction: column;[^}]*padding: 6px 12px;/s);
    expect(css).toMatch(/\.lit-desk-quick\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s);
    expect(css).toMatch(/@container \(max-width: 420px\)[\s\S]*\.lit-desk-quick > button \{ padding-inline: 8px; \}/s);
  });

  it("keeps the ticket compact while preserving its primary controls", () => {
    expect(css).toMatch(/\.lit-ticket-body\s*\{[^}]*gap: 5px;[^}]*overflow-y: auto;[^}]*padding: 6px 8px 8px;/s);
    expect(css).toMatch(/\.lit-ticket-footer\s*\{[^}]*gap: 4px;[^}]*padding: 6px 8px;/s);
    expect(css).toMatch(/\.lit-side-actions \.lit-review-button\s*\{[^}]*min-height: 38px;/s);
    expect(css).toMatch(/@container \(max-width: 300px\)[\s\S]*\.lit-ticket-meta \{ padding-inline: 7px; \}/s);
    expect(css).toMatch(/@container \(max-width: 300px\)[\s\S]*\.lit-slippage-field \{ grid-template-columns: 48px minmax\(0, 1fr\);/s);
  });

  it("keeps order-behavior choices legible at desk density", () => {
    expect(css).toMatch(/\.lit-tif-tabs button\s*\{[^}]*min-height: 30px;[^}]*font-size: 11px;/s);
  });

  it("gives ticket actions visible focus and brief reduced-motion-safe feedback", () => {
    expect(css).toMatch(/\.lit-ticket button:focus-visible,[\s\S]*outline: 2px solid var\(--lit-focus\);/s);
    expect(css).toContain("@keyframes lit-ticket-status-in");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.lit-desk \*/s);
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
    expect(css).toContain("@container (max-width: 1020px)");
    expect(css).not.toMatch(/@media \(max-width: 1440px\)/);
  });

  it("keeps the chart, order book, ticket and account dock mounted together", () => {
    expect(css).toMatch(/\.lit-desk-upper\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) 260px 300px;/s);
    expect(css).toMatch(/\.lit-book-column > \.lit-book-panel\s*\{[^}]*min-height: 140px;/s);
    expect(css).toMatch(/\.lit-book-column > \.lit-trades-slot\s*\{[^}]*min-height: 120px;/s);
    expect(css).toMatch(/\.lit-ticket-content,\s*\.lit-ticket\s*\{[^}]*min-height: 0;[^}]*height: 100%;[^}]*flex: 1 1 auto;/s);
    expect(css).toMatch(/\.lit-ticket-column > \.lit-ticket-panel\s*\{[^}]*overflow: hidden;/s);
    expect(css).toMatch(/\.lit-ticket-footer\s*\{[^}]*flex: 0 0 auto;/s);
    expect(css).toMatch(/\.lit-splitter\[data-axis="x"\]\s*\{[^}]*cursor: ew-resize;/s);
    expect(css).not.toMatch(/\.lit-bottom-panel\s*\{[^}]*display: none/s);
    expect(css).not.toContain(".lit-dialog");
  });

  it("paints the desk from the app's aliases: one blue for both deployments", () => {
    // V10 has one blue: the desk shares the room's paper, ink and rules, and
    // the deployment is named by the switch's logo and label, not repainted.
    expect(css).toContain("--lit-bg: var(--vex-alias-bg-base);");
    expect(css).toContain("--lit-positive: var(--vex-alias-accent-primary);");
    expect(css).toContain("--lit-negative: var(--vex-alias-label-primary);");
    expect(css).toContain("--lit-environment-mark: var(--vex-alias-accent-primary);");
    expect(css).not.toContain("--lit-radius");
    expect(css).not.toMatch(/\[data-lighter-environment="(?:core|rhc)"\]\s*[,{]/);
    expect(css).not.toContain("--lit-env-core");
    expect(css).not.toContain("--lit-env-rhc");
    expect(css).not.toContain("radial-gradient(");
    expect(css).not.toContain("--lit-robin-neon");
    expect(css).not.toContain("--lit-chart-font-size: 18");
  });

  it("keeps the candlesticks the one hue pair, inside the chart canvas only", () => {
    expect(css).toMatch(/\.lit-desk \.lit-chart-canvas\s*\{[^}]*--lit-positive: var\(--color-candle-up\);[^}]*--lit-negative: var\(--color-candle-down\);/s);
  });

  it("lets the adjacent Vex rail speak the room without a re-projection", () => {
    // The rail's transcript and composer are the shell's own components; with
    // the desk on the room's aliases they need no copy of the palette, and a
    // re-projection onto `--lit-*` would close a var() cycle.
    expect(css).not.toMatch(/--vex-alias-[a-z0-9-]+: var\(--lit-/);
    expect(css).toMatch(/\.lit-chat-frame\s*>\s*\[data-vex-area="book-panel"\]\s*\{[^}]*background: var\(--lit-bg\);/s);
  });

  it("themes live thinking with the desk's focus blue", () => {
    expect(css).toMatch(/\.lit-chat-shell \.vex-turn-shimmer\s*\{[^}]*var\(--lit-focus\)[^}]*var\(--lit-ink\)/s);
  });
});
