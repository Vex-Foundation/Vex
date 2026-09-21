import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LighterAccountSetupStatus } from "@shared/schemas/lighter-trading.js";

const mocks = vi.hoisted(() => ({
  useLighterAccountSetup: vi.fn(),
}));

vi.mock("../useLighterAccountSetup.js", () => ({
  useLighterAccountSetup: mocks.useLighterAccountSetup,
}));

import { LighterAccountSetupModal } from "../LighterAccountSetupModal.js";

function readyStatus(
  environment: "core" | "rhc",
): LighterAccountSetupStatus {
  return {
    environment,
    settlementSymbol: environment === "core" ? "USDC" : "USDG",
    walletAddress: "0xb3920000000000000000000000000000000dDfE1",
    walletSettlementBalance: "0",
    nativeGasSufficient: true,
    settlementNetworkName: environment === "core" ? "Ethereum mainnet" : "Robinhood Chain mainnet",
    nativeGasSymbol: "ETH",
    minimumDeposit: "1",
    accountExists: true,
    accountCollateral: "10",
    tradingKeyRegistered: true,
    keyRegistrationResumable: false,
    feePolicy: { perpFeePercent: 0.1, spotFeePercent: 0.25 },
    feeAuthorized: true,
  };
}

function renderReady(environment: "core" | "rhc") {
  mocks.useLighterAccountSetup.mockReturnValue({
    environment,
    setEnvironment: vi.fn(),
    amountIn: "",
    setAmountIn: vi.fn(),
    status: readyStatus(environment),
    statusError: null,
    statusLoading: false,
    phase: "idle",
    error: null,
    needsDeposit: false,
    canStart: true,
    start: vi.fn(),
    retry: vi.fn(),
  });
  const onDone = vi.fn();
  const onOpenChange = vi.fn();
  const onCancel = vi.fn();
  render(
    <LighterAccountSetupModal
      open
      onOpenChange={onOpenChange}
      sessionId="11111111-1111-4111-8111-111111111111"
      environment={environment}
      onDone={onDone}
      onCancel={onCancel}
    />,
  );
  const dialog = screen.getByRole("dialog");
  expect(dialog.classList.contains("lit-environment-dialog")).toBe(true);
  expect(dialog.getAttribute("data-lighter-environment")).toBe(environment);
  return { onDone, onOpenChange, onCancel };
}

describe("LighterAccountSetupModal ready action", () => {
  it.each([
    ["rhc", "Start Trading on Lighter RHC"],
    ["core", "Start Trading on Lighter Core"],
  ] as const)("enters the ready %s environment immediately", async (environment, label) => {
    const { onDone, onOpenChange } = renderReady(environment);
    const button = screen.getByRole("button", { name: label });

    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);

    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledWith(environment);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  /**
   * Ethereum behind Core, the Robinhood feather behind RHC - the same pairing
   * the desk's environment switch makes, from the same source, so the two
   * surfaces cannot drift onto different files. Decorative: the network is
   * already written above the mark, so announcing it twice would be noise.
   */
  it.each([
    ["core", "./logo/ethereum.svg"],
    ["rhc", "./logo/robinhood.svg"],
  ] as const)("marks the %s button with its own network logo", (environment, src) => {
    renderReady(environment);
    // Scoped to the toggle: "Core" also names the ready-state action button.
    const toggle = within(screen.getByRole("group", { name: "Environment" }));
    const button = toggle.getByRole("button", {
      name: environment === "core" ? /Core/ : /Robinhood Chain/,
    });
    const logo = button.querySelector("img.lit-setup-env-logo");

    expect(logo?.getAttribute("src")).toBe(src);
    expect(logo?.getAttribute("aria-hidden")).toBe("true");
    expect(logo?.getAttribute("alt")).toBe("");
  });

  it("ignores backdrop and Escape and closes only from Cancel", async () => {
    const { onOpenChange, onCancel } = renderReady("core");
    const dialog = screen.getByRole("dialog");

    fireEvent.click(dialog);
    fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("stays open when the deliberate cancellation is not acknowledged", async () => {
    const rendered = renderReady("rhc");
    rendered.onCancel.mockResolvedValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not cancel this setup request",
    );
    expect(rendered.onOpenChange).not.toHaveBeenCalled();
  });
});
