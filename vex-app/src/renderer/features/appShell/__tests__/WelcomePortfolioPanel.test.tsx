/**
 * WelcomePortfolioPanel — the welcome-stage floating Portfolio tab
 * (BookPanel's welcome route).
 *
 * Pins:
 *   - collapsed (`bookOpen=false`): only the round handle button ("Open the
 *     Portfolio tab", aria-expanded=false); no cards mount; the handle
 *     fires the shared onToggle,
 *   - expanded (`bookOpen=true`): the three cards (Portfolio Overview /
 *     Wallets / Balances) plus the persisting handle ("Collapse the
 *     Portfolio tab", aria-expanded=true) — the handle exists in BOTH
 *     states as the morph anchor,
 *   - scope chips: "All wallets" default shows the global aggregate; a
 *     wallet chip switches to the wallet-scoped `useWalletPortfolio` read
 *     and back; the Primary badge rides ONLY family-primary chips (index 0
 *     per family),
 *   - Wallets card: per-wallet USD totals from the wallet-scoped read
 *     (em dash while unresolved), and the "Add wallet" row deep-links the
 *     Settings screen's Wallets section via the PUBLIC uiStore action.
 *
 * Data hooks are mocked (GlobalWalletSwitcher.test.tsx pattern) — this
 * suite owns the tab's display/selection rules, not the query wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { PortfolioDto } from "@shared/schemas/portfolio.js";
import { useUiStore } from "../../../stores/uiStore.js";

vi.mock("../../../components/icons/VexIcon.js", () => ({
  VexIcon: () => null,
}));

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
const mockUseWalletPortfolio = vi.hoisted(() => vi.fn());
const mockUseAvailableWallets = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/api/portfolio.js", () => ({
  usePortfolio: mockUsePortfolio,
  useWalletPortfolio: mockUseWalletPortfolio,
}));
vi.mock("../../../lib/api/wallet-inventory.js", () => ({
  useAvailableWallets: mockUseAvailableWallets,
}));

const { WelcomePortfolioPanel } = await import(
  "../book/portfolio/WelcomePortfolioPanel.js"
);

const EVM_1 = {
  id: "evm-1",
  family: "evm" as const,
  address: "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa",
  label: "",
};
const EVM_2 = {
  id: "evm-2",
  family: "evm" as const,
  address: "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb",
  label: "Trading",
};
const SOL_1 = {
  id: "sol-1",
  family: "solana" as const,
  address: "9jk8UbH339rCgnohpBvqiss4a7bXWmicMPCUCFmDrmYK",
  label: "",
};

function portfolio(overrides: Partial<PortfolioDto> = {}): PortfolioDto {
  return {
    scope: "global",
    walletCount: 3,
    liveTotalUsd: 999,
    snapshotTotalUsd: 990,
    pnlVsPrev: 9,
    snapshotAt: null,
    tokens: [{ chainId: 1, symbol: "ETH", balanceUsd: 100, amount: null }],
    chains: [],
    ...overrides,
  };
}

function loaded(dto: PortfolioDto) {
  return { isLoading: false, isError: false, data: { ok: true, data: dto } };
}

const WALLET_TOTALS: Readonly<Record<string, number>> = {
  [EVM_1.address]: 50,
  [EVM_2.address]: 111,
  [SOL_1.address]: 60,
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useUiStore.setState({
    currentView: "appShell",
    wizardEntryMode: "setup",
    shellRoute: { kind: "none" },
  });
  mockUsePortfolio.mockReturnValue(loaded(portfolio()));
  mockUseAvailableWallets.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { ok: true, data: { evm: [EVM_1, EVM_2], solana: [SOL_1] } },
  });
  mockUseWalletPortfolio.mockImplementation((address: string | null) => {
    if (address !== null && address in WALLET_TOTALS) {
      const total = WALLET_TOTALS[address] ?? 0;
      return loaded(
        portfolio({ walletCount: 1, liveTotalUsd: total, snapshotTotalUsd: null, pnlVsPrev: null }),
      );
    }
    return { isLoading: false, isError: false, data: undefined };
  });
});

function overviewRegion() {
  return within(screen.getByRole("region", { name: "Portfolio Overview" }));
}

function scopeChips() {
  return within(screen.getByRole("group", { name: "Portfolio scope" }));
}

describe("WelcomePortfolioPanel — collapsed ⇄ expanded", () => {
  it("collapsed: only the round handle, no cards; the handle fires onToggle", () => {
    const onToggle = vi.fn();
    render(<WelcomePortfolioPanel bookOpen={false} onToggle={onToggle} />);

    const handle = screen.getByRole("button", { name: "Open the Portfolio tab" });
    expect(handle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Portfolio Overview" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Wallets" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Balances" })).toBeNull();

    fireEvent.click(handle);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("expanded: the three cards mount and the handle persists as the collapse anchor", () => {
    render(<WelcomePortfolioPanel bookOpen onToggle={() => {}} />);

    expect(screen.getByRole("region", { name: "Portfolio Overview" })).not.toBeNull();
    expect(screen.getByRole("region", { name: "Wallets" })).not.toBeNull();
    expect(screen.getByRole("region", { name: "Balances" })).not.toBeNull();
    // The SAME handle button, now the collapse affordance (one-object morph).
    const handle = screen.getByRole("button", { name: "Collapse the Portfolio tab" });
    expect(handle.getAttribute("aria-expanded")).toBe("true");
  });

  it("is an IN-FLOW aside that reserves width open and releases it collapsed (owner correction: cards must never cover the center)", () => {
    const { container, rerender } = render(
      <WelcomePortfolioPanel bookOpen onToggle={() => {}} />,
    );
    const aside = container.querySelector('[data-vex-area="welcome-portfolio"]');
    expect(aside).not.toBeNull();
    // A real flex sibling (sidebar behavior), not an absolute overlay.
    expect(aside?.tagName).toBe("ASIDE");
    expect(aside?.className).toContain("transition-[width]");
    expect(aside?.className).toContain("w-[380px]");
    expect(aside?.className).not.toContain("w-0");

    rerender(<WelcomePortfolioPanel bookOpen={false} onToggle={() => {}} />);
    const collapsed = container.querySelector(
      '[data-vex-area="welcome-portfolio"]',
    );
    expect(collapsed?.className).toContain("w-0");
    expect(collapsed?.className).not.toContain("w-[380px]");
  });
});

describe("WelcomePortfolioPanel — Primary label dedupe", () => {
  it('suppresses the badge when the wallet label already says "Primary" (no "Primary PRIMARY")', () => {
    mockUseAvailableWallets.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        ok: true,
        data: {
          evm: [{ ...EVM_1, label: "Primary" }, EVM_2],
          solana: [SOL_1],
        },
      },
    });
    render(<WelcomePortfolioPanel bookOpen onToggle={() => {}} />);

    const chips = scopeChips();
    // The labelled family-primary chip reads "Primary" ONCE — label only.
    expect(chips.getByRole("button", { name: "Primary" })).not.toBeNull();
    expect(chips.queryByRole("button", { name: "Primary Primary" })).toBeNull();
    // The UNLABELED Solana family-primary keeps its badge (it adds info).
    const solChip = chips.getByRole("button", { name: /9jk8Ub…rmYK/ });
    expect(within(solChip).queryByText("Primary")).not.toBeNull();
  });
});

describe("WelcomePortfolioPanel — overview scope chips", () => {
  it("defaults to the global aggregate and narrows to a wallet-scoped read on chip click", () => {
    render(<WelcomePortfolioPanel bookOpen onToggle={() => {}} />);

    // "All wallets" default: the aggregate figure, pressed chip.
    expect(overviewRegion().getByText("$999.00")).not.toBeNull();
    expect(
      scopeChips()
        .getByRole("button", { name: "All wallets" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    // Selecting a wallet chip swaps in the wallet-scoped read...
    fireEvent.click(scopeChips().getByRole("button", { name: "Trading" }));
    expect(mockUseWalletPortfolio).toHaveBeenCalledWith(EVM_2.address);
    expect(overviewRegion().getByText("$111.00")).not.toBeNull();
    expect(overviewRegion().queryByText("$999.00")).toBeNull();

    // ...and "All wallets" restores the aggregate.
    fireEvent.click(scopeChips().getByRole("button", { name: "All wallets" }));
    expect(overviewRegion().getByText("$999.00")).not.toBeNull();
  });

  it("shows the snapshot delta in the solid direction-color convention", () => {
    render(<WelcomePortfolioPanel bookOpen onToggle={() => {}} />);
    // pnlVsPrev = +9 → "+$9.00" beside the muted caption.
    expect(overviewRegion().getByText("+$9.00")).not.toBeNull();
    expect(overviewRegion().getByText("vs last snapshot")).not.toBeNull();
  });

  it("puts the Primary badge on family-primary chips only (index 0 per family)", () => {
    render(<WelcomePortfolioPanel bookOpen onToggle={() => {}} />);
    const chips = scopeChips();

    // EVM_1 (family index 0, unlabeled → truncated address) wears the badge…
    const evm1Chip = chips.getByRole("button", { name: /0xAAAA…aaaa/ });
    expect(within(evm1Chip).queryByText("Primary")).not.toBeNull();
    // …SOL_1 (its family's index 0) too…
    const solChip = chips.getByRole("button", { name: /9jk8Ub…rmYK/ });
    expect(within(solChip).queryByText("Primary")).not.toBeNull();
    // …but the second EVM wallet does not.
    const tradingChip = chips.getByRole("button", { name: "Trading" });
    expect(within(tradingChip).queryByText("Primary")).toBeNull();
    expect(within(evm1Chip).queryByText("Primary")).not.toBeNull();
  });
});

describe("WelcomePortfolioPanel — wallets card", () => {
  it("lists each inventory wallet with its own wallet-scoped USD total", () => {
    render(<WelcomePortfolioPanel bookOpen onToggle={() => {}} />);
    const wallets = within(screen.getByRole("region", { name: "Wallets" }));
    expect(wallets.getByText("$50.00")).not.toBeNull();
    expect(wallets.getByText("$111.00")).not.toBeNull();
    expect(wallets.getByText("$60.00")).not.toBeNull();
    expect(wallets.getByText("Trading")).not.toBeNull();
  });

  it("keeps the em dash while a per-wallet read is unresolved — never a fabricated $0", () => {
    mockUseWalletPortfolio.mockImplementation(() => ({
      isLoading: true,
      isError: false,
      data: undefined,
    }));
    render(<WelcomePortfolioPanel bookOpen onToggle={() => {}} />);
    const wallets = within(screen.getByRole("region", { name: "Wallets" }));
    expect(wallets.getAllByText("—").length).toBeGreaterThanOrEqual(3);
    expect(wallets.queryByText("$0.00")).toBeNull();
  });

  it("Add wallet deep-links the Settings screen's Wallets section via the public store action", () => {
    render(<WelcomePortfolioPanel bookOpen onToggle={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Add wallet/i }));
    const route = useUiStore.getState().shellRoute;
    expect(route.kind).toBe("settings");
    if (route.kind !== "settings") throw new Error("route kind mismatch");
    expect(route.section).toBe("wallets");
    // The row's own rect rides along as the screen's expand origin.
    expect(route.origin).not.toBeNull();
    // The view machine never leaves the shell (the reconfigure wizard door
    // is retired — Phase 2b).
    expect(useUiStore.getState().currentView).not.toBe("wizard");
  });
});
