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
