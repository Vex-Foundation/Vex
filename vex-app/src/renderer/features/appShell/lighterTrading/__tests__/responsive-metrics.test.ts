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
 * the book, the market picker and the desk chat): H3's caps labels, each
 * tracked.
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

describe("Lighter desk sheets (docs/design/H3-DESKTOP.md sections 2 and 4.9)", () => {
  it("draws the desk's head in the header's title cell: where you are, then three 76 icon cells", () => {
    // The header's row, its height and its drag region are the shell's
    // (title-bar.css); the desk lays its cells out in the title cell.
    expect(css).toMatch(/\.vex-shell-head > \[data-vex-head-cell="title"\]\[data-vex-desk-head\]\s*\{[^}]*align-items: stretch;[^}]*padding: 0;/s);
    expect(css).toMatch(/\[data-vex-desk-head\] > \.vex-running-head__start,\s*\[data-vex-desk-head\] \.lit-desk-head\s*\{\s*display: contents;/s);
    // "Lighter" over the section and deployment, 24 in from the cell's edge.
    expect(css).toMatch(/\.lit-desk-head__title\s*\{[^}]*flex-direction: column;[^}]*padding-inline: 24px 16px;/s);
    expect(css).toMatch(/\.lit-desk-head__name\s*\{[^}]*font-size: 15px;/s);
    expect(css).toMatch(/\.lit-desk-head__sub\s*\{[^}]*font-size: 12px;[^}]*letter-spacing: var\(--tracking-label\);[^}]*text-transform: uppercase;/s);
    // The keys: 76-wide icon cells behind a 1px rule.
    expect(css).toMatch(/\.lit-desk-head__key\s*\{[^}]*width: 76px;[^}]*border-left: 1px solid var\(--vex-alias-rule\);/s);
    // The drawer: a flat panel hung from the header's rule, a 1px chosen rule.
    expect(css).toMatch(/\.lit-desk-nav-drawer\s*\{[^}]*position: absolute;[^}]*top: 100%;/s);
    expect(css).toMatch(/\.lit-desk-nav-drawer\s*\{[^}]*border: 1px solid var\(--vex-alias-rule-chosen\);/s);
  });

  it("puts the Vex key over her column and, on Windows and Linux, folds its chevron into the state cell", () => {
    expect(css).toMatch(/\.vex-shell-frame\[data-vex-frame="desk"\] \.vex-shell-head > \[data-vex-head-cell="vex-key"\]\s*\{[^}]*border-right: 0;[^}]*border-left: 1px solid/s);
    expect(css).toMatch(/html\[data-chrome="overlay"\] \.vex-shell-frame\[data-vex-frame="desk"\] \.vex-key__chevron\s*\{[^}]*border-left: 0;/s);
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

  it("lays the ticket out in cells: the account row, Market | Limit, the fields, the foot", () => {
    expect(css).toMatch(/\.lit-ticket-meta\s*\{[^}]*min-height: 40px;[^}]*border-bottom: 1px solid var\(--vex-alias-rule\);/s);
    expect(css).toMatch(/\.lit-order-type-controls\s*\{[^}]*height: 40px;[^}]*border-bottom: 1px solid var\(--vex-alias-rule\);/s);
    expect(css).toMatch(/\.lit-order-type-controls > button\[aria-pressed="true"\]\s*\{[^}]*background: var\(--lit-pressed\);/s);
    // Only the order fields scroll.
    expect(css).toMatch(/\.lit-ticket-body\s*\{[^}]*overflow-y: auto;/s);
    expect(css).toMatch(/\.lit-ticket-footer\s*\{[^}]*flex: 0 0 auto;[^}]*margin-top: auto;/s);
    // Review with Vex is a key cell on the raised fill, never the blue.
    expect(css).toMatch(/\.lit-ask-draft\s*\{[^}]*background: var\(--vex-alias-interactive-solid\);[^}]*text-transform: uppercase;/s);
    expect(css).toMatch(/\.lit-review-note\s*\{[^}]*border-top: 1px solid var\(--vex-alias-rule\);/s);
  });

  it("draws Long and Short as raised cells, the side word in gain or loss, never a fill of the pair or the blue", () => {
    expect(css).toMatch(/\.lit-side-actions \.lit-review-button\s*\{[^}]*min-height: 56px;[^}]*background: var\(--vex-alias-interactive-solid\);/s);
    expect(css).toContain('.lit-side-actions .lit-review-button[data-side="buy"] b { color: var(--lit-trade-up); }');
    expect(css).toContain('.lit-side-actions .lit-review-button[data-side="sell"] b { color: var(--lit-trade-down); }');
    expect(css).not.toMatch(/\.lit-review-button\[data-side="(?:buy|sell)"\]\s*\{[^}]*background: var\(--vex-alias-trade-/s);
    expect(css).not.toMatch(/\.lit-side-actions[^{]*\{[^}]*background: var\(--lit-action\)/s);
    // No arrows: the word carries the side.
    expect(rules).not.toMatch(/\.lit-side-actions[^{]*b::before/);
    // A disabled key is the cell fill with muted words (H3 section 2.4).
    expect(css).toMatch(/\.lit-side-actions \.lit-review-button:disabled\s*\{[^}]*background: var\(--vex-alias-bg-layer-3\);[^}]*color: var\(--lit-ink-muted\);/s);
  });

  it("keeps order-behaviour choices legible at desk density", () => {
    expect(css).toMatch(/\.lit-tif-tabs button\s*\{[^}]*min-height: 28px;[^}]*font-size: 12\.5px;/s);
  });

  it("gives desk actions visible focus and a reduced-motion floor", () => {
    expect(css).toMatch(/\.lit-ticket button:focus-visible,[\s\S]*outline: 2px solid var\(--lit-focus\);/s);
    expect(css).toMatch(/\.lit-desk button:focus-visible,[\s\S]*outline: 2px solid var\(--lit-focus\);/s);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.lit-desk \*/s);
  });

  it("names what the market bar sheds by its metric, never by its position", () => {
    const bar = sheetRules("lighter-market-bar.css");
    expect(bar).toMatch(/@container \(max-width: 1100px\)\s*\{[^}]*data-metric="index"[^}]*data-metric="volume"/s);
    expect(bar).toMatch(/@container \(max-width: 760px\)\s*\{[^}]*data-metric="mark"[^}]*data-metric="open-interest"/s);
    expect(css).not.toMatch(/\.lit-market-metric:nth-of-type/);
    expect(css).not.toMatch(/@media \(max-width: 1440px\)/);
  });

  it("draws the market bar as one 56 row of cells across the desk", () => {
    expect(css).toMatch(/\.lit-desk-top\s*\{[^}]*container-type: inline-size;[^}]*height: 56px;[^}]*padding: 0;/s);
    const bar = sheetRules("lighter-market-bar.css");
    // Every cell behind a 1px rule; the market key on the cell fill.
    expect(bar).toMatch(/\.lit-market-bar > :is\(\.lit-market-select, \.lit-market-deploy, \.lit-market-price, \.lit-market-metric\)\s*\{[^}]*border-right: 1px solid var\(--vex-alias-rule\);/s);
    expect(bar).toMatch(/button\.lit-market-select\s*\{[^}]*background: var\(--vex-alias-bg-layer-3\);/s);
    expect(bar).toMatch(/button\.lit-market-select b\s*\{[^}]*font-size: 17px;/s);
    // The last price over its day change, a trading value.
    expect(bar).toMatch(/\.lit-market-price b\s*\{[^}]*font-size: 18px;/s);
    expect(bar).toContain('.lit-market-price[data-tone="positive"] small { color: var(--lit-trade-up); }');
    expect(bar).toContain('.lit-market-price[data-tone="negative"] small { color: var(--lit-trade-down); }');
    // A figure: its caps label over the mono value.
    expect(bar).toMatch(/\.lit-market-metric small\s*\{[^}]*font-size: 11px;[^}]*letter-spacing: var\(--tracking-label\);[^}]*text-transform: uppercase;/s);
    // LIVE at the right end, a status square in the status green.
    expect(bar).toMatch(/\.lit-live-status\s*\{[^}]*margin-left: auto;/s);
    expect(bar).toContain('.lit-live-status[data-status="live"] i { background: var(--vex-alias-state-success-mark); }');
  });

  it("keeps the chart over the book beside a fixed ticket, and the dock across the desk", () => {
    expect(css).toMatch(/\.lit-desk-upper\s*\{[^}]*--lit-ticket-w: 340px;[^}]*grid-template-columns: minmax\(0, 1fr\) var\(--lit-ticket-w\);/s);
    expect(css).toMatch(/@media \(max-width: 1023px\)\s*\{\s*\.lit-desk-upper \{ --lit-ticket-w: 280px; \}/s);
    expect(css).toMatch(/\.lit-desk-main\s*\{[^}]*display: grid;/s);
    // Five levels a side, four under an 800-high window.
    expect(css).toContain('.lit-book-column[data-book-rows="5"] .lit-book-rows > .lit-book-row:nth-child(n + 6)');
    expect(css).toContain('.lit-book-column[data-book-rows="4"] .lit-book-rows > .lit-book-row:nth-child(n + 5)');
    expect(css).toMatch(/\.lit-ticket-content,\s*\.lit-ticket\s*\{[^}]*min-height: 0;[^}]*height: 100%;[^}]*flex: 1 1 auto;/s);
    expect(css).toMatch(/\.lit-ticket-column > \.lit-ticket-panel\s*\{[^}]*overflow: hidden;/s);
    expect(css).not.toMatch(/\.lit-bottom-panel\s*\{[^}]*display: none/s);
    expect(css).not.toContain(".lit-dialog");
    // The seams are the quiet rule, seen once through the clear nested grids.
    expect(css).toMatch(/\.lit-desk-body\s*\{[^}]*background: var\(--lit-line-quiet\);[^}]*gap: 1px;/s);
    expect(css).toMatch(/\.lit-desk-upper\s*\{[^}]*background: transparent;/s);
  });

  it("paints the desk from the app's aliases: one accent for both deployments, the trading pair from its aliases", () => {
    expect(css).toContain("--lit-bg: var(--vex-alias-bg-base);");
    // H3 (docs/design/H3-DESKTOP.md section 2): direction off the trading
    // values is the ink and the second ink, never the blue as a line.
    expect(css).toContain("--lit-positive: var(--vex-alias-label-primary);");
    expect(css).toContain("--lit-negative: var(--vex-alias-label-secondary);");
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
    expect(css).toContain("--lit-depth-ask: color-mix(in srgb, var(--lit-trade-down) 14%, transparent);");
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

  it("sets words in the sans and figures in the mono, every caps label tracked (H3 section 2.3)", () => {
    expect(css).toMatch(/\.lit-desk\s*\{[^}]*font-family: var\(--font-mono\);[^}]*font-size: 12px;[^}]*font-variant-numeric: tabular-nums;/s);
    // H3's labels are caps with the label tracking, in the same rule.
    for (const name of CHROME_SHEETS) {
      for (const rule of sheetRules(name).match(/[^{}]*\{[^}]*\}/g) ?? []) {
        if (/text-transform:\s*uppercase/.test(rule)) {
          expect(rule, `${name}: ${rule.slice(0, 80)}`).toMatch(/letter-spacing: var\(--tracking-label\)/);
        }
      }
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

  it("paints the candles and their volume in the gain and loss pair, inside the chart canvas only", () => {
    expect(css).toMatch(/\.lit-desk \.lit-chart-canvas\s*\{[^}]*--lit-candle-up: var\(--vex-alias-trade-up\);[^}]*--lit-candle-down: var\(--vex-alias-trade-down\);/s);
    // Declared once, on the canvas host, and never painted with by a sheet.
    expect(rules.match(/--lit-candle-(?:up|down):/g)).toHaveLength(2);
    expect(rules).not.toContain("var(--lit-candle-");
  });

  it("frames the chart in a 40 row of cells over a 40 wide drawing strip", () => {
    expect(css).toMatch(/\.lit-chart-body\s*\{[^}]*--lit-chart-toolbar: 40px;[^}]*--lit-chart-rail: 40px;/s);
    const tools = sheetRules("chart-tools.css");
    expect(tools).toMatch(/\.lit-analysis-toolbar\s*\{[^}]*height: var\(--lit-chart-toolbar, 40px\);[^}]*border-bottom: 1px solid var\(--vex-alias-rule\);/s);
    expect(tools).toMatch(/\.lit-drawing-rail\s*\{[^}]*width: var\(--lit-chart-rail, 40px\);/s);
    // The snapshot key ends the row.
    expect(tools).toMatch(/\.lit-analysis-toolbar \.lit-chart-export\s*\{[^}]*width: 40px;[^}]*margin-left: auto;/s);
    // The chosen interval on raised 2, never the blue.
    expect(sheetRules("lighter-chart.css")).toMatch(/\.lit-resolution-tabs button\[aria-pressed="true"\]\s*\{[^}]*background: var\(--lit-pressed\);/s);
  });

  it("draws Zen as the chart under one 76 row, the lights' 92 kept, and folded no drag region", () => {
    // The approved `lighter-zen` plate (plan row S8-12): the header does not
    // stand; the chart's toolbar is Zen's row, the header's height.
    expect(css).toMatch(/\.vex-shell-frame\[data-lighter-zen\] > \.vex-shell-head \{ display: none; \}/);
    expect(css).toMatch(/\.lit-desk\[data-zen-mode\] \.lit-chart-body \{ --lit-chart-toolbar: var\(--head-h\); \}/);
    expect(css).toMatch(/html\[data-os="mac"\] \.lit-desk\[data-zen-mode\] \.lit-analysis-toolbar \{ padding-inline-start: 92px; \}/);
    expect(css).toMatch(/\.lit-desk\[data-zen-mode\] \.lit-analysis-toolbar\s*\{[^}]*padding-inline-end: var\(--overlay-w\);[^}]*-webkit-app-region: drag;/s);
    // Folded, the chart takes the window and the row is no drag region.
    expect(css).toMatch(/\.lit-desk\[data-zen-controls="closed"\] \.lit-chart-body \{ --lit-chart-toolbar: 0px; \}/);
    expect(css).toMatch(/\.lit-desk\[data-zen-controls="closed"\] \.lit-analysis-toolbar\s*\{[^}]*pointer-events: none;[^}]*-webkit-app-region: no-drag;/s);
    // Nothing of the desk is drawn under it, and all of it stays mounted.
    expect(css).toMatch(/\.lit-desk\[data-zen-mode\] \.lit-desk-main > :not\(\.lit-chart-panel\)\s*\{[^}]*visibility: hidden;/s);
  });

  it("stands Zen's desk chat in her column's seat over the chart, moving it only by transform, opacity and clip", () => {
    const seat = /\.vex-shell-frame\[data-lighter-zen\] > \.lit-zen-assistant \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(seat).toMatch(/position: absolute;/);
    expect(seat).toMatch(/top: var\(--head-h\);/);
    expect(seat).toMatch(/right: 0;/);
    expect(seat).toMatch(/width: min\(var\(--lit-zen-seat, 430px\), 100vw\);/);
    const transition = /transition:([^;]*);/s.exec(seat)?.[1] ?? "";
    const animated = transition.split(",").map((part) => part.trim().split(/\s+/)[0]);
    expect(animated).toEqual(["transform", "opacity", "clip-path", "visibility"]);
  });

  it("keeps the dock's tabs and its end keys on one row under a 760 dock: REFRESH an icon cell, its word its name", () => {
    const narrow = /@container \(max-width: 760px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(narrow).toMatch(/\.lit-bottom-status > \.lit-account-refresh-button \{[^}]*width: 40px;/s);
    expect(narrow).toMatch(/\.lit-account-refresh-word \{[^}]*clip-path: inset\(50%\);/s);
    expect(narrow).not.toMatch(/\.lit-account-refresh-word \{[^}]*display: none/s);
  });

  it("keeps a short message of yours on one line in her narrow column: its clock and keys give way first", () => {
    expect(css).toMatch(/\.lit-chat-shell \.vex-you__cap \{[^}]*flex: 0 1 auto;[^}]*min-width: 0;[^}]*overflow: hidden;/s);
    expect(css).toMatch(/\.lit-chat-shell \.vex-you__stack \{[^}]*flex: 0 0 auto;[^}]*max-width: calc\(100% - 60px\);/s);
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
