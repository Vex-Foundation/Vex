/**
 * TokenHistoryScreen GATE — the per-token Vex-recorded activity screen (eye
 * trigger on Balances / All-assets rows), covering what the screen file
 * itself owns after the move-only split: chrome, the query identity, the
 * states matrix, and pagination. Per-entry display rules live in the sibling
 * `TokenHistoryScreen-rows.test.tsx`, mirroring the
 * `screens/token-history/` split of the source.
 *
 * Pins (screen-states matrix from the harness plan):
 *   - `shellRoute: tokenHistory` mounts through ShellScreens as a modal
 *     dialog named "<display name> history" with the header identity cluster
 *     (name + chain) and the honest "Vex-recorded activity" disclosure —
 *     and NO serif H1 (the chrome's `header` slot replaces it);
 *   - status "unavailable" (query timeout) renders the calm try-again note
 *     and NEVER the empty-history copy;
 *   - empty available history renders the quiet "No Vex-recorded history"
 *     invitation;
 *   - Load more appears on hasNextPage, fires fetchNextPage, and appended
 *     pages' entries render;
 *   - Escape/close returns to `returnTo`: "shell" → none, "assets" → the
 *     assets route remounted with a NULL origin (no stale morph rect).
 *
 * `useTokenHistoryInfinite` is mocked — this suite owns screen states, not
 * query wiring (the hook's pagination contract is pinned in the api layer).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TokenHistoryDto } from "@shared/schemas/token-history.js";
import type { Result } from "@shared/ipc/result.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import type { ShellRouteReturnTo } from "../../../../stores/uiStore.js";
import {
  availablePage,
  swapEntry,
  tokenHistoryRoute,
  USDC_BASE,
} from "./_token-history-fixtures.js";

vi.mock("@thesvg/react", () => ({
  Bitcoin: () => null,
  Bnb: () => null,
  BnbChain: () => null,
  Chainlink: () => null,
  Circle: () => null,
  DaiStablecoin: () => null,
  Ethereum: () => null,
  Optimism: () => null,
  Polygon: () => null,
  Robinhood: () => null,
  Solana: () => null,
  Tether: () => null,
  Usdc: () => null,
}));

// Sibling screens pull heavy registers; only the token-history branch is
// under test (the assets-return route pin asserts STORE state, not the
// remounted assets dialog — AssetsScreen.test owns that side).
vi.mock("../MemoryScreen.js", () => ({ MemoryScreen: () => null }));
vi.mock("../SessionsScreen.js", () => ({ SessionsScreen: () => null }));
vi.mock("../HowVexWorksScreen.js", () => ({ HowVexWorksScreen: () => null }));
// Phase 2b: SettingsScreen hosts the wizard step forms — a heavy module
// graph this suite's partial mocks do not cover. Own suite covers it.
vi.mock("../SettingsScreen.js", () => ({ SettingsScreen: () => null }));
vi.mock("../AssetsScreen.js", () => ({ AssetsScreen: () => null }));
vi.mock("../AgentScanScreen.js", () => ({ AgentScanScreen: () => null }));

const mockUseTokenHistoryInfinite = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/portfolio.js", () => ({
  useTokenHistoryInfinite: mockUseTokenHistoryInfinite,
}));

const { ShellScreens } = await import("../ShellScreens.js");

const mockFetchNextPage = vi.fn();

function mockQuery(
  pages: readonly Result<TokenHistoryDto>[],
  options?: {
    readonly isLoading?: boolean;
    readonly hasNextPage?: boolean;
    readonly isFetchingNextPage?: boolean;
  },
): void {
  mockUseTokenHistoryInfinite.mockReturnValue({
    isLoading: options?.isLoading ?? false,
    isError: false,
    data: pages.length > 0 ? { pages: [...pages] } : undefined,
    hasNextPage: options?.hasNextPage ?? false,
    isFetchingNextPage: options?.isFetchingNextPage ?? false,
    fetchNextPage: mockFetchNextPage,
  });
}

function mountScreen(
  returnTo: ShellRouteReturnTo = { kind: "shell" },
): void {
  useUiStore.setState({ shellRoute: tokenHistoryRoute(returnTo) });
  render(<ShellScreens />);
}

const SESSION = "00000000-0000-4000-8000-0000000000aa";

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useUiStore.setState({ shellRoute: { kind: "none" } });
});

afterEach(() => {
  cleanup();
});

describe("TokenHistoryScreen - chrome and disclosure", () => {
  it("mounts as the '<name> history' dialog with the identity cluster, the scope disclosure, and NO serif H1", () => {
    mockQuery([availablePage([swapEntry({ id: "a-1" })])]);
    mountScreen();

    const dialog = screen.getByRole("dialog", { name: "USD Coin history" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // Identity cluster: display name + chain.
    expect(screen.getByText("USD Coin")).not.toBeNull();
    expect(screen.getByText("(Base)")).not.toBeNull();
    // Honest scope disclosure — this is Vex-recorded activity, not a chain scan.
    expect(screen.getByText(/Vex-recorded activity/)).not.toBeNull();
    expect(screen.getByText(/not locally known/)).not.toBeNull();
    // Serif NOWHERE on this screen: the chrome's serif H1 is replaced by the
    // header slot (the h1 element itself is absent).
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    // Close key still named by the title.
    expect(
      screen.getByRole("button", { name: "Close USD Coin history" }),
    ).not.toBeNull();
    // The hook received the EXACT route identity (never symbol/name).
    expect(mockUseTokenHistoryInfinite).toHaveBeenCalledWith({
      chainId: 8453,
      tokenAddress: USDC_BASE,
    });
  });

  it("routes back to `returnTo` on Escape: 'shell' closes to none", () => {
    mockQuery([availablePage([])]);
    mountScreen({ kind: "shell" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });

  it("routes back to `returnTo` on Escape: 'assets' remounts the assets route with a NULL origin", () => {
    mockQuery([availablePage([])]);
    mountScreen({ kind: "assets", sessionId: null });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "assets",
      origin: null,
      sessionId: null,
    });
  });

  it("PRESERVES the session scope on the 'assets' return - the register never re-mints global", () => {
    mockQuery([availablePage([])]);
    mountScreen({ kind: "assets", sessionId: SESSION });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "assets",
      origin: null,
      sessionId: SESSION,
    });
  });
});

describe("TokenHistoryScreen - states matrix", () => {
  it("status 'unavailable' renders the calm try-again note and NEVER the empty-history copy", () => {
    mockQuery([
      { ok: true, data: { status: "unavailable", reason: "query_timeout" } },
    ]);
    mountScreen();

    expect(
      screen.getByText(/History is unavailable right now - try again shortly/),
    ).not.toBeNull();
    expect(screen.queryByText(/No Vex-recorded history/)).toBeNull();
  });

  it("empty available history renders the quiet invitation (and no unavailable note)", () => {
    mockQuery([availablePage([])]);
    mountScreen();

    expect(
      screen.getByText(/No Vex-recorded history for this token yet/),
    ).not.toBeNull();
    expect(screen.queryByText(/unavailable right now/)).toBeNull();
  });

  it("a failed Result renders the warn state, not empty history", () => {
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

    expect(
      screen.getByText(/Couldn't load this token's history/),
    ).not.toBeNull();
    expect(screen.queryByText(/No Vex-recorded history/)).toBeNull();
  });
});

describe("TokenHistoryScreen - pagination", () => {
  it("shows Load more on hasNextPage, fires fetchNextPage, and renders appended pages' entries", () => {
    mockQuery(
      [
        availablePage([swapEntry({ id: "a-1" })], { hasMore: true }),
        availablePage([
          swapEntry({
            id: "a-2",
            productType: "older_swap",
            tradeSide: "sell",
          }),
        ]),
      ],
      { hasNextPage: true },
    );
    mountScreen();

    // Both pages' entries render (flattened append) — identified by their own
    // leg text, which is independent of the badge vocabulary.
    expect(screen.getAllByText(/1\.5 TOKA/).length).toBe(2);

    const loadMore = screen.getByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);
    expect(mockFetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("hides Load more when the feed is exhausted and disables it mid-fetch", () => {
    mockQuery([availablePage([swapEntry({ id: "a-1" })])]);
    mountScreen();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    cleanup();

    mockQuery(
      [availablePage([swapEntry({ id: "a-1" })], { hasMore: true })],
      { hasNextPage: true, isFetchingNextPage: true },
    );
    mountScreen();
    const busy = screen.getByRole("button", { name: "Loading…" });
    expect(busy.hasAttribute("disabled")).toBe(true);
  });
});
