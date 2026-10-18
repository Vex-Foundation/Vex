/**
 * BalancesCard, the Value column (review problem 4). At 1440 the Balances
 * table sits in the narrower column of the Wallets band (460 of the 920 page,
 * Vex open or hidden). Its cells were all nowrap, so two "Not available" words
 * out-grew the column and the section's sideways scroll cut the last column to
 * "Valu" and "$100.0".
 *
 * jsdom lays nothing out, so the pins are the contract that guarantees the
 * layout, in the markup and in the stylesheet:
 *   - the Value head and every Value cell carry `vex-pf-v`, and that rule is
 *     nowrap, so the column's min-content IS its max-content (the whole
 *     figure) and an auto table layout can never take it below that;
 *   - every "Not available" word is `vex-pf-wrap` (white-space: normal), the
 *     network cell and the asset name wrap at spaces: the columns that give
 *     way when the band is narrow;
 *   - the table is NOT `table-layout: fixed` and no track is a percentage, so
 *     no column is sized against its content;
 *   - the section keeps its sideways scroll as the last resort, never as the
 *     first one.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type {
  PortfolioDto,
  PortfolioReadInput,
  PositionTokenDto,
} from "@shared/schemas/portfolio.js";
import { ok, type Result } from "@shared/ipc/result.js";
import { useUiStore } from "../../../stores/uiStore.js";

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
vi.mock("../../../lib/api/portfolio.js", () => ({
  usePortfolio: mockUsePortfolio,
  useWalletPortfolio: vi.fn(),
}));

const { BalancesCard } = await import("../book/portfolio/BalancesCard.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(
  path.resolve(here, "../../../styles/global-css/book.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rule whose selector is exactly `selector`, or null. */
function ruleOf(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(CSS);
  return match === null ? null : (match[1] ?? "");
}

function token(overrides: Partial<PositionTokenDto>): PositionTokenDto {
  return { chainId: 1, symbol: "TOK", balanceUsd: 1, amount: 1, ...overrides };
}

/** The review's rows: priced, with a quantity and a price the read does not carry. */
const ROWS: readonly PositionTokenDto[] = [
  token({ tokenName: "ETH", symbol: "ETH", balanceUsd: 100, amount: null }),
  token({ tokenName: "USD Coin", symbol: "USDC", chainId: 8453, balanceUsd: 100, amount: null }),
  token({ tokenName: "WETH", symbol: "WETH", balanceUsd: 90, amount: null }),
  token({ tokenName: "Unpriced", symbol: "VEX", balanceUsd: null, amount: 5 }),
];

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ shellRoute: { kind: "none" }, hideDustBalances: true });
  mockUsePortfolio.mockReturnValue({
    isLoading: false,
    isError: false,
    data: ok({
      scope: "global",
      walletCount: 2,
      liveTotalUsd: 999,
      snapshotTotalUsd: null,
      pnlVsPrev: null,
      snapshotAt: null,
      tokens: [...ROWS],
      chains: [],
    }),
  });
});

afterEach(cleanup);

describe("BalancesCard: the Value column never clips", () => {
  it("marks the Value head and every Value cell, and the table as the balances table", () => {
    render(<BalancesCard scope={{ kind: "global" }} />);
    const table = document.querySelector('[data-vex-area="portfolio-balances"]');
    expect(table?.classList.contains("vex-pf-t--balances")).toBe(true);

    const heads = [...document.querySelectorAll("thead th")];
    expect(heads.map((head) => head.textContent)).toEqual([
      "Asset",
      "Network",
      "Quantity",
      "Price",
      "Value",
      "Actions",
    ]);
    expect(heads[4]?.classList.contains("vex-pf-v")).toBe(true);
    expect(heads.filter((head) => head.classList.contains("vex-pf-v"))).toHaveLength(1);

    for (const row of document.querySelectorAll("tbody tr")) {
      const cells = [...row.querySelectorAll("td")];
      expect(cells[4]?.classList.contains("vex-pf-v")).toBe(true);
      expect(cells.filter((cell) => cell.classList.contains("vex-pf-v"))).toHaveLength(1);
    }
  });

  it("lets every Not available word wrap, in the Quantity, Price and Value cells alike", () => {
    render(<BalancesCard scope={{ kind: "global" }} />);
    const words = [...document.querySelectorAll("tbody td span")].filter(
      (span) => span.textContent === "Not available",
    );
    // Three rows without a quantity (two figures each) plus the unpriced row's
    // price and value.
    expect(words.length).toBeGreaterThanOrEqual(8);
    for (const word of words) {
      expect(word.classList.contains("vex-pf-wrap")).toBe(true);
    }
  });

  it("the Value rule is nowrap, so the column keeps its whole figure at any width", () => {
    const value = ruleOf(".vex-pf-t--balances .vex-pf-v");
    expect(value).not.toBeNull();
    expect(value).toMatch(/white-space:\s*nowrap/);
    // Nothing on the Value track may shrink or clip it.
    expect(value).not.toMatch(/(?:max-width|width|overflow|text-overflow)\s*:/);
  });

  it("the words give way instead: Not available, the network and the asset name wrap", () => {
    expect(ruleOf(".vex-pf-wrap")).toMatch(/white-space:\s*normal/);
    expect(ruleOf(".vex-pf-t--balances .vex-pf-net")).toMatch(/white-space:\s*normal/);
    expect(ruleOf(".vex-pf-t--balances .vex-pf-asset > span:last-child")).toMatch(
      /white-space:\s*normal/,
    );
  });

  it("sizes no column against its content: auto layout, no fixed table, no percentage track", () => {
    expect(CSS).not.toMatch(/table-layout:\s*fixed/);
    // (The table itself is 100% wide; it is the columns that carry no track.)
    for (const selector of [
      ".vex-pf-t th",
      ".vex-pf-t td",
      ".vex-pf-t--balances .vex-pf-v",
      ".vex-pf-t--balances .vex-pf-net",
    ]) {
      expect(ruleOf(selector) ?? "").not.toMatch(/(?:^|;|\s)width:\s*\d+%/);
    }
  });

  it("keeps the section's sideways scroll as the last resort", () => {
    expect(ruleOf(".vex-pf-sec")).toMatch(/overflow-x:\s*auto/);
  });
});
