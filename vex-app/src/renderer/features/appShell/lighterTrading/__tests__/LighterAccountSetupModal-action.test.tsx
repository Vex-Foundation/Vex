import { fireEvent, render, screen } from "@testing-library/react";
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
    walletSettlementBalance: "0",
    nativeGasSufficient: true,
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
  render(
    <LighterAccountSetupModal
      open
      onOpenChange={onOpenChange}
      sessionId="11111111-1111-4111-8111-111111111111"
      environment={environment}
      onDone={onDone}
    />,
  );
  return { onDone, onOpenChange };
}

describe("LighterAccountSetupModal ready action", () => {
  it.each([
    ["rhc", "Start Trading on Lighter RHC"],
    ["core", "Start Trading on Lighter Core"],
  ] as const)("enters the ready %s environment immediately", (environment, label) => {
    const { onDone, onOpenChange } = renderReady(environment);
    const button = screen.getByRole("button", { name: label });

    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);

    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledWith(environment);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
