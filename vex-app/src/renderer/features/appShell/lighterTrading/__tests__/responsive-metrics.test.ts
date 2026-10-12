import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dir = resolve(process.cwd(), "src/renderer/styles/global-css");
/** Every sheet the Lighter desk owns: the `lighter-*` set plus its three companions. */
const DESK_SHEETS = readdirSync(dir)
  .filter((name) => (name.startsWith("lighter-") && name.endsWith(".css"))
    || name === "market-picker.css"
    || name === "chart-tools.css"
    || name === "trade-ticket-controls.css")
  .sort();
const css = DESK_SHEETS
  .map((name) => readFileSync(resolve(dir, name), "utf8"))
  .join("\n");
/** The sheets with their comments removed, so a law reads only live rules. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("Lighter desk responsive market metrics", () => {
  it("uses a compact top navigation bar with an overlay drawer", () => {
    expect(css).toMatch(/\.lit-desk-topbar-header\s*\{[^}]*height: 100%;[^}]*align-items: center;/s);
    expect(css).toMatch(/\.lit-desk-nav-drawer\s*\{[^}]*position: absolute;[^}]*top: calc\(100% \+ 6px\);/s);
    expect(css).toMatch(/\.lit-desk-nav-drawer\s*\{[^}]*width: min\(420px, calc\(100vw - 16px\)\);/s);
  });

  it("leaves the desk's dialogs to the shared primitive and its paper dither veil", () => {
    // One palette for both deployments: no desk-world repaint of the dialog
    // chrome, its buttons or its backdrop (the primitive draws the 2px paper
    // dither, docs/design/V10-SPREAD.md section 7).
    expect(rules).not.toMatch(/\.lit-environment-dialog\.vex-dialog/);
    expect(rules).not.toMatch(/\.lit-environment-dialog \[data-vex-button=/);
    expect(css).not.toContain('[data-vex-button="outline"]');
    // The class stays the scope hook for the desk's square check box.
    expect(css).toMatch(/\.lit-environment-dialog input\[type="checkbox"\]:checked\s*\{ background: var\(--lit-ink\); \}/);
  });

  it("keeps the panel and dock tabs in a breathable compact cluster", () => {
    expect(css).toMatch(/\.lit-bottom-tabs\s*\{[^}]*gap: 16px;/s);
    expect(css).toMatch(/\.lit-bottom-tabs button\[aria-selected="true"\]\s*\{[^}]*border-bottom-color: var\(--lit-positive\);[^}]*color: var\(--lit-positive\);/s);
  });

  it("shows all agent prompts without a hidden horizontal scroll", () => {
    expect(css).toMatch(/\.lit-desk-scope\s*\{[^}]*flex-direction: column;[^}]*padding: 0 0 12px;/s);
    expect(css).toMatch(/\.lit-desk-quick\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s);
    expect(css).toMatch(/@container \(max-width: 420px\)[\s\S]*\.lit-desk-quick > button \{ padding-inline: 8px; \}/s);
  });

  it("keeps the ticket compact while preserving its primary controls", () => {
    expect(css).toMatch(/\.lit-ticket-body\s*\{[^}]*gap: 9px;[^}]*overflow-y: auto;[^}]*padding: 7px 12px 10px;/s);
    expect(css).toMatch(/\.lit-ticket-footer\s*\{[^}]*gap: 8px;[^}]*padding: 8px 12px 12px;/s);
    expect(css).toMatch(/\.lit-side-actions \.lit-review-button\s*\{[^}]*min-height: 50px;/s);
    expect(css).toMatch(/@container \(max-width: 300px\)[\s\S]*\.lit-ticket-meta \{ padding-inline: 10px; \}/s);
    expect(css).toMatch(/@container \(max-width: 300px\)[\s\S]*\.lit-slippage-field \{ grid-template-columns: 68px minmax\(0, 1fr\);/s);
  });

  it("draws Long as the true blue fill and Short as the ink fill, direction by arrow", () => {
    expect(css).toMatch(/\.lit-review-button\s*\{[^}]*background: var\(--lit-action\);[^}]*color: var\(--lit-action-ink\);/s);
    expect(css).toMatch(/\.lit-review-button\[data-side="sell"\]\s*\{[^}]*background: var\(--lit-ink-fill\);[^}]*color: var\(--lit-ink-fill-ink\);/s);
    expect(css).toContain('.lit-side-actions .lit-review-button[data-side="buy"] b::before { content: "\\2191\\00a0"; }');
    expect(css).toContain('.lit-side-actions .lit-review-button[data-side="sell"] b::before { content: "\\2193\\00a0"; }');
    // A disabled key is a dotted outline, never a faded fill.
    expect(css).toMatch(/\.lit-review-button:disabled\s*\{[^}]*outline: 1px dotted var\(--lit-positive\);/s);
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
    // the deployment is named by the switch's label, not repainted.
    expect(css).toContain("--lit-bg: var(--vex-alias-bg-base);");
    expect(css).toContain("--lit-positive: var(--vex-alias-accent-primary);");
    expect(css).toContain("--lit-negative: var(--vex-alias-label-primary);");
    expect(css).toContain("--lit-environment-mark: var(--vex-alias-accent-primary);");
    expect(css).not.toContain("--lit-radius");
    expect(css).not.toMatch(/\[data-lighter-environment="(?:core|rhc)"\]\s*[,{]/);
    expect(css).not.toContain("--lit-env-core");
    expect(css).not.toContain("--lit-env-rhc");
    expect(css).not.toContain("--lit-robin-neon");
    expect(css).not.toContain("--lit-chart-font-size: 18");
    // The only radial gradient is the dot screen of the ongoing swatch.
    const radials = rules.match(/radial-gradient\([^;]*/g) ?? [];
    expect(radials.length).toBeGreaterThan(0);
    for (const radial of radials) {
      expect(radial).toMatch(/^radial-gradient\(currentColor 1px, transparent 1\.2px\)/);
    }
  });

  it("sets the desk in Departure Mono, dense: 11px labels, no counters", () => {
    expect(css).toMatch(/\.lit-desk,\s*\.lit-desk-topbar\s*\{[^}]*font-family: var\(--font-mono\);[^}]*font-size: 12px;/s);
    // Caps labels are 10 or 11px; no desk rule sets type above the 36px
    // serif of a workspace error and the chat rail's title.
    const sizes = [...rules.matchAll(/font-size: (\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(36);
    expect(rules).not.toMatch(/font-weight: (?:[6-9]\d\d|bold)/);
  });

  it("keeps the V10 surface law on every desk sheet: no radius, shadow, blur, fade or raw colour", () => {
    expect(rules).not.toMatch(/border-radius:\s*(?!0[;\s])/);
    expect(rules).not.toMatch(/(?:^|[^-])box-shadow:/m);
    expect(rules).not.toContain("text-shadow");
    expect(rules).not.toMatch(/(?:backdrop-)?filter:/);
    expect(rules).not.toContain("mask-image");
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\brgba?\(/);
  });

  it("keeps the candlesticks the one hue pair, inside the chart canvas only", () => {
    expect(css).toMatch(/\.lit-desk \.lit-chart-canvas\s*\{[^}]*--lit-candle-up: var\(--color-candle-up\);[^}]*--lit-candle-down: var\(--color-candle-down\);/s);
    // Declared once, on the canvas host, and never painted with by a sheet.
    expect(rules.match(/--color-candle-/g)).toHaveLength(2);
    expect(rules).not.toContain("var(--lit-candle-");
  });

  it("closes the drag region while the Zen bar is folded away", () => {
    expect(css).toMatch(/\.lit-desk-topbar\[data-zen-controls="closed"\] \.lit-desk-topbar-header \{ -webkit-app-region: no-drag; \}/);
  });

  it("lets the adjacent Vex rail speak the room without a re-projection", () => {
    // The rail's transcript and composer are the shell's own components; with
    // the desk on the room's aliases they need no copy of the palette, and a
    // re-projection onto `--lit-*` would close a var() cycle.
    expect(css).not.toMatch(/--vex-alias-[a-z0-9-]+: var\(--lit-/);
    expect(css).toMatch(/\.lit-chat-frame\s*>\s*\[data-vex-area="book-panel"\]\s*\{[^}]*background: var\(--lit-bg\);/s);
  });

  it("themes live thinking with the desk's focus blue, flat", () => {
    expect(css).toMatch(/\.lit-chat-shell \.vex-turn-shimmer\s*\{[^}]*background: none;[^}]*color: var\(--lit-focus\);/s);
    expect(rules).not.toMatch(/linear-gradient\(\s*(?:90deg|180deg)/);
  });
});
