/**
 * The H3 page frame's sheet, read as text (docs/design/H3-DESKTOP.md sections
 * 1.9 and 1.11; VEX Cloud's page kit, `apps/web/src/styles/page.css`): jsdom
 * does not lay out CSS, so the values the design fixes are pinned where they
 * are written in `book.css`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const book = readFileSync(resolve(here, "../../../../styles/global-css/book.css"), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`no rule for ${selector}`);
  return match[1] ?? "";
}

describe("the page frame: width and the reading line (C3-E-03)", () => {
  it("stands its blocks at the left, 24 in, at most 1136 wide", () => {
    const frame = rule(book, '.vex-ov[data-frame="h3"][data-width]');
    expect(frame).toContain("--vex-ov-in: 24px;");
    expect(frame).toContain("--vex-ov-max: calc(var(--vex-ov-in) + 1136px + var(--vex-ov-pad));");
    expect(frame).not.toContain("--vex-ov-max: none");
    const body = rule(book, '.vex-ov[data-frame="h3"][data-width] .vex-ov__body');
    expect(body).toContain("margin-inline: 0;");
    expect(body).toContain("padding-inline-start: var(--vex-ov-in);");
  });

  it("with her column standing, starts the body and the tabs row on the reading line", () => {
    expect(
      rule(
        book,
        '.vex-shell-frame[data-vex-frame="h3"][data-vex-seat="column"] .vex-ov[data-frame="h3"][data-width]',
      ),
    ).toContain("--vex-ov-in: calc(var(--vex-read-x) / var(--vex-zoom, 1));");
    expect(
      rule(
        book,
        '.vex-shell-frame[data-vex-frame="h3"][data-vex-seat="column"] .vex-ov[data-frame="h3"] > .vex-pg-bar',
      ),
    ).toContain("padding-left: var(--vex-read-x);");
  });
});

describe("the Board keeps the whole column (section 4.9)", () => {
  it("lifts the cap and the reading line for the board's grid", () => {
    expect(book).toMatch(
      /\.vex-ov\[data-frame="h3"\]\[data-width\]:has\(> \.vex-ov__scroll > \.vex-ov__body > \.vex-bd\)[^{]*\{\s*--vex-ov-in: 24px;\s*--vex-ov-max: none;/,
    );
  });
});

const memory = readFileSync(resolve(here, "../../../../styles/global-css/memory.css"), "utf8");

describe("page leads (C3-E-05, VEX Cloud's `.vx-pglead`)", () => {
  it("set every lead at most 760 wide", () => {
    expect(rule(book, ".vex-pf-lead")).toContain("max-width: 760px;");
    expect(rule(book, '.vex-ov[data-frame="h3"] .vex-scan-lead')).toContain("max-width: 760px;");
    expect(rule(book, ".vex-mk__lead")).toContain("max-width: 760px;");
    expect(rule(memory, ".vex-mem-lead")).toMatch(
      /max-width: 760px;[\s\S]*font-size: 14px;[\s\S]*line-height: 1.5;[\s\S]*label-secondary/,
    );
  });

  it("on Portfolio, the sentence in ink 2 and what the total includes muted", () => {
    expect(rule(book, ".vex-pf-lead__ink")).toContain("color: var(--vex-alias-label-secondary);");
    expect(rule(book, ".vex-pf-lead .vex-pf-top__line")).toContain(
      "color: var(--vex-alias-label-tertiary);",
    );
  });
});

describe("Balances and All assets tables (C3-E-06, VEX Cloud's data table)", () => {
  const t = ".vex-pf-t:is(.vex-pf-t--balances, .vex-pf-t--register)";
  it("frame the table on the card ground", () => {
    expect(rule(book, t)).toMatch(/border: 1px solid var\(--vex-alias-rule\);\s*background: var\(--vex-alias-card\);/);
  });
  it("draw a 34 head, 48 rows, cells 12 in and the first 16 in", () => {
    expect(rule(book, `${t} th`)).toMatch(/height: 34px;\s*padding: 0 12px;/);
    expect(rule(book, `${t} td`)).toMatch(/height: 48px;\s*padding: 0 12px;/);
    expect(rule(book, `${t} :is(th, td):first-child`)).toContain("padding-left: 16px;");
  });
  it("wash a row under a hovering pointer", () => {
    expect(book).toMatch(
      /@media \(hover: hover\) \{\s*\.vex-pf-t:is\(\.vex-pf-t--balances, \.vex-pf-t--register\) tbody tr:hover > td \{\s*background: var\(--vex-alias-interactive-hover\);/,
    );
  });
});

describe("Agent Scan's feed (C3-E-07, VEX Cloud's `.vx-rows`)", () => {
  it("frames the rows on the card ground without changing their measured heights", () => {
    expect(rule(book, '.vex-ov[data-frame="h3"] .vex-scan-rows')).toMatch(
      /outline: 1px solid var\(--vex-alias-rule\);\s*outline-offset: -1px;\s*background: var\(--vex-alias-card\);/,
    );
  });
  it("sets each row at least 56 high and 20 in, and the day heads on that inset", () => {
    expect(rule(book, '.vex-ov[data-frame="h3"] .vex-scan-rows .vex-scan-row')).toMatch(
      /min-height: 56px;\s*padding: 10px 20px;/,
    );
    expect(rule(book, '.vex-ov[data-frame="h3"] .vex-scan-rows .vex-scan-day')).toContain(
      "padding-inline: 20px;",
    );
  });
});

describe("the tab cells (C3-E-10)", () => {
  it("pad each cell 22 each side, Cloud's tab cell", () => {
    expect(rule(book, ".vex-pg-tab")).toContain("padding: 0 22px;");
  });
});

describe("the figure strip (C3-E-11, VEX Cloud's `.vx-fstrip`)", () => {
  it("gives the wallet total's track 1.3 to the others' 1", () => {
    expect(rule(book, '.vex-pf-tiles[data-count="2"]')).toContain(
      "grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);",
    );
    expect(rule(book, '.vex-pf-tiles[data-count="3"]')).toContain(
      "grid-template-columns: minmax(0, 1.3fr) repeat(2, minmax(0, 1fr));",
    );
    expect(rule(book, '.vex-pf-tiles[data-count="4"]')).toContain(
      "grid-template-columns: minmax(0, 1.3fr) repeat(3, minmax(0, 1fr));",
    );
  });
  it("wraps four tiles two by two under 900, with equal tracks and no hole", () => {
    expect(book).toMatch(
      /@container vex-pf \(width < 900px\) \{\s*\.vex-pf-tiles\[data-count="4"\] \{\s*--vex-pf-tiles: 2;\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    );
  });
});

describe("the equity box (C3-E-12)", () => {
  it("has a 44 head", () => {
    expect(rule(book, ".vex-pf-chart__h")).toContain("min-height: 44px;");
  });
  it("draws the range as Cloud's brand segments: the chosen one framed on the raised ground, never blue", () => {
    expect(rule(book, ".vex-pf-range__item")).toMatch(/min-height: 32px;[\s\S]*padding: 0 14px;/);
    const chosen = rule(book, '.vex-pf-range__item[aria-checked="true"]');
    expect(chosen).toContain("border-color: var(--vex-alias-rule-chosen);");
    expect(chosen).toContain("background: var(--vex-alias-interactive-solid);");
    expect(chosen).not.toMatch(/accent|blue/);
    expect(book).not.toContain(".vex-pf-chart__h .vex-pg-tab");
  });
});

describe("section head rhythm (C3-E-13, VEX Cloud's `.vx-psec-h`)", () => {
  it("keeps 12 under a Portfolio section head", () => {
    expect(rule(book, ".vex-pf-sec__h")).toContain("margin: 0 0 12px;");
  });
  it("keeps 6 to Memory's lead and 12 under it, with the count 12 muted tabular", () => {
    expect(rule(memory, ".vex-mem-sec__head")).toContain("margin: 0 0 6px;");
    expect(rule(memory, ".vex-mem-sec__lead")).toContain("margin: 0 0 12px;");
    expect(rule(memory, ".vex-mem-sec__count")).toMatch(
      /font-size: 12px;\s*font-variant-numeric: tabular-nums;\s*color: var\(--vex-alias-label-tertiary\);/,
    );
  });
});

describe("Memory takes Cloud's built page as its plate (owner decision 2026-11-09)", () => {
  it("goes to two columns from a 760 page, the side 300 wide", () => {
    expect(rule(memory, ".vex-mem-page")).toContain("container: vex-mem-page / inline-size;");
    expect(memory).toMatch(
      /@container vex-mem-page \(width >= 760px\) \{\s*\.vex-mem-g \{\s*grid-template-columns: minmax\(0, 1fr\) 300px;/,
    );
  });
  it("stands the guarantee box and the register lists on the card ground, rows 16 in, heads at 12", () => {
    expect(rule(memory, ".vex-mem-card")).toMatch(/padding: 12px 16px;[\s\S]*background: var\(--vex-alias-card\);/);
    expect(rule(memory, ".vex-mem-list")).toContain("background: var(--vex-alias-card);");
    expect(rule(memory, ".vex-mem-row")).toContain("padding: 12px 16px;");
    expect(rule(memory, ".vex-mem-sec__title")).toContain("font-size: 12px;");
  });
});

describe("Vex Inference funds take Cloud's built page as the plate (owner decision 2026-11-09)", () => {
  it("frames the Balance box on the card ground with a 44 head and 20 mono figures", () => {
    expect(rule(book, ".vex-inf-bal")).toContain("background: var(--vex-alias-card);");
    expect(rule(book, ".vex-inf-bal__h")).toContain("min-height: 44px;");
    expect(rule(book, ".vex-inf-fig__v")).toMatch(/font-family: var\(--font-mono\);\s*font-size: 20px;/);
    expect(rule(book, ".vex-inf-figs")).toContain("grid-template-columns: repeat(2, minmax(0, 1fr)) auto;");
  });
  it("keeps the box's keys off the blue, and frames the forms at most 760 wide", () => {
    expect(rule(book, ".vex-inf-key")).not.toMatch(/accent|blue/);
    expect(rule(book, ".vex-inf-forms")).toContain("max-width: 760px;");
    expect(rule(book, ".vex-inf-panel")).toContain("background: var(--vex-alias-card);");
  });
});
