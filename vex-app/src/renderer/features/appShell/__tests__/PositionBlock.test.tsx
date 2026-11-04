/**
 * PositionBlock - the Portfolio page's tiles (docs/design/H3-DESKTOP.md
 * sections 1.9 and 4.1 item 12): the lead line with the REAL FUNDS stamp, and
 * one tile per real figure (the wallet total, the change since the snapshot
 * before, and for All wallets the Lighter equity and unrealized PnL), never a
 * cell for a figure desktop has no source for. The scope tabs, the refresh key and "Updated {time}"
 * stand in the page's tabs row (docs/design/H3-DESKTOP.md sections 1.9 and
 * 4.8), pinned in `PortfolioScreen.test.tsx`.
 *
 * Pins:
 *   - SCOPE IS THE ONLY INPUT and it is never widened: global, session and
 *     project each read exactly their own scope, a single wallet reads the
 *     global read narrowed by its own address and shows THAT read's figure,
 *   - the headline is the full USD figure ("$12,345.67", Intl, never compact)
 *     and the line over it names what the total includes, per scope,
 *   - the per-scope empty notes, the Add wallet route, the loading and error
 *     lines; the block itself draws neither the refresh key nor the tabs,
 *   - the snapshot line says what the DTO says (the delta is `pnlVsPrev`, never
 *     a live gain), prints the snapshot's AGE, and past 24 hours mutes the
 *     delta (`data-stale`); no age when the DTO carries no (or a future)
 *     timestamp; no fetch time is printed here (the tabs row's stamp has it),
 *   - chain read problems stay beside the cached total.
 *
 * The query hooks are mocked: this suite owns the block's display rules and
 * which read it asks for, not the query wiring (the real query layer is pinned
 * in `portfolio-scope-cards.test.tsx`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  PortfolioDto,
  PortfolioReadInput,
} from "@shared/schemas/portfolio.js";
import type { AvailableWalletDto } from "@shared/schemas/wallets.js";
import type { LighterTradingAccount } from "@shared/schemas/lighter-trading.js";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import { useUiStore } from "../../../stores/uiStore.js";

interface QueryStub {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly data: Result<PortfolioDto> | undefined;
  readonly dataUpdatedAt: number;
}

const mockUsePortfolio = vi.hoisted(() =>
  vi.fn<(input: PortfolioReadInput) => QueryStub>(),
);
const mockUseWalletPortfolio = vi.hoisted(() =>
  vi.fn<(address: string | null) => QueryStub>(),
);
const mockResolvedInvalidation = vi.hoisted(() => vi.fn());
const mockProgressInvalidation = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/api/portfolio.js", () => ({
  usePortfolio: mockUsePortfolio,
  useWalletPortfolio: mockUseWalletPortfolio,
  // The block hosts the refresh key, a query-cache concern owned by the api
  // module. The activity pushes are mocked only to prove the block never
  // subscribes them itself: AppShell holds them once for the whole app.
  useActivityResolvedInvalidation: mockResolvedInvalidation,
  useActivityProgressInvalidation: mockProgressInvalidation,
  usePortfolioRefresh: () => ({ refresh: async () => ({ status: "refreshed" }) }),
}));

// The Lighter account read behind the Lighter tiles: the Lighter section's own
// query, stubbed here to its answer.
const mockUseLighterTradingAccount = vi.hoisted(() =>
  vi.fn<(environment: string, enabled: boolean, sessionId?: string | null) => unknown>(),
);
vi.mock("../../../lib/api/lighter-trading.js", () => ({
  useLighterTradingAccount: mockUseLighterTradingAccount,
}));

/** A ready Lighter account on core: equity 1,020.00 (1,000 + 20), uPnL +20.00. */
const LIGHTER_READY: LighterTradingAccount = {
  environment: "core",
  retrievedAt: 0,
  status: "ready",
  unavailableReason: null,
  accountIndex: 7,
  openOrdersAvailable: true,
  openOrdersTruncated: false,
  summary: { collateral: "1000", availableBalance: "600", unrealizedPnl: "20" },
  assets: [],
  positions: [],
  marginTerms: [],
  exchangeFees: { makerTicks: 0, takerTicks: 350, source: "account" },
  openOrders: [],
};

function mockLighter(account: LighterTradingAccount | null): void {
  mockUseLighterTradingAccount.mockReturnValue({
    isLoading: false,
    isError: false,
    data: account === null ? undefined : ok(account),
  });
}

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

const { PositionBlock } = await import("../book/PositionBlock.js");

const SESSION = "00000000-0000-4000-8000-00000000aaaa";
const PROJECT = "00000000-0000-4000-8000-00000000bbbb";
const EVM_WALLET: AvailableWalletDto = {
  id: "evm-1",
  family: "evm",
  address: "0x1111111111111111111111111111111111111111",
  label: "Main",
};
const SOL_WALLET: AvailableWalletDto = {
  id: "sol-1",
  family: "solana",
  address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  label: "",
};

/** The query's own fetch time: local 09:07, so the "loaded" clock is "09:07". */
const LOADED_AT = new Date(2026, 8, 4, 9, 7, 30).getTime();
const LOADED_CLOCK = "09:07";

function portfolio(overrides: Partial<PortfolioDto> = {}): PortfolioDto {
  return {
    scope: "global",
    walletCount: 2,
    liveTotalUsd: 123.45,
    snapshotTotalUsd: null,
    pnlVsPrev: null,
    snapshotAt: null,
    tokens: [],
    chains: [],
    ...overrides,
  };
}

function ready(dto: PortfolioDto, dataUpdatedAt: number = LOADED_AT): QueryStub {
  return { isLoading: false, isError: false, data: ok(dto), dataUpdatedAt };
}

const NO_READ: QueryStub = {
  isLoading: false,
  isError: false,
  data: undefined,
  dataUpdatedAt: 0,
};

function mockScopeRead(dto: PortfolioDto, dataUpdatedAt: number = LOADED_AT): void {
  mockUsePortfolio.mockReturnValue(ready(dto, dataUpdatedAt));
}

/** Every input the scope read was asked for, across all renders. */
function scopeReads(): readonly PortfolioReadInput[] {
  return mockUsePortfolio.mock.calls.map(([input]) => input);
}

/** Every address the wallet read was asked for, across all renders. */
function walletReads(): readonly (string | null)[] {
  return mockUseWalletPortfolio.mock.calls.map(([address]) => address);
}

function area(name: string): HTMLElement {
  const found = document.querySelector(`[data-vex-area="${name}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`missing area: ${name}`);
  return found;
}

function maybeArea(name: string): HTMLElement | null {
  const found = document.querySelector(`[data-vex-area="${name}"]`);
  return found instanceof HTMLElement ? found : null;
}

function maybeTile(id: string): HTMLElement | null {
  const found = document.querySelector(`[data-vex-tile="${id}"]`);
  return found instanceof HTMLElement ? found : null;
}

function tile(id: string): HTMLElement {
  const found = maybeTile(id);
  if (found === null) throw new Error(`missing tile: ${id}`);
  return found;
}

/** The tiles drawn, in order. */
function tileIds(): readonly (string | null)[] {
  return [...document.querySelectorAll("[data-vex-tile]")].map((node) =>
    node.getAttribute("data-vex-tile"),
  );
}

function tileLabel(node: HTMLElement): string | null {
  return node.querySelector(".vex-pf-tile__l")?.textContent ?? null;
}

function tileFigure(node: HTMLElement): string | null {
  return node.querySelector(".vex-pf-tile__fig")?.textContent ?? null;
}

/** The snapshot tile's muted line (the change tile, or Last snapshot). */
function subLine(): HTMLElement {
  const found = document.querySelector('[data-vex-area="position-snapshot"] .vex-pf-tile__sub');
  if (!(found instanceof HTMLElement)) throw new Error("missing snapshot line");
  return found;
}

function renderBlock(
  scope: Parameters<typeof PositionBlock>[0]["scope"] = { kind: "global" },
) {
  return render(<PositionBlock scope={scope} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useUiStore.setState({ shellRoute: { kind: "none" } });
  mockScopeRead(portfolio());
  mockUseWalletPortfolio.mockReturnValue(NO_READ);
  mockLighter(null);
});

afterEach(() => {
  cleanup();
});

describe("PositionBlock - each scope reads its own scope and never a wider one", () => {
  it("global reads the global portfolio and never asks for a wallet", () => {
    renderBlock({ kind: "global" });

    expect(scopeReads().length).toBeGreaterThan(0);
    for (const input of scopeReads()) expect(input).toEqual({ scope: "global" });
    // The wallet-narrowed read stays disabled by its null address.
    for (const address of walletReads()) expect(address).toBeNull();
    expect(screen.getByText("$123.45")).not.toBeNull();
  });

  it("session reads exactly that session - never the global inventory", () => {
    mockScopeRead(portfolio({ scope: "session", liveTotalUsd: 40 }));
    renderBlock({ kind: "session", sessionId: SESSION });

    expect(scopeReads().length).toBeGreaterThan(0);
    for (const input of scopeReads()) {
      expect(input).toEqual({ scope: "session", sessionId: SESSION });
    }
    expect(mockUsePortfolio).not.toHaveBeenCalledWith({ scope: "global" });
    for (const address of walletReads()) expect(address).toBeNull();
    expect(screen.getByText("$40.00")).not.toBeNull();
  });

  it("project reads exactly that project - never the global inventory", () => {
    mockScopeRead(portfolio({ scope: "project", liveTotalUsd: 75 }));
    renderBlock({ kind: "project", projectId: PROJECT });

    expect(scopeReads().length).toBeGreaterThan(0);
    for (const input of scopeReads()) {
      expect(input).toEqual({ scope: "project", projectId: PROJECT });
    }
    expect(mockUsePortfolio).not.toHaveBeenCalledWith({ scope: "global" });
    for (const address of walletReads()) expect(address).toBeNull();
    expect(screen.getByText("$75.00")).not.toBeNull();
  });

  it("a wallet reads the global read narrowed by ITS address and shows that read's figure", () => {
    mockScopeRead(portfolio({ liveTotalUsd: 9999.99, walletCount: 2 }));
    mockUseWalletPortfolio.mockReturnValue(
      ready(portfolio({ liveTotalUsd: 111.11, walletCount: 1 })),
    );
    renderBlock({ kind: "wallet", wallet: EVM_WALLET });

    expect(mockUseWalletPortfolio).toHaveBeenCalledWith(EVM_WALLET.address);
    expect(screen.getByText("$111.11")).not.toBeNull();
    // The aggregate rides in the cache but is NOT the figure for this wallet.
    expect(screen.queryByText("$9,999.99")).toBeNull();
    // No session or project read leaks into a wallet scope.
    for (const input of scopeReads()) expect(input).toEqual({ scope: "global" });
  });

  it("leaves the activity pushes to the shell and never subscribes them twice", () => {
    renderBlock();
    expect(mockResolvedInvalidation).not.toHaveBeenCalled();
    expect(mockProgressInvalidation).not.toHaveBeenCalled();
  });
});

describe("PositionBlock - the headline", () => {
  it("prints the total as the full USD figure, never compact", () => {
    mockScopeRead(portfolio({ liveTotalUsd: 12345.67 }));
    renderBlock();
    expect(screen.getByText("$12,345.67")).not.toBeNull();

    cleanup();
    mockScopeRead(portfolio({ liveTotalUsd: 1234567.891 }));
    renderBlock();
    expect(screen.getByText("$1,234,567.89")).not.toBeNull();
    expect(screen.queryByText(/\$1\.2M/)).toBeNull();
    expect(screen.queryByText(/K\b/)).toBeNull();
  });

  it("sets the total as the first tile, Wallet total, in the block's header seam", () => {
    mockScopeRead(portfolio({ liveTotalUsd: 12345.67 }));
    renderBlock();
    const header = area("portfolio-total");
    expect(header.tagName).toBe("HEADER");
    expect(tileIds()[0]).toBe("total");
    const total = tile("total");
    expect(header.contains(total)).toBe(true);
    expect(tileLabel(total)).toBe("Wallet total");
    expect(total.querySelector(".vex-pf-top__big")?.textContent).toBe("$12,345.67");
    // The settled balances: the live total counts no money in transit.
    expect(total.querySelector(".vex-pf-tile__sub")?.textContent).toBe("Settled balances");
  });

  it("a real zero total reads $0.00, a non-finite one says Not available", () => {
    mockScopeRead(portfolio({ liveTotalUsd: 0 }));
    renderBlock();
    expect(screen.getByText("$0.00")).not.toBeNull();

    cleanup();
    mockScopeRead(portfolio({ liveTotalUsd: Number.NaN }));
    renderBlock();
    expect(screen.getByText("Not available")).not.toBeNull();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("names what the total includes, per scope, and says Lighter is separate", () => {
    mockScopeRead(portfolio({ walletCount: 3 }));
    renderBlock({ kind: "global" });
    expect(
      screen.getByText(
        "Total value of your 3 on-chain wallets · Lighter is shown separately",
      ),
    ).not.toBeNull();

    cleanup();
    mockScopeRead(portfolio({ walletCount: 1 }));
    renderBlock({ kind: "global" });
    expect(
      screen.getByText(
        "Total value of your 1 on-chain wallet · Lighter is shown separately",
      ),
    ).not.toBeNull();

    cleanup();
    mockScopeRead(portfolio({ scope: "session", walletCount: 2 }));
    renderBlock({ kind: "session", sessionId: SESSION });
    expect(
      screen.getByText(
        "Total value of this chat's 2 on-chain wallets · Lighter is shown separately",
      ),
    ).not.toBeNull();

    cleanup();
    mockScopeRead(portfolio({ scope: "project", walletCount: 2 }));
    renderBlock({ kind: "project", projectId: PROJECT });
    expect(
      screen.getByText(
        "Total value of this project's 2 on-chain wallets · Lighter is shown separately",
      ),
    ).not.toBeNull();

    cleanup();
    mockUseWalletPortfolio.mockReturnValue(ready(portfolio({ walletCount: 1 })));
    renderBlock({ kind: "wallet", wallet: EVM_WALLET });
    expect(
      screen.getByText("Total value of Main · Lighter is shown separately"),
    ).not.toBeNull();
  });

  it("names an unlabeled wallet by its family", () => {
    mockUseWalletPortfolio.mockReturnValue(ready(portfolio({ walletCount: 1 })));
    renderBlock({ kind: "wallet", wallet: SOL_WALLET });
    expect(
      screen.getByText("Total value of SOL · Lighter is shown separately"),
    ).not.toBeNull();
  });

  it("keeps the total on the DTO's own figure even when every token is dust", () => {
    mockScopeRead(
      portfolio({
        liveTotalUsd: 987.65,
        tokens: [
          { chainId: 1, symbol: "DUST", balanceUsd: 0.001, amount: 1 },
          { chainId: 1, symbol: "ZERO", balanceUsd: 0, amount: 1 },
        ],
      }),
    );
    renderBlock();
    expect(screen.getByText("$987.65")).not.toBeNull();
    // The total block lists no token rows: that is the Balances table's job.
    expect(screen.queryByText("DUST")).toBeNull();
  });
});

describe("PositionBlock - empty, loading and error", () => {
  it("states the whole-inventory empty note and routes Add wallet to Settings wallets", () => {
    mockScopeRead(portfolio({ walletCount: 0, liveTotalUsd: 0 }));
    renderBlock({ kind: "global" });

    expect(
      screen.getByText(
        "No wallets configured yet. Add your first and your total appears here.",
      ),
    ).not.toBeNull();
    expect(document.querySelector(".vex-pf-top__big")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
    // jsdom rects are all-zero: the pin is that the measured rect object (not
    // null) rode along as the page's origin.
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "settings",
      origin: { x: 0, y: 0, width: 0, height: 0 },
      section: "wallets",
    });
  });

  it("a single wallet with nothing configured says the same and offers Add wallet", () => {
    mockUseWalletPortfolio.mockReturnValue(ready(portfolio({ walletCount: 0 })));
    renderBlock({ kind: "wallet", wallet: EVM_WALLET });

    expect(
      screen.getByText(
        "No wallets configured yet. Add your first and your total appears here.",
      ),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
    expect(useUiStore.getState().shellRoute.kind).toBe("settings");
  });

  it("names the SESSION when the scope holds no wallets, with no Add wallet", () => {
    mockScopeRead(portfolio({ scope: "session", walletCount: 0 }));
    renderBlock({ kind: "session", sessionId: SESSION });

    expect(screen.getByText("No wallets in this session.")).not.toBeNull();
    expect(screen.queryByText("No wallets selected for this project.")).toBeNull();
    expect(screen.queryByText(/No wallets configured yet/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add wallet" })).toBeNull();
  });

  it("names the PROJECT when the scope holds no wallets, with no Add wallet", () => {
    mockScopeRead(portfolio({ scope: "project", walletCount: 0 }));
    renderBlock({ kind: "project", projectId: PROJECT });

    expect(screen.getByText("No wallets selected for this project.")).not.toBeNull();
    expect(screen.queryByText("No wallets in this session.")).toBeNull();
    expect(screen.queryByText(/No wallets configured yet/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add wallet" })).toBeNull();
  });

  it("says Loading while the read is in flight and prints no figure", () => {
    mockUsePortfolio.mockReturnValue({
      isLoading: true,
      isError: false,
      data: undefined,
      dataUpdatedAt: 0,
    });
    renderBlock();

    expect(screen.getByText("Loading your portfolio…")).not.toBeNull();
    expect(document.querySelector(".vex-pf-top__big")).toBeNull();
    expect(screen.queryByText("Not available")).toBeNull();
  });

  it("a failed read says it could not load, never a zero or an empty-wallets note", () => {
    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: err(READ_FAILED),
      dataUpdatedAt: 0,
    });
    renderBlock();

    expect(screen.getByText("Couldn't load your portfolio.")).not.toBeNull();
    expect(document.querySelector(".vex-pf-top__big")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText(/No wallets configured yet/)).toBeNull();
  });

  it("a transport error says it could not load too", () => {
    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
      dataUpdatedAt: 0,
    });
    renderBlock({ kind: "session", sessionId: SESSION });

    expect(screen.getByText("Couldn't load your portfolio.")).not.toBeNull();
    expect(screen.queryByText("No wallets in this session.")).toBeNull();
  });

  it("a wallet read that failed says so rather than falling back to the aggregate", () => {
    mockScopeRead(portfolio({ liveTotalUsd: 9999.99 }));
    mockUseWalletPortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: err(READ_FAILED),
      dataUpdatedAt: 0,
    });
    renderBlock({ kind: "wallet", wallet: EVM_WALLET });

    expect(screen.getByText("Couldn't load your portfolio.")).not.toBeNull();
    expect(screen.queryByText("$9,999.99")).toBeNull();
  });
});

describe("PositionBlock - the tiles are real figures only (H3 section 4.1, item 12)", () => {
  it("draws the REAL FUNDS stamp and the lead, and no PAPER or LIVE key", () => {
    renderBlock();
    const lead = area("portfolio-total").querySelector(".vex-pf-lead");
    expect(lead?.querySelector(".vex-stamp")?.textContent).toBe("Real funds");
    expect(lead?.textContent).toContain("Real money on mainnet.");
    expect(screen.queryByText(/paper/i)).toBeNull();
    expect(screen.queryByText(/^live/i)).toBeNull();
  });

  it("draws one tile per figure the reads carry, and no cell for the rest", () => {
    mockScopeRead(portfolio({ snapshotTotalUsd: 100, pnlVsPrev: 1, snapshotAt: null }));
    renderBlock();
    expect(tileIds()).toEqual(["total", "change"]);
    expect(area("portfolio-total").querySelector(".vex-pf-tiles")?.getAttribute("data-count")).toBe("2");
    // H3's tiles with no desktop source are never drawn, not even empty.
    const words = area("portfolio-total").textContent ?? "";
    for (const absent of ["Today", "7 days", "All time", "Drawdown", "Running", "allocated", "strateg"]) {
      expect(words.toLowerCase()).not.toContain(absent.toLowerCase());
    }
  });

  it("adds Lighter equity and the unrealized PnL from a ready account, for All wallets", () => {
    mockLighter({
      ...LIGHTER_READY,
      positions: [
        {
          marketId: 1,
          symbol: "ETH",
          side: "long",
          size: "0.5",
          entryPrice: "2000",
          value: "1100",
          unrealizedPnl: "20",
          liquidationPrice: "1500",
          initialMarginFraction: 1000,
          marginMode: "cross",
          allocatedMargin: null,
        },
      ],
    });
    renderBlock({ kind: "global" });
    expect(tileIds()).toEqual(["total", "lighter-equity", "lighter-pnl"]);
    expect(tileFigure(tile("lighter-equity"))).toBe("1,020.00 USDC");
    expect(tile("lighter-equity").querySelector(".vex-pf-tile__sub")?.textContent).toBe(
      "Not in the wallet total",
    );
    const pnl = tile("lighter-pnl");
    expect(tileFigure(pnl)).toBe("+20.00 USDC");
    // The PnL IS a trading value: it takes the gain colour.
    expect(pnl.querySelector('[data-trade="up"]')).not.toBeNull();
    expect(pnl.querySelector(".vex-pf-tile__sub")?.textContent).toBe("1 open Lighter position");
    // The tiles read the Lighter section's own unscoped account, enabled.
    const [, enabled, sessionId] = mockUseLighterTradingAccount.mock.calls[0] ?? [];
    expect(enabled).toBe(true);
    expect(sessionId).toBeUndefined();
  });

  it("draws no Lighter tile while the page is narrowed, and never reads it then", () => {
    mockLighter(LIGHTER_READY);
    mockUseWalletPortfolio.mockReturnValue(ready(portfolio({ walletCount: 1 })));
    renderBlock({ kind: "wallet", wallet: EVM_WALLET });
    expect(tileIds()).toEqual(["total"]);
    cleanup();

    mockScopeRead(portfolio({ scope: "session", walletCount: 1 }));
    renderBlock({ kind: "session", sessionId: SESSION });
    expect(tileIds()).toEqual(["total"]);
    for (const [, enabled] of mockUseLighterTradingAccount.mock.calls) {
      expect(enabled).toBe(false);
    }
  });

  it("draws no Lighter tile for an account that is not ready, or a figure the read lacks", () => {
    mockLighter({ ...LIGHTER_READY, status: "unavailable", unavailableReason: "not_onboarded", summary: null });
    renderBlock();
    expect(tileIds()).toEqual(["total"]);
    cleanup();

    mockLighter({ ...LIGHTER_READY, summary: { collateral: "1000", availableBalance: "600", unrealizedPnl: null } });
    renderBlock();
    // Equity is collateral plus a missing PnL counted as none; the PnL tile goes.
    expect(tileIds()).toEqual(["total", "lighter-equity"]);
  });
});

describe("PositionBlock - the frame's parts are not the block's", () => {
  it("draws neither the refresh key nor the scope tabs, in any state", () => {
    renderBlock();
    expect(screen.queryByRole("button", { name: "Refresh portfolio" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Portfolio scope" })).toBeNull();
    cleanup();

    mockUsePortfolio.mockReturnValue({
      isLoading: true,
      isError: false,
      data: undefined,
      dataUpdatedAt: 0,
    });
    renderBlock();
    expect(screen.queryByRole("button", { name: "Refresh portfolio" })).toBeNull();
  });
});

describe("PositionBlock snapshot line (owner measurement 2026-09-04)", () => {
  // The clock is read at render, so the age is a deterministic function of
  // the fixture's `snapshotAt` and this fake now.
  const NOW = new Date("2026-09-04T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mountSnapshot(
    snapshotAt: string | null,
    overrides: Partial<PortfolioDto> = {},
  ) {
    mockScopeRead(
      portfolio({
        liveTotalUsd: 62.71,
        snapshotTotalUsd: 100.62,
        pnlVsPrev: 0.41,
        snapshotAt,
        ...overrides,
      }),
    );
    return renderBlock();
  }

  it("a FRESH snapshot states its age and keeps the ink delta", () => {
    mountSnapshot("2026-09-04T11:55:00.000Z");

    const seam = area("position-snapshot");
    expect(seam.getAttribute("data-stale")).toBe("false");
    expect(area("position-snapshot-age").textContent).toContain("5 min ago");

    const delta = screen.getByLabelText("Change from the snapshot before +$0.41");
    expect(delta.textContent).toBe("+$0.41");
    expect(delta.classList.contains("vex-pf-top__pnl")).toBe(true);
    expect(delta.getAttribute("data-stale")).toBe("false");
    // Direction is the sign, never a colour: no inline tone on the delta.
    expect(delta.getAttribute("style")).toBeNull();
  });

  it("the tile: the change against the one before, the snapshot's figure and its age", () => {
    mountSnapshot("2026-09-04T11:55:00.000Z");
    const change = tile("change");
    expect(tileLabel(change)).toBe("Since the snapshot before");
    expect(tileFigure(change)).toBe("+$0.41");
    expect(subLine().textContent).toBe("Snapshot $100.62, 5 min ago");
  });

  it("the delta is the DTO's snapshot-against-snapshot change, never a live gain", () => {
    // Live $62.71 against a $100.62 snapshot would read -$37.91; the DTO says
    // +$0.41 against the snapshot BEFORE, and that is what the tile carries.
    mountSnapshot("2026-09-04T11:55:00.000Z");
    expect(area("portfolio-total").textContent).not.toContain("37.91");
    expect(tileLabel(tile("change"))).toBe("Since the snapshot before");
  });

  it("is a change in wallet value, not trading P&L: it never takes a trading colour", () => {
    mountSnapshot("2026-09-04T11:55:00.000Z", { pnlVsPrev: 12.5 });
    expect(tile("change").querySelector("[data-trade]")).toBeNull();
    cleanup();
    mountSnapshot("2026-09-04T11:55:00.000Z", { pnlVsPrev: -12.5 });
    expect(tile("change").querySelector("[data-trade]")).toBeNull();
  });

  it("a STALE snapshot (31 days) states its age and MUTES the delta - not a live gain", () => {
    mountSnapshot("2026-08-04T12:00:00.000Z");

    expect(area("position-snapshot").getAttribute("data-stale")).toBe("true");
    expect(area("position-snapshot-age").textContent).toContain("31 days ago");

    const delta = screen.getByLabelText("Change from the snapshot before +$0.41");
    expect(delta.getAttribute("data-stale")).toBe("true");
    // The figures themselves are untouched: the tone changed, not the truth.
    expect(delta.textContent).toBe("+$0.41");
    expect(subLine().textContent).toContain("$100.62");
  });

  it.each([
    ["2026-09-03T13:00:00.000Z", "23 hours ago", "false"],
    ["2026-09-03T11:00:00.000Z", "1 day ago", "true"],
  ])("the 24 hour line: a snapshot from %s is %s (stale: %s)", (at, label, stale) => {
    mountSnapshot(at);
    expect(area("position-snapshot").getAttribute("data-stale")).toBe(stale);
    expect(area("position-snapshot-age").textContent).toContain(label);
  });

  it("renders no age when the DTO carries no snapshot timestamp, and keeps the delta", () => {
    mountSnapshot(null);

    expect(maybeArea("position-snapshot-age")).toBeNull();
    expect(subLine().textContent).toBe("Snapshot $100.62");
    expect(screen.getByLabelText("Change from the snapshot before +$0.41")).not.toBeNull();
  });

  it("renders no age for a snapshot dated in the future (clock skew)", () => {
    mountSnapshot("2026-09-04T12:30:00.000Z");
    expect(maybeArea("position-snapshot-age")).toBeNull();
  });

  it("signs the delta by value: negative, zero", () => {
    mountSnapshot("2026-09-04T11:55:00.000Z", { pnlVsPrev: -4.1 });
    expect(screen.getByLabelText("Change from the snapshot before -$4.10").textContent).toBe(
      "-$4.10",
    );

    cleanup();
    mountSnapshot("2026-09-04T11:55:00.000Z", { pnlVsPrev: 0 });
    expect(screen.getByLabelText("Change from the snapshot before $0.00").textContent).toBe(
      "$0.00",
    );
  });

  it("a snapshot without a comparison (pnlVsPrev null) is the Last snapshot tile, with no delta", () => {
    mountSnapshot("2026-09-04T11:55:00.000Z", { pnlVsPrev: null });

    const last = tile("snapshot");
    expect(tileLabel(last)).toBe("Last snapshot");
    expect(tileFigure(last)).toBe("$100.62");
    expect(subLine().textContent).toBe("5 min ago");
    expect(maybeTile("change")).toBeNull();
    expect(document.querySelector(".vex-pf-top__pnl")).toBeNull();
  });

  it("with no snapshot at all there is no snapshot tile, only the total", () => {
    mountSnapshot(null, { snapshotTotalUsd: null, pnlVsPrev: null });

    expect(maybeArea("position-snapshot")).toBeNull();
    expect(tileIds()).toEqual(["total"]);
  });

  it("never prints the fetch time: the tabs row's Updated stamp carries it", () => {
    mountSnapshot("2026-09-04T11:55:00.000Z");
    expect(area("portfolio-total").textContent).not.toContain("loaded");
    expect(area("portfolio-total").textContent).not.toContain(LOADED_CLOCK);
  });
});

describe("PositionBlock - chain read uncertainty stays beside the cached total", () => {
  it("shows the stale chain, its timestamps and the stale-balances line", () => {
    const staleSince = "2026-09-08T20:37:00.000Z";
    const lastSuccessAt = "2026-09-07T10:00:00.000Z";
    mockScopeRead(
      portfolio({
        chainReadIssues: [
          {
            chainId: 20011000000,
            status: "read_failed",
            reason: "http_403",
            staleSince,
            lastSuccessAt,
          },
        ],
      }),
    );
    const { container } = renderBlock();

    const warning = screen.getByRole("status");
    expect(warning.textContent).toContain("Solana: stale since");
    expect(warning.textContent).toContain("Some balances are stale. Totals include last known values.");
    expect(container.querySelector(`time[datetime="${staleSince}"]`)).not.toBeNull();
    expect(container.querySelector(`time[datetime="${lastSuccessAt}"]`)).not.toBeNull();
    // The cached total is still printed, with the warning beside it.
    expect(screen.getByText("$123.45")).not.toBeNull();
  });

  it("labels a partial snapshot and says its P&L is unavailable", () => {
    mockScopeRead(
      portfolio({
        snapshotPartial: true,
        snapshotUnresolvedChainCount: 1,
        snapshotTotalUsd: 100,
        pnlVsPrev: null,
      }),
    );
    renderBlock();
    const warning = screen.getByRole("status");
    expect(warning.textContent).toContain("Latest snapshot is partial (1 unresolved chain reads)");
    expect(warning.textContent).toContain("P&L is unavailable");
  });

  it("is silent for a clean read", () => {
    mockScopeRead(portfolio({ chainReadIssues: [], snapshotPartial: false }));
    renderBlock();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
