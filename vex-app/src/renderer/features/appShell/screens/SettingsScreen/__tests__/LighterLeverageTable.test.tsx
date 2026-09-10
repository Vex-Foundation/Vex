/**
 * The leverage table: what it shows, what it will not let a person send, and
 * what it says when the vault is locked or rows are missing.
 *
 * The properties worth pinning are the bounds. Apply is the entry to a signing
 * path, so it stays disabled for anything the market's own maximum does not
 * admit, and "Max" fills the largest whole leverage rather than a rounded one.
 * The vault-locked copy is the SAME sentence the Points card uses, because one
 * lock must read one way across the section.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LighterLeverageTable } from "../LighterLeverageTable.js";
import type {
  LeverageOutcomeView,
  LighterLeverageMarketRow,
} from "../lighter-leverage-view.js";
import {
  LEVERAGE_EMPTY,
  LEVERAGE_VAULT_LOCKED,
  leverageOmittedNote,
  leveragePickerBoundNote,
} from "../lighter-trading-setup-copy.js";

afterEach(cleanup);

function marketRow(
  overrides: Partial<LighterLeverageMarketRow> = {},
): LighterLeverageMarketRow {
  return {
    marketId: 1,
    symbol: "BTC",
    current: {
      initialMarginFraction: 5000,
      leverageDisplay: "2.00",
      marginMode: "cross",
      source: "market_default",
    },
    max: { initialMarginFraction: 200, leverageDisplay: "50.00" },
    openPosition: null,
    ...overrides,
  } as LighterLeverageMarketRow;
}

const POSITION_ROW = marketRow({
  marketId: 0,
  symbol: "ETH",
  current: {
    initialMarginFraction: 5000,
    leverageDisplay: "2.00",
    marginMode: "cross",
    source: "position_row",
  },
  openPosition: { size: "0.0050", side: "long" },
});

function renderTable(
  props: Partial<React.ComponentProps<typeof LighterLeverageTable>> = {},
): { readonly onApply: ReturnType<typeof vi.fn>; readonly onReconcile: ReturnType<typeof vi.fn> } {
  const onApply = vi.fn();
  const onReconcile = vi.fn();
  render(
    <LighterLeverageTable
      markets={[POSITION_ROW]}
      omitted={null}
      vaultLocked={false}
      busyMarketId={null}
      outcomes={new Map<number, LeverageOutcomeView>()}
      onApply={onApply}
      onReconcile={onReconcile}
      {...props}
    />,
  );
  return { onApply, onReconcile };
}

function leverageField(symbol: string): HTMLInputElement {
  return screen.getByLabelText(`New leverage for ${symbol}`) as HTMLInputElement;
}

function applyButton(symbol: string): HTMLButtonElement {
  return screen.getByRole("button", {
    name: `Apply new leverage to ${symbol}`,
  }) as HTMLButtonElement;
}

it("says a market with no leverage row is on the market default", () => {
  renderTable({ markets: [marketRow(), POSITION_ROW] });
  const eth = screen.getByRole("row", { name: /ETH/ });
  expect(within(eth).getByText("2.00x cross")).not.toBeNull();
  // BTC has neither a position nor terms of its own, so it is not listed yet.
  expect(screen.queryByLabelText("New leverage for BTC")).toBeNull();
});

it("shows nothing to change when the account has no terms anywhere", () => {
  renderTable({ markets: [marketRow()] });
  expect(screen.getByText(LEVERAGE_EMPTY)).not.toBeNull();
});

it("shows the market maximum and the open position with its base unit", () => {
  renderTable();
  const eth = screen.getByRole("row", { name: /ETH/ });
  expect(within(eth).getByText("50x")).not.toBeNull();
  expect(eth.textContent).toContain("long 0.0050 ETH");
});

it("Max fills the largest whole leverage the market admits", () => {
  const { onApply } = renderTable({
    markets: [{ ...POSITION_ROW, max: { initialMarginFraction: 3333, leverageDisplay: "3.00" } }],
  });
  fireEvent.click(screen.getByRole("button", { name: "Use the maximum leverage for ETH" }));
  expect(leverageField("ETH").value).toBe("3");
  fireEvent.click(applyButton("ETH"));
  expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ symbol: "ETH" }), 3, "cross");
});

it("will not let a leverage above the market maximum reach main", () => {
  const { onApply } = renderTable();
  fireEvent.change(leverageField("ETH"), { target: { value: "51" } });
  expect(applyButton("ETH").disabled).toBe(true);
  expect(screen.getByText("Lighter's maximum for ETH is 50x.")).not.toBeNull();
  fireEvent.click(applyButton("ETH"));
  expect(onApply).not.toHaveBeenCalled();
});

it("hands up a selector, never the terms of the change", () => {
  const { onApply } = renderTable();
  fireEvent.change(leverageField("ETH"), { target: { value: "10" } });
  fireEvent.click(applyButton("ETH"));
  expect(onApply).toHaveBeenCalledTimes(1);
  const [row, leverage, marginMode] = onApply.mock.calls[0] as [
    LighterLeverageMarketRow,
    number,
    string,
  ];
  expect(row.marketId).toBe(0);
  expect(leverage).toBe(10);
  expect(marginMode).toBe("cross");
});

it("disables every control with the Points card's own locked sentence", () => {
  renderTable({ vaultLocked: true });
  expect(screen.getByText(new RegExp(LEVERAGE_VAULT_LOCKED))).not.toBeNull();
  expect(leverageField("ETH").disabled).toBe(true);
  expect(applyButton("ETH").disabled).toBe(true);
});

it("stops a second Apply while one change is in flight", () => {
  renderTable({ busyMarketId: 0 });
  expect(applyButton("ETH").disabled).toBe(true);
});

it("says how many markets are not listed, and why", () => {
  renderTable({ omitted: { count: 12, reason: "the account read is bounded to 32 markets" } });
  expect(
    screen.getByText(leverageOmittedNote(12, "the account read is bounded to 32 markets")),
  ).not.toBeNull();
});

it("browses every market without a query, and says what the window leaves out", () => {
  const many = Array.from({ length: 57 }, (_, index) =>
    marketRow({ marketId: index + 10, symbol: `M${index}` }),
  );
  renderTable({ markets: [POSITION_ROW, ...many] });
  const pickable = screen.getByRole("list");
  expect(within(pickable).getAllByRole("button")).toHaveLength(8);
  expect(
    screen.getByText(leveragePickerBoundNote(8, 57)),
  ).not.toBeNull();
});

it("adds a market the person searched for", () => {
  renderTable({ markets: [POSITION_ROW, marketRow({ marketId: 3, symbol: "SOL" })] });
  expect(screen.queryByLabelText("New leverage for SOL")).toBeNull();
  fireEvent.change(screen.getByLabelText("Add a market"), { target: { value: "sol" } });
  fireEvent.click(screen.getByRole("button", { name: "SOL" }));
  expect(screen.getByLabelText("New leverage for SOL")).not.toBeNull();
});

it("shows an outcome for the row it belongs to, with Reconcile only when it applies", () => {
  const { onReconcile } = renderTable({
    outcomes: new Map<number, LeverageOutcomeView>([
      [0, { tone: "warning", message: "Vex sent the change.", reconcilable: true }],
    ]),
  });
  expect(screen.getByRole("status").textContent).toBe("Vex sent the change.");
  fireEvent.click(screen.getByRole("button", { name: "Reconcile" }));
  expect(onReconcile).toHaveBeenCalledWith(expect.objectContaining({ marketId: 0 }));
});

it("omits Reconcile for an outcome that settled", () => {
  renderTable({
    outcomes: new Map<number, LeverageOutcomeView>([
      [0, { tone: "success", message: "Applied.", reconcilable: false }],
    ]),
  });
  expect(screen.queryByRole("button", { name: "Reconcile" })).toBeNull();
});
