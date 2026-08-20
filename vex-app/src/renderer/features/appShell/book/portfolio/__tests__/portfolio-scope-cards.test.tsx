/**
 * Characterization pins for the three scope-driven portfolio cards
 * (Portfolio Overview / Wallets / Balances) around the vex-studio scope seam:
 * a card's reads are a function of its scope input, never of session state
 * read inside the card. Written against the pre-refactor behavior first and
 * kept green across the scope-param refactor — the assertions describe
 * observable behavior (which IPC read fires, what renders), not wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { PortfolioDto } from "@shared/schemas/portfolio.js";
import { useUiStore } from "../../../../../stores/uiStore.js";
import { PortfolioOverviewCard } from "../PortfolioOverviewCard.js";
import { WalletsCard } from "../WalletsCard.js";
import { BalancesCard } from "../BalancesCard.js";
import { GLOBAL_PORTFOLIO_SCOPE } from "../portfolio-scope.js";

const readMock = vi.fn();
const listAvailableMock = vi.fn();

function installVexBridge(): void {
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      portfolio: { read: readMock },
      wallets: { listAvailable: listAvailableMock },
    },
  });
}

function portfolio(overrides: Partial<PortfolioDto> = {}): PortfolioDto {
  return {
    scope: "global",
    walletCount: 2,
    liveTotalUsd: 1234.56,
    snapshotTotalUsd: 1200,
    pnlVsPrev: 34.56,
    snapshotAt: "2026-08-20T10:00:00.000Z",
    tokens: [],
    chains: [],
    ...overrides,
  };
}

const EVM_WALLET = {
  id: "evm-1",
  family: "evm" as const,
  address: "0x1111111111111111111111111111111111111111",
  label: "Main",
};
const SOL_WALLET = {
  id: "sol-1",
  family: "solana" as const,
  address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  label: "",
};

const SESSION = "00000000-0000-4000-8000-0000000000aa";

function token(symbol: string, usd: number | null) {
  return {
    chainId: 8453,
    symbol,
    tokenAddress: null,
    tokenName: null,
    balanceUsd: usd,
    amount: null,
  };
}

function renderWith(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  installVexBridge();
  readMock.mockReset();
  listAvailableMock.mockReset();
});

afterEach(cleanup);

describe("BalancesCard scope input", () => {
  it("a global scope reads the global portfolio, never a session one", async () => {
    readMock.mockResolvedValue({
      ok: true,
      data: portfolio({ tokens: [token("ETH", 900), token("USDC", 100)] }),
    });
    renderWith(<BalancesCard scope={GLOBAL_PORTFOLIO_SCOPE} />);
    await screen.findByText(/ETH/);
    expect(readMock).toHaveBeenCalledWith({ scope: "global" });
  });

  it("a session scope narrows the read to exactly that session id", async () => {
    readMock.mockResolvedValue({
      ok: true,
      data: portfolio({ scope: "session", tokens: [token("SOL", 40)] }),
    });
    renderWith(<BalancesCard scope={{ kind: "session", sessionId: SESSION }} />);
    await screen.findByText(/SOL/);
    expect(readMock).toHaveBeenCalledWith({
      scope: "session",
      sessionId: SESSION,
    });
  });

  it("shows at most the top five holdings, largest USD first, dust cut before the cap", async () => {
    // Seven priced rows: one sub-cent dust row ($0.004 < $0.005 threshold)
    // must be dropped BEFORE the top-5 cut, so the $1 row still makes the
    // list; the sixth-largest real row ($2) then falls off the cap.
    readMock.mockResolvedValue({
      ok: true,
      data: portfolio({
        tokens: [
          token("DUST", 0.004),
          token("A", 500),
          token("B", 400),
          token("C", 300),
          token("D", 200),
          token("E", 100),
          token("F", 2),
        ],
      }),
    });
    renderWith(<BalancesCard scope={GLOBAL_PORTFOLIO_SCOPE} />);
    await screen.findByText(/\bA\b/);
    for (const visible of ["A", "B", "C", "D", "E"]) {
      expect(screen.getByText(new RegExp(`\\b${visible}\\b`))).toBeTruthy();
    }
    expect(screen.queryByText(/\bF\b/)).toBeNull();
    expect(screen.queryByText(/DUST/)).toBeNull();
  });

  it("the global and session empty states speak different sentences", async () => {
    readMock.mockResolvedValue({ ok: true, data: portfolio({ tokens: [] }) });
    renderWith(<BalancesCard scope={GLOBAL_PORTFOLIO_SCOPE} />);
    await screen.findByText(/No balances yet/);
    cleanup();
    readMock.mockResolvedValue({
      ok: true,
      data: portfolio({ scope: "session", tokens: [] }),
    });
    renderWith(<BalancesCard scope={{ kind: "session", sessionId: SESSION }} />);
    await screen.findByText(/No balances in this session/);
  });
});

describe("PortfolioOverviewCard scope input", () => {
  it("renders the aggregate total from the global read", async () => {
    readMock.mockResolvedValue({ ok: true, data: portfolio() });
    listAvailableMock.mockResolvedValue({
      ok: true,
      data: { evm: [EVM_WALLET], solana: [] },
    });
    renderWith(<PortfolioOverviewCard scope={GLOBAL_PORTFOLIO_SCOPE} />);
    await screen.findByText("$1234.56");
    expect(readMock).toHaveBeenCalledWith({ scope: "global" });
  });

  it("hides the wallet chip row at exactly one wallet and shows it at two", async () => {
    readMock.mockResolvedValue({ ok: true, data: portfolio() });
    listAvailableMock.mockResolvedValue({
      ok: true,
      data: { evm: [EVM_WALLET], solana: [] },
    });
    renderWith(<PortfolioOverviewCard scope={GLOBAL_PORTFOLIO_SCOPE} />);
    await screen.findByText("$1234.56");
    expect(screen.queryByRole("group", { name: "Portfolio scope" })).toBeNull();
    cleanup();
    listAvailableMock.mockResolvedValue({
      ok: true,
      data: { evm: [EVM_WALLET], solana: [SOL_WALLET] },
    });
    renderWith(<PortfolioOverviewCard scope={GLOBAL_PORTFOLIO_SCOPE} />);
    await screen.findByRole("group", { name: "Portfolio scope" });
  });

  it("selecting a wallet chip narrows the read to that wallet; All wallets restores the aggregate", async () => {
    readMock.mockImplementation((input: { walletAddress?: string }) =>
      Promise.resolve({
        ok: true,
        data: portfolio(
          input.walletAddress === undefined ? {} : { liveTotalUsd: 111.11 },
        ),
      }),
    );
    listAvailableMock.mockResolvedValue({
      ok: true,
      data: { evm: [EVM_WALLET], solana: [SOL_WALLET] },
    });
    renderWith(<PortfolioOverviewCard scope={GLOBAL_PORTFOLIO_SCOPE} />);
    await screen.findByText("$1234.56");
    fireEvent.click(screen.getByRole("button", { name: /Main/ }));
    await screen.findByText("$111.11");
    expect(readMock).toHaveBeenCalledWith({
      scope: "global",
      walletAddress: EVM_WALLET.address,
    });
    fireEvent.click(screen.getByRole("button", { name: "All wallets" }));
    await screen.findByText("$1234.56");
  });
});

describe("WalletsCard scope input", () => {
  it("renders one identity row per inventory wallet with each family's first marked Primary", async () => {
    listAvailableMock.mockResolvedValue({
      ok: true,
      data: { evm: [EVM_WALLET], solana: [SOL_WALLET] },
    });
    readMock.mockResolvedValue({ ok: true, data: portfolio() });
    renderWith(<WalletsCard scope={GLOBAL_PORTFOLIO_SCOPE} />);
    await screen.findByText("Main");
    // Both family firsts wear the badge (the labeled EVM row and the
    // unlabeled Solana row, which falls back to the terse family caption).
    expect(screen.getAllByText("Primary")).toHaveLength(2);
    expect(screen.getByText("SOL")).toBeTruthy();
  });

  it("Add wallet routes to the Settings wallets section through the public store action", async () => {
    listAvailableMock.mockResolvedValue({
      ok: true,
      data: { evm: [], solana: [] },
    });
    renderWith(<WalletsCard scope={GLOBAL_PORTFOLIO_SCOPE} />);
    const add = await screen.findByRole("button", { name: /Add wallet/ });
    fireEvent.click(add);
    await waitFor(() => {
      const route = useUiStore.getState().shellRoute;
      expect(route?.kind).toBe("settings");
      expect(route?.kind === "settings" ? route.section : null).toBe("wallets");
    });
  });
});
