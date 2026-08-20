/**
 * BalancesCard — the welcome tab's top-holdings card.
 *
 * Pins:
 *   - top-5 cut: the five largest `balanceUsd` lines, sorted descending,
 *     unpriced (`null`) rows last — a reordered payload can never scramble
 *     the cut,
 *   - display name: `tokenName` (main-sanitized) with the chain name in
 *     parentheses; falls back to the SANITIZED symbol when the name is
 *     absent, and to the em dash when the symbol is hostile,
 *   - unpriced rows keep the em-dash USD convention (never $0.00),
 *   - "View all assets" measures its own rect and opens the `assets`
 *     ShellScreen route with that origin through the uiStore.
 *   - hide-dust (`hideDustBalances`, default true): sub-cent priced rows are
 *     filtered out BEFORE the top-5 cut, so a dust row never occupies a
 *     slot a real (or unpriced) holding should fill instead,
 *   - THE EYE: rows with exact `(chainId, tokenAddress)` identity carry the
 *     token-history eye; clicking routes to `tokenHistory` with the row's
 *     identity + `returnTo: { kind: "shell" }`; identity-less rows carry NO eye and
 *     the token name itself stays non-interactive.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { PortfolioDto, PositionTokenDto } from "@shared/schemas/portfolio.js";
import { useUiStore } from "../../../stores/uiStore.js";

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

const mockUsePortfolio = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/api/portfolio.js", () => ({
  usePortfolio: mockUsePortfolio,
}));

const { BalancesCard } = await import("../book/portfolio/BalancesCard.js");

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

function mountWith(
  tokens: readonly PositionTokenDto[],
  sessionId: string | null = null,
) {
  mockUsePortfolio.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { ok: true, data: portfolio(tokens) },
  });
  return render(
    <BalancesCard
      scope={
        sessionId === null ? { kind: "global" } : { kind: "session", sessionId }
      }
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useUiStore.setState({
    shellRoute: { kind: "none" },
    hideDustBalances: true,
  });
});

describe("BalancesCard — top-5 ordering", () => {
  it("shows the five largest USD lines, sorted descending, from an unsorted payload", () => {
    const view = mountWith([
      token({ tokenName: "Token C", symbol: "CCC", balanceUsd: 300 }),
      token({ tokenName: "Token F", symbol: "FFF", balanceUsd: 25 }),
      token({ tokenName: "Token A", symbol: "AAA", balanceUsd: 600 }),
      token({ tokenName: "Token E", symbol: "EEE", balanceUsd: 50 }),
      token({ tokenName: "Token B", symbol: "BBB", balanceUsd: 500 }),
      token({ tokenName: "Token D", symbol: "DDD", balanceUsd: 100 }),
    ]);

    const rows = [...view.container.querySelectorAll("li")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain("Token A");
    expect(rows[1]).toContain("Token B");
    expect(rows[2]).toContain("Token C");
    expect(rows[3]).toContain("Token D");
    expect(rows[4]).toContain("Token E");
    // The sixth-largest line is deferred to the All-assets screen.
    expect(screen.queryByText(/Token F/)).toBeNull();
  });

  it("sorts unpriced (null USD) rows last and keeps their em-dash USD", () => {
    const view = mountWith([
      token({ tokenName: "Unpriced", symbol: "VEX", balanceUsd: null, amount: 5 }),
      token({ tokenName: "Priced A", symbol: "AAA", balanceUsd: 40 }),
      token({ tokenName: "Priced B", symbol: "BBB", balanceUsd: 90 }),
    ]);

    const rows = [...view.container.querySelectorAll("li")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Priced B");
    expect(rows[1]).toContain("Priced A");
    expect(rows[2]).toContain("Unpriced");
    // Em dash, never a fabricated $0.00 — the quantity still shows.
    expect(rows[2]).toContain("—");
    expect(rows[2]).toContain("5.00 VEX");
    expect(rows[2]).not.toContain("$0.00");
  });
});

describe("BalancesCard — display name and chain", () => {
  it("renders `TokenName (ChainName)` and falls back to the sanitized symbol without a name", () => {
    mountWith([
      token({ tokenName: "USD Coin", symbol: "USDC", chainId: 8453, balanceUsd: 100 }),
      token({ symbol: "WETH", chainId: 1, balanceUsd: 90 }),
    ]);
    expect(screen.getByText(/USD Coin/)).not.toBeNull();
    expect(screen.getByText(/\(Base\)/)).not.toBeNull();
    // No tokenName → the sanitized symbol carries the line. The symbol also
    // appears inside the mono amount ("… WETH"), so match all occurrences.
    expect(screen.getAllByText(/WETH/).length).toBeGreaterThan(0);
    expect(screen.getByText(/\(Ethereum\)/)).not.toBeNull();
  });

  it("drops a hostile symbol to the em-dash placeholder when no name exists", () => {
    // Zero-width space spliced into "ETH" — the sanitizer rejects it.
    const view = mountWith([
      token({ symbol: "E​TH", chainId: 1, balanceUsd: 100, amount: null }),
    ]);
    expect(screen.queryByText(/E​TH/)).toBeNull();
    const row = view.container.querySelector("li");
    expect(row?.textContent).toContain("—");
  });
});

describe("BalancesCard — View all assets", () => {
  it("opens the assets ShellScreen route with the pressed row's rect as the morph origin", () => {
    mountWith([token({ tokenName: "Token A", symbol: "AAA", balanceUsd: 10 })]);

    fireEvent.click(screen.getByRole("button", { name: /View all assets/i }));

    // jsdom rects are all-zero — the pin is that the measured rect object
    // (not null) rode along as the expand origin.
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "assets",
      origin: { x: 0, y: 0, width: 0, height: 0 },
      // The welcome card is the GLOBAL scope — the screen it opens must be too.
      sessionId: null,
    });
  });

  it("states a quiet invitation when there are no balances", () => {
    mountWith([]);
    expect(
      screen.getByText(/No balances yet — fund a wallet/i),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: /View all assets/i })).toBeNull();
  });
});

describe("BalancesCard — token-history eye", () => {
  const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  it("renders the eye for exact-identity rows and routes to tokenHistory with returnTo 'shell'", () => {
    mountWith([
      token({
        tokenName: "USD Coin",
        symbol: "USDC",
        chainId: 8453,
        tokenAddress: USDC_BASE,
        balanceUsd: 100,
      }),
    ]);

    const eye = screen.getByRole("button", { name: "Token history: USD Coin" });
    fireEvent.click(eye);

    const route = useUiStore.getState().shellRoute;
    expect(route.kind).toBe("tokenHistory");
    if (route.kind !== "tokenHistory") throw new Error("route kind mismatch");
    expect(route.token).toEqual({
      chainId: 8453,
      tokenAddress: USDC_BASE,
      symbol: "USDC",
      tokenName: "USD Coin",
    });
    expect(route.returnTo).toEqual({ kind: "shell" });
    // jsdom rects are all-zero — the pin is that the measured rect object
    // (not null) rode along as the expand origin.
    expect(route.origin).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("renders NO eye for rows without exact (chainId, tokenAddress) identity", () => {
    mountWith([
      // Address missing → no identity; symbol/name are display metadata and
      // must never become a query input (plan rule).
      token({ tokenName: "Legacy Row", symbol: "OLD", balanceUsd: 50 }),
      // Chain id missing → equally non-interactive.
      token({
        tokenName: "Chainless",
        symbol: "CHL",
        chainId: null,
        tokenAddress: USDC_BASE,
        balanceUsd: 25,
      }),
    ]);
    expect(
      screen.queryByRole("button", { name: /^Token history:/ }),
    ).toBeNull();
  });
});

describe("BalancesCard — hide dust", () => {
  /**
   * 4 real (well-priced) rows + 2 sub-cent dust rows + 1 UNPRICED real
   * holding: without filtering, the raw sort ranks the 2 dust rows above
   * the unpriced row (unpriced always sorts last), so an un-gated top-5 cut
   * would seat one dust row in the 5th slot instead of the unpriced
   * holding — exactly the clutter the owner reported.
   */
  const MIXED_WITH_DUST: readonly PositionTokenDto[] = [
    token({ tokenName: "Token A", symbol: "AAA", balanceUsd: 600 }),
    token({ tokenName: "Token B", symbol: "BBB", balanceUsd: 500 }),
    token({ tokenName: "Token C", symbol: "CCC", balanceUsd: 300 }),
    token({ tokenName: "Token D", symbol: "DDD", balanceUsd: 100 }),
    token({ tokenName: "Seeyuh", symbol: "SEEYUH", balanceUsd: 0.001 }),
    token({ tokenName: "Dust Two", symbol: "DUST2", balanceUsd: 0.002 }),
    token({
      tokenName: "Unpriced Real",
      symbol: "UPR",
      balanceUsd: null,
      amount: 3,
    }),
  ];

  it("excludes dust from the top-5 cut (default hideDustBalances: true) so the unpriced holding fills the slot instead", () => {
    const view = mountWith(MIXED_WITH_DUST);
    const rows = [...view.container.querySelectorAll("li")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(5);
    expect(rows.some((row) => row.includes("Seeyuh"))).toBe(false);
    expect(rows.some((row) => row.includes("Dust Two"))).toBe(false);
    expect(rows.some((row) => row.includes("Unpriced Real"))).toBe(true);
  });

  it("lets a dust row occupy a top-5 slot when hideDustBalances is false", () => {
    useUiStore.setState({ hideDustBalances: false });
    const view = mountWith(MIXED_WITH_DUST);
    const rows = [...view.container.querySelectorAll("li")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(5);
    // Raw sort seats the larger dust row (0.002) 5th; the unpriced holding
    // (always last) is pushed out of the top-5 window.
    expect(rows[4]).toContain("Dust Two");
    expect(rows.some((row) => row.includes("Unpriced Real"))).toBe(false);
  });
});

describe("BalancesCard — session scope (C4)", () => {
  const SESSION = "00000000-0000-4000-8000-0000000000ad";

  it("reads the SESSION portfolio, never the global one", () => {
    mountWith([token({ tokenName: "Token A", symbol: "AAA", balanceUsd: 10 })], SESSION);
    expect(mockUsePortfolio).toHaveBeenCalledWith(SESSION);
  });

  it("carries the session scope into the All-assets route it opens", () => {
    mountWith([token({ tokenName: "Token A", symbol: "AAA", balanceUsd: 10 })], SESSION);
    fireEvent.click(screen.getByRole("button", { name: /View all assets/i }));
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "assets",
      origin: { x: 0, y: 0, width: 0, height: 0 },
      sessionId: SESSION,
    });
  });

  it("filters dust BEFORE the top-5 cut — a dust row never takes a real holding's slot", () => {
    // 5 dust rows sort ahead of nothing, but 6 real rows exist: with the
    // filter applied AFTER the cut, the dust would eat visible slots.
    mountWith(
      [
        token({ tokenName: "Dust 1", symbol: "D1", balanceUsd: 0.001 }),
        token({ tokenName: "Dust 2", symbol: "D2", balanceUsd: 0.002 }),
        token({ tokenName: "Real A", symbol: "AAA", balanceUsd: 600 }),
        token({ tokenName: "Real B", symbol: "BBB", balanceUsd: 500 }),
        token({ tokenName: "Real C", symbol: "CCC", balanceUsd: 400 }),
        token({ tokenName: "Real D", symbol: "DDD", balanceUsd: 300 }),
        token({ tokenName: "Real E", symbol: "EEE", balanceUsd: 200 }),
        token({ tokenName: "Real F", symbol: "FFF", balanceUsd: 100 }),
      ],
      SESSION,
    );
    const names = [...document.querySelectorAll("li")].map(
      (row) => row.textContent ?? "",
    );
    expect(names).toHaveLength(5);
    expect(names.some((n) => n.includes("Dust"))).toBe(false);
    expect(names[0]).toContain("Real A");
    expect(names[4]).toContain("Real E");
  });

  it("states the SESSION empty invitation, never the global one", () => {
    mountWith([], SESSION);
    expect(
      screen.getByText(/No balances in this session's wallets yet/i),
    ).not.toBeNull();
  });
});
