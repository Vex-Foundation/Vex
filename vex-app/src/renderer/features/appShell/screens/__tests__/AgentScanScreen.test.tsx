/**
 * AgentScanScreen - the full-history activity ledger: FILTERS, the states
 * matrix, and pagination. (Row display + virtualization live in
 * `AgentScanScreen-rows.test.tsx`; the session preset in
 * `AgentScanScreen-session-preset.test.tsx`. Shared DTO factories and the
 * jsdom geometry stubs live in `_agent-scan-fixtures.ts`.)
 *
 * Pins:
 *   - the filter bar DRIVES the query input: each of its four named menus
 *     (Kind, Status, Protocol, Chain) projects onto the
 *     `agentScanFiltersSchema` shape, empty selections are omitted entirely
 *     (never sent as a "match nothing" empty array), and active filters are
 *     visibly pinned with a working Clear;
 *   - the menus behave as menus: multi-select ones stay open on a press,
 *     single-select ones close, the key says "All" / the choice / "Swap +1",
 *     the arrows move between rows, and Escape closes the menu WITHOUT also
 *     closing the page behind it;
 *   - the states matrix fails CLOSED: a timed-out page renders the try-again
 *     note and NEVER the empty state, and an empty result while filters are
 *     active says so instead of claiming there is no history;
 *   - pagination: Load more fires fetchNextPage and a degraded LATER page
 *     never wipes the rows already shown.
 *
 * `useAgentScanInfinite` is mocked - this suite owns the screen, not the query
 * wiring (the hook's pagination contract is pinned in the api layer).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { AgentScanDto } from "@shared/schemas/agent-scan-feed.js";
import type { Result } from "@shared/ipc/result.js";
import {
  availablePage,
  GLOBAL_SCOPE,
  entry,
  installJsdomGeometry,
  restoreJsdomGeometry,
  UNAVAILABLE_PAGE,
} from "./_agent-scan-fixtures.js";

const mockUseAgentScanInfinite = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/portfolio.js", () => ({
  useAgentScanInfinite: mockUseAgentScanInfinite,
}));

/**
 * The project NAME read is mocked, not provided through a QueryClient: it is a
 * LABEL for the scope chip and nothing about it belongs to this suite's
 * subject. `useProject` is disabled for every non-project scope in the screen,
 * so a global or session mount never consults it.
 */
const mockUseProject = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/projects.js", () => ({
  useProject: mockUseProject,
}));

const { AgentScanScreen } = await import("../AgentScanScreen.js");

const mockFetchNextPage = vi.fn();

function mockQuery(
  pages: readonly Result<AgentScanDto>[],
  options?: {
    readonly isLoading?: boolean;
    readonly isError?: boolean;
    readonly hasNextPage?: boolean;
    readonly isFetchingNextPage?: boolean;
  },
): void {
  mockUseAgentScanInfinite.mockReturnValue({
    isLoading: options?.isLoading ?? false,
    isError: options?.isError ?? false,
    data: pages.length > 0 ? { pages: [...pages] } : undefined,
    hasNextPage: options?.hasNextPage ?? false,
    isFetchingNextPage: options?.isFetchingNextPage ?? false,
    fetchNextPage: mockFetchNextPage,
  });
}

function mountScreen(onClose: () => void = () => undefined): void {
  render(<AgentScanScreen origin={null} scope={GLOBAL_SCOPE} onClose={onClose} />);
}

type FilterMenuName = "Kind" | "Status" | "Protocol" | "Chain";

/** The select-like key that opens one named filter menu ("Kind  All  v"). */
function menuKey(name: FilterMenuName): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${name}`) });
}

/**
 * Open one filter menu the way a pointer does: the press lands on the key
 * (which is outside every OTHER menu, so an open one closes), then the click
 * opens this one.
 */
function openMenu(name: FilterMenuName): void {
  const key = menuKey(name);
  fireEvent.pointerDown(key);
  fireEvent.click(key);
}

/** What the key currently says: "All", one label, or "Swap +1". */
function keyValue(name: FilterMenuName): string {
  return (
    menuKey(name).querySelector(".vex-scan-filter__value")?.textContent ?? ""
  );
}

/** The filters argument the screen most recently handed the hook. */
function lastFilters(): unknown {
  const calls = mockUseAgentScanInfinite.mock.calls;
  return calls[calls.length - 1]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  // The disabled-query shape `useProject` returns for a non-project scope.
  mockUseProject.mockReturnValue({ data: undefined });
  installJsdomGeometry();
});

afterEach(() => {
  restoreJsdomGeometry();
  cleanup();
});

describe("AgentScanScreen - filters drive the query input", () => {
  it("starts with NO constraints - an empty selection is omitted, never sent as an empty array", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();
    expect(lastFilters()).toEqual({});
  });

  it("projects each control onto the filter contract", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();

    openMenu("Kind");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Lend" }));
    expect(lastFilters()).toEqual({ kinds: ["lend"] });

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Bridge" }));
    expect(lastFilters()).toEqual({ kinds: ["lend", "bridge"] });

    openMenu("Status");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Failed" }));
    expect(lastFilters()).toEqual({
      kinds: ["lend", "bridge"],
      statuses: ["failed"],
    });

    openMenu("Protocol");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "KyberSwap" }));
    expect(lastFilters()).toEqual({
      kinds: ["lend", "bridge"],
      statuses: ["failed"],
      protocols: ["kyberswap"],
    });

    openMenu("Chain");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Solana" }));
    expect(lastFilters()).toEqual({
      kinds: ["lend", "bridge"],
      statuses: ["failed"],
      protocols: ["kyberswap"],
      chainFamily: "solana",
    });
  });

  it("offers ONLY protocols that actually write the feed - never an always-empty option", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();
    openMenu("Protocol");

    // The executors that write `agent_activity` today.
    for (const label of [
      "KyberSwap",
      "Uniswap",
      "Jupiter",
      "Trench Express (legacy)",
      // Joined in Phase 3, with the launch and claim executors that write it.
      "pools.fun",
      // Both arms write it: `exchange` deposits/withdrawals in `agent_activity`
      // and the venue's own matched fills in `lighter_fills`.
      "Lighter",
      "Khalani",
      "Relay",
    ]) {
      expect(screen.getByRole("menuitemcheckbox", { name: label })).not.toBeNull();
    }
    // Polymarket is deleted from the product, DexScreener only reads market
    // data, and Pendle still captures into the LEGACY table - filtering on any
    // of them could only ever return an empty feed, which on an audit surface
    // reads as "the agent never did this".
    for (const label of ["Polymarket", "DexScreener", "Pendle"]) {
      expect(screen.queryByRole("menuitemcheckbox", { name: label })).toBeNull();
    }
  });

  /**
   * The FEED kind that selects the second ledger. `kinds` is an OPEN bounded
   * list on the contract, so this row routes exactly like the vocabulary-derived
   * ones - it is simply not an `agent_activity.kind`, which is why it is not in
   * `AGENT_ACTIVITY_KINDS`.
   */
  it("offers a Lighter fills kind row that toggles `kinds` like every other row", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();
    openMenu("Kind");

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Lighter fills" }));
    expect(lastFilters()).toEqual({ kinds: ["lighter_fill"] });

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Swap" }));
    expect(lastFilters()).toEqual({ kinds: ["lighter_fill", "swap"] });

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Lighter fills" }));
    expect(lastFilters()).toEqual({ kinds: ["swap"] });
  });

  it("offers the `lighter` protocol, which both arms of the feed write", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();
    openMenu("Protocol");

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Lighter" }));
    expect(lastFilters()).toEqual({ protocols: ["lighter"] });
  });

  it("toggles a selected value back off", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();
    openMenu("Kind");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Swap" }));
    expect(lastFilters()).toEqual({ kinds: ["swap"] });
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Swap" }));
    expect(lastFilters()).toEqual({});
  });

  it("toggles a single-select value back off by pressing the checked row again", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();

    openMenu("Status");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Failed" }));
    expect(lastFilters()).toEqual({ statuses: ["failed"] });

    openMenu("Status");
    const failed = screen.getByRole("menuitemradio", { name: "Failed" });
    expect(failed.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(failed);
    expect(lastFilters()).toEqual({});
  });

  it("the All row clears ITS dimension only", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();

    openMenu("Kind");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Lend" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Bridge" }));
    openMenu("Status");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Failed" }));
    expect(lastFilters()).toEqual({
      kinds: ["lend", "bridge"],
      statuses: ["failed"],
    });

    openMenu("Kind");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "All" }));
    expect(lastFilters()).toEqual({ statuses: ["failed"] });
    expect(keyValue("Kind")).toBe("All");
    expect(keyValue("Status")).toBe("Failed");
  });

  it("labels the statuses in sentence case", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();
    openMenu("Status");
    for (const label of ["Pending", "Confirmed", "Failed", "Superseded"]) {
      expect(screen.getByRole("menuitemradio", { name: label })).not.toBeNull();
    }
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Superseded" }));
    expect(lastFilters()).toEqual({ statuses: ["superseded_unproven"] });
  });

  it("PINS the active filters with a count and clears them all", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();

    openMenu("Kind");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Wrap" }));
    openMenu("Status");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Pending" }));
    expect(screen.getByText("2 filters active")).not.toBeNull();
    // The menus that narrow the feed say so on their keys.
    expect(menuKey("Kind").hasAttribute("data-active")).toBe(true);
    expect(menuKey("Status").hasAttribute("data-active")).toBe(true);
    expect(menuKey("Chain").hasAttribute("data-active")).toBe(false);
    // The checked state reaches assistive tech, not just the paint.
    openMenu("Kind");
    const wrap = screen.getByRole("menuitemcheckbox", { name: "Wrap" });
    expect(wrap.getAttribute("aria-checked")).toBe("true");
    expect(wrap.hasAttribute("data-selected")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(lastFilters()).toEqual({});
    expect(screen.queryByText(/filters active/)).toBeNull();
    expect(keyValue("Kind")).toBe("All");
    expect(menuKey("Kind").hasAttribute("data-active")).toBe(false);
  });

  it("counts ONE active filter in the singular", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();
    openMenu("Chain");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "EVM" }));
    expect(screen.getByText("1 filter active")).not.toBeNull();
    expect(lastFilters()).toEqual({ chainFamily: "eip155" });
  });
});

describe("AgentScanScreen - filter menus behave as menus", () => {
  it("says All, then the chosen label, then 'Swap +1' on the key", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();
    expect(keyValue("Kind")).toBe("All");

    openMenu("Kind");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Swap" }));
    expect(keyValue("Kind")).toBe("Swap");

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Bridge" }));
    expect(keyValue("Kind")).toBe("Swap +1");

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Lend" }));
    expect(keyValue("Kind")).toBe("Swap +2");
  });

  it("closes a SINGLE-select menu after a choice and returns focus to its key", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();

    openMenu("Status");
    expect(menuKey("Status").getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Failed" }));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(menuKey("Status").getAttribute("aria-expanded")).toBe("false");
    expect(keyValue("Status")).toBe("Failed");
    expect(document.activeElement).toBe(menuKey("Status"));
  });

  it("keeps a MULTI-select menu open while the user builds a set", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();

    openMenu("Kind");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Lend" }));
    expect(screen.getByRole("menu", { name: "Kind" })).not.toBeNull();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Bridge" }));
    expect(screen.getByRole("menu", { name: "Kind" })).not.toBeNull();
    expect(menuKey("Kind").getAttribute("aria-expanded")).toBe("true");
  });

  it("opens one menu at a time: pressing another key closes the first", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();
    openMenu("Kind");
    openMenu("Chain");
    expect(screen.queryByRole("menu", { name: "Kind" })).toBeNull();
    expect(screen.getByRole("menu", { name: "Chain" })).not.toBeNull();
  });

  it("closes on a press outside the menu", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();
    openMenu("Kind");
    expect(screen.getByRole("menu", { name: "Kind" })).not.toBeNull();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("focuses the first row on open, or the first CHECKED row when there is one", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();

    openMenu("Kind");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitemcheckbox", { name: "All" }),
    );
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Bridge" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();

    openMenu("Kind");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitemcheckbox", { name: "Bridge" }),
    );
  });

  it("moves between rows with the arrows (wrapping), Home and End", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();
    openMenu("Kind");
    const menu = screen.getByRole("menu", { name: "Kind" });
    const rows = within(menu).getAllByRole("menuitemcheckbox");
    const first = rows[0];
    const second = rows[1];
    const last = rows[rows.length - 1];
    expect(first?.textContent).toBe("All");
    expect(second?.textContent).toBe("Swap");
    expect(last?.textContent).toBe("Lighter fills");
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);

    // Up from the first row wraps to the last, down from the last to the first.
    fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document.activeElement ?? menu, { key: "End" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document.activeElement ?? menu, { key: "Home" });
    expect(document.activeElement).toBe(first);
  });

  /**
   * The page sheet closes on a WINDOW Escape listener that skips handled
   * events. An Escape the menu takes must therefore be marked handled and must
   * not travel on, or one key press would close the menu AND the page behind
   * it.
   */
  it("Escape closes an open menu, refocuses its key and does NOT close the page", () => {
    const onClose = vi.fn();
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen(onClose);

    openMenu("Kind");
    const row = screen.getByRole("menuitemcheckbox", { name: "All" });
    // `fireEvent` returns false when a listener called `preventDefault`.
    expect(fireEvent.keyDown(row, { key: "Escape" })).toBe(false);

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(menuKey("Kind"));
    expect(onClose).not.toHaveBeenCalled();

    // Control: with no menu open the same key IS the page's, so the check
    // above is not vacuous (the screen really does close on Escape).
    expect(fireEvent.keyDown(menuKey("Kind"), { key: "Escape" })).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape on the OPEN key closes the menu the same way", () => {
    const onClose = vi.fn();
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen(onClose);

    openMenu("Protocol");
    expect(fireEvent.keyDown(menuKey("Protocol"), { key: "Escape" })).toBe(false);

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(menuKey("Protocol"));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("AgentScanScreen - states matrix", () => {
  it("renders a timed-out page as the calm try-again note, NEVER as empty history", () => {
    mockQuery([UNAVAILABLE_PAGE]);
    mountScreen();
    expect(
      screen.getByText(/Activity is unavailable right now - try again shortly/),
    ).not.toBeNull();
    expect(screen.queryByText(/No activity recorded yet/)).toBeNull();
  });

  it("distinguishes a FILTERED-empty feed from an empty history", () => {
    mockQuery([availablePage([])]);
    mountScreen();
    expect(screen.getByText(/No activity recorded yet/)).not.toBeNull();

    openMenu("Kind");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Lend" }));
    expect(screen.getByText("No activity matches these filters.")).not.toBeNull();
    expect(screen.queryByText(/No activity recorded yet/)).toBeNull();
  });

  it("renders a failed Result as the warn state, not empty history", () => {
    mockQuery([
      {
        ok: false,
        error: {
          code: "internal.unexpected",
          domain: "portfolio",
          message: "boom",
          retryable: false,
          userActionable: false,
          redacted: true,
          correlationId: "11111111-1111-4111-8111-111111111111",
        },
      },
    ]);
    mountScreen();
    expect(screen.getByText("Couldn't load activity.")).not.toBeNull();
    expect(screen.queryByText(/No activity recorded yet/)).toBeNull();
  });
});

describe("AgentScanScreen - pagination", () => {
  it("shows Load more on hasNextPage and fires fetchNextPage", () => {
    mockQuery([availablePage([entry({ id: "1" })], { hasMore: true })], {
      hasNextPage: true,
    });
    mountScreen();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(mockFetchNextPage).toHaveBeenCalled();
  });

  it("notes a degraded LATER page instead of wiping the rows already shown", () => {
    mockQuery([
      availablePage([entry({ id: "1" })], { hasMore: true }),
      UNAVAILABLE_PAGE,
    ]);
    mountScreen();
    expect(screen.getByText(/Couldn't load more activity right now/)).not.toBeNull();
    // The first page's row survives.
    expect(screen.getByRole("list", { name: "Activity" })).not.toBeNull();
  });
});
