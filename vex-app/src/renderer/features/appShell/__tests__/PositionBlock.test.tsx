/**
 * PositionBlock - the Portfolio page's total (docs/design/R3-MINIMAL.md
 * section 9.1): what the total includes, the money headline, the snapshot it
 * compares with and when the figures were loaded.
 *
 * Pins:
 *   - SCOPE IS THE ONLY INPUT and it is never widened: global, session and
 *     project each read exactly their own scope, a single wallet reads the
 *     global read narrowed by its own address and shows THAT read's figure,
 *   - the headline is the full USD figure ("$12,345.67", Intl, never compact)
 *     and the line over it names what the total includes, per scope,
 *   - the per-scope empty notes, the Add wallet route, the loading and error
 *     lines, and the refresh key + the chips the page hands in always stand,
 *   - the snapshot line says what the DTO says (the delta is `pnlVsPrev`, never
 *     a live gain), prints the snapshot's AGE, and past 24 hours mutes the
 *     delta (`data-stale`); no age when the DTO carries no (or a future)
 *     timestamp; "loaded HH:MM" is the query's own fetch time,
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
  // The block subscribes the page's figures to the activity pushes and hosts
  // the refresh key. Both are query-cache concerns owned by the api module.
  useActivityResolvedInvalidation: mockResolvedInvalidation,
  useActivityProgressInvalidation: mockProgressInvalidation,
  usePortfolioRefresh: () => ({ refresh: async () => ({ status: "refreshed" }) }),
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

function subLine(): HTMLElement {
  const found = document.querySelector(".vex-pf-top__sub");
  if (!(found instanceof HTMLElement)) throw new Error("missing snapshot line");
  return found;
}

function renderBlock(
  scope: Parameters<typeof PositionBlock>[0]["scope"] = { kind: "global" },
) {
  return render(<PositionBlock scope={scope} chips={null} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useUiStore.setState({ shellRoute: { kind: "none" } });
  mockScopeRead(portfolio());
  mockUseWalletPortfolio.mockReturnValue(NO_READ);
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

  it("subscribes the figures to the activity pushes", () => {
    renderBlock();
    expect(mockResolvedInvalidation).toHaveBeenCalled();
    expect(mockProgressInvalidation).toHaveBeenCalled();
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

  it("sets the headline in the block's header seam, in mono", () => {
    mockScopeRead(portfolio({ liveTotalUsd: 12345.67 }));
    renderBlock();
    const header = area("portfolio-total");
    expect(header.tagName).toBe("HEADER");
    const big = header.querySelector(".vex-pf-top__big");
    expect(big?.textContent).toBe("$12,345.67");
    expect(big?.classList.contains("vex-num")).toBe(true);
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

describe("PositionBlock - the refresh key and the chips stand in every state", () => {
  const chips = <div role="group" aria-label="Portfolio scope">chips</div>;

  function renderWithChips() {
    return render(<PositionBlock scope={{ kind: "global" }} chips={chips} />);
  }

  it("renders the refresh key and the handed chips beside a total", () => {
    renderWithChips();
    expect(screen.getByRole("button", { name: "Refresh portfolio" })).not.toBeNull();
    expect(screen.getByRole("group", { name: "Portfolio scope" })).not.toBeNull();
    expect(
      document.querySelector(".vex-pf-top__side")?.contains(
        screen.getByRole("group", { name: "Portfolio scope" }),
      ),
    ).toBe(true);
  });

  it("keeps both through loading, error and empty", () => {
    mockUsePortfolio.mockReturnValue({
      isLoading: true,
      isError: false,
      data: undefined,
      dataUpdatedAt: 0,
    });
    renderWithChips();
    expect(screen.getByRole("button", { name: "Refresh portfolio" })).not.toBeNull();
    expect(screen.getByRole("group", { name: "Portfolio scope" })).not.toBeNull();
    cleanup();

    mockUsePortfolio.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
      dataUpdatedAt: 0,
    });
    renderWithChips();
    expect(screen.getByRole("button", { name: "Refresh portfolio" })).not.toBeNull();
    expect(screen.getByRole("group", { name: "Portfolio scope" })).not.toBeNull();
    cleanup();

    mockScopeRead(portfolio({ walletCount: 0 }));
    renderWithChips();
    expect(screen.getByRole("button", { name: "Refresh portfolio" })).not.toBeNull();
    expect(screen.getByRole("group", { name: "Portfolio scope" })).not.toBeNull();
  });

  it("renders no chip group when the page hands none", () => {
    renderBlock();
    expect(screen.queryByRole("group", { name: "Portfolio scope" })).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh portfolio" })).not.toBeNull();
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

  it("prints the whole line: snapshot age, figure, delta against the one before, loaded time", () => {
    mountSnapshot("2026-09-04T11:55:00.000Z");
    expect(subLine().textContent).toBe(
      `Snapshot 5 min ago $100.62 · +$0.41 since the snapshot before · loaded ${LOADED_CLOCK}`,
    );
  });

  it("the delta is the DTO's snapshot-against-snapshot change, never a live gain", () => {
    // Live $62.71 against a $100.62 snapshot would read -$37.91; the DTO says
    // +$0.41 against the snapshot BEFORE, and that is what the line carries.
    mountSnapshot("2026-09-04T11:55:00.000Z");
    expect(subLine().textContent).not.toContain("37.91");
    expect(subLine().textContent).toContain("since the snapshot before");
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
    expect(subLine().textContent).toBe(
      `Snapshot $100.62 · +$0.41 since the snapshot before · loaded ${LOADED_CLOCK}`,
    );
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

  it("a snapshot without a comparison (pnlVsPrev null) prints the figure and no delta", () => {
    mountSnapshot("2026-09-04T11:55:00.000Z", { pnlVsPrev: null });

    expect(subLine().textContent).toBe(
      `Snapshot 5 min ago $100.62 · loaded ${LOADED_CLOCK}`,
    );
    expect(subLine().textContent).not.toContain("since the snapshot before");
    expect(document.querySelector(".vex-pf-top__pnl")).toBeNull();
  });

  it("with no snapshot at all the line carries only when the figures were loaded", () => {
    mountSnapshot(null, { snapshotTotalUsd: null, pnlVsPrev: null });

    expect(maybeArea("position-snapshot")).toBeNull();
    expect(subLine().textContent).toBe(`Loaded ${LOADED_CLOCK}`);
  });

  it("prints no loaded time when the query has no fetch time", () => {
    mockScopeRead(portfolio({ snapshotTotalUsd: 100.62, pnlVsPrev: 0.41 }), 0);
    renderBlock();
    expect(subLine().textContent).not.toContain("loaded");
    expect(subLine().textContent).toContain("Snapshot");

    cleanup();
    mockScopeRead(portfolio(), 0);
    renderBlock();
    // Nothing to say beneath the headline: no snapshot and no loaded time.
    expect(document.querySelector(".vex-pf-top__sub")).toBeNull();
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
