import { describe, expect, it, vi } from "vitest";

import {
  resolveLighterOnboardingChecklist,
  type LighterOnboardingChecklistDeps,
} from "../onboarding-checklist.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const SESSION = "11111111-1111-4111-8111-111111111111";

function deps(overrides: Partial<LighterOnboardingChecklistDeps> = {}): LighterOnboardingChecklistDeps {
  return {
    readSessionWallet: vi.fn().mockResolvedValue({
      walletAddress: WALLET,
      walletResolution: { source: "session", evm: { id: "w1", address: WALLET }, solana: null },
      walletPolicy: { kind: "none" },
    }),
    readLighterAccount: vi.fn().mockResolvedValue({ account_index: 42 }),
    hasTradingKey: vi.fn().mockReturnValue(false),
    inspectFee: vi.fn().mockResolvedValue({ status: "needs_approval", reason: "", accountIndex: 42 }),
    ...overrides,
  };
}

describe("resolveLighterOnboardingChecklist", () => {
  it("marks every step todo when the wallet owns no Lighter account, without a fee read", async () => {
    const d = deps({ readLighterAccount: vi.fn().mockResolvedValue(null) });
    await expect(resolveLighterOnboardingChecklist({ sessionId: SESSION, environment: "rhc" }, d))
      .resolves.toEqual({ deposit: "todo", key: "todo", fee: "todo" });
    expect(d.readLighterAccount).toHaveBeenCalledWith("rhc", WALLET);
    expect(d.inspectFee).not.toHaveBeenCalled();
  });

  it("reads the key from the vault scope for the account and the fee from the inspection", async () => {
    const d = deps({
      hasTradingKey: vi.fn().mockReturnValue(true),
      inspectFee: vi.fn().mockResolvedValue({ status: "ready", reason: "", accountIndex: 42 }),
    });
    await expect(resolveLighterOnboardingChecklist({ sessionId: SESSION, environment: "core" }, d))
      .resolves.toEqual({ deposit: "done", key: "done", fee: "done" });
    expect(d.hasTradingKey).toHaveBeenCalledWith("core", 42);
    expect(d.inspectFee).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION,
      environment: "core",
      walletPolicy: { kind: "none" },
    }));
  });

  it("reports a disabled fee policy as not required and anything else as todo", async () => {
    await expect(resolveLighterOnboardingChecklist(
      { sessionId: SESSION, environment: "core" },
      deps({ inspectFee: vi.fn().mockResolvedValue({ status: "disabled", reason: "", accountIndex: null }) }),
    )).resolves.toEqual({ deposit: "done", key: "todo", fee: "not_required" });
    await expect(resolveLighterOnboardingChecklist(
      { sessionId: SESSION, environment: "core" },
      deps({ inspectFee: vi.fn().mockResolvedValue({ status: "blocked", reason: "", accountIndex: 42 }) }),
    )).resolves.toEqual({ deposit: "done", key: "todo", fee: "todo" });
  });
});
