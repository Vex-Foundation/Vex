/**
 * AgentScanScreen — the full-history activity ledger: FILTERS, the states
 * matrix, and pagination. (Row display + virtualization live in
 * `AgentScanScreen-rows.test.tsx`; the session preset in
 * `AgentScanScreen-session-preset.test.tsx`. Shared DTO factories and the
 * jsdom geometry stubs live in `_agent-scan-fixtures.ts`.)
 *
 * Pins:
 *   - the filter bar DRIVES the query input: each control projects onto the
 *     `agentScanFiltersSchema` shape, empty selections are omitted entirely
 *     (never sent as a "match nothing" empty array), and active filters are
 *     visibly pinned with a working Clear;
 *   - the states matrix fails CLOSED: a timed-out page renders the try-again
 *     note and NEVER the empty state, and an empty result while filters are
 *     active says so instead of claiming there is no history;
 *   - pagination: Load more fires fetchNextPage and a degraded LATER page
 *     never wipes the rows already shown.
 *
 * `useAgentScanInfinite` is mocked — this suite owns the screen, not the query
 * wiring (the hook's pagination contract is pinned in the api layer).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

function mountScreen(): void {
  render(
    <AgentScanScreen origin={null} scope={GLOBAL_SCOPE} onClose={() => undefined} />,
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

    fireEvent.click(screen.getByRole("button", { name: "lend" }));
    expect(lastFilters()).toEqual({ kinds: ["lend"] });

    fireEvent.click(screen.getByRole("button", { name: "bridge" }));
    expect(lastFilters()).toEqual({ kinds: ["lend", "bridge"] });

    fireEvent.click(screen.getByRole("button", { name: "failed" }));
    expect(lastFilters()).toEqual({
      kinds: ["lend", "bridge"],
      statuses: ["failed"],
    });

    fireEvent.click(screen.getByRole("button", { name: "KyberSwap" }));
    expect(lastFilters()).toEqual({
      kinds: ["lend", "bridge"],
      statuses: ["failed"],
      protocols: ["kyberswap"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Solana" }));
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

    // The executors that write `agent_activity` today.
    for (const label of [
      "KyberSwap",
      "Uniswap",
      "Jupiter",
      "Trench Express",
      // Joined in Phase 3, with the launch and claim executors that write it.
      "pools.fun",
      "Khalani",
      "Relay",
    ]) {
      expect(screen.getByRole("button", { name: label })).not.toBeNull();
    }
    // Polymarket is deleted from the product, DexScreener only reads market
    // data, and Pendle still captures into the LEGACY table — filtering on any
    // of them could only ever return an empty feed, which on an audit surface
    // reads as "the agent never did this".
    for (const label of ["Polymarket", "DexScreener", "Pendle"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("toggles a selected value back off", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();
    const swap = screen.getByRole("button", { name: "swap" });
    fireEvent.click(swap);
    expect(lastFilters()).toEqual({ kinds: ["swap"] });
    fireEvent.click(swap);
    expect(lastFilters()).toEqual({});
  });

  it("PINS the active filters with a count and clears them all", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();

    fireEvent.click(screen.getByRole("button", { name: "wrap" }));
    fireEvent.click(screen.getByRole("button", { name: "pending" }));
    expect(screen.getByText("2 filters active")).not.toBeNull();
    // The pressed state reaches assistive tech, not just the paint.
    expect(
      screen.getByRole("button", { name: "wrap" }).getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(lastFilters()).toEqual({});
    expect(screen.queryByText(/filters active/)).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: "lend" }));
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
