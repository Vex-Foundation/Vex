/**
 * GlobalWalletSwitcher (WP-L2) — the welcome/global POSITION body:
 *
 *   - "All wallets" is the default state and reproduces the ORIGINAL global
 *     body verbatim: GlobalWalletAddresses + the flat top-holdings list,
 *   - the wallet chip row is hidden entirely for 0 or 1 configured wallets
 *     (a single wallet's "All wallets" view already IS that wallet),
 *   - with >1 wallet, the chip row lists "All wallets" + every inventory
 *     wallet; selecting one swaps in the wallet-scoped, chain-grouped
 *     PositionChains presentation fed by `useWalletPortfolio`, with a
 *     compact "Wallet total" figure that is DISTINCT from the (unmounted
 *     here) aggregate hero total,
 *   - switching back to "All wallets" restores the flat list.
 *
 * `useAvailableWallets` and `useWalletPortfolio` are mocked — this suite
 * owns the switcher's display/selection rules, not the query wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import type { PortfolioDto } from "@shared/schemas/portfolio.js";

const mockUseAvailableWallets = vi.hoisted(() => vi.fn());
const mockUseWalletPortfolio = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/api/wallet-inventory.js", () => ({
  useAvailableWallets: mockUseAvailableWallets,
}));

vi.mock("../../../lib/api/portfolio.js", () => ({
  useWalletPortfolio: mockUseWalletPortfolio,
}));

const { GlobalWalletSwitcher } = await import("../book/GlobalWalletSwitcher.js");

const EVM_1 = { id: "evm-1", family: "evm" as const, address: "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa", label: "" };
const EVM_2 = { id: "evm-2", family: "evm" as const, address: "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb", label: "Trading" };
const SOL_1 = { id: "sol-1", family: "solana" as const, address: "9jk8UbH339rCgnohpBvqiss4a7bXWmicMPCUCFmDrmYK", label: "" };

function portfolio(overrides: Partial<PortfolioDto> = {}): PortfolioDto {
  return {
    scope: "global",
    walletCount: 2,
    liveTotalUsd: 999,
    snapshotTotalUsd: null,
    pnlVsPrev: null,
    snapshotAt: null,
    tokens: [{ chainId: 1, symbol: "ETH", balanceUsd: 100, amount: null }],
    chains: [],
    ...overrides,
  };
}

function mockWallets(evm: (typeof EVM_1)[], solana: (typeof SOL_1)[]): void {
  mockUseAvailableWallets.mockReturnValue({
    data: { ok: true, data: { evm, solana } },
  });
}

/**
 * The chip row's own wallet label can collide with text `GlobalWalletAddresses`
 * ALSO renders (e.g. a "remaining wallets" label) — every chip-specific
 * assertion is scoped to the `role="group"` chip row so it never matches the
 * unrelated address-identity rows below it.
 */
function chipRow() {
  return within(screen.getByRole("group", { name: "Wallet" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseWalletPortfolio.mockReturnValue({ isLoading: true, isError: false, data: undefined });
});

describe("GlobalWalletSwitcher - chip visibility", () => {
  it("hides the chip row with zero configured wallets (default flat list only)", () => {
    mockWallets([], []);
    render(<GlobalWalletSwitcher portfolio={portfolio()} />);
    expect(screen.queryByRole("group", { name: "Wallet" })).toBeNull();
    expect(screen.getByText("ETH")).not.toBeNull();
  });

  it("hides the chip row with exactly one configured wallet", () => {
    mockWallets([EVM_1], []);
    render(<GlobalWalletSwitcher portfolio={portfolio()} />);
    expect(screen.queryByRole("group", { name: "Wallet" })).toBeNull();
    expect(screen.queryByText("All wallets")).toBeNull();
  });

  it("shows the chip row (All wallets + each wallet) with more than one configured wallet", () => {
    mockWallets([EVM_1, EVM_2], [SOL_1]);
    render(<GlobalWalletSwitcher portfolio={portfolio()} />);
    const chips = chipRow();
    expect(chips.getByText("All wallets")).not.toBeNull();
    expect(chips.getByText("Trading")).not.toBeNull();
    // EVM_1 and SOL_1 have no label — they fall back to the truncated address.
    expect(chips.getByText("0xAAAA…aaaa")).not.toBeNull();
  });
});

describe("GlobalWalletSwitcher - default 'All wallets' body", () => {
  it("defaults to the aggregate flat holdings list; the wallet-scoped hook is never invoked", () => {
    mockWallets([EVM_1, EVM_2], []);
    render(<GlobalWalletSwitcher portfolio={portfolio()} />);
    expect(screen.getByText("ETH")).not.toBeNull();
    // WalletScopedHoldings (the only caller of useWalletPortfolio) is not
    // mounted at all while "All wallets" is selected — no wasted read.
    expect(mockUseWalletPortfolio).not.toHaveBeenCalled();
  });
});

describe("GlobalWalletSwitcher - token-symbol trust boundary (no branding by symbol)", () => {
  it("drops a symbol carrying control/zero-width spoofing characters, falling back to the em dash", () => {
    mockWallets([EVM_1, EVM_2], []);
    // Zero-width space (U+200B) spliced into "ETH".
    const spoofed = "E​TH";
    render(
      <GlobalWalletSwitcher
        portfolio={portfolio({
          tokens: [{ chainId: 1, symbol: spoofed, balanceUsd: 100, amount: null }],
        })}
      />,
    );
    expect(screen.queryByText("ETH")).toBeNull();
    expect(screen.queryByText(spoofed)).toBeNull();
    expect(screen.getByText("-")).not.toBeNull();
  });

  it("drops an over-length symbol (length-capped)", () => {
    mockWallets([EVM_1, EVM_2], []);
    render(
      <GlobalWalletSwitcher
        portfolio={portfolio({
          tokens: [
            { chainId: 1, symbol: "A".repeat(65), balanceUsd: 100, amount: null },
          ],
        })}
      />,
    );
    expect(screen.queryByText("A".repeat(65))).toBeNull();
    expect(screen.getByText("-")).not.toBeNull();
  });

  it("renders a legitimate ASCII symbol unchanged", () => {
    mockWallets([EVM_1, EVM_2], []);
    render(
      <GlobalWalletSwitcher
        portfolio={portfolio({
          tokens: [{ chainId: 1, symbol: "USDC", balanceUsd: 100, amount: null }],
        })}
      />,
    );
    expect(screen.getByText("USDC")).not.toBeNull();
  });
});

describe("GlobalWalletSwitcher - per-wallet drill-down", () => {
  it("selecting a wallet swaps in the wallet-scoped, chain-grouped view with its own total", () => {
    mockWallets([EVM_1, EVM_2], []);
    mockUseWalletPortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        ok: true,
        data: portfolio({
          liveTotalUsd: 42.5,
          chains: [
            {
              chainId: 1,
              family: "evm",
              totalUsd: 42.5,
              tokens: [{ symbol: "USDC", balanceUsd: 42.5, amount: null }],
            },
          ],
        }),
      },
    });

    render(<GlobalWalletSwitcher portfolio={portfolio({ liveTotalUsd: 999 })} />);
    fireEvent.click(chipRow().getByText("Trading"));

    expect(mockUseWalletPortfolio).toHaveBeenCalledWith(EVM_2.address);
    // The wallet's OWN total (42.50), distinct from the aggregate (999) which
    // this component never renders itself (that lives in PositionBlock's
    // hero). $42.50 legitimately appears more than once here — the "Wallet
    // total" figure AND the single USDC token row (the whole wallet balance
    // is that one token) — mirrors PositionChains' own equal-total precedent.
    expect(screen.getByText("Wallet total")).not.toBeNull();
    expect(screen.getAllByText("$42.50").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("$999.00")).toBeNull();
    expect(screen.getByText("USDC")).not.toBeNull();
    // The flat aggregate list is gone once a wallet is selected.
    expect(screen.queryByText("No token balances.")).toBeNull();
  });

  it("switching back to 'All wallets' restores the flat aggregate list", () => {
    mockWallets([EVM_1, EVM_2], []);
    mockUseWalletPortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { ok: true, data: portfolio({ chains: [] }) },
    });

    render(<GlobalWalletSwitcher portfolio={portfolio()} />);
    fireEvent.click(chipRow().getByText("Trading"));
    expect(screen.getByText("Wallet total")).not.toBeNull();

    fireEvent.click(chipRow().getByText("All wallets"));
    expect(screen.queryByText("Wallet total")).toBeNull();
    expect(screen.getByText("ETH")).not.toBeNull();
  });

  it("shows a quiet error line when the wallet-scoped read fails", () => {
    mockWallets([EVM_1, EVM_2], []);
    mockUseWalletPortfolio.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { ok: false, error: { code: "INTERNAL", message: "boom" } },
    });
    render(<GlobalWalletSwitcher portfolio={portfolio()} />);
    fireEvent.click(chipRow().getByText("Trading"));
    expect(
      screen.getByText(/Couldn.t load this wallet.s holdings\./),
    ).not.toBeNull();
  });
});
