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
/** One sheet's live rules (comments removed). */
const sheetRules = (name: string): string =>
  readFileSync(resolve(dir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/**
 * The sheets the desk chrome owns (the title row, the market bar, the chart,
 * the book, the market picker and the desk chat): R3 words throughout, so no
 * caps anywhere in them.
 */
const CHROME_SHEETS = [
  "chart-tools.css",
  "lighter-book.css",
  "lighter-chart.css",
  "lighter-chat.css",
  "lighter-desk.css",
  "lighter-market-bar.css",
  "lighter-tokens.css",
  "market-picker.css",
] as const;

describe("Lighter desk sheets (docs/design/R3-MINIMAL.md sections 1.2 and 9.3)", () => {
  it("draws the title row as the centre's 44px head row with an overlay drawer", () => {
    expect(css).toMatch(/\.lit-desk-topbar\s*\{[^}]*position: relative;[^}]*flex: 0 0 auto;[^}]*height: var\(--head-h\);[^}]*container-type: inline-size;/s);
    expect(css).toMatch(/\.lit-desk-topbar-header\s*\{[^}]*height: 100%;[^}]*align-items: center;[^}]*gap: 12px;/s);
    // The right end reserves the caption buttons as the title bar does.
    expect(css).toMatch(/\.lit-desk-topbar-header\s*\{[^}]*padding-inline: 22px max\(16px, calc\(var\(--overlay-w\) \+ 12px - var\(--vex-vex-track, 0px\)\)\);/s);
    // The rail leaves the macOS lights their row; Zen has no rail.
    expect(css).toContain('html[data-os="mac"] .lit-desk-topbar-header { padding-inline-start: 38px; }');
    expect(css).toContain('html[data-os="mac"] .lit-desk-topbar[data-lighter-zen] .lit-desk-topbar-header { padding-inline-start: 96px; }');
    // A flat panel with a 1.5px ink frame, hung from the row's rule.
    expect(css).toMatch(/\.lit-desk-nav-drawer\s*\{[^}]*position: absolute;[^}]*top: calc\(100% \+ 6px\);/s);
    expect(css).toMatch(/\.lit-desk-nav-drawer\s*\{[^}]*width: min\(420px, calc\(100vw - 16px\)\);/s);
    expect(css).toMatch(/\.lit-desk-nav-drawer\s*\{[^}]*border: 1\.5px solid var\(--lit-rule-ink\);/s);
    // Title bar controls are 32 high: the pills and the icon keys.
    expect(css).toMatch(/\.lit-topbar-pill\s*\{[^}]*height: 32px;[^}]*border: 1px solid var\(--lit-line-quiet\);[^}]*font-family: var\(--font-sans\);[^}]*font-size: 13px;/s);
    expect(css).toMatch(/\.lit-topbar-key\s*\{[^}]*width: 32px;[^}]*height: 32px;/s);
    // A folded Zen row hides the title bar's cluster without unmounting it.
    expect(css).toMatch(/\.lit-desk-top-shell:empty,\s*\.lit-desk-top-shell\[hidden\]\s*\{ display: none; \}/);
  });

  it("folds the title row's pills to icons, then drops the place words, by its own width", () => {
    expect(css).toMatch(/@container \(max-width: 1060px\)[\s\S]*\.lit-topbar-pill \{ width: 32px; padding-inline: 0; \}/);
    expect(css).toMatch(/@container \(max-width: 760px\)[\s\S]*\.lit-topbar-title > \.vex-tb-title__sub \{ display: none; \}/);
  });

  it("leaves the desk's dialogs to the shared primitive", () => {
    // One palette for both deployments: no desk-world repaint of the dialog
    // chrome, its buttons or its backdrop.
    expect(rules).not.toMatch(/\.lit-environment-dialog\.vex-dialog/);
    expect(rules).not.toMatch(/\.lit-environment-dialog \[data-vex-button=/);
    expect(css).not.toContain('[data-vex-button="outline"]');
    // The class stays the scope hook for the desk's check box: checked is the fill blue.
    expect(css).toMatch(/\.lit-environment-dialog input\[type="checkbox"\]:checked\s*\{ background: var\(--lit-action\); \}/);
  });

  it("sets the panel and dock tabs in the sans, the selected one in the blue", () => {
    expect(css).toMatch(/\.lit-panel-tabs \{ gap: 18px; \}/);
    expect(css).toMatch(/\.lit-bottom-tabs \{ gap: 22px; \}/);
    expect(css).toMatch(/\.lit-bottom-tabs button\[aria-selected="true"\]\s*\{[^}]*border-bottom-color: var\(--lit-accent\);[^}]*color: var\(--lit-accent\);[^}]*font-weight: 500;/s);
  });

  it("lays the desk chat's prompts out as wrapping 28 high keys under the scope chip", () => {
    expect(css).toMatch(/\.lit-desk-scope\s*\{[^}]*flex-direction: column;[^}]*gap: 10px;[^}]*padding: 12px 0 10px;/s);
    expect(css).toMatch(/\.lit-desk-quick\s*\{[^}]*display: flex;[^}]*flex-wrap: wrap;[^}]*gap: 6px;/s);
    expect(css).toMatch(/\.lit-desk-quick > button\s*\{[^}]*min-height: 28px;[^}]*font-size: 12\.5px;/s);
    // The position's side is a trading value.
    expect(css).toContain('.lit-desk-scope-chip i[data-side="long"] { color: var(--lit-trade-up); }');
    expect(css).toContain('.lit-desk-scope-chip i[data-side="short"] { color: var(--lit-trade-down); }');
  });

  it("keeps the ticket compact while preserving its primary controls", () => {
    expect(css).toMatch(/\.lit-ticket-body\s*\{[^}]*gap: 10px;[^}]*overflow-y: auto;[^}]*padding: 0 16px 10px;/s);
    expect(css).toMatch(/\.lit-ticket-footer\s*\{[^}]*gap: 8px;[^}]*padding: 4px 16px 14px;/s);
    expect(css).toMatch(/\.lit-side-actions \.lit-review-button\s*\{[^}]*min-height: 48px;/s);
    expect(css).toMatch(/@container \(max-width: 300px\)[\s\S]*\.lit-ticket-meta \{ padding-inline: 10px; \}/s);
    expect(css).toMatch(/@container \(max-width: 300px\)[\s\S]*\.lit-slippage-field \{ grid-template-columns: 68px minmax\(0, 1fr\);/s);
  });

  it("draws Long and Short in the trading pair with its type, direction by arrow", () => {
    // The base key is the setup action's blue fill; the two sides take the pair.
    expect(css).toMatch(/\.lit-review-button\s*\{[^}]*background: var\(--lit-action\);[^}]*color: var\(--lit-action-ink\);/s);
    expect(css).toContain('.lit-side-actions .lit-review-button[data-side="buy"] { background: var(--vex-alias-trade-up); }');
    expect(css).toContain('.lit-side-actions .lit-review-button[data-side="sell"] { background: var(--vex-alias-trade-down); }');
    expect(css).toMatch(/\.lit-side-actions \.lit-review-button\s*\{[^}]*color: var\(--vex-alias-trade-ink\);/s);
    expect(css).not.toMatch(/\.lit-review-button\[data-side="sell"\]\s*\{[^}]*background: var\(--lit-ink-fill\);/s);
    expect(css).toContain('.lit-side-actions .lit-review-button[data-side="buy"] b::before { content: "\\2191\\00a0"; }');
    expect(css).toContain('.lit-side-actions .lit-review-button[data-side="sell"] b::before { content: "\\2193\\00a0"; }');
    // A disabled key is a dotted outline, never a faded fill.
    expect(css).toMatch(/\.lit-review-button:disabled\s*\{[^}]*outline: 1px dotted var\(--lit-positive\);/s);
  });

  it("keeps order-behaviour choices legible at desk density", () => {
    expect(css).toMatch(/\.lit-tif-tabs button\s*\{[^}]*min-height: 28px;[^}]*font-size: 12\.5px;/s);
  });

  it("gives desk actions visible focus and a reduced-motion floor", () => {
    expect(css).toMatch(/\.lit-ticket button:focus-visible,[\s\S]*outline: 2px solid var\(--lit-focus\);/s);
    expect(css).toMatch(/\.lit-desk button:focus-visible,[\s\S]*outline: 2px solid var\(--lit-focus\);/s);
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

  it("sizes the market bar to its own column, 58 high, not the viewport", () => {
    expect(css).toMatch(/\.lit-desk-top\s*\{[^}]*container-type: inline-size;[^}]*min-height: 58px;[^}]*padding: 0 18px;/s);
    // With the Vex column open at 1440 the desk is 1128: a perp keeps Mark,
    // Open interest and Funding.
    expect(css).toMatch(/@container \(max-width: 1130px\)\s*\{[^}]*data-metric="change"/s);
    expect(css).toMatch(/@container \(max-width: 960px\)\s*\{[^}]*data-metric="funding"/s);
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
    // The seams are the quiet rule, seen once through the clear nested grids.
    expect(css).toMatch(/\.lit-desk-body\s*\{[^}]*background: var\(--lit-line-quiet\);[^}]*gap: 1px;/s);
    expect(css).toMatch(/\.lit-desk-upper\s*\{[^}]*background: transparent;/s);
  });

  it("paints the desk from the app's aliases: one blue for both deployments, the trading pair from its aliases", () => {
    expect(css).toContain("--lit-bg: var(--vex-alias-bg-base);");
    expect(css).toContain("--lit-positive: var(--vex-alias-accent-primary);");
    expect(css).toContain("--lit-negative: var(--vex-alias-label-primary);");
    expect(css).toContain("--lit-accent: var(--vex-alias-accent-primary);");
    expect(css).toContain("--lit-pressed: var(--vex-alias-interactive-active);");
    expect(css).toContain("--lit-environment-mark: var(--vex-alias-accent-primary);");
    expect(css).toContain("--lit-trade-up: var(--vex-alias-trade-up);");
    expect(css).toContain("--lit-trade-down: var(--vex-alias-trade-down);");
    expect(css).toContain("--lit-trade-ink: var(--vex-alias-trade-ink);");
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

  it("paints bids, asks and the B and S ratio in the trading pair, and keeps it off the chart chrome", () => {
    expect(css).toContain("--lit-depth-bid: color-mix(in srgb, var(--lit-trade-up) 14%, transparent);");
    expect(css).toContain("--lit-depth-ask: color-mix(in srgb, var(--lit-trade-down) 12%, transparent);");
    expect(css).toContain('.lit-book-rows[data-side="bid"] .lit-book-row b { color: var(--lit-trade-up); }');
    expect(css).toContain('.lit-book-rows[data-side="ask"] .lit-book-row b { color: var(--lit-trade-down); }');
    expect(css).toContain('.lit-book-ratio > [data-side="bid"] { color: var(--lit-trade-up); }');
    expect(css).toContain('.lit-book-ratio > [data-side="ask"] { color: var(--lit-trade-down); }');
    expect(css).toMatch(/\.lit-book-ratio i\s*\{[^}]*background: var\(--lit-trade-down\);/s);
    expect(css).toMatch(/\.lit-book-ratio i::before\s*\{[^}]*background: var\(--lit-trade-up\);/s);
    // Price lines, studies, drawings and the order handle stay the blue and the ink.
    for (const name of ["chart-tools.css", "lighter-chart.css"]) {
      expect(sheetRules(name)).not.toMatch(/trade-(?:up|down)/);
    }
  });

  it("sets words in the sans and figures in the mono, with no caps in the desk chrome", () => {
    expect(css).toMatch(/\.lit-desk\s*\{[^}]*font-family: var\(--font-mono\);[^}]*font-size: 12px;[^}]*font-variant-numeric: tabular-nums;/s);
    expect(css).toMatch(/\.lit-desk-topbar\s*\{[^}]*font-family: var\(--font-sans\);[^}]*font-size: 13px;/s);
    for (const name of CHROME_SHEETS) {
      expect(sheetRules(name)).not.toMatch(/text-transform:\s*uppercase/);
    }
    // Type stays within the desk's sizes and the sans's weights.
    const sizes = [...rules.matchAll(/font-size: (\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(36);
    expect(rules).not.toMatch(/font-weight: (?:[7-9]\d\d|bold)/);
    expect(rules).not.toContain("Departure Mono");
  });

  it("keeps the surface law on every desk sheet: no radius, shadow, blur, fade or raw colour", () => {
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
    expect(css).toMatch(/\.lit-desk-topbar\[data-lighter-zen\]\s*\{[^}]*position: absolute;/s);
  });

  it("lets the desk chat in the Vex sidebar speak the room without a re-projection", () => {
    // The chat's transcript and composer are the shell's own components; with
    // the desk on the room's aliases they need no copy of the palette, and a
    // re-projection onto `--lit-*` would close a var() cycle.
    expect(css).not.toMatch(/--vex-alias-[a-z0-9-]+: var\(--lit-/);
    // The BOOK column is gone: no rule targets it.
    expect(rules).not.toContain('[data-vex-area="book-panel"]');
  });

  it("themes live thinking with the desk's focus blue, flat", () => {
    expect(css).toMatch(/\.lit-chat-shell \.vex-turn-shimmer\s*\{[^}]*background: none;[^}]*color: var\(--lit-focus\);/s);
    expect(rules).not.toMatch(/linear-gradient\(\s*(?:90deg|180deg)/);
  });
});
