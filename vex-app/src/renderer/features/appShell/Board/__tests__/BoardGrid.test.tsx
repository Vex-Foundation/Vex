/**
 * THE BOARD GRID - the list, the filter, and the words nothing may delete.
 *
 * THE ACCESSIBLE NAME CARRIES THE TRUE POOL COUNT. A filter is a VIEW, not a
 * redefinition of the board: a reader who has narrowed a six-pool board to
 * one chain is told both numbers, because "1 pool" alone misdescribes the
 * board they opened.
 *
 * THE AUTHORED-CONTENT REGRESSION is the other subject. Replacing the old
 * in-transcript block with a card grid would have silently deleted every
 * model-written string from every board already sitting in a transcript.
 * `buildBoardAuthoredContent` is where that becomes a testable claim about
 * one function rather than a hope about five components, and the test below
 * drives it through the rendered disclosure: captions, per-pool assessments,
 * board notes, annotation labels WITH their unmatched-marker reasons,
 * provenance and both composition clocks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useUiStore } from "../../../../stores/uiStore.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { BoardGrid, boardFootnote, boardGridLabel } from "../BoardGrid.js";
import {
  BOARD_FILTER_NONE,
  useBoardSurfaceStore,
} from "../board-surface-store.js";
import { boardRefOf, type BoardRef } from "../board-surface-contracts.js";
import { useBoardLiveOverlayStore } from "../board-live-overlay.js";
import { boardSpec, hydratedRow } from "./boardFixture.js";

const readBoardIcon = vi.fn();
const prefetchBoardDetails = vi.fn();
const getSession = vi.fn();

/** An abortable invocation, as the two board bridges now return one. */
function invocation<T>(value: T): { promise: Promise<T>; cancel: () => void } {
  return { promise: Promise.resolve(value), cancel: vi.fn() };
}

function resetStores(): void {
  useBoardSurfaceStore.setState({
    latestBoard: null,
    pinnedBoard: null,
    modalBoard: null,
    unseenBoardKey: null,
    surfaceKey: null,
    view: "grid",
    selectedPoolIndex: 0,
    filter: BOARD_FILTER_NONE,
    scrollTop: 0,
    askPanelOpen: false,
    liveRequested: false,
    modalGeneration: 0,
    spotlightGeneration: 0,
  });
  useBoardLiveOverlayStore.setState({ published: null });
}

beforeEach(() => {
  resetStores();
  readBoardIcon.mockReset();
  prefetchBoardDetails.mockReset();
  getSession.mockReset();
  // Every pool answers `not_mounted`, which is the honest shape of a board
  // opened before the market services finished mounting: the classifier reads
  // it as evidence and the cards keep their unchecked chips.
  prefetchBoardDetails.mockImplementation(
    (input: { pools: { chain: string; pairAddress: string }[] }) =>
      invocation({
        ok: true,
        data: {
          entries: input.pools.map((subject) => ({
            key: `${subject.chain}:${subject.pairAddress}`.toLowerCase(),
            subject,
            outcome: { kind: "unavailable", reason: "not_mounted" },
          })),
        },
      }),
  );
  // The source session of every fixture board, as the session read returns it.
  getSession.mockResolvedValue({
    ok: true,
    data: { id: "session-1", title: "Agent session", initialGoal: null },
  });
  readBoardIcon.mockResolvedValue({
    ok: true,
    data: { iconId: "abcd1234", icon: { kind: "not_found" } },
  });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      boardIcons: { read: readBoardIcon },
      boardDetails: { prefetch: prefetchBoardDetails },
      sessions: { get: getSession },
    },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

function twoChainBoard(): BoardRef {
  const pools = [
    { chain: "base", pairAddress: "0xaaa111", analysis: null },
    { chain: "solana", pairAddress: "0xbbb222", analysis: null },
    { chain: "base", pairAddress: "0xccc333", analysis: null },
  ];
  return boardRefOf(
    "session-1",
    12,
    boardSpec({
      title: "Token Radar",
      pools,
      rows: pools.map((pool, index) =>
        hydratedRow({ baseTokenSymbol: `T${String(index)}`, chainId: pool.chain }),
      ),
    }),
  );
}

function authoredBoard(): BoardRef {
  const pools = [
    {
      chain: "base",
      pairAddress: "0xaaa111",
      caption: "Volume led the move.",
      analysis: "Momentum is elevated.\nLiquidity is thin above the range.",
    },
  ];
  return boardRefOf(
    "session-1",
    13,
    boardSpec({
      title: "Composed board",
      pools,
      rows: [hydratedRow()],
      notes: ["Figures were read during a volatile hour."],
      // No explicit `chart`: the fixture derives one from the annotations,
      // and passing both would make it ignore them.
      annotations: [
        { kind: "level", price: "0.00000123", label: "Prior high" },
        { kind: "marker", atMs: 1_783_100_000_000, label: "Listing" },
      ],
    }),
  );
}

function mount(board: BoardRef): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={client}>
      <BoardGrid board={board} />
    </QueryClientProvider>
  );
}

describe("boardGridLabel", () => {
  it("names only the board's own size when nothing is filtered", () => {
    expect(boardGridLabel(6, 6)).toBe("6 pools on this board");
    expect(boardGridLabel(1, 1)).toBe("1 pool on this board");
  });

  it("keeps the TRUE count and adds what the filter is showing", () => {
    expect(boardGridLabel(6, 2)).toBe("6 pools on this board, 2 shown by the filter");
  });
});

describe("BoardGrid", () => {
  it("renders a real list with one item per pool, in the model's order", () => {
    render(mount(twoChainBoard()));
    const list = screen.getByRole("list", { name: /3 pools on this board/ });
    expect(list.querySelectorAll("li")).toHaveLength(3);
  });

  it("draws the plate the mockup draws", () => {
    render(mount(twoChainBoard()));
    const plate = document.querySelector('[data-vex-area="board-grid-plate"]');
    expect(plate?.className).toContain("vex-board-surface");
  });

  // The subtitle belongs to the HOST now (`BoardSubtitle`, mounted in the
  // header's `subtitleSlot`), not to this view. Asserting its absence here is
  // what keeps it from quietly coming back as a second copy: two lines stating
  // one board's pool count is exactly the drift this move exists to prevent.
  it("no longer prints a subtitle of its own", () => {
    render(mount(twoChainBoard()));
    expect(
      document.querySelector('[data-vex-area="board-subtitle"]'),
    ).toBeNull();
  });

  it("offers a chain filter only when the board HAS more than one chain", () => {
    render(mount(twoChainBoard()));
    expect(
      document.querySelectorAll('[data-vex-area="board-filter-chain"]'),
    ).toHaveLength(2);
    cleanup();
    const single = boardRefOf("session-1", 14, boardSpec({ title: "One" }));
    render(mount(single));
    // A control that can only ever do nothing is not offered.
    expect(
      document.querySelectorAll('[data-vex-area="board-filter-chain"]'),
    ).toHaveLength(0);
  });

  it("does not render the filter row at all when no axis has two values", () => {
    const single = boardRefOf("session-1", 14, boardSpec({ title: "One" }));
    render(mount(single));
    expect(document.querySelector('[data-vex-area="board-grid-bar"]')).toBeNull();
    expect(document.querySelector('[data-vex-area="board-filter-label"]')).toBeNull();
  });

  it("labels the filter row visibly and seats it right above the grid", () => {
    render(mount(twoChainBoard()));
    const plate = document.querySelector('[data-vex-area="board-grid-plate"]');
    const bar = document.querySelector('[data-vex-area="board-grid-bar"]');
    expect(bar).not.toBeNull();
    // The plate is the grid's container query box, so the row sits just
    // before it: a control and the tiles it filters, read together.
    expect(bar?.nextElementSibling).toBe(plate);
    const label = bar?.querySelector('[data-vex-area="board-filter-label"]');
    expect(label?.textContent).toBe("Show");
    expect(label?.className).not.toContain("sr-only");
    // The chips are pressable filters, never bare verdict labels.
    for (const chip of bar?.querySelectorAll('[data-vex-area="board-filter-chain"]') ?? []) {
      expect(chip.tagName).toBe("BUTTON");
      expect(chip.getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("filters the CARDS without shrinking what the board is said to hold", () => {
    render(mount(twoChainBoard()));
    act(() => {
      useBoardSurfaceStore
        .getState()
        .setBoardFilter({ chain: "solana", safety: null });
    });
    const list = screen.getByRole("list", {
      name: "3 pools on this board, 1 shown by the filter",
    });
    expect(list.querySelectorAll("li")).toHaveLength(1);
  });

  it("says so honestly when a filter matches nothing", () => {
    render(mount(twoChainBoard()));
    act(() => {
      useBoardSurfaceStore
        .getState()
        .setBoardFilter({ chain: "ethereum", safety: null });
    });
    expect(
      document.querySelector('[data-vex-area="board-grid-empty"]'),
    ).not.toBeNull();
  });

  it("opens the spotlight through the store, and never on its own", () => {
    render(mount(twoChainBoard()));
    expect(useBoardSurfaceStore.getState().view).toBe("grid");
    screen.getAllByRole("button", { name: /^Spotlight / })[1]?.click();
    expect(useBoardSurfaceStore.getState().view).toBe("spotlight");
    expect(useBoardSurfaceStore.getState().selectedPoolIndex).toBe(1);
  });

  it("points the Ask block at the tile BEFORE opening it, and shows Vex", () => {
    useUiStore.setState({ shellRoute: { kind: "board", origin: null }, vexOpenPages: false });
    render(mount(twoChainBoard()));
    screen.getAllByRole("button", { name: /^Ask Vex about / })[2]?.click();
    const state = useBoardSurfaceStore.getState();
    expect(state.selectedPoolIndex).toBe(2);
    expect(state.askPanelOpen).toBe(true);
    // Ask Vex lives in the Vex sidebar, hidden by default on the Board page.
    expect(useUiStore.getState().vexOpenPages).toBe(true);
  });
});

describe("BoardGrid - the meta line and the footnote", () => {
  it("names the chat the board was composed in, one press from it", async () => {
    useUiStore.setState({ shellRoute: { kind: "board", origin: null } });
    render(mount(twoChainBoard()));
    expect(
      document.querySelector('[data-vex-area="board-meta"]')?.textContent,
    ).toContain("Composed by Vex in");
    const source = await screen.findByRole("button", { name: "Agent session" });
    act(() => {
      source.click();
    });
    expect(useUiStore.getState().shellRoute.kind).toBe("none");
    expect(getSession).toHaveBeenCalledWith({ id: "session-1" });
  });

  it("says 'this chat' while the session cannot be read, never a made-up name", () => {
    getSession.mockReturnValue(new Promise(() => undefined));
    render(mount(twoChainBoard()));
    expect(
      document.querySelector('[data-vex-area="board-source-session"]')?.textContent,
    ).toBe("this chat");
  });

  it("says where the figures come from and what Ask Vex does", () => {
    render(mount(twoChainBoard()));
    const foot = document.querySelector('[data-vex-area="board-footnote"]')?.textContent ?? "";
    expect(foot).toMatch(/^Prices and 24h changes are DexScreener figures from the snapshot at \d{2}:\d{2} UTC\./);
    expect(foot).toContain("Ask Vex sends a token to the chat behind this board.");
  });

  it("words a live board's footnote as live, with the clock of its last read", () => {
    expect(boardFootnote(true, "13:45 UTC")).toBe(
      "Prices and 24h changes are live figures, last read at 13:45 UTC. Ask Vex sends a token to the chat behind this board.",
    );
    expect(boardFootnote(false, null)).toBe(
      "Prices and 24h changes are DexScreener figures from the snapshot. Ask Vex sends a token to the chat behind this board.",
    );
  });
});

describe("BoardGrid - every authored string stays reachable", () => {
  it("carries captions, assessments, notes, annotations and provenance", () => {
    render(mount(authoredBoard()));
    const trigger = screen.getByRole("button", {
      name: /composed analysis · data notes/i,
    });
    act(() => {
      trigger.click();
    });

    const notes = document.querySelector('[data-vex-area="board-data-notes"]');
    const text = notes?.textContent ?? "";
    expect(text).toContain("Volume led the move.");
    expect(text).toContain("Momentum is elevated.");
    expect(text).toContain("Liquidity is thin above the range.");
    expect(text).toContain("Figures were read during a volatile hour.");
    expect(text).toContain("Prior high");
    expect(text).toContain("Listing");
    // The unmatched-marker reason: a marker that matched no candle is left OFF
    // the canvas, so this line is the only place the reader learns the claim
    // exists at all.
    expect(
      document.querySelector('[data-vex-area="board-note-annotation-reason"]')
        ?.textContent,
    ).toContain("matches no candle");
    expect(text).toContain("Analysis composed");
    expect(text).toContain("Figures read");
    // The safety states PRESENT on the board, each with its chip label and
    // its bucket, so the legend's words are explained where they are read.
    const states = [
      ...document.querySelectorAll('[data-vex-area="board-note-safety-state"]'),
    ];
    expect(states.length).toBeGreaterThan(0);
    expect(states[0]?.textContent).toContain("counted as");
  });

  it("says a legacy board has no saved analysis rather than hiding the section", () => {
    render(mount(boardRefOf("session-1", 15, boardSpec({ title: "Bare" }))));
    act(() => {
      screen
        .getByRole("button", { name: /composed analysis · data notes/i })
        .click();
    });
    expect(
      document.querySelector('[data-vex-area="board-data-notes-empty"]')
        ?.textContent,
    ).toContain("No saved analysis");
    // Provenance is runtime-authored and is present on EVERY board, legacy
    // included, so the section is never an empty box.
    expect(
      document.querySelector('[data-vex-area="board-note-provenance"]'),
    ).not.toBeNull();
  });

  it("keeps the disclosure collapsed until it is asked for", () => {
    render(mount(authoredBoard()));
    const trigger = screen.getByRole("button", {
      name: /composed analysis · data notes/i,
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
