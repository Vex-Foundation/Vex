/**
 * W3/W4: the Risk Setup steppers are click-to-type with a clamp affordance, and
 * the panel names the venue's 10-USDC minimum notional. The clamp is UI only —
 * server-side risk-policy validation stays authoritative (not exercised here).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HypervexingRiskSetup } from "../HypervexingRiskSetup.js";

const setPolicyMutate = vi.hoisted(() => vi.fn());

vi.mock("../../../../lib/api/hyperliquid.js", () => ({
  useHyperliquidSessionRiskPolicy: () => ({
    data: {
      ok: true,
      data: {
        policy: { leverageCapDefault: 3, perOrderNotionalPct: 20, totalNotionalPct: 100 },
        source: "user",
      },
    },
  }),
  useSetHyperliquidSessionRiskPolicy: () => ({ mutate: setPolicyMutate, isPending: false, data: undefined }),
  useHyperliquidMarkets: () => ({ data: { ok: true, data: [{ coin: "BTC", maxLeverage: 40 }] } }),
  useHyperliquidPreferences: () => ({
    data: { ok: true, data: { hyperliquid: { policy: { requireStopLoss: true } } } },
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}));

function renderPanel(): void {
  render(<HypervexingRiskSetup sessionId="00000000-0000-4000-8000-000000000001" selectedCoin="BTC" />);
}

describe("HypervexingRiskSetup steppers", () => {
  it("keeps the venue minimum-notional hint out of the panel body until the help modal opens", () => {
    renderPanel();
    expect(screen.queryByText(/Venue minimum per order: 10 USDC notional\./)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "What do these limits do?" }));
    expect(screen.getByText(/Venue minimum per order: 10 USDC notional\./)).not.toBeNull();
  });

  it("opens a numeric input when the value is clicked", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit Leverage cap" }));
    expect(screen.getByRole("spinbutton", { name: "Leverage cap value" })).not.toBeNull();
  });

  it("clamps an over-max commit to the bound and flashes a max notice", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit Leverage cap" }));
    const input = screen.getByRole("spinbutton", { name: "Leverage cap value" });
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("max accessible is 40")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Edit Leverage cap" }).textContent).toContain("40");
  });

  it("clamps an under-min commit to the bound and flashes a min notice", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit Per order" }));
    const input = screen.getByRole("spinbutton", { name: "Per order value" });
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("min accessible is 1")).not.toBeNull();
  });

  it("reverts an empty commit without changing the value", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit Leverage cap" }));
    const input = screen.getByRole("spinbutton", { name: "Leverage cap value" });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("button", { name: "Edit Leverage cap" }).textContent).toContain("3");
    expect(screen.queryByText(/accessible is/)).toBeNull();
  });

  it("preserves a decimal commit for the percentage fields (no silent rounding)", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit Per order" }));
    const input = screen.getByRole("spinbutton", { name: "Per order value" });
    fireEvent.change(input, { target: { value: "12.5" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const valueButton = screen.getByRole("button", { name: "Edit Per order" });
    expect(valueButton.textContent).toContain("12.5");
    expect(screen.queryByText(/accessible is/)).toBeNull();
  });

  it("coerces the leverage field to an integer on commit", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit Leverage cap" }));
    const input = screen.getByRole("spinbutton", { name: "Leverage cap value" });
    fireEvent.change(input, { target: { value: "3.7" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const valueButton = screen.getByRole("button", { name: "Edit Leverage cap" });
    expect(valueButton.textContent).toContain("4");
    expect(valueButton.textContent).not.toContain("3.7");
  });

  it("reverts on Escape without committing", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit Leverage cap" }));
    const input = screen.getByRole("spinbutton", { name: "Leverage cap value" });
    fireEvent.change(input, { target: { value: "25" } });
    fireEvent.keyDown(input, { key: "Escape" });

    const valueButton = screen.getByRole("button", { name: "Edit Leverage cap" });
    expect(valueButton.textContent).toContain("3");
    expect(valueButton.textContent).not.toContain("25");
  });
});
