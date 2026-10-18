/**
 * LIGHTER ACCOUNT on the Portfolio page (docs/design/R3-MINIMAL.md section
 * 9.1): the venue account, NOT in the on-chain total. Four figures (Equity,
 * Available, Margin in use, Unrealized trading PnL), then the open positions
 * as a table, "Open Lighter" at the right of the head.
 *
 * Pins:
 *   - every state resolves to words: loading, a provider that is not
 *     answering, a read that failed, and each reason the read succeeded with
 *     nothing to show (locked vault, several accounts, not set up) with its own
 *     next step,
 *   - the figures are the desk's own derivations (equity = collateral + uPnL,
 *     margin in use = collateral - available, with its usage share) in the
 *     account's settlement unit (core USDC, rhc USDG); a figure the read does
 *     not carry says "Not available", never a zero,
 *   - TRADING COLOURS ON TRADING VALUES ONLY: `data-trade` sits on the uPnL
 *     cells and the Long/Short word and nowhere else (never Equity or
 *     Available), and a zero or unknown uPnL keeps the ink,
 *   - a position's menu opens it on the desk (saves the desk market, enters
 *     Lighter); this page signs nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Result, VexErrorCode } from "@shared/ipc/result.js";
import type {
  LighterTradingAccount,
  LighterTradingPosition,
} from "@shared/schemas/lighter-trading.js";
import { DEFAULT_LIGHTER_DESK } from "../../../lighterTrading/desk-preferences.js";

const mockUseLighterTradingAccount = vi.hoisted(() => vi.fn());
vi.mock("../../../../../lib/api/lighter-trading.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../lib/api/lighter-trading.js")>();
  return { ...actual, useLighterTradingAccount: mockUseLighterTradingAccount };
});

const { LighterAccountCard } = await import("../LighterAccountCard.js");
const { useUiStore } = await import("../../../../../stores/uiStore.js");
const { useLighterAnalysisStore } = await import("../../../../../stores/lighterAnalysisStore.js");

const RETRIEVED_AT = Date.UTC(2026, 9, 17, 12, 29, 0);

/** The store's own action, kept so a test can wrap it and every test starts from it. */
const realSaveDesk = useLighterAnalysisStore.getState().saveDesk;

/** Local HH:MM of an epoch, computed here so the test is timezone-proof. */
function clockOfMs(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function position(overrides: Partial<LighterTradingPosition> = {}): LighterTradingPosition {
  return {
    marketId: 7,
    symbol: "ETH",
    side: "long",
    size: "0.5",
    entryPrice: "2000",
    value: "1100",
    unrealizedPnl: "100",
    liquidationPrice: "1500",
    initialMarginFraction: 1000,
    marginMode: "cross",
    allocatedMargin: null,
    ...overrides,
  };
}

/** A long ETH (cross, 10x) that is up, and a short BTC (isolated, 5x) that is down. */
const LONG_ETH = position();
const SHORT_BTC = position({
  marketId: 3,
  symbol: "BTC",
  side: "short",
  size: "0.02",
  entryPrice: "60000",
  value: "1180",
  unrealizedPnl: "-50",
  liquidationPrice: "70000",
  initialMarginFraction: 2000,
  marginMode: "isolated",
  allocatedMargin: "200",
});
/** A position whose read carried almost nothing. */
const BARE_SOL = position({
  marketId: 9,
  symbol: "SOL",
  size: "10",
  entryPrice: null,
  value: null,
  unrealizedPnl: null,
  liquidationPrice: null,
  initialMarginFraction: null,
  marginMode: null,
  allocatedMargin: null,
});

function account(overrides: Partial<LighterTradingAccount> = {}): LighterTradingAccount {
  return {
    environment: "core",
    retrievedAt: RETRIEVED_AT,
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
    ...overrides,
  };
}

function unavailable(
  reason: LighterTradingAccount["unavailableReason"],
): LighterTradingAccount {
  return account({
    status: "unavailable",
    unavailableReason: reason,
    summary: null,
    exchangeFees: null,
    accountIndex: null,
  });
}

function mockAccount(
  data: Result<LighterTradingAccount> | undefined,
  options?: { readonly isLoading?: boolean; readonly isError?: boolean },
): void {
  mockUseLighterTradingAccount.mockReturnValue({
    isLoading: options?.isLoading ?? false,
    isError: options?.isError ?? false,
    data,
  });
}

function mockReady(overrides: Partial<LighterTradingAccount> = {}): void {
  mockAccount({ ok: true, data: account(overrides) });
}

function failure(code: VexErrorCode, message: string): Result<LighterTradingAccount> {
  return {
    ok: false,
    error: {
      code,
      domain: "market",
      message,
      retryable: true,
      userActionable: false,
      redacted: true,
      correlationId: "c-1",
    },
  };
}

/** One of the four figures, by its label. */
function figure(container: HTMLElement, label: string): HTMLElement {
  const terms = Array.from(container.querySelectorAll("dl.vex-pf-kv4 dt"));
  const term = terms.find((candidate) => candidate.textContent === label);
  const value = term?.parentElement?.querySelector("dd") ?? null;
  if (value === null) throw new Error(`no figure labelled ${label}`);
  return value;
}

function positionRows(container: HTMLElement): readonly HTMLTableRowElement[] {
  return Array.from(
    container.querySelectorAll<HTMLTableRowElement>(
      '[data-vex-area="portfolio-lighter-positions"] tbody tr',
    ),
  );
}

/** One cell by column: 0 position, 1 size, 2 entry, 3 mark, 4 liq, 5 margin, 6 uPnL, 7 actions. */
function cell(row: HTMLTableRowElement | undefined, column: number): HTMLTableCellElement {
  const found = row === undefined ? undefined : row.querySelectorAll<HTMLTableCellElement>("td")[column];
  if (found === undefined) throw new Error(`row has no cell ${String(column)}`);
  return found;
}

function renderCard() {
  return render(<LighterAccountCard />);
}

const funnelStep = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  funnelStep.mockResolvedValue(undefined);
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { telemetry: { funnelStep } },
  });
  useUiStore.setState({
    runtimeMode: "agent",
    shellRoute: { kind: "none" },
    lighterReturn: null,
  });
  useLighterAnalysisStore.setState({ desk: DEFAULT_LIGHTER_DESK, saveDesk: realSaveDesk });
});

afterEach(() => {
  Reflect.deleteProperty(window, "vex");
});

describe("LighterAccountCard - the section and its read", () => {
  it("is a region named Lighter account, on the paper, with Open Lighter in its head", () => {
    mockReady();
    renderCard();
    const region = screen.getByRole("region", { name: "Lighter account" });
    expect(region.className).toContain("vex-pf-sec");
    expect(within(region).getByRole("button", { name: "Open Lighter" })).toBeTruthy();
  });

  it("reads the desk's environment, enabled, with no session (the same account the desk opens on)", () => {
    mockReady();
    renderCard();
    expect(mockUseLighterTradingAccount).toHaveBeenCalledWith("rhc", true, undefined);
  });

  it("follows the desk when it is on the other environment", () => {
    useLighterAnalysisStore.getState().saveDesk({ environment: "core" });
    mockReady();
    renderCard();
    expect(mockUseLighterTradingAccount).toHaveBeenCalledWith("core", true, undefined);
  });

  it("the note says the account is not in the total, with the read's time once it is ready", () => {
    mockReady();
    renderCard();
    const region = screen.getByRole("region", { name: "Lighter account" });
    expect(region.querySelector(".vex-pf-sec__note")?.textContent).toBe(
      ` · not in the total above · as of ${clockOfMs(RETRIEVED_AT)}`,
    );
  });

  it("an account read with no time says it is not in the total and nothing about when", () => {
    mockReady({ retrievedAt: 0 });
    renderCard();
    const region = screen.getByRole("region", { name: "Lighter account" });
    expect(region.querySelector(".vex-pf-sec__note")?.textContent).toBe(" · not in the total above");
  });
});

describe("LighterAccountCard - states that are not figures", () => {
  it("loading says so, and keeps the head link", () => {
    mockAccount(undefined, { isLoading: true });
    const { container } = renderCard();
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(container.querySelector("dl")).toBeNull();
    expect(screen.getByRole("button", { name: "Open Lighter" })).toBeTruthy();
    expect(container.querySelector(".vex-pf-sec__note")?.textContent).toBe(" · not in the total above");
  });

  it("a provider that is not answering says so", () => {
    mockAccount(failure("provider.unavailable", "upstream 503 from the venue gateway"));
    const { container } = renderCard();
    expect(screen.getByText("Lighter is not answering.")).toBeTruthy();
    expect(screen.queryByText(/503/)).toBeNull();
    expect(container.querySelector("dl")).toBeNull();
  });

  it("any other failure is the generic line, never the raw message", () => {
    mockAccount(failure("internal.unexpected", "ECONNRESET at gateway (internal detail)"));
    renderCard();
    expect(screen.getByText("Couldn't load the Lighter account.")).toBeTruthy();
    expect(screen.queryByText(/ECONNRESET/)).toBeNull();
  });

  it("a thrown read is the generic line", () => {
    mockAccount(undefined, { isError: true });
    renderCard();
    expect(screen.getByText("Couldn't load the Lighter account.")).toBeTruthy();
  });

  it("no answer yet, and not loading, is the generic line rather than a blank section", () => {
    mockAccount(undefined);
    renderCard();
    expect(screen.getByText("Couldn't load the Lighter account.")).toBeTruthy();
  });

  it.each<readonly [string, LighterTradingAccount["unavailableReason"], string]>([
    ["a locked vault", "locked_vault", "Unlock Vex to read your Lighter account."],
    [
      "several accounts",
      "ambiguous_account",
      "Several Lighter accounts are set up. Choose one on the Lighter desk.",
    ],
    ["no account yet", "not_onboarded", "No Lighter account yet."],
  ])("%s gets its own sentence, and no figures", (_name, reason, sentence) => {
    mockAccount({ ok: true, data: unavailable(reason) });
    const { container } = renderCard();
    expect(screen.getByText(sentence)).toBeTruthy();
    expect(container.querySelector("dl")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
    // Not ready: the note carries no read time.
    expect(container.querySelector(".vex-pf-sec__note")?.textContent).toBe(" · not in the total above");
  });

  it("a locked vault and several accounts offer no setup (it would not help)", () => {
    mockAccount({ ok: true, data: unavailable("locked_vault") });
    const locked = renderCard();
    expect(screen.queryByRole("button", { name: "Set up Lighter" })).toBeNull();
    locked.unmount();

    mockAccount({ ok: true, data: unavailable("ambiguous_account") });
    renderCard();
    expect(screen.queryByRole("button", { name: "Set up Lighter" })).toBeNull();
  });

  it("no account yet offers Set up Lighter, which enters Lighter", () => {
    mockAccount({ ok: true, data: unavailable("not_onboarded") });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Set up Lighter" }));
    expect(useUiStore.getState().runtimeMode).toBe("lighter");
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });
});

describe("LighterAccountCard - the four figures", () => {
  it("Equity is collateral plus uPnL; Available, Margin in use and the PnL follow, in USDC on core", () => {
    mockReady();
    const { container } = renderCard();
    // collateral 1000, available 600, uPnL 20
    expect(figure(container, "Equity").textContent).toBe("1,020.00 USDC");
    expect(figure(container, "Available").textContent).toBe("600.00 USDC");
    // collateral - available = 400, a 40% share of the collateral.
    expect(figure(container, "Margin in use").textContent).toBe("400.00 USDC · 40%");
    // 20 over the 400 holding it is +5%.
    expect(figure(container, "Unrealized trading PnL").textContent).toBe("+20.00 USDC (+5%)");
  });

  it("names the four figures in order", () => {
    mockReady();
    const { container } = renderCard();
    expect(
      Array.from(container.querySelectorAll("dl.vex-pf-kv4 dt")).map((term) => term.textContent),
    ).toEqual(["Equity", "Available", "Margin in use", "Unrealized trading PnL"]);
    expect(container.querySelector("dl.vex-pf-kv4")?.getAttribute("aria-label")).toBe("Lighter account");
  });

  it("uses the settlement unit of the account: USDC on core, USDG on rhc", () => {
    mockReady({ environment: "rhc" });
    const { container } = renderCard();
    expect(figure(container, "Equity").textContent).toBe("1,020.00 USDG");
    expect(figure(container, "Available").textContent).toBe("600.00 USDG");
    expect(figure(container, "Margin in use").textContent).toBe("400.00 USDG · 40%");
    expect(figure(container, "Unrealized trading PnL").textContent).toBe("+20.00 USDG (+5%)");
    expect(container.textContent).not.toContain("USDC");
  });

  it("a negative uPnL is signed, and lowers equity", () => {
    mockReady({ summary: { collateral: "1000", availableBalance: "600", unrealizedPnl: "-30" } });
    const { container } = renderCard();
    expect(figure(container, "Equity").textContent).toBe("970.00 USDC");
    expect(figure(container, "Unrealized trading PnL").textContent).toBe("-30.00 USDC (-7.5%)");
  });

  it("no margin in use is a zero with its share, not a missing figure", () => {
    mockReady({ summary: { collateral: "1000", availableBalance: "1000", unrealizedPnl: "0" } });
    const { container } = renderCard();
    expect(figure(container, "Margin in use").textContent).toBe("0.00 USDC · 0%");
  });

  it("no collateral to share has no usage share, and no ROE", () => {
    mockReady({ summary: { collateral: "0", availableBalance: "0", unrealizedPnl: "5" } });
    const { container } = renderCard();
    expect(figure(container, "Margin in use").textContent).toBe("0.00 USDC");
    expect(figure(container, "Unrealized trading PnL").textContent).toBe("+5.00 USDC");
  });

  it("says Not available for every figure when the read carries no summary", () => {
    mockReady({ summary: null });
    const { container } = renderCard();
    for (const label of ["Equity", "Available", "Margin in use", "Unrealized trading PnL"]) {
      expect(figure(container, label).textContent).toBe("Not available");
    }
    expect(container.textContent).not.toContain("0.00");
  });

  it("says Not available only where the summary lacks the figure", () => {
    mockReady({ summary: { collateral: null, availableBalance: "600", unrealizedPnl: null } });
    const { container } = renderCard();
    expect(figure(container, "Equity").textContent).toBe("Not available");
    expect(figure(container, "Available").textContent).toBe("600.00 USDC");
    expect(figure(container, "Margin in use").textContent).toBe("Not available");
    expect(figure(container, "Unrealized trading PnL").textContent).toBe("Not available");
  });
});

describe("LighterAccountCard - trading colours on trading values only", () => {
  it("a positive uPnL is trade up, on the uPnL cell alone", () => {
    mockReady();
    const { container } = renderCard();
    expect(figure(container, "Unrealized trading PnL").getAttribute("data-trade")).toBe("up");
    expect(figure(container, "Equity").hasAttribute("data-trade")).toBe(false);
    expect(figure(container, "Available").hasAttribute("data-trade")).toBe(false);
    expect(figure(container, "Margin in use").hasAttribute("data-trade")).toBe(false);
    expect(container.querySelectorAll("[data-trade]")).toHaveLength(1);
  });

  it("a negative uPnL is trade down, and Equity does not take it", () => {
    mockReady({ summary: { collateral: "1000", availableBalance: "600", unrealizedPnl: "-30" } });
    const { container } = renderCard();
    expect(figure(container, "Unrealized trading PnL").getAttribute("data-trade")).toBe("down");
    expect(figure(container, "Equity").hasAttribute("data-trade")).toBe(false);
    expect(figure(container, "Available").hasAttribute("data-trade")).toBe(false);
    expect(container.querySelectorAll("[data-trade]")).toHaveLength(1);
  });

  it("a zero uPnL keeps the ink", () => {
    mockReady({ summary: { collateral: "1000", availableBalance: "600", unrealizedPnl: "0" } });
    const { container } = renderCard();
    expect(figure(container, "Unrealized trading PnL").textContent).toBe("0.00 USDC (0%)");
    expect(container.querySelector("[data-trade]")).toBeNull();
  });

  it("an unknown uPnL keeps the ink", () => {
    mockReady({ summary: null });
    const { container } = renderCard();
    expect(container.querySelector("[data-trade]")).toBeNull();
  });

  it("on the whole page, data-trade is only the account uPnL, each position's uPnL, and the Long or Short word", () => {
    mockReady({ positions: [LONG_ETH, SHORT_BTC, BARE_SOL] });
    const { container } = renderCard();
    const marked = Array.from(container.querySelectorAll("[data-trade]"));
    const rows = positionRows(container);
    expect(rows).toHaveLength(3);
    const expected = [
      figure(container, "Unrealized trading PnL"),
      rows[0]?.querySelector(".vex-pf-side") ?? null,
      cell(rows[0], 6),
      rows[1]?.querySelector(".vex-pf-side") ?? null,
      cell(rows[1], 6),
      rows[2]?.querySelector(".vex-pf-side") ?? null,
      // BARE_SOL's own uPnL is unknown: its cell is NOT marked.
    ];
    expect(marked).toHaveLength(expected.length);
    for (const node of expected) expect(marked).toContain(node);
    expect(marked).not.toContain(cell(rows[2], 6));
  });
});

describe("LighterAccountCard - the positions", () => {
  it("lists them in a table under the figures, with the desk's columns", () => {
    mockReady({ positions: [LONG_ETH] });
    const { container } = renderCard();
    const table = container.querySelector('[data-vex-area="portfolio-lighter-positions"]');
    expect(table?.tagName).toBe("TABLE");
    expect(
      within(table instanceof HTMLElement ? table : container)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Position", "Size", "Entry", "Mark", "Liq. price", "Margin", "uPnL", "Actions"]);
    expect(container.querySelector("dl")?.compareDocumentPosition(table ?? container)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("a long cross position: the side word, its terms, size, entry, mark, liq, margin and uPnL with ROE", () => {
    mockReady({ positions: [LONG_ETH] });
    const { container } = renderCard();
    const [row] = positionRows(container);
    expect(cell(row, 0).textContent).toBe("ETH Long · 10x Cross");
    expect(cell(row, 1).textContent).toBe("0.5 ETH");
    expect(cell(row, 2).textContent).toBe("2,000");
    // Mark is the position's value over its size: 1100 / 0.5.
    expect(cell(row, 3).textContent).toBe("2,200.00");
    expect(cell(row, 4).textContent).toBe("1,500");
    // A cross position's margin is its notional times its fraction: 1100 x 10%.
    expect(cell(row, 5).textContent).toBe("110.00");
    // 100 over that 110 is +90.91%.
    expect(cell(row, 6).textContent).toBe("+100.00 +90.91%");
    expect(row?.querySelector(".vex-pf-side")?.textContent).toBe("Long");
    expect(row?.querySelector(".vex-pf-side")?.getAttribute("data-trade")).toBe("up");
    expect(cell(row, 6).getAttribute("data-trade")).toBe("up");
  });

  it("a short isolated position: Short is trade down, margin is the allocated one, uPnL is signed", () => {
    mockReady({ positions: [SHORT_BTC] });
    const { container } = renderCard();
    const [row] = positionRows(container);
    expect(cell(row, 0).textContent).toBe("BTC Short · 5x Isolated");
    expect(cell(row, 1).textContent).toBe("0.02 BTC");
    expect(cell(row, 2).textContent).toBe("60,000");
    expect(cell(row, 3).textContent).toBe("59,000.00");
    expect(cell(row, 4).textContent).toBe("70,000");
    expect(cell(row, 5).textContent).toBe("200.00");
    expect(cell(row, 6).textContent).toBe("-50.00 -25%");
    expect(row?.querySelector(".vex-pf-side")?.textContent).toBe("Short");
    expect(row?.querySelector(".vex-pf-side")?.getAttribute("data-trade")).toBe("down");
    expect(cell(row, 6).getAttribute("data-trade")).toBe("down");
  });

  it("no figure is trade-coloured in a position row except the side word and the uPnL", () => {
    mockReady({ positions: [LONG_ETH] });
    const { container } = renderCard();
    const [row] = positionRows(container);
    for (const column of [0, 1, 2, 3, 4, 5, 7]) {
      expect(cell(row, column).hasAttribute("data-trade")).toBe(false);
    }
  });

  it("a zero uPnL keeps the ink on the row too", () => {
    mockReady({ positions: [position({ unrealizedPnl: "0" })] });
    const { container } = renderCard();
    const [row] = positionRows(container);
    expect(cell(row, 6).textContent).toBe("0.00 0%");
    expect(cell(row, 6).hasAttribute("data-trade")).toBe(false);
  });

  it("says Not available for every figure the position's read lacks, never a zero", () => {
    mockReady({ positions: [BARE_SOL] });
    const { container } = renderCard();
    const [row] = positionRows(container);
    // No terms, so nothing after the side word.
    expect(cell(row, 0).textContent).toBe("SOL Long");
    expect(cell(row, 1).textContent).toBe("10 SOL");
    for (const column of [2, 3, 4, 5, 6]) {
      expect(cell(row, column).textContent).toBe("Not available");
    }
    expect(cell(row, 6).hasAttribute("data-trade")).toBe(false);
  });

  it("says No open positions. and draws no table when there are none", () => {
    mockReady({ positions: [] });
    const { container } = renderCard();
    expect(screen.getByText("No open positions.")).toBeTruthy();
    expect(container.querySelector("table")).toBeNull();
    // The figures are still there.
    expect(figure(container, "Equity").textContent).toBe("1,020.00 USDC");
  });

  it("each row has one actions key named for its position", () => {
    mockReady({ positions: [LONG_ETH, SHORT_BTC] });
    renderCard();
    expect(screen.getByRole("button", { name: "Actions for the ETH position" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actions for the BTC position" })).toBeTruthy();
    // Nothing is open until a key is pressed.
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("LighterAccountCard - opening the desk", () => {
  it("the row menu has one item, Open on the Lighter desk, rendered outside the table", () => {
    mockReady({ positions: [LONG_ETH] });
    const { container } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Actions for the ETH position" }));
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toBe("Open on the Lighter desk");
    // The kit's menu portals into the body so the page's scroller never clips it.
    expect(container.contains(items[0] ?? null)).toBe(false);
    expect(document.body.contains(items[0] ?? null)).toBe(true);
  });

  it("saves the position's market on the desk (saveDesk with its marketId) and enters Lighter", () => {
    const saveDesk = vi.fn(realSaveDesk);
    useLighterAnalysisStore.setState({ saveDesk });
    mockReady({ positions: [LONG_ETH, SHORT_BTC] });
    renderCard();
    expect(useLighterAnalysisStore.getState().desk.marketId).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Actions for the BTC position" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open on the Lighter desk" }));

    // The patch is the market and nothing else, saved once.
    expect(saveDesk).toHaveBeenCalledTimes(1);
    expect(saveDesk).toHaveBeenCalledWith({ marketId: SHORT_BTC.marketId });
    expect(useLighterAnalysisStore.getState().desk.marketId).toBe(SHORT_BTC.marketId);
    expect(useUiStore.getState().runtimeMode).toBe("lighter");
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
    // The menu closes on selection.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("saves only the market: the rest of the desk is left as the user set it", () => {
    useLighterAnalysisStore.getState().saveDesk({ environment: "core" });
    mockReady({ positions: [LONG_ETH] });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Actions for the ETH position" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open on the Lighter desk" }));
    const desk = useLighterAnalysisStore.getState().desk;
    expect(desk.marketId).toBe(LONG_ETH.marketId);
    expect(desk.environment).toBe("core");
    expect(desk.resolution).toBe(DEFAULT_LIGHTER_DESK.resolution);
  });

  it("the head link Open Lighter enters Lighter and counts the entry once", () => {
    mockReady();
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Open Lighter" }));
    expect(useUiStore.getState().runtimeMode).toBe("lighter");
    expect(funnelStep).toHaveBeenCalledTimes(1);
    expect(funnelStep).toHaveBeenCalledWith({ step: "desk_enter", environment: "rhc" });
  });

  it("from the desk itself, Open Lighter does not re-enter it", () => {
    useUiStore.setState({ runtimeMode: "lighter" });
    mockReady();
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Open Lighter" }));
    expect(useUiStore.getState().runtimeMode).toBe("lighter");
    expect(funnelStep).not.toHaveBeenCalled();
  });

  it("the head link works in every state, even when the read failed", () => {
    mockAccount(failure("provider.unavailable", "down"));
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Open Lighter" }));
    expect(useUiStore.getState().runtimeMode).toBe("lighter");
  });
});
