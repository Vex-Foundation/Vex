/**
 * AssetsScreen — the All-assets ShellScreen (opened from the welcome
 * Portfolio tab's Balances footer).
 *
 * Pins (mirroring the Sessions-screen shape in the AppShell suite):
 *   - `uiStore.shellRoute = { kind: "assets" }` mounts the screen through
 *     ShellScreens as a titled modal dialog ("All assets"),
 *   - EVERY portfolio token line renders (no top-5 cut here), in the shared
 *     row grammar, sorted largest USD first,
 *   - Escape closes back to `{ kind: "none" }` (the ShellScreen chrome's
 *     window-level listener — identical to MemoryScreen's shape),
 *   - the quiet empty state invites rather than errors,
 *   - hide-dust: the screen's checkbox (default checked, `hideDustBalances`
 *     in uiStore) filters sub-cent priced rows and names the hidden count;
 *     toggling flips the persisted uiStore preference and re-shows/re-hides,
 *   - THE EYE: rows with exact `(chainId, tokenAddress)` identity carry the
 *     token-history eye; clicking routes to `tokenHistory` with the row's
 *     identity + `returnTo: { kind: "assets", sessionId }`; identity-less rows
 *     carry NO eye,
 *   - SESSION SCOPE (C4): a `sessionId` on the route reads THAT session's
 *     portfolio (never the global one), retitles the screen, and rides along
 *     on the eye's `returnTo` so the close path restores the same scope.
 *
 * The sibling screens and the portfolio query hook are mocked — this suite
 * owns the assets branch, not Memory/Sessions/HowVexWorks/TokenHistory or
 * query wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PortfolioDto, PositionTokenDto } from "@shared/schemas/portfolio.js";
import { useUiStore } from "../../../../stores/uiStore.js";

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

// Sibling screens pull heavy registers (MemoryPanel, the sessions library);
// only the assets branch is under test.
vi.mock("../MemoryScreen.js", () => ({ MemoryScreen: () => null }));
vi.mock("../SessionsScreen.js", () => ({ SessionsScreen: () => null }));
vi.mock("../HowVexWorksScreen.js", () => ({ HowVexWorksScreen: () => null }));
// Phase 2b: SettingsScreen hosts the wizard step forms — a heavy module
// graph this suite's partial mocks do not cover. Own suite covers it.
vi.mock("../SettingsScreen.js", () => ({ SettingsScreen: () => null }));
// The token-history screen itself is owned by TokenHistoryScreen.test.tsx;
// here a stub exposing its `onClose` wire is enough to pin ShellScreens'
// returnTo routing back into THIS screen.
vi.mock("../TokenHistoryScreen.js", () => ({
  TokenHistoryScreen: ({ onClose }: { readonly onClose: () => void }) => (
    <button type="button" aria-label="Close token history (stub)" onClick={onClose} />
  ),
}));

const mockUsePortfolio = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/portfolio.js", () => ({
  usePortfolio: mockUsePortfolio,
}));

const { ShellScreens } = await import("../ShellScreens.js");

const ORIGIN = { x: 12, y: 640, width: 320, height: 40 };

function token(overrides: Partial<PositionTokenDto>): PositionTokenDto {
  return {
    chainId: 1,
    symbol: "TOK",
    balanceUsd: 1,
    amount: 1,
    ...overrides,
  };
}

function portfolio(tokens: readonly PositionTokenDto[]): PortfolioDto {
  return {
    scope: "global",
    walletCount: 2,
    liveTotalUsd: 999,
    snapshotTotalUsd: null,
    pnlVsPrev: null,
    snapshotAt: null,
    tokens: [...tokens],
    chains: [],
  };
}

/** Six lines — more than the Balances card's five, proving the full list. */
const SIX_TOKENS: readonly PositionTokenDto[] = [
  token({ tokenName: "Token A", symbol: "AAA", balanceUsd: 600 }),
  token({ tokenName: "Token B", symbol: "BBB", balanceUsd: 500 }),
  token({ tokenName: "Token C", symbol: "CCC", balanceUsd: 300 }),
  token({ tokenName: "Token D", symbol: "DDD", balanceUsd: 100 }),
  token({ tokenName: "Token E", symbol: "EEE", balanceUsd: 50 }),
  token({ tokenName: "Token F", symbol: "FFF", balanceUsd: 25 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useUiStore.setState({
    shellRoute: { kind: "none" },
    hideDustBalances: true,
  });
  mockUsePortfolio.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { ok: true, data: portfolio(SIX_TOKENS) },
  });
});

afterEach(() => {
  cleanup();
});

describe("AssetsScreen", () => {
  it("opens via uiStore as the titled All-assets dialog listing EVERY token line", () => {
    const view = render(<ShellScreens />);
    expect(screen.queryByRole("dialog", { name: "All assets" })).toBeNull();

    act(() => {
      useUiStore.getState().setShellRoute({ kind: "assets", origin: ORIGIN, sessionId: null });
    });

    expect(screen.getByRole("dialog", { name: "All assets" })).not.toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "All assets" }),
    ).not.toBeNull();
    // All six lines render — the card's top-5 cut does not apply here.
    const rows = [...view.container.querySelectorAll("li")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(6);
    expect(rows[0]).toContain("Token A");
    expect(rows[5]).toContain("Token F");
  });

  it("closes on Escape back to shellRoute 'none' (ShellScreen chrome contract)", () => {
    useUiStore.setState({ shellRoute: { kind: "assets", origin: ORIGIN, sessionId: null } });
    render(<ShellScreens />);
    expect(screen.getByRole("dialog", { name: "All assets" })).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });

  it("states the quiet empty invitation when no balances exist", () => {
    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { ok: true, data: portfolio([]) },
    });
    useUiStore.setState({ shellRoute: { kind: "assets", origin: null, sessionId: null } });
    render(<ShellScreens />);
    expect(
      screen.getByText(/No balances yet — fund a wallet/i),
    ).not.toBeNull();
  });
});

describe("AssetsScreen — token-history eye", () => {
  const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  it("renders the eye ONLY for rows with exact identity and routes to tokenHistory with returnTo 'assets'", () => {
    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        ok: true,
        data: portfolio([
          token({
            tokenName: "USD Coin",
            symbol: "USDC",
            chainId: 8453,
            tokenAddress: USDC_BASE,
            balanceUsd: 100,
          }),
          // No tokenAddress → no exact identity → NO eye (plan rule).
          token({ tokenName: "Legacy Row", symbol: "OLD", balanceUsd: 50 }),
        ]),
      },
    });
    useUiStore.setState({ shellRoute: { kind: "assets", origin: null, sessionId: null } });
    render(<ShellScreens />);

    // Exactly one eye: the identity-less row stays non-interactive.
    const eyes = screen.getAllByRole("button", { name: /^Token history:/ });
    expect(eyes).toHaveLength(1);
    expect(eyes[0]!.getAttribute("aria-label")).toBe("Token history: USD Coin");

    fireEvent.click(eyes[0]!);
    const route = useUiStore.getState().shellRoute;
    expect(route.kind).toBe("tokenHistory");
    if (route.kind !== "tokenHistory") throw new Error("route kind mismatch");
    expect(route.token).toEqual({
      chainId: 8453,
      tokenAddress: USDC_BASE,
      symbol: "USDC",
      tokenName: "USD Coin",
    });
    expect(route.returnTo).toEqual({ kind: "assets", sessionId: null });
    // jsdom rects are all-zero — the pin is that a measured rect object
    // (not null) rode along as the expand origin.
    expect(route.origin).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("closing the token-history screen returns to the All-assets screen (remounted, centered)", () => {
    useUiStore.setState({
      shellRoute: {
        kind: "tokenHistory",
        origin: { x: 1, y: 2, width: 3, height: 4 },
        token: {
          chainId: 8453,
          tokenAddress: USDC_BASE,
          symbol: "USDC",
          tokenName: "USD Coin",
        },
        returnTo: { kind: "assets", sessionId: null },
      },
    });
    render(<ShellScreens />);
    expect(screen.queryByRole("dialog", { name: "All assets" })).toBeNull();

    // The stub's close wire is the same `onClose` the real screen's Escape/
    // close-key path fires (TokenHistoryScreen.test pins the Escape half).
    fireEvent.click(
      screen.getByRole("button", { name: "Close token history (stub)" }),
    );
    // Back to assets — with a NULL origin: the old morph rect belonged to a
    // row instance that no longer exists (no stale-origin morph).
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "assets",
      origin: null,
      sessionId: null,
    });
    expect(screen.getByRole("dialog", { name: "All assets" })).not.toBeNull();
  });
});

describe("AssetsScreen — hide dust", () => {
  /** 4 real (well-priced) rows + 2 sub-cent dust rows. */
  const TOKENS_WITH_DUST: readonly PositionTokenDto[] = [
    token({ tokenName: "Token A", symbol: "AAA", balanceUsd: 600 }),
    token({ tokenName: "Token B", symbol: "BBB", balanceUsd: 500 }),
    token({ tokenName: "Token C", symbol: "CCC", balanceUsd: 300 }),
    token({ tokenName: "Token D", symbol: "DDD", balanceUsd: 100 }),
    token({ tokenName: "Seeyuh", symbol: "SEEYUH", balanceUsd: 0.001 }),
    token({ tokenName: "Dust Two", symbol: "DUST2", balanceUsd: 0.002 }),
  ];

  function mountAssetsScreen(): ReturnType<typeof render> {
    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { ok: true, data: portfolio(TOKENS_WITH_DUST) },
    });
    useUiStore.setState({ shellRoute: { kind: "assets", origin: null, sessionId: null } });
    return render(<ShellScreens />);
  }

  it("hides dust rows by default (checkbox checked) and names the hidden count", () => {
    const view = mountAssetsScreen();
    const checkbox = screen.getByRole("checkbox", { name: /Hide dust/i });
    expect(checkbox).toHaveProperty("checked", true);

    const rows = [...view.container.querySelectorAll("li")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(4);
    expect(rows.some((row) => row.includes("Seeyuh"))).toBe(false);
    expect(rows.some((row) => row.includes("Dust Two"))).toBe(false);
    expect(screen.getByText(/2 dust assets hidden/i)).not.toBeNull();
  });

  it("toggling the checkbox reveals dust rows, flips + persists uiStore, and clears the note; toggling again re-hides", () => {
    const view = mountAssetsScreen();
    const checkbox = screen.getByRole("checkbox", { name: /Hide dust/i });

    fireEvent.click(checkbox);
    expect(useUiStore.getState().hideDustBalances).toBe(false);
    const persisted = JSON.parse(
      window.localStorage.getItem("vex-ui") ?? "{}",
    );
    expect(persisted.state.hideDustBalances).toBe(false);

    let rows = [...view.container.querySelectorAll("li")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(6);
    expect(rows.some((row) => row.includes("Seeyuh"))).toBe(true);
    expect(rows.some((row) => row.includes("Dust Two"))).toBe(true);
    expect(screen.queryByText(/dust assets? hidden/i)).toBeNull();

    fireEvent.click(checkbox);
    expect(useUiStore.getState().hideDustBalances).toBe(true);
    rows = [...view.container.querySelectorAll("li")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(4);
    expect(rows.some((row) => row.includes("Seeyuh"))).toBe(false);
    expect(screen.getByText(/2 dust assets hidden/i)).not.toBeNull();
  });
});

describe("AssetsScreen — session scope (C4)", () => {
  const SESSION = "00000000-0000-4000-8000-0000000000ab";
  const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  it("reads the SESSION portfolio, not the global one, and says so in the title", () => {
    useUiStore.setState({
      shellRoute: { kind: "assets", origin: null, sessionId: SESSION },
    });
    render(<ShellScreens />);
    // The scope reaches the query hook — a narrowed register must never be
    // fed the global read.
    expect(mockUsePortfolio).toHaveBeenCalledWith(SESSION);
    expect(
      screen.getByRole("dialog", { name: "Session assets" }),
    ).not.toBeNull();
  });

  it("carries the session scope onto the eye's returnTo, so the close path restores it", () => {
    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        ok: true,
        data: portfolio([
          token({
            tokenName: "USD Coin",
            symbol: "USDC",
            chainId: 8453,
            tokenAddress: USDC_BASE,
            balanceUsd: 100,
          }),
        ]),
      },
    });
    useUiStore.setState({
      shellRoute: { kind: "assets", origin: null, sessionId: SESSION },
    });
    render(<ShellScreens />);
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Token history:/ })[0]!,
    );
    const route = useUiStore.getState().shellRoute;
    if (route.kind !== "tokenHistory") throw new Error("route kind mismatch");
    expect(route.returnTo).toEqual({ kind: "assets", sessionId: SESSION });
  });

  it("states the SESSION empty invitation, never the global one", () => {
    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { ok: true, data: portfolio([]) },
    });
    useUiStore.setState({
      shellRoute: { kind: "assets", origin: null, sessionId: SESSION },
    });
    render(<ShellScreens />);
    expect(
      screen.getByText(/No balances in this session's wallets yet/i),
    ).not.toBeNull();
  });
});
