/**
 * BalancesCard - the Portfolio page's Balances section (docs/design/
 * R3-MINIMAL.md section 9.1): the top holdings of the page scope's read as a
 * table of Asset, Network, Quantity, Price and Value, with a row menu and
 * "View all assets" in the head.
 *
 * Pins:
 *   - the scope's own read, never a wider one: global, session and project
 *     read their own scope, a single wallet shows ITS read (never the
 *     aggregate's rows),
 *   - top-5 cut: the five largest `balanceUsd` lines, sorted descending,
 *     unpriced (`null`) rows last, so a reordered payload can never scramble
 *     the cut,
 *   - the row grammar: name is the main-sanitized `tokenName`, else the
 *     SANITIZED symbol, else a dash; the network is the chain's display name
 *     (empty for a `chainId: null` aggregate line); the price is the
 *     valuation's own unit value (value over quantity); an unpriced row says
 *     "Not available" for price and value, never $0.00,
 *   - hide-dust (`hideDustBalances`, default true): sub-cent priced rows are
 *     filtered out BEFORE the top-5 cut in every scope, so a dust row never
 *     occupies a slot a real (or unpriced) holding should fill,
 *   - "View all assets" opens the `assets` route carrying the card's OWN scope
 *     (global, session or project) with the link's rect as origin, and is not
 *     offered under a single wallet (no register of its own) or without rows,
 *   - the row menu: "Token history" only for rows with exact `(chainId,
 *     tokenAddress)` identity, routing to `tokenHistory` with the row's
 *     identity and `returnTo: { kind: "shell" }`; an identity-less row renders
 *     no actions key at all,
 *   - the per-scope empty notes, and the loading and error lines.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  PortfolioDto,
  PortfolioReadInput,
  PositionTokenDto,
} from "@shared/schemas/portfolio.js";
import type { AvailableWalletDto } from "@shared/schemas/wallets.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import { useUiStore } from "../../../stores/uiStore.js";

// Every brand mark stubs to null, whatever its name: the marks are
// presentation-only here, and a hand-listed mock breaks the whole suite
// file each time a component references a new mark.
vi.mock("@thesvg/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@thesvg/react")>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, () => null]));
});

interface QueryStub {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly data: Result<PortfolioDto> | undefined;
}

const mockUsePortfolio = vi.hoisted(() =>
  vi.fn<(input: PortfolioReadInput) => QueryStub>(),
);
const mockUseWalletPortfolio = vi.hoisted(() =>
  vi.fn<(address: string | null) => QueryStub>(),
);

vi.mock("../../../lib/api/portfolio.js", () => ({
  usePortfolio: mockUsePortfolio,
  useWalletPortfolio: mockUseWalletPortfolio,
}));

/** A full error envelope, as main would hand the renderer on a failed read. */
const READ_FAILED: VexError = {
  code: "internal.unexpected",
  domain: "system",
  message: "boom",
  retryable: false,
  userActionable: false,
  redacted: true,
  correlationId: "00000000-0000-4000-8000-0000000000ee",
};

const { BalancesCard } = await import("../book/portfolio/BalancesCard.js");

type Scope = Parameters<typeof BalancesCard>[0]["scope"];

const SESSION = "00000000-0000-4000-8000-0000000000ad";
const PROJECT = "9c1b0e8e-0000-4000-8000-0000000000ab";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WALLET: AvailableWalletDto = {
  id: "evm-1",
  family: "evm",
  address: "0x1111111111111111111111111111111111111111",
  label: "Main",
};
const ORIGIN_ZERO = { x: 0, y: 0, width: 0, height: 0 };

const GLOBAL_SCOPE: Scope = { kind: "global" };
const SESSION_SCOPE: Scope = { kind: "session", sessionId: SESSION };
const PROJECT_SCOPE: Scope = { kind: "project", projectId: PROJECT };
const WALLET_SCOPE: Scope = { kind: "wallet", wallet: WALLET };

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

function ready(tokens: readonly PositionTokenDto[]): QueryStub {
  return { isLoading: false, isError: false, data: ok(portfolio(tokens)) };
}

/**
 * Mount under a scope. The tokens are the scope's own read: for a wallet scope
 * they come through the wallet hook, for every other scope through the scope
 * hook (the page hands the same scope to every section).
 */
function mountScoped(tokens: readonly PositionTokenDto[], scope: Scope = GLOBAL_SCOPE) {
  if (scope.kind === "wallet") {
    mockUseWalletPortfolio.mockReturnValue(ready(tokens));
  } else {
    mockUsePortfolio.mockReturnValue(ready(tokens));
  }
  return render(<BalancesCard scope={scope} />);
}

function mountState(state: QueryStub, scope: Scope = GLOBAL_SCOPE) {
  if (scope.kind === "wallet") {
    mockUseWalletPortfolio.mockReturnValue(state);
  } else {
    mockUsePortfolio.mockReturnValue(state);
  }
  return render(<BalancesCard scope={scope} />);
}

function bodyRows(): readonly HTMLTableRowElement[] {
  return [...document.querySelectorAll("tbody tr")].filter(
    (row): row is HTMLTableRowElement => row instanceof HTMLTableRowElement,
  );
}

/** The cells of a row as text, in column order. */
function cellsOf(row: HTMLTableRowElement): readonly string[] {
  return [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "");
}

/** The asset name of a row (the mark beside it carries no text of its own). */
function nameOf(row: HTMLTableRowElement): string {
  return row.querySelector(".vex-pf-asset > span:last-child")?.textContent ?? "";
}

function rowNames(): readonly string[] {
  return bodyRows().map(nameOf);
}

function rowNamed(name: string): HTMLTableRowElement {
  const row = bodyRows().find((candidate) => nameOf(candidate) === name);
  if (row === undefined) throw new Error(`no balance row named ${name}`);
  return row;
}

function viewAllAssets(): HTMLElement | null {
  return screen.queryByRole("button", { name: /View all assets/i });
}

function openActions(name: string): void {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${name}` }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useUiStore.setState({
    shellRoute: { kind: "none" },
    hideDustBalances: true,
  });
  mockUsePortfolio.mockReturnValue(ready([]));
  mockUseWalletPortfolio.mockReturnValue({
    isLoading: false,
    isError: false,
    data: undefined,
  });
});

afterEach(() => {
  cleanup();
});

describe("BalancesCard - the scope's own read, never a wider one", () => {
  it("global reads the global portfolio and never a wallet", () => {
    mountScoped([token({ tokenName: "Token A", symbol: "AAA", balanceUsd: 10 })]);

    expect(mockUsePortfolio.mock.calls.length).toBeGreaterThan(0);
    for (const [input] of mockUsePortfolio.mock.calls) {
      expect(input).toEqual({ scope: "global" });
    }
    for (const [address] of mockUseWalletPortfolio.mock.calls) {
      expect(address).toBeNull();
    }
  });

  it("session reads the SESSION portfolio, never the global one", () => {
    mountScoped(
      [token({ tokenName: "Token A", symbol: "AAA", balanceUsd: 10 })],
      SESSION_SCOPE,
    );

    expect(mockUsePortfolio.mock.calls.length).toBeGreaterThan(0);
    for (const [input] of mockUsePortfolio.mock.calls) {
      expect(input).toEqual({ scope: "session", sessionId: SESSION });
    }
    expect(mockUsePortfolio).not.toHaveBeenCalledWith({ scope: "global" });
    for (const [address] of mockUseWalletPortfolio.mock.calls) {
      expect(address).toBeNull();
    }
  });

  it("project reads the PROJECT portfolio, never the global one", () => {
    mountScoped(
      [token({ tokenName: "Token A", symbol: "AAA", balanceUsd: 10 })],
      PROJECT_SCOPE,
    );

    expect(mockUsePortfolio.mock.calls.length).toBeGreaterThan(0);
    for (const [input] of mockUsePortfolio.mock.calls) {
      expect(input).toEqual({ scope: "project", projectId: PROJECT });
    }
    expect(mockUsePortfolio).not.toHaveBeenCalledWith({ scope: "global" });
  });

  it("a wallet shows ITS read's rows, never the aggregate's", () => {
    mockUsePortfolio.mockReturnValue(
      ready([token({ tokenName: "Aggregate Only", symbol: "AGG", balanceUsd: 900 })]),
    );
    mountScoped(
      [token({ tokenName: "Wallet Only", symbol: "WAL", balanceUsd: 40 })],
      WALLET_SCOPE,
    );

    expect(mockUseWalletPortfolio).toHaveBeenCalledWith(WALLET.address);
    expect(rowNames()).toEqual(["Wallet Only"]);
    expect(screen.queryByText("Aggregate Only")).toBeNull();
  });

  it("a wallet with nothing says so even when the aggregate holds assets", () => {
    mockUsePortfolio.mockReturnValue(
      ready([token({ tokenName: "Aggregate Only", symbol: "AGG", balanceUsd: 900 })]),
    );
    mountScoped([], WALLET_SCOPE);

    expect(screen.getByText("No balances in this wallet yet.")).not.toBeNull();
    expect(screen.queryByText("Aggregate Only")).toBeNull();
  });

  it("a failed wallet read says so rather than falling back to the aggregate", () => {
    mockUsePortfolio.mockReturnValue(
      ready([token({ tokenName: "Aggregate Only", symbol: "AGG", balanceUsd: 900 })]),
    );
    mountState(
      {
        isLoading: false,
        isError: false,
        data: err(READ_FAILED),
      },
      WALLET_SCOPE,
    );

    expect(screen.getByText("Couldn't load your balances.")).not.toBeNull();
    expect(screen.queryByText("Aggregate Only")).toBeNull();
  });
});

describe("BalancesCard - the table", () => {
  it("is the Balances section with the five columns and a row actions key", () => {
    mountScoped([token({ tokenName: "Token A", symbol: "AAA", balanceUsd: 10 })]);

    expect(screen.getByRole("region", { name: "Balances" })).not.toBeNull();
    const table = document.querySelector('[data-vex-area="portfolio-balances"]');
    expect(table?.tagName).toBe("TABLE");
    const headings = [...document.querySelectorAll("thead th")].map(
      (th) => th.textContent ?? "",
    );
    expect(headings).toEqual(["Asset", "Network", "Quantity", "Price", "Value", "Actions"]);
    // The actions heading is for assistive tech only.
    expect(document.querySelector("thead th .sr-only")?.textContent).toBe("Actions");
    // The three figure columns are right aligned.
    const right = [...document.querySelectorAll("thead th.vex-pf-r")].map(
      (th) => th.textContent,
    );
    expect(right).toEqual(["Quantity", "Price", "Value"]);
  });

  it("prints name, network, quantity with its symbol, the unit price and the full-USD value", () => {
    mountScoped([
      token({
        tokenName: "Ether",
        symbol: "ETH",
        chainId: 1,
        amount: 1,
        balanceUsd: 2598.09,
      }),
    ]);

    const [row] = bodyRows();
    if (row === undefined) throw new Error("no balance row");
    const cells = cellsOf(row);
    expect(nameOf(row)).toBe("Ether");
    expect(cells[1]).toBe("Ethereum");
    expect(cells[2]).toBe("1.00 ETH");
    expect(cells[3]).toBe("$2,598.09");
    expect(cells[4]).toBe("$2,598.09");
    // The figure cells are mono.
    for (const index of [2, 3, 4]) {
      expect(row.querySelectorAll("td")[index]?.classList.contains("vex-num")).toBe(true);
    }
  });

  it("derives the price from value over quantity, the small-price form below a dollar", () => {
    mountScoped([
      token({ tokenName: "Four", symbol: "FOUR", amount: 4, balanceUsd: 10 }),
      token({ tokenName: "Penny", symbol: "PNY", amount: 1000, balanceUsd: 0.543 }),
    ]);

    expect(cellsOf(rowNamed("Four"))[3]).toBe("$2.50");
    expect(cellsOf(rowNamed("Four"))[4]).toBe("$10.00");
    expect(cellsOf(rowNamed("Penny"))[3]).toBe("$0.0005430");
    expect(cellsOf(rowNamed("Penny"))[4]).toBe("$0.54");
  });

  it("says Not available for a price it cannot derive: no quantity, or a non-positive one", () => {
    mountScoped([
      token({ tokenName: "No Quantity", symbol: "NOQ", amount: null, balanceUsd: 50 }),
      token({ tokenName: "Zero Quantity", symbol: "ZRQ", amount: 0, balanceUsd: 40 }),
    ]);

    for (const name of ["No Quantity", "Zero Quantity"]) {
      const cells = cellsOf(rowNamed(name));
      expect(cells[3]).toBe("Not available");
    }
    // The value is the read's own and still prints.
    expect(cellsOf(rowNamed("No Quantity"))[4]).toBe("$50.00");
    expect(cellsOf(rowNamed("No Quantity"))[2]).toBe("Not available");
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("names the network by the chain's display name and leaves a chainless line blank", () => {
    mountScoped([
      token({ tokenName: "USD Coin", symbol: "USDC", chainId: 8453, balanceUsd: 100 }),
      token({ tokenName: "Wrapped Ether", symbol: "WETH", chainId: 1, balanceUsd: 90 }),
      token({ tokenName: "Aggregate Line", symbol: "AGG", chainId: null, balanceUsd: 80 }),
    ]);

    expect(cellsOf(rowNamed("USD Coin"))[1]).toBe("Base");
    expect(cellsOf(rowNamed("Wrapped Ether"))[1]).toBe("Ethereum");
    // A `chainId: null` row is a real aggregate line: it keeps its place, with
    // no network, and is never dropped.
    expect(rowNames()).toContain("Aggregate Line");
    expect(cellsOf(rowNamed("Aggregate Line"))[1]).toBe("");
  });

  it("falls back to the sanitized symbol when there is no token name", () => {
    mountScoped([token({ symbol: "WETH", chainId: 1, balanceUsd: 90 })]);
    expect(rowNames()).toEqual(["WETH"]);
  });

  it("drops a hostile symbol to a dash when no name exists, and never prints it", () => {
    // A zero-width space spliced into "ETH": the sanitizer rejects it.
    mountScoped([token({ symbol: "E\u200bTH", chainId: 1, balanceUsd: 100, amount: 2 })]);

    const [row] = bodyRows();
    if (row === undefined) throw new Error("no balance row");
    expect(nameOf(row)).toBe("-");
    expect(document.body.textContent ?? "").not.toContain("\u200b");
    // No symbol suffix after the quantity either.
    expect(cellsOf(row)[2]).toBe("2.00");
  });

  it("keeps the main-sanitized name and drops a hostile symbol from the quantity", () => {
    mountScoped([
      token({ tokenName: "Ether", symbol: "E\u202eTH", chainId: 1, balanceUsd: 100, amount: 2 }),
    ]);

    const [row] = bodyRows();
    if (row === undefined) throw new Error("no balance row");
    expect(nameOf(row)).toBe("Ether");
    expect(cellsOf(row)[2]).toBe("2.00");
    expect(document.body.textContent ?? "").not.toContain("\u202e");
  });
});

describe("BalancesCard - top-5 ordering", () => {
  it("shows the five largest USD lines, sorted descending, from an unsorted payload", () => {
    mountScoped([
      token({ tokenName: "Token C", symbol: "CCC", balanceUsd: 300 }),
      token({ tokenName: "Token F", symbol: "FFF", balanceUsd: 25 }),
      token({ tokenName: "Token A", symbol: "AAA", balanceUsd: 600 }),
      token({ tokenName: "Token E", symbol: "EEE", balanceUsd: 50 }),
      token({ tokenName: "Token B", symbol: "BBB", balanceUsd: 500 }),
      token({ tokenName: "Token D", symbol: "DDD", balanceUsd: 100 }),
    ]);

    expect(rowNames()).toEqual(["Token A", "Token B", "Token C", "Token D", "Token E"]);
    // The sixth-largest line is deferred to the All assets page.
    expect(screen.queryByText("Token F")).toBeNull();
  });

  it("sorts unpriced (null USD) rows last and says Not available for their price and value", () => {
    mountScoped([
      token({ tokenName: "Unpriced", symbol: "VEX", balanceUsd: null, amount: 5 }),
      token({ tokenName: "Priced A", symbol: "AAA", balanceUsd: 40 }),
      token({ tokenName: "Priced B", symbol: "BBB", balanceUsd: 90 }),
    ]);

    expect(rowNames()).toEqual(["Priced B", "Priced A", "Unpriced"]);
    const unpriced = rowNamed("Unpriced");
    const cells = cellsOf(unpriced);
    // The quantity still shows; price and value say so, never a $0.00.
    expect(cells[2]).toBe("5.00 VEX");
    expect(cells[3]).toBe("Not available");
    expect(cells[4]).toBe("Not available");
    expect(unpriced.textContent).not.toContain("$0.00");
    expect(unpriced.hasAttribute("data-unpriced")).toBe(true);
    expect(rowNamed("Priced A").hasAttribute("data-unpriced")).toBe(false);
  });

  it("keeps an unpriced holding even when its quantity is unknown", () => {
    mountScoped([
      token({ tokenName: "Priced", symbol: "PRC", balanceUsd: 40 }),
      token({ tokenName: "Ghost", symbol: "GST", balanceUsd: null, amount: null }),
    ]);

    expect(rowNames()).toEqual(["Priced", "Ghost"]);
    expect(cellsOf(rowNamed("Ghost")).slice(2, 5)).toEqual([
      "Not available",
      "Not available",
      "Not available",
    ]);
  });
});

describe("BalancesCard - hide dust", () => {
  /**
   * 4 real (well-priced) rows + 2 sub-cent dust rows + 1 UNPRICED real
   * holding: without filtering, the raw sort ranks the 2 dust rows above
   * the unpriced row (unpriced always sorts last), so an un-gated top-5 cut
   * would seat one dust row in the 5th slot instead of the unpriced
   * holding - exactly the clutter the owner reported.
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
    mountScoped(MIXED_WITH_DUST);

    const names = rowNames();
    expect(names).toHaveLength(5);
    expect(names).not.toContain("Seeyuh");
    expect(names).not.toContain("Dust Two");
    expect(names).toContain("Unpriced Real");
  });

  it("lets a dust row occupy a top-5 slot when hideDustBalances is false", () => {
    useUiStore.setState({ hideDustBalances: false });
    mountScoped(MIXED_WITH_DUST);

    const names = rowNames();
    expect(names).toHaveLength(5);
    // Raw sort seats the larger dust row (0.002) 5th; the unpriced holding
    // (always last) is pushed out of the top-5 window.
    expect(names[4]).toBe("Dust Two");
    expect(names).not.toContain("Unpriced Real");
  });

  it("aligns the cut with the USD rounding: 0.004, 0 and a negative sub-cent hide, 0.006 shows as $0.01", () => {
    mountScoped([
      token({ tokenName: "Real", symbol: "REAL", balanceUsd: 12 }),
      token({ tokenName: "Hidden Cheap", symbol: "DUST", balanceUsd: 0.004 }),
      token({ tokenName: "Hidden Zero", symbol: "ZERO", balanceUsd: 0 }),
      token({ tokenName: "Hidden Negative", symbol: "NEG", balanceUsd: -0.002 }),
      token({ tokenName: "Edge", symbol: "EDGE", balanceUsd: 0.006 }),
    ]);

    expect(rowNames()).toEqual(["Real", "Edge"]);
    expect(cellsOf(rowNamed("Edge"))[4]).toBe("$0.01");
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("a scope holding only dust draws no table and no dust row, says so, and keeps the register door", () => {
    mountScoped([
      token({ tokenName: "Seeyuh", symbol: "SEEYUH", balanceUsd: 0.001 }),
      token({ tokenName: "Dust Two", symbol: "DUST2", balanceUsd: 0 }),
    ]);

    expect(document.querySelector('[data-vex-area="portfolio-balances"]')).toBeNull();
    expect(screen.queryByText("Seeyuh")).toBeNull();
    expect(screen.queryByText("Dust Two")).toBeNull();
    // Holdings exist, so the line is not the "fund a wallet" invitation, and
    // the full register (where the dust toggle lives) stays one click away.
    expect(screen.getByText("No priced balances.")).toBeTruthy();
    expect(screen.queryByText(/fund a wallet/)).toBeNull();
    expect(viewAllAssets()).not.toBeNull();
  });

  // 2 dust rows sort ahead of nothing, but 6 real rows exist: with the filter
  // applied AFTER the cut, the dust would eat visible slots.
  const DUST_AND_SIX_REAL: readonly PositionTokenDto[] = [
    token({ tokenName: "Dust 1", symbol: "D1", balanceUsd: 0.001 }),
    token({ tokenName: "Dust 2", symbol: "D2", balanceUsd: 0.002 }),
    token({ tokenName: "Real A", symbol: "AAA", balanceUsd: 600 }),
    token({ tokenName: "Real B", symbol: "BBB", balanceUsd: 500 }),
    token({ tokenName: "Real C", symbol: "CCC", balanceUsd: 400 }),
    token({ tokenName: "Real D", symbol: "DDD", balanceUsd: 300 }),
    token({ tokenName: "Real E", symbol: "EEE", balanceUsd: 200 }),
    token({ tokenName: "Real F", symbol: "FFF", balanceUsd: 100 }),
  ];

  it.each([
    ["global", GLOBAL_SCOPE],
    ["session", SESSION_SCOPE],
    ["project", PROJECT_SCOPE],
    ["wallet", WALLET_SCOPE],
  ] as const)(
    "filters dust BEFORE the top-5 cut under the %s scope - a dust row never takes a real holding's slot",
    (_label, scope) => {
      mountScoped(DUST_AND_SIX_REAL, scope);

      expect(rowNames()).toEqual(["Real A", "Real B", "Real C", "Real D", "Real E"]);
    },
  );
});

describe("BalancesCard - View all assets", () => {
  const ONE_ROW = [token({ tokenName: "Token A", symbol: "AAA", balanceUsd: 10 })];

  it("opens the assets route with the link's rect as the morph origin, GLOBAL for the global scope", () => {
    mountScoped(ONE_ROW, GLOBAL_SCOPE);

    const link = viewAllAssets();
    if (link === null) throw new Error("View all assets is not offered");
    fireEvent.click(link);

    // jsdom rects are all-zero: the pin is that the measured rect object (not
    // null) rode along as the expand origin.
    expect(useUiStore.getState().shellRoute).toStrictEqual({
      kind: "assets",
      origin: ORIGIN_ZERO,
      // The card is the GLOBAL scope: the page it opens must be too.
      sessionId: null,
    });
  });

  it("carries the session scope into the assets route it opens", () => {
    mountScoped(ONE_ROW, SESSION_SCOPE);

    const link = viewAllAssets();
    if (link === null) throw new Error("View all assets is not offered");
    fireEvent.click(link);

    expect(useUiStore.getState().shellRoute).toStrictEqual({
      kind: "assets",
      origin: ORIGIN_ZERO,
      sessionId: SESSION,
    });
  });

  it("carries the project scope into the assets route, never a session id beside it", () => {
    mountScoped(ONE_ROW, PROJECT_SCOPE);

    const link = viewAllAssets();
    if (link === null) throw new Error("View all assets is not offered");
    fireEvent.click(link);

    expect(useUiStore.getState().shellRoute).toStrictEqual({
      kind: "assets",
      origin: ORIGIN_ZERO,
      projectId: PROJECT,
    });
  });

  it("is NOT offered under a single wallet: the register has no wallet narrowing", () => {
    mountScoped(ONE_ROW, WALLET_SCOPE);

    expect(rowNames()).toEqual(["Token A"]);
    expect(viewAllAssets()).toBeNull();
  });

  it("is not offered when there are no balances, in every scope", () => {
    for (const scope of [GLOBAL_SCOPE, SESSION_SCOPE, PROJECT_SCOPE]) {
      mountScoped([], scope);
      expect(viewAllAssets()).toBeNull();
      cleanup();
    }
  });
});

describe("BalancesCard - the row menu", () => {
  it("opens Token history for an exact-identity row and routes with returnTo 'shell'", () => {
    mountScoped([
      token({
        tokenName: "USD Coin",
        symbol: "USDC",
        chainId: 8453,
        tokenAddress: USDC_BASE,
        balanceUsd: 100,
      }),
    ]);

    openActions("USD Coin");
    // One action, and it is the history.
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Token history",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Token history" }));

    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "tokenHistory",
      origin: null,
      token: {
        chainId: 8453,
        tokenAddress: USDC_BASE,
        symbol: "USDC",
        tokenName: "USD Coin",
      },
      returnTo: { kind: "shell" },
    });
    // Choosing closes the menu.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the menu closed until its key is pressed, and names the key by the row", () => {
    mountScoped([
      token({
        tokenName: "USD Coin",
        symbol: "USDC",
        chainId: 8453,
        tokenAddress: USDC_BASE,
        balanceUsd: 100,
      }),
    ]);

    expect(screen.queryByRole("menu")).toBeNull();
    const key = screen.getByRole("button", { name: "Actions for USD Coin" });
    expect(key.getAttribute("aria-haspopup")).toBe("menu");
    expect(key.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(key);
    expect(key.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu")).not.toBeNull();
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });

  it("names the history of a row by its sanitized symbol when it has no token name", () => {
    mountScoped([
      token({ symbol: "WETH", chainId: 1, tokenAddress: USDC_BASE, balanceUsd: 90 }),
    ]);

    openActions("WETH");
    fireEvent.click(screen.getByRole("menuitem", { name: "Token history" }));

    const route = useUiStore.getState().shellRoute;
    if (route.kind !== "tokenHistory") throw new Error("route kind mismatch");
    expect(route.token).toEqual({
      chainId: 1,
      tokenAddress: USDC_BASE,
      symbol: "WETH",
      tokenName: null,
    });
  });

  it("renders NO actions key for rows without exact (chainId, tokenAddress) identity", () => {
    mountScoped([
      // Address missing: no identity. Symbol and name are display metadata and
      // must never become a query input.
      token({ tokenName: "Legacy Row", symbol: "OLD", balanceUsd: 50 }),
      // Chain id missing: equally without actions.
      token({
        tokenName: "Chainless",
        symbol: "CHL",
        chainId: null,
        tokenAddress: USDC_BASE,
        balanceUsd: 25,
      }),
      // An empty address is no address.
      token({
        tokenName: "Empty Address",
        symbol: "EMP",
        tokenAddress: "",
        balanceUsd: 20,
      }),
    ]);

    expect(rowNames()).toEqual(["Legacy Row", "Chainless", "Empty Address"]);
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
    // The row keeps its (empty) actions cell: no disabled key stands in.
    for (const row of bodyRows()) {
      expect(row.querySelector("td.vex-pf-act")?.children).toHaveLength(0);
    }
  });

  it("gives only the identified rows a key when the table mixes both", () => {
    mountScoped([
      token({
        tokenName: "USD Coin",
        symbol: "USDC",
        chainId: 8453,
        tokenAddress: USDC_BASE,
        balanceUsd: 100,
      }),
      token({ tokenName: "Legacy Row", symbol: "OLD", balanceUsd: 50 }),
    ]);

    expect(screen.getAllByRole("button", { name: /^Actions for/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Actions for USD Coin" })).not.toBeNull();
  });
});

describe("BalancesCard - the per-scope empty note, loading and error", () => {
  it("states the whole-inventory invitation for global", () => {
    mountScoped([], GLOBAL_SCOPE);
    expect(
      screen.getByText("No balances yet. Fund a wallet and your holdings appear here."),
    ).not.toBeNull();
  });

  it("states the wallet note for one wallet", () => {
    mountScoped([], WALLET_SCOPE);
    expect(screen.getByText("No balances in this wallet yet.")).not.toBeNull();
  });

  it("states the SESSION invitation, never the global one", () => {
    mountScoped([], SESSION_SCOPE);
    expect(
      screen.getByText(
        "No balances in this session's wallets yet. Fund them and your holdings appear here.",
      ),
    ).not.toBeNull();
    expect(screen.queryByText(/No balances yet/)).toBeNull();
  });

  it("states the PROJECT invitation, never the session or global one", () => {
    mountScoped([], PROJECT_SCOPE);
    expect(
      screen.getByText(
        "No balances in this project's wallets yet. Fund them and your holdings appear here.",
      ),
    ).not.toBeNull();
    expect(screen.queryByText(/this session's wallets/)).toBeNull();
    expect(screen.queryByText(/No balances yet/)).toBeNull();
  });

  it("says Loading while the read is in flight, with no table and no empty note", () => {
    mountState({ isLoading: true, isError: false, data: undefined });

    expect(screen.getByText("Loading…")).not.toBeNull();
    expect(document.querySelector('[data-vex-area="portfolio-balances"]')).toBeNull();
    expect(screen.queryByText(/No balances yet/)).toBeNull();
    expect(viewAllAssets()).toBeNull();
  });

  it("says it could not load on a failed read or a transport error, never an empty invitation", () => {
    mountState({
      isLoading: false,
      isError: false,
      data: err(READ_FAILED),
    });
    expect(screen.getByText("Couldn't load your balances.")).not.toBeNull();
    expect(screen.queryByText(/No balances yet/)).toBeNull();
    cleanup();

    mountState({ isLoading: false, isError: true, data: undefined }, SESSION_SCOPE);
    expect(screen.getByText("Couldn't load your balances.")).not.toBeNull();
    expect(screen.queryByText(/this session's wallets/)).toBeNull();
  });
});
