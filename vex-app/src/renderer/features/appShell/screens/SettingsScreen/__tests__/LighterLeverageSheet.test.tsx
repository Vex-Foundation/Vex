/**
 * The leverage sheet: the one surface that picks a new leverage, from Settings
 * and from the desk ticket alike.
 *
 * The properties worth pinning are the bounds. Apply is the entry to a signing
 * path, so it stays disabled for anything the market's own maximum does not
 * admit, "Max" fills the largest whole leverage rather than a rounded one, and
 * the slider and the field are two views of one draft. The sheet starts from
 * the row's CURRENT terms so a person who only changes the margin mode sends
 * the leverage they already have, not an empty field.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LighterLeverageSheet } from "../LighterLeverageSheet.js";
import type {
  LeverageOutcomeView,
  LighterLeverageMarketRow,
} from "../lighter-leverage-view.js";
import {
  LEVERAGE_MAX_UNAVAILABLE,
  LEVERAGE_VAULT_LOCKED,
} from "../lighter-trading-setup-copy.js";

afterEach(cleanup);

const ETH_ROW: LighterLeverageMarketRow = {
  marketId: 0,
  symbol: "ETH",
  current: {
    initialMarginFraction: 5000,
    leverageDisplay: "2.00",
    marginMode: "cross",
    source: "position_row",
  },
  max: { initialMarginFraction: 200, leverageDisplay: "50.00" },
  openPosition: { size: "0.0050", side: "long" },
} as LighterLeverageMarketRow;

function renderSheet(
  props: Partial<React.ComponentProps<typeof LighterLeverageSheet>> = {},
): {
  readonly onApply: ReturnType<typeof vi.fn>;
  readonly onReconcile: ReturnType<typeof vi.fn>;
  readonly onClose: ReturnType<typeof vi.fn>;
} {
  const onApply = vi.fn();
  const onReconcile = vi.fn();
  const onClose = vi.fn();
  render(
    <LighterLeverageSheet
      symbol="ETH"
      row={ETH_ROW}
      notice={null}
      vaultLocked={false}
      busy={false}
      outcome={null}
      onApply={onApply}
      onReconcile={onReconcile}
      onClose={onClose}
      {...props}
    />,
  );
  return { onApply, onReconcile, onClose };
}

function leverageField(): HTMLInputElement {
  return screen.getByLabelText("New leverage for ETH") as HTMLInputElement;
}

function slider(): HTMLInputElement {
  return screen.getByLabelText("Leverage slider for ETH") as HTMLInputElement;
}

function applyButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Apply new leverage to ETH" }) as HTMLButtonElement;
}

it("opens on the row's current terms and its market maximum", () => {
  renderSheet();
  expect(screen.getByText("2.00x cross")).not.toBeNull();
  expect(screen.getAllByText("50x").length).toBeGreaterThan(0);
  expect(screen.getByText("long 0.0050 ETH")).not.toBeNull();
  expect(leverageField().value).toBe("2");
  expect(slider().max).toBe("50");
  expect(applyButton().disabled).toBe(false);
});

it("keeps the slider and the field as one draft", () => {
  renderSheet();
  fireEvent.change(slider(), { target: { value: "10" } });
  expect(leverageField().value).toBe("10");
  fireEvent.change(leverageField(), { target: { value: "25" } });
  expect(slider().value).toBe("25");
});

it("Max fills the largest whole leverage the market admits", () => {
  const { onApply } = renderSheet({
    row: { ...ETH_ROW, max: { initialMarginFraction: 3333, leverageDisplay: "3.00" } },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use the maximum leverage for ETH" }));
  expect(leverageField().value).toBe("3");
  fireEvent.click(applyButton());
  expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ symbol: "ETH" }), 3, "cross");
});

it("will not let a leverage above the market maximum reach main", () => {
  const { onApply } = renderSheet();
  fireEvent.change(leverageField(), { target: { value: "51" } });
  expect(applyButton().disabled).toBe(true);
  expect(screen.getByText("Lighter's maximum for ETH is 50x.")).not.toBeNull();
  fireEvent.click(applyButton());
  expect(onApply).not.toHaveBeenCalled();
});

it("hands up a selector with the chosen margin mode, never the terms", () => {
  const { onApply } = renderSheet();
  fireEvent.change(leverageField(), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("combobox", { name: "Margin mode for ETH" }));
  fireEvent.click(screen.getByRole("option", { name: "Isolated" }));
  fireEvent.click(applyButton());
  expect(onApply).toHaveBeenCalledTimes(1);
  const [row, leverage, marginMode] = onApply.mock.calls[0] as [
    LighterLeverageMarketRow,
    number,
    string,
  ];
  expect(row.marketId).toBe(0);
  expect(leverage).toBe(10);
  expect(marginMode).toBe("isolated");
});

it("disables every control with the Points card's own locked sentence", () => {
  renderSheet({ vaultLocked: true });
  expect(screen.getByText(new RegExp(LEVERAGE_VAULT_LOCKED))).not.toBeNull();
  expect(leverageField().disabled).toBe(true);
  expect(slider().disabled).toBe(true);
  expect(applyButton().disabled).toBe(true);
});

it("offers no unbounded input when Lighter reported no usable maximum", () => {
  renderSheet({ row: { ...ETH_ROW, max: { initialMarginFraction: 0, leverageDisplay: "0.00" } } });
  expect(screen.getByText(LEVERAGE_MAX_UNAVAILABLE)).not.toBeNull();
  expect(screen.queryByLabelText("Leverage slider for ETH")).toBeNull();
  expect(applyButton().disabled).toBe(true);
});

it("shows the notice and no controls when there is no row to change", () => {
  renderSheet({ row: null, notice: "Reading leverage from Lighter…" });
  expect(screen.getByRole("status").textContent).toBe("Reading leverage from Lighter…");
  expect(screen.queryByLabelText("New leverage for ETH")).toBeNull();
  expect(applyButton().disabled).toBe(true);
});

it("holds Apply and Close while a change is in flight", () => {
  const { onClose } = renderSheet({ busy: true });
  expect(applyButton().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).not.toHaveBeenCalled();
});

it("shows the outcome where the person is, with Reconcile only when it applies", () => {
  const { onReconcile } = renderSheet({
    outcome: { tone: "warning", message: "Vex sent the change.", reconcilable: true } as LeverageOutcomeView,
  });
  expect(screen.getByRole("status").textContent).toBe("Vex sent the change.");
  fireEvent.click(screen.getByRole("button", { name: "Reconcile" }));
  expect(onReconcile).toHaveBeenCalledWith(expect.objectContaining({ marketId: 0 }));
});
