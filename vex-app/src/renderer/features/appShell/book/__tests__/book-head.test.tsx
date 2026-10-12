/**
 * THE BOOK HEAD UNDER THE WINDOW CONTROLS (docs/design/V10-SPREAD.md
 * section 8).
 *
 * On Windows and Linux the native caption buttons sit over the top right of
 * the window, over the BOOK's head row. Two things broke there:
 *
 *  - the row's rule stopped where the buttons began. The rule is the head's
 *    own (it spans the page); the native overlay is an opaque plate and at
 *    the row's full 44px it painted over it. The overlay is now 1px short of
 *    the row (main-window-chrome.test.ts pins that side);
 *  - on a narrow BOOK the worded strip outgrew what the reserve left it, and
 *    Lighter and the collapse key went under the buttons or under each other.
 *
 * The head is now a size container that swaps the words for pixel icons when
 * they do not fit. jsdom evaluates no container query, so this suite pins the
 * two halves it can see: the DOM (both forms present, the word as each
 * control's name and tooltip, the collapse key outside the strip) and the
 * sheet (the container, the query and the width it switches at).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../PositionBlock.js", () => ({
  PositionBlock: () => <div data-testid="card-position" />,
}));
vi.mock("../WalletPairCard.js", () => ({
  WalletPairCard: () => <div data-testid="card-wallets" />,
}));
vi.mock("../portfolio/BalancesCard.js", () => ({
  BalancesCard: () => <div data-testid="card-balances" />,
}));
vi.mock("../SessionActivityCard.js", () => ({
  SessionActivityCard: () => <div data-testid="card-activity" />,
}));
vi.mock("../SessionBlock.js", () => ({
  SessionBlock: () => <div data-testid="card-session" />,
}));
vi.mock("../ImageLockerCard.js", () => ({
  ImageLockerCard: () => <div data-testid="card-images" />,
}));
vi.mock("../board/ActiveBoardModule.js", () => ({
  ActiveBoardModule: () => <div data-testid="board-module" />,
}));

const { BookRailFrame } = await import("../BookRailFrame.js");
const { BookRailStack } = await import("../BookRailStack.js");
const { useUiStore } = await import("../../../../stores/uiStore.js");
const { useBoardSurfaceStore } = await import(
  "../../Board/board-surface-store.js"
);
const { boardRefOf } = await import("../../Board/board-surface-contracts.js");
const { boardSpec } = await import("../../Board/__tests__/boardFixture.js");

const SESSION = "00000000-0000-4000-8000-00000000dddd";

const here = path.dirname(fileURLToPath(import.meta.url));
const bookCss = readFileSync(
  path.join(here, "../../../../styles/global-css/book.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function renderHead(bookOpen = true) {
  return render(
    <BookRailFrame label="Session book" bookOpen={bookOpen} onToggle={() => {}}>
      <BookRailStack scope={{ kind: "session", sessionId: SESSION }} />
    </BookRailFrame>,
  );
}

function head(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".vex-bk__head");
  if (el === null) throw new Error("no BOOK head");
  return el;
}

/** The sprite symbol a control's pixel icon points at. */
function iconOf(control: HTMLElement): string | null {
  return control.querySelector("svg use")?.getAttribute("href") ?? null;
}

/** The body of the first `selector { ... }` block in the sheet. */
function block(selector: string): string {
  const at = bookCss.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return bookCss.slice(at, bookCss.indexOf("}", at));
}

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ bookSectionOrder: [], bookTab: "portfolio", runtimeMode: "agent" });
  useBoardSurfaceStore.setState({
    latestBoard: null,
    pinnedBoard: null,
    modalBoard: null,
    unseenBoardKey: null,
  });
});

afterEach(cleanup);

describe("the BOOK head's controls", () => {
  it("seats the strip in the head and the collapse key after it, outside the strip", () => {
    renderHead();
    const row = head();
    const strip = screen.getByRole("group", { name: "Book instruments" });
    expect(row.contains(strip)).toBe(true);
    const collapse = screen.getByRole("button", { name: "Collapse the BOOK panel" });
    expect(row.lastElementChild).toBe(collapse);
    expect(strip.contains(collapse)).toBe(false);
    expect(collapse.classList.contains("vex-bk__key")).toBe(true);
  });

  it("gives every control its word as its name and a pixel icon picked by meaning", () => {
    renderHead();
    const portfolio = screen.getByRole("tab", { name: "Portfolio" });
    const board = screen.getByRole("tab", { name: "Board" });
    const lighter = screen.getByRole("button", { name: "Lighter" });

    expect(portfolio.getAttribute("aria-label")).toBe("Portfolio");
    expect(board.getAttribute("aria-label")).toBe("Board");
    expect(lighter.getAttribute("aria-label")).toBe("Lighter");

    expect(iconOf(portfolio)).toBe("#px-portfolio");
    expect(iconOf(board)).toBe("#px-chart");
    expect(iconOf(lighter)).toBe("#px-external");

    // Both forms are in the DOM; the head's width picks which one shows.
    expect(portfolio.querySelector(".vex-bk__word")?.textContent).toBe("Portfolio");
    expect(board.querySelector(".vex-bk__word")?.textContent).toBe("Board");
    expect(lighter.querySelector(".vex-bk__word")?.textContent).toBe("Lighter");
  });

  it("keeps the worded tab's selected treatment on the icon tab", () => {
    renderHead();
    const board = screen.getByRole("tab", { name: "Board" });
    expect(board.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(board);
    expect(board.getAttribute("aria-selected")).toBe("true");
    expect(board.classList.contains("border-accent-primary")).toBe(true);
    expect(board.classList.contains("text-accent-primary")).toBe(true);
  });

  it("names the unseen board in the Board tab's label, word or icon", () => {
    renderHead();
    act(() => {
      useBoardSurfaceStore
        .getState()
        .noteBoardRow(boardRefOf(SESSION, 12, boardSpec({ title: "Token Radar" })), "live-append");
    });
    const board = screen.getByRole("tab", { name: "Board, new board" });
    expect(board.querySelector(".vex-bk__unseen")).not.toBeNull();
  });

  it.each([
    ["tab", "Portfolio"],
    ["tab", "Board"],
    ["button", "Lighter"],
  ] as const)("shows a %s tooltip with the word: %s", (role, name) => {
    renderHead();
    const control = screen.getByRole(role, { name });
    fireEvent.focus(control);
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toBe(name);
    // Inside the strip, so the head's query can hide it while the word shows.
    expect(screen.getByRole("group", { name: "Book instruments" }).contains(tip)).toBe(true);
    fireEvent.blur(control);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps the collapsed spine's toggle and no strip", () => {
    renderHead(false);
    expect(screen.getByRole("button", { name: "Expand the BOOK panel" })).not.toBeNull();
    expect(screen.queryByRole("group", { name: "Book instruments" })).toBeNull();
  });
});

describe("the BOOK head's sheet (book.css)", () => {
  // Departure Mono: advance 350 of 550 units, 11px, .14em tracking.
  const letter = (350 / 550) * 11 + 0.14 * 11;
  const words = (n: number): number => n * letter;
  // The worded strip at its widest (the Board tab's unseen dot showing):
  // PORTFOLIO, 18, BOARD + dot 15, 18, door 1 + 16 + LIGHTER + 6 + icon 16.
  const wordedStrip = words(9) + 18 + words(5) + 15 + 18 + 1 + 16 + words(7) + 6 + 16;
  // The head's content box also holds the 8px gap and the 28px collapse key.
  const wordedNeed = wordedStrip + 8 + 28;
  const SWITCH = 308;
  /** The head's content box: BOOK less its left rule, 20 start, the reserve. */
  const contentBox = (book: number, overlay: number): number => book - 1 - 20 - (overlay + 8);

  it("makes the open head a named inline-size container, never the closed spine", () => {
    expect(block(".vex-bk__head")).toContain("container: vex-bk-head / inline-size;");
    expect(block('.vex-bk[data-vex-book-open="false"] .vex-bk__head')).toContain(
      "container-type: normal;",
    );
  });

  it("puts the rule on the head row itself, which spans the page", () => {
    expect(block(".vex-bk__head")).toContain("border-bottom: 1px solid var(--vex-alias-rule);");
  });

  it("never shrinks the collapse key and clips the slot before it", () => {
    expect(block(".vex-bk__key")).toContain("flex-shrink: 0;");
    expect(block(".vex-bk__slot")).toContain("overflow-x: clip;");
  });

  it("swaps words for icons below the worded strip's width", () => {
    const query = `@container vex-bk-head (width < ${String(SWITCH)}px) {`;
    const at = bookCss.indexOf(query);
    expect(at).toBeGreaterThan(-1);
    const body = bookCss.slice(at, bookCss.indexOf("\n}", at));
    expect(body).toMatch(/\.vex-bk__word \{\s*display: none;/);
    expect(body).toMatch(/\.vex-bk__glyph \{\s*display: block;/);
    expect(block(".vex-bk__glyph")).toContain("display: none;");
    expect(bookCss).toContain(`@container vex-bk-head (width >= ${String(SWITCH)}px) {`);
    expect(SWITCH).toBeGreaterThanOrEqual(wordedNeed);
  });

  it("keeps the words on macOS at 340 and fits the icons at 300 under the Windows buttons", () => {
    expect(contentBox(340, 0)).toBeGreaterThanOrEqual(SWITCH);
    expect(contentBox(340, 138)).toBeLessThan(SWITCH);
    // Icon-only: 26 + 2 + 26, 4, the door 1 + 5 + 16 + 5; then 8 and 28.
    const iconNeed = 26 + 2 + 26 + 4 + 27 + 8 + 28;
    expect(contentBox(300, 138)).toBeGreaterThanOrEqual(iconNeed);
  });
});
