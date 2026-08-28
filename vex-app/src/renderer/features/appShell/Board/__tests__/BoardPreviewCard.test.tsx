/**
 * THE CHAT CARD - the summary, the door, and the thing it must never do.
 *
 * THE MODAL NEVER OPENS BY ITSELF. That is the first test in this file and
 * the reason it is first: a board arriving in a conversation is a thing to be
 * told about, not a surface to be interrupted with. Nothing here may call the
 * store's open action on mount, on arrival or on a timer, and the probe below
 * proves it by rendering the card and asserting the action was never reached.
 *
 * THE CONCLUSION IS ARITHMETIC. Its words come from the shared A11 tally, so
 * the sentence here and the chips inside the modal cannot disagree, and no
 * bucket is dropped: a pool nobody could verify is COUNTED as unchecked, not
 * quietly removed to make the board read cleaner than it is.
 *
 * LEGACY BOARDS. A board composed before `iconId` and `analysis` existed must
 * render whole. The regression this guards is a card that throws or blanks on
 * a document that is already sitting in somebody's transcript.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  BOARD_PREVIEW_PENDING_CONCLUSION,
  BoardPreviewCard,
} from "../BoardPreviewCard.js";
import { BOARD_LIVE_READOUT_SNAPSHOT } from "../board-live-overlay.js";
import { boardRefOf, type BoardRef } from "../board-surface-contracts.js";
import {
  BOARD_STALE_AFTER_MS,
  boardSpecV1Schema,
} from "@vex-lib/board/index.js";
import { FIXTURE_FETCHED_AT, boardSpec, hydratedRow } from "./boardFixture.js";

/** A hydrated row as it was persisted BEFORE `iconId` existed. */
function legacyRow(): Record<string, unknown> {
  const { iconId: _iconId, ...rest } = hydratedRow();
  return rest;
}

const readBoardIcon = vi.fn();

beforeEach(() => {
  readBoardIcon.mockReset();
  readBoardIcon.mockResolvedValue({
    ok: true,
    data: { iconId: "abcd1234", icon: { kind: "not_found" } },
  });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { boardIcons: { read: readBoardIcon } },
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

function pools(count: number): { chain: string; pairAddress: string; analysis: null }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    chain: "base",
    pairAddress: `0x${String(index).padStart(6, "a")}`,
    analysis: null,
  }));
}

function ref(count = 6, title = "Token Radar"): BoardRef {
  const poolList = pools(count);
  return boardRefOf(
    "session-1",
    41,
    boardSpec({
      title,
      pools: poolList,
      rows: poolList.map((_unused, index) =>
        hydratedRow({ baseTokenSymbol: `TOK${String(index)}` }),
      ),
    }),
  );
}

function mount(node: ReactNode): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function area(name: string): HTMLElement {
  const node = document.querySelector(`[data-vex-area="${name}"]`);
  if (node === null) throw new Error(`missing element: ${name}`);
  return node as HTMLElement;
}

describe("BoardPreviewCard", () => {
  it("NEVER opens the modal on its own", () => {
    const onOpen = vi.fn();
    render(
      mount(
        <BoardPreviewCard
          board={ref()}
          onOpen={onOpen}
          live={BOARD_LIVE_READOUT_SNAPSHOT}
        />,
      ),
    );
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens it through View board, handing back the SAME board ref", () => {
    const onOpen = vi.fn();
    const board = ref();
    render(
      mount(
        <BoardPreviewCard
          board={board}
          onOpen={onOpen}
          live={BOARD_LIVE_READOUT_SNAPSHOT}
        />,
      ),
    );
    screen.getByRole("button", { name: /view board/i }).click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(board);
  });

  it("shows the MODEL's title, a derived subtitle and the result count", () => {
    render(
      mount(
        <BoardPreviewCard
          board={ref(6, "Top gainers on Base")}
          onOpen={vi.fn()}
          live={BOARD_LIVE_READOUT_SNAPSHOT}
        />,
      ),
    );
    expect(area("board-preview-title").textContent).toBe("Top gainers on Base");
    // Derived from facts the RUNTIME owns; never words put in the model's
    // mouth.
    expect(area("board-preview-subtitle").textContent).toContain("6 pools");
    expect(area("board-preview-subtitle").textContent).toContain("UTC");
    expect(area("board-preview-count").textContent).toBe("6 results");
  });

  it("shows three thumbnails and COUNTS the rest rather than hiding them", () => {
    render(
      mount(
        <BoardPreviewCard
          board={ref(6)}
          onOpen={vi.fn()}
          live={BOARD_LIVE_READOUT_SNAPSHOT}
        />,
      ),
    );
    expect(
      document.querySelectorAll('[data-vex-area="board-preview-thumbnail"]'),
    ).toHaveLength(3);
    expect(area("board-preview-overflow").textContent).toBe("+3");
  });

  it("omits the overflow mark when every pool is shown", () => {
    render(
      mount(
        <BoardPreviewCard
          board={ref(2)}
          onOpen={vi.fn()}
          live={BOARD_LIVE_READOUT_SNAPSHOT}
        />,
      ),
    );
    expect(
      document.querySelector('[data-vex-area="board-preview-overflow"]'),
    ).toBeNull();
  });

  it("draws the DESIGNED pending line while no pool has a settled verdict", () => {
    // Not a tally of zeroes and not a blank: a number shown before it is known
    // is wrong for exactly as long as it is on screen.
    render(
      mount(
        <BoardPreviewCard
          board={ref(3)}
          onOpen={vi.fn()}
          live={BOARD_LIVE_READOUT_SNAPSHOT}
        />,
      ),
    );
    const line = area("board-preview-conclusion");
    expect(line.getAttribute("data-pending")).toBe("true");
    expect(line.textContent).toBe(BOARD_PREVIEW_PENDING_CONCLUSION);
  });

  it("reads Snapshot with its clock while no lease is held", () => {
    render(
      mount(
        <BoardPreviewCard
          board={ref()}
          onOpen={vi.fn()}
          live={BOARD_LIVE_READOUT_SNAPSHOT}
        />,
      ),
    );
    const badge = area("board-preview-mode");
    expect(badge.getAttribute("data-mode")).toBe("snapshot");
    expect(badge.textContent).toContain("Snapshot");
    expect(badge.textContent).toContain("UTC");
  });

  it("reads LIVE only once a tick has actually landed", () => {
    // The dot follows the FETCH, not the switch: a green LIVE beside figures
    // that have not arrived is a claim the data does not support.
    const { rerender } = render(
      mount(
        <BoardPreviewCard
          board={ref()}
          onOpen={vi.fn()}
          live={{ mode: "live-connecting", isLiveOwner: true, lastTickAtMs: null }}
        />,
      ),
    );
    expect(area("board-preview-mode").getAttribute("data-mode")).toBe("connecting");
    rerender(
      mount(
        <BoardPreviewCard
          board={ref()}
          onOpen={vi.fn()}
          live={{ mode: "live-connected", isLiveOwner: true, lastTickAtMs: 1 }}
        />,
      ),
    );
    expect(area("board-preview-mode").getAttribute("data-mode")).toBe("live");
    expect(area("board-preview-mode").textContent).toContain("LIVE");
  });

  it("offers Ask VEX only where an intent can actually be received", () => {
    const onAsk = vi.fn();
    const { rerender } = render(
      mount(
        <BoardPreviewCard
          board={ref()}
          onOpen={vi.fn()}
          live={BOARD_LIVE_READOUT_SNAPSHOT}
        />,
      ),
    );
    expect(document.querySelector('[data-vex-area="board-preview-ask"]')).toBeNull();
    rerender(
      mount(
        <BoardPreviewCard
          board={ref()}
          onOpen={vi.fn()}
          live={BOARD_LIVE_READOUT_SNAPSHOT}
          onAsk={onAsk}
        />,
      ),
    );
    screen.getByRole("button", { name: /ask vex about results/i }).click();
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it("renders a LEGACY board whole - no iconId, no analysis, no caption", () => {
    // Built the way a legacy board actually reaches the renderer: a persisted
    // document with neither key, PARSED through the real schema. Casting a
    // literal into the type would prove only that TypeScript can be told to
    // be quiet; parsing proves the expand-and-contract defaults are what make
    // the old row readable at all.
    const spec = boardSpecV1Schema.parse({
      version: 1,
      title: "Older board",
      pools: [{ chain: "base", pairAddress: "0xaaa111" }],
      hydration: {
        rows: [legacyRow()],
        candles: null,
        analysisCreatedAt: FIXTURE_FETCHED_AT,
        marketDataFetchedAt: FIXTURE_FETCHED_AT,
        provenance: { transport: "http", sourceObservation: "legacy fixture" },
        unmatchedMarkerAtMs: null,
        staleAfterMs: BOARD_STALE_AFTER_MS,
      },
    });
    render(
      mount(
        <BoardPreviewCard
          board={boardRefOf("session-1", 7, spec)}
          onOpen={vi.fn()}
          live={BOARD_LIVE_READOUT_SNAPSHOT}
        />,
      ),
    );
    expect(area("board-preview-title").textContent).toBe("Older board");
    expect(area("board-preview-count").textContent).toBe("1 result");
    expect(
      document.querySelector('[data-vex-area="board-preview-thumbnail"]')
        ?.getAttribute("data-state"),
    ).toBe("monogram");
  });
});
