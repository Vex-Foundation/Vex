/**
 * The chat's header cells (docs/design/H3-DESKTOP.md sections 1.3, 2.2 and
 * 4.2; Appendix A.1): after the chat's title, a static network statement,
 * MAINNET and the REAL FUNDS mark with no chevron and no menu, and the
 * caption buttons' reserve where H3 draws PAUSE ALL. The title cell's H3
 * type (the title over its caps kind line, 24 in) is the chat sheet's, on
 * the running head's markup.
 *
 * The sheet is read as TEXT: jsdom has no cascade for imported stylesheets,
 * so a computed style would report the initial value and pass vacuously.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatHeaderCells } from "../ChatHeaderCells.js";

const SHEET = readFileSync(
  join(process.cwd(), "src/renderer/styles/global-css/console.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** One rule's declarations by its exact selector. */
function rule(selector: string): string {
  const start = SHEET.indexOf(`${selector} {`);
  expect(start, `selector not found: ${selector}`).toBeGreaterThan(-1);
  const open = SHEET.indexOf("{", start);
  return SHEET.slice(open + 1, SHEET.indexOf("}", open));
}

function cells(): HTMLElement[] {
  const { container } = render(<ChatHeaderCells />);
  return Array.from(container.children) as HTMLElement[];
}

describe("the chat's header cells", () => {
  it("are the network cell and then the caption reserve, both drag regions", () => {
    const [funds, reserve] = cells();
    expect(funds?.getAttribute("data-vex-head-cell")).toBe("funds");
    expect(reserve?.getAttribute("data-vex-head-cell")).toBe("caption-reserve");
    for (const cell of [funds, reserve]) expect(cell?.classList.contains("vex-drag")).toBe(true);
  });

  it("state Mainnet and Real funds in sentence case, the sheet setting the caps", () => {
    const [funds] = cells();
    expect(funds?.querySelector(".vex-chat-funds__net")?.textContent).toBe("Mainnet");
    expect(funds?.querySelector("[data-vex-real-funds-mark]")?.textContent).toBe("Real funds");
    expect(rule(".vex-chat-funds__net")).toMatch(/text-transform:\s*uppercase;/);
    expect(rule(".vex-chat-funds__mark")).toMatch(/text-transform:\s*uppercase;/);
  });

  it("say Main with the hatch under 1280, keeping Mainnet and Real funds for assistive tech", () => {
    const [funds] = cells();
    const short = funds?.querySelector(".vex-chat-funds__short");
    expect(short?.textContent).toBe("Main");
    expect(short?.getAttribute("aria-hidden")).toBe("true");
    expect(rule(".vex-chat-funds__short")).toMatch(/display:\s*none;/);
    const narrow = SHEET.slice(SHEET.indexOf("@media (max-width: 1279px)"));
    // The long word and the mark's words are clipped out of sight, never
    // removed from the accessibility tree; the hatch (`::before`) stays.
    expect(narrow).toMatch(
      /\.vex-chat-funds__net,\s*\.vex-chat-funds__words \{[^}]*clip-path:\s*inset\(50%\);/,
    );
    expect(narrow).toMatch(/\.vex-chat-funds__short \{\s*display:\s*inline;/);
    expect(funds?.querySelector(".vex-chat-funds__words")?.textContent).toBe("Real funds");
  });

  it("offer no menu: no control, no chevron, nothing to choose on a mainnet-only app", () => {
    const [funds] = cells();
    expect(funds?.querySelector("button, [role='button'], [aria-haspopup], svg")).toBeNull();
    expect(funds?.textContent).not.toMatch(/testnet|paper|pause/i);
  });

  it("leave PAUSE ALL out: its cell is the empty caption reserve, hidden from assistive tech", () => {
    const [, reserve] = cells();
    expect(reserve?.getAttribute("aria-hidden")).toBe("true");
    expect(reserve?.childElementCount).toBe(0);
    expect(reserve?.textContent).toBe("");
  });

  it("draws the mark as the card's stamp without its fill: the hatch glyph in ink, no plate", () => {
    const mark = rule(".vex-chat-funds__mark");
    expect(mark).not.toMatch(/background/);
    const glyph = rule(".vex-chat-funds__mark::before");
    expect(glyph).toMatch(/repeating-linear-gradient\(\s*135deg,\s*var\(--vex-alias-label-primary\)/);
    expect(glyph).toMatch(/width:\s*12px;/);
  });

  it("sets MAINNET at 13 and REAL FUNDS at 11, text 24 in, a rule before the cell", () => {
    expect(rule(".vex-chat-funds__net")).toMatch(/font-size:\s*13px;/);
    expect(rule(".vex-chat-funds__mark")).toMatch(/font-size:\s*11px;/);
    const cell = rule(".vex-shell-head > .vex-chat-funds");
    expect(cell).toMatch(/padding-inline:\s*24px;/);
    expect(cell).toMatch(/border-left:\s*1px solid var\(--vex-alias-rule\);/);
  });

  it("divides the reserve by its rule only while the caption overlay stands over it", () => {
    expect(
      rule('html[data-chrome="overlay"] .vex-shell-head > [data-vex-head-cell="caption-reserve"]'),
    ).toMatch(/border-left:\s*1px solid var\(--vex-alias-rule\);/);
  });
});

describe("the chat's title cell, in H3 type", () => {
  const TITLE = '.vex-shell-head > [data-vex-head-cell="title"]';

  it("sets its text 24 in from the cell's edge", () => {
    expect(rule(TITLE)).toMatch(/padding-left:\s*24px;/);
  });

  it("stacks the kind line under the title, never a page's crumb", () => {
    expect(rule(`${TITLE} span.vex-tb-title`)).toMatch(/flex-direction:\s*column;/);
  });

  it("draws the title in sans 14 and its kind in tracked caps 11", () => {
    const name = rule(`${TITLE} span.vex-tb-title > .vex-tb-title__name`);
    expect(name).toMatch(/font-size:\s*14px;/);
    expect(name).toMatch(/font-weight:\s*400;/);
    const sub = rule(`${TITLE} span.vex-tb-title > .vex-tb-title__sub`);
    expect(sub).toMatch(/font-size:\s*11px;/);
    expect(sub).toMatch(/text-transform:\s*uppercase;/);
    expect(sub).toMatch(/letter-spacing:\s*var\(--tracking-label\);/);
  });
});
