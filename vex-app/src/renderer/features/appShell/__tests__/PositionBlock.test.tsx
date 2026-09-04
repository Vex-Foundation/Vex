/**
 * POSITION block — pins the zero-balance display rules:
 *
 *   - token rows whose USD would render as `$0.00` (|USD| < 0.005, i.e.
 *     below formatUsd's 2-decimal rounding threshold) never render,
 *   - the threshold matches formatUsd exactly: 0.004 hides, 0.006 shows,
 *   - the 8-row cap and "+N more" tail count only displayable rows,
 *   - when the wallet has tokens but ALL of them round to $0.00, a single
 *     muted "No priced balances." line replaces the list (the truly-empty
 *     "No token balances." copy is reserved for zero token rows),
 *   - UNPRICED rows (`balanceUsd: null`) with a positive amount stay VISIBLE
 *     as `amount + symbol` plus a muted em dash — owner decision: show held
 *     funds without a valuation, never a fabricated $0.00,
 *   - totals stay untouched — they reflect the full portfolio.
 *
 * `usePortfolio` is mocked — this suite owns the block's display rules,
 * not the query wiring. `useAvailableWallets` (consumed by the GLOBAL-scope
 * `GlobalWalletAddresses`, WP-L) is mocked to an empty inventory so this
 * suite's assertions stay about the token/total display rules; the panel's
 * own behavior is pinned separately in `GlobalWalletAddresses.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  PortfolioDto,
  PositionChainDto,
  PositionTokenDto,
} from "@shared/schemas/portfolio.js";

const mockUsePortfolio = vi.hoisted(() => vi.fn());
const mockUseSessionWallets = vi.hoisted(() => vi.fn());
const mockUseAvailableWallets = vi.hoisted(() => vi.fn());
const mockUseProject = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/api/portfolio.js", () => ({
  usePortfolio: mockUsePortfolio,
  // Wave P — the card subscribes to the terminalization push and hosts the
  // refresh button. Both are query-cache concerns owned by the api module, so
  // stubbing them here keeps these cases about the card's DISPLAY logic.
  useActivityResolvedInvalidation: () => undefined,
  useActivityProgressInvalidation: () => undefined,
  usePortfolioRefresh: () => ({ refresh: async () => ({ status: "refreshed" }) }),
}));

vi.mock("../../../lib/api/session-wallets.js", () => ({
  useSessionWallets: mockUseSessionWallets,
}));

vi.mock("../../../lib/api/wallet-inventory.js", () => ({
  useAvailableWallets: mockUseAvailableWallets,
}));

vi.mock("../../../lib/api/projects.js", () => ({
  useProject: mockUseProject,
}));

const { PositionBlock } = await import("../book/PositionBlock.js");

function token(
  symbol: string,
  balanceUsd: number | null,
  chainId: number | null = 1,
  amount: number | null = null,
): PositionTokenDto {
  return { chainId, symbol, balanceUsd, amount };
}

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

function mockPortfolio(dto: PortfolioDto): void {
  mockUsePortfolio.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { ok: true, data: dto },
  });
}

function mockSessionWallets(
  evmAddr: string | null,
  solAddr: string | null,
): void {
  mockUseSessionWallets.mockReturnValue({
    isLoading: false,
    isError: false,
    data: {
      ok: true,
      data: {
        evm: evmAddr ? { walletId: "evm_1", address: evmAddr, label: "Main" } : null,
        solana: solAddr
          ? { walletId: "sol_1", address: solAddr, label: "Sol" }
          : null,
      },
    },
  });
}

/** The project's own wallet selection, as `useProject` resolves it. */
function mockProjectWallets(
  evmAddr: string | null,
  solAddr: string | null,
): void {
  mockUseProject.mockReturnValue({
    isLoading: false,
    isError: false,
    data: {
      ok: true,
      data: {
        id: PROJECT,
        wallets: {
          evm: evmAddr === null ? null : { walletId: "evm_1", address: evmAddr },
          solana: solAddr === null ? null : { walletId: "sol_1", address: solAddr },
        },
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // A project read that has not answered: no families, so no chip row - never
  // a row of chains the project may not hold.
  mockUseProject.mockReturnValue({
    isLoading: true,
    isError: false,
    data: undefined,
  });
  // Global-scope suites never render the session body; a benign default keeps
  // the hook harmless when a test forgets to script it.
  mockUseSessionWallets.mockReturnValue({
    isLoading: true,
    isError: false,
    data: undefined,
  });
  // GLOBAL scope renders GlobalWalletAddresses (WP-L); default to an empty
  // inventory so this suite's assertions stay about the token/total rules —
  // GlobalWalletAddresses' own rendering is pinned in its dedicated suite.
  mockUseAvailableWallets.mockReturnValue({
    data: { ok: true, data: { evm: [], solana: [] } },
  });
});

describe("PositionBlock zero-balance display", () => {
  it("hides token rows that would render as $0.00", () => {
    mockPortfolio(
      portfolio({
        tokens: [
          token("SOL", 12.3),
          token("GABECUBE", 0),
          token("AWSTIN", 0.0001),
        ],
      }),
    );
    const { container } = render(<PositionBlock scope={{ kind: "global" }} />);

    expect(screen.getByText("SOL")).not.toBeNull();
    expect(screen.queryByText("GABECUBE")).toBeNull();
    expect(screen.queryByText("AWSTIN")).toBeNull();
    // No figure anywhere on the block reads $0.00.
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(container.querySelectorAll("li")).toHaveLength(1);
  });

  it("aligns the cut with formatUsd rounding: 0.004 hides, 0.006 shows as $0.01", () => {
    mockPortfolio(
      portfolio({
        tokens: [token("DUST", 0.004), token("EDGE", 0.006)],
      }),
    );
    render(<PositionBlock scope={{ kind: "global" }} />);

    expect(screen.queryByText("DUST")).toBeNull();
    expect(screen.getByText("EDGE")).not.toBeNull();
    expect(screen.getByText("$0.01")).not.toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("shows 'No priced balances.' when every token rounds to $0.00", () => {
    mockPortfolio(
      portfolio({
        tokens: [token("GABECUBE", 0), token("AWSTIN", -0.002)],
      }),
    );
    const { container } = render(<PositionBlock scope={{ kind: "global" }} />);

    expect(container.querySelectorAll("li")).toHaveLength(0);
    expect(screen.getByText("No priced balances.")).not.toBeNull();
    // The truly-empty copy stays reserved for a portfolio with NO token rows.
    expect(screen.queryByText("No token balances.")).toBeNull();
  });

  it("keeps 'No token balances.' for a portfolio with no token rows at all", () => {
    mockPortfolio(portfolio({ tokens: [] }));
    render(<PositionBlock scope={{ kind: "global" }} />);

    expect(screen.getByText("No token balances.")).not.toBeNull();
    expect(screen.queryByText("No priced balances.")).toBeNull();
  });

  it("caps at 8 rows and counts '+N more' AFTER filtering zero balances", () => {
    // 12 rows fetched: 10 displayable + 2 zero. Pre-filter counting would
    // say "+4 more"; the correct tail is 10 - 8 = "+2 more".
    const priced = Array.from({ length: 10 }, (_, i) =>
      token(`TOK${i}`, 5 + i),
    );
    const dust = [token("ZERO1", 0), token("ZERO2", 0.001)];
    mockPortfolio(portfolio({ tokens: [...priced, ...dust] }));
    const { container } = render(<PositionBlock scope={{ kind: "global" }} />);

    expect(container.querySelectorAll("li")).toHaveLength(8);
    expect(screen.getByText("+2 more")).not.toBeNull();
    expect(screen.queryByText("+4 more")).toBeNull();
  });

  it("shows an UNPRICED holding as amount + symbol with a muted em dash (no $0.00)", () => {
    mockPortfolio(
      portfolio({
        tokens: [token("ETH", null, 4663, 0.005)],
      }),
    );
    const { container } = render(<PositionBlock scope={{ kind: "global" }} />);

    expect(screen.getByText("ETH")).not.toBeNull();
    expect(screen.getByText("0.005 ETH")).not.toBeNull();
    expect(screen.getByText("-")).not.toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText("No priced balances.")).toBeNull();
    expect(container.querySelectorAll("li")).toHaveLength(1);
  });

  it("hides an unpriced row whose amount is unknown or zero (nothing to show)", () => {
    mockPortfolio(
      portfolio({
        tokens: [
          token("SOL", 12.3),
          token("GHOST", null, 1, null),
          token("EMPTY", null, 1, 0),
        ],
      }),
    );
    render(<PositionBlock scope={{ kind: "global" }} />);

    expect(screen.getByText("SOL")).not.toBeNull();
    expect(screen.queryByText("GHOST")).toBeNull();
    expect(screen.queryByText("EMPTY")).toBeNull();
  });

  it("keeps the live total on the FULL portfolio even when rows filter out", () => {
    mockPortfolio(
      portfolio({
        liveTotalUsd: 987.65,
        tokens: [token("GABECUBE", 0)],
      }),
    );
    render(<PositionBlock scope={{ kind: "global" }} />);

    expect(screen.getByText("$987.65")).not.toBeNull();
    expect(screen.getByText("No priced balances.")).not.toBeNull();
  });
});

// ── Session scope: deposit addresses + per-chain switcher (owner redesign) ──

const SESSION = "00000000-0000-4000-8000-00000000aaaa";
const PROJECT = "00000000-0000-4000-8000-00000000bbbb";
const EVM_ADDR = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const SOL_ADDR = "So11111111111111111111111111111111111111112";

function chain(
  chainId: number,
  family: "evm" | "solana",
  totalUsd: number,
  tokens: PositionChainDto["tokens"],
): PositionChainDto {
  return { chainId, family, totalUsd, tokens };
}

describe("PositionBlock session view (unified chain switcher)", () => {
  it("defaults the EVM group to Ethereum with a quiet empty state at zero balance", () => {
    mockSessionWallets(EVM_ADDR, SOL_ADDR);
    // Funds on Base only — Ethereum still leads as the standing default.
    mockPortfolio(
      portfolio({
        scope: "session",
        chains: [chain(8453, "evm", 25, [{ symbol: "USDC", balanceUsd: 25, amount: null }])],
      }),
    );
    render(<PositionBlock scope={{ kind: "session", sessionId: SESSION }} />);

    expect(screen.getByText("Ethereum")).not.toBeNull();
    expect(screen.getByText("No assets on Ethereum")).not.toBeNull();
  });

  it("switches chains via the quick icons and shows that chain's top tokens", () => {
    mockSessionWallets(EVM_ADDR, null);
    mockPortfolio(
      portfolio({
        scope: "session",
        chains: [chain(8453, "evm", 25, [{ symbol: "USDC", balanceUsd: 25, amount: null }])],
      }),
    );
    render(<PositionBlock scope={{ kind: "session", sessionId: SESSION }} />);

    fireEvent.click(screen.getByRole("button", { name: "Show Base assets" }));
    // The brand SVGs carry their own <title> text, so the name can match
    // more than once — the header text is asserted as "at least one".
    expect(screen.getAllByText("Base").length).toBeGreaterThan(0);
    expect(screen.getByText("USDC")).not.toBeNull();
    // $25.00 legitimately appears twice: the chain total in the group header
    // AND the single USDC token row (the chain's whole balance is USDC).
    expect(screen.getAllByText("$25.00")).toHaveLength(2);
  });

  it("shows an unpriced-only chain (Robinhood 4663): amount + symbol, muted dashes, no $0.00", () => {
    mockSessionWallets(EVM_ADDR, null);
    mockPortfolio(
      portfolio({
        scope: "session",
        // Only holding: native ETH on Robinhood Chain with NO price source —
        // the chain still appears (totalUsd 0) and the funds stay visible.
        chains: [
          chain(4663, "evm", 0, [
            { symbol: "ETH", balanceUsd: null, amount: 0.005 },
          ]),
        ],
      }),
    );
    render(<PositionBlock scope={{ kind: "session", sessionId: SESSION }} />);

    fireEvent.click(screen.getByRole("button", { name: "Show Robinhood assets" }));
    expect(screen.getAllByText("Robinhood").length).toBeGreaterThan(0);
    expect(screen.getByText("ETH")).not.toBeNull();
    expect(screen.getByText("0.005 ETH")).not.toBeNull();
    // Chain total AND token valuation both render the muted em dash — a $0.00
    // would fabricate a valuation that does not exist.
    expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText("No assets on Robinhood")).toBeNull();
  });

  it("always offers 'more'; the dialog lists only funded networks", () => {
    mockSessionWallets(EVM_ADDR, null);
    mockPortfolio(
      portfolio({
        scope: "session",
        // Polygon (137) is not a quick chain — it appears ONLY in the dialog.
        chains: [chain(137, "evm", 5, [{ symbol: "POL", balanceUsd: 5, amount: null }])],
      }),
    );
    render(<PositionBlock scope={{ kind: "session", sessionId: SESSION }} />);

    fireEvent.click(screen.getByRole("button", { name: "more" }));
    expect(screen.getByText("Networks")).not.toBeNull();
    expect(screen.getAllByText("Polygon").length).toBeGreaterThan(0);
  });

  it("offers 'more' even when nothing beyond the quick set is funded (empty-state dialog)", () => {
    mockSessionWallets(EVM_ADDR, null);
    mockPortfolio(portfolio({ scope: "session", chains: [] }));
    render(<PositionBlock scope={{ kind: "session", sessionId: SESSION }} />);

    fireEvent.click(screen.getByRole("button", { name: "more" }));
    expect(screen.getByText("Networks")).not.toBeNull();
    expect(screen.getByText("No funded networks yet.")).not.toBeNull();
  });

  it("keeps Solana COLLAPSED by default and opens it from its chip (no always-open second group)", () => {
    mockSessionWallets(EVM_ADDR, SOL_ADDR);
    mockPortfolio(
      portfolio({
        scope: "session",
        chains: [
          chain(1, "evm", 40, [{ symbol: "ETH", balanceUsd: 40, amount: null }]),
          chain(20011000000, "solana", 60, [
            { symbol: "SOL", balanceUsd: 50, amount: null },
            { symbol: "BONK", balanceUsd: 10, amount: null },
          ]),
        ],
      }),
    );
    const { container } = render(<PositionBlock scope={{ kind: "session", sessionId: SESSION }} />);
    const chainsArea = container.querySelector(
      '[data-vex-area="position-chains"]',
    ) as HTMLElement;
    const chains = within(chainsArea);

    // Default = the EVM standing default; Solana's holdings are NOT on screen.
    expect(chains.getByText("Ethereum")).not.toBeNull();
    expect(chains.queryByText("BONK")).toBeNull();

    // Solana is a peer chip in the ONE chip row, labelled for assistive tech.
    fireEvent.click(
      chains.getByRole("button", { name: "Show Solana assets" }),
    );
    expect(chains.getByText("SOL")).not.toBeNull();
    expect(chains.getByText("BONK")).not.toBeNull();
    // One selection at a time — the EVM chain's holdings are gone now.
    expect(chains.queryByText("ETH")).toBeNull();
  });

  it("opens on Solana when the session has NO EVM wallet (never an empty EVM default)", () => {
    mockSessionWallets(null, SOL_ADDR);
    mockPortfolio(
      portfolio({
        scope: "session",
        chains: [
          chain(20011000000, "solana", 60, [
            { symbol: "SOL", balanceUsd: 60, amount: null },
          ]),
        ],
      }),
    );
    const { container } = render(<PositionBlock scope={{ kind: "session", sessionId: SESSION }} />);
    const chains = within(
      container.querySelector('[data-vex-area="position-chains"]') as HTMLElement,
    );
    expect(chains.getByText("SOL")).not.toBeNull();
    // No EVM chips at all — the session has no EVM wallet.
    expect(
      chains.queryByRole("button", { name: "Show Ethereum assets" }),
    ).toBeNull();
  });

  it("the 'more' dialog lists Solana too, not just EVM networks", () => {
    mockSessionWallets(EVM_ADDR, SOL_ADDR);
    mockPortfolio(
      portfolio({
        scope: "session",
        chains: [
          chain(137, "evm", 5, [{ symbol: "POL", balanceUsd: 5, amount: null }]),
          chain(20011000000, "solana", 60, [
            { symbol: "SOL", balanceUsd: 60, amount: null },
          ]),
        ],
      }),
    );
    render(<PositionBlock scope={{ kind: "session", sessionId: SESSION }} />);
    fireEvent.click(screen.getByRole("button", { name: "more" }));
    expect(screen.getAllByText("Polygon").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Solana").length).toBeGreaterThan(0);
  });
});

/**
 * PROJECT scope - the Vex Studio rail's arm of the same card (owner parity
 * decree, 2026-09-04).
 *
 * The property that carries the money risk: the read goes out as the PROJECT
 * scope and the chip row is built from the PROJECT's own wallet selection. A
 * fallback to the global inventory here would put somebody else's funds under
 * a project's name, which is a wrong answer that renders.
 */
describe("PositionBlock project view", () => {
  it("reads the PROJECT scope - never the global inventory", () => {
    mockProjectWallets(EVM_ADDR, SOL_ADDR);
    mockPortfolio(portfolio({ scope: "project", chains: [] }));
    render(<PositionBlock scope={{ kind: "project", projectId: PROJECT }} />);

    expect(mockUsePortfolio).toHaveBeenCalledWith({
      scope: "project",
      projectId: PROJECT,
    });
  });

  it("is titled Position and counts the project's wallets", () => {
    mockProjectWallets(EVM_ADDR, SOL_ADDR);
    mockPortfolio(portfolio({ scope: "project", walletCount: 2, chains: [] }));
    render(<PositionBlock scope={{ kind: "project", projectId: PROJECT }} />);

    expect(screen.getByText("Position")).not.toBeNull();
    expect(screen.getByText("2 wallets")).not.toBeNull();
    expect(screen.queryByText("Portfolio")).toBeNull();
  });

  it("builds the chip row from the PROJECT's selection, defaulting to Ethereum", () => {
    mockProjectWallets(EVM_ADDR, SOL_ADDR);
    mockPortfolio(
      portfolio({
        scope: "project",
        chains: [
          chain(8453, "evm", 25, [
            { symbol: "USDC", balanceUsd: 25, amount: null },
          ]),
        ],
      }),
    );
    render(<PositionBlock scope={{ kind: "project", projectId: PROJECT }} />);

    expect(screen.getByText("Ethereum")).not.toBeNull();
    expect(screen.getByText("No assets on Ethereum")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Show Solana assets" }),
    ).not.toBeNull();
  });

  it("opens on Solana when the project selected NO EVM wallet", () => {
    mockProjectWallets(null, SOL_ADDR);
    mockPortfolio(
      portfolio({
        scope: "project",
        chains: [
          chain(20011000000, "solana", 60, [
            { symbol: "SOL", balanceUsd: 60, amount: null },
          ]),
        ],
      }),
    );
    const { container } = render(
      <PositionBlock scope={{ kind: "project", projectId: PROJECT }} />,
    );
    const chains = within(
      container.querySelector('[data-vex-area="position-chains"]') as HTMLElement,
    );
    expect(chains.getByText("SOL")).not.toBeNull();
    expect(
      chains.queryByRole("button", { name: "Show Ethereum assets" }),
    ).toBeNull();
  });

  it("a FAILED project read draws no chip row rather than guessing the families", () => {
    mockUseProject.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
    });
    mockPortfolio(
      portfolio({
        scope: "project",
        chains: [chain(1, "evm", 40, [{ symbol: "ETH", balanceUsd: 40, amount: null }])],
      }),
    );
    const { container } = render(
      <PositionBlock scope={{ kind: "project", projectId: PROJECT }} />,
    );
    expect(
      container.querySelector('[data-vex-area="position-chains"]'),
    ).toBeNull();
    // The resolved total is still the project's own and stays on screen.
    expect(screen.getByText("$123.45")).not.toBeNull();
  });

  it("names the PROJECT when the scope holds no wallets", () => {
    mockProjectWallets(null, null);
    mockPortfolio(portfolio({ scope: "project", walletCount: 0 }));
    render(<PositionBlock scope={{ kind: "project", projectId: PROJECT }} />);

    expect(
      screen.getByText("No wallets selected for this project."),
    ).not.toBeNull();
    expect(screen.queryByText("No wallets in this session.")).toBeNull();
  });
});

describe("PositionBlock snapshot age (owner measurement 2026-09-04)", () => {
  // The clock is read at render, so the age is a deterministic function of
  // the fixture's `snapshotAt` and this fake now.
  const NOW = new Date("2026-09-04T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mountSnapshot(snapshotAt: string) {
    mockPortfolio(
      portfolio({
        liveTotalUsd: 62.71,
        snapshotTotalUsd: 100.62,
        pnlVsPrev: 0.41,
        snapshotAt,
      }),
    );
    return render(<PositionBlock scope={{ kind: "global" }} />);
  }

  it("a FRESH snapshot states its age and keeps the gain tone", () => {
    mountSnapshot("2026-09-04T11:55:00.000Z");
    const line = document.querySelector('[data-vex-area="position-snapshot"]');
    expect(line?.getAttribute("data-stale")).toBe("false");
    expect(
      document.querySelector('[data-vex-area="position-snapshot-age"]')?.textContent,
    ).toContain("5 min ago");
    const delta = screen.getByLabelText(/Profit and loss versus snapshot taken 5 min ago/);
    expect(delta.className).toContain("text-success");
  });

  it("a STALE snapshot (31 days) states its age and MUTES the delta - not a live gain", () => {
    mountSnapshot("2026-08-04T12:00:00.000Z");
    const line = document.querySelector('[data-vex-area="position-snapshot"]');
    expect(line?.getAttribute("data-stale")).toBe("true");
    expect(
      document.querySelector('[data-vex-area="position-snapshot-age"]')?.textContent,
    ).toContain("31 days ago");
    const delta = screen.getByLabelText(/Profit and loss versus snapshot taken 31 days ago/);
    expect(delta.className).not.toContain("text-success");
    expect(delta.className).toContain("text-ink-tertiary");
    // The figures themselves are untouched: the tone changed, not the truth.
    expect(delta.textContent).toBe("+$0.41");
    expect(screen.getByText(/snapshot \$100\.62/)).toBeTruthy();
  });

  it("renders no age when the DTO carries no snapshot timestamp", () => {
    mockPortfolio(
      portfolio({ snapshotTotalUsd: 100.62, pnlVsPrev: 0.41, snapshotAt: null }),
    );
    render(<PositionBlock scope={{ kind: "global" }} />);
    expect(document.querySelector('[data-vex-area="position-snapshot-age"]')).toBeNull();
    expect(
      screen.getByLabelText(/Profit and loss versus previous snapshot/).className,
    ).toContain("text-success");
  });
});
