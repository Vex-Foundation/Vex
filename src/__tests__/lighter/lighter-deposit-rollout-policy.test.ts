import { afterEach, describe, expect, it } from "vitest";

import {
  LIGHTER_DEPOSIT_KILL_SWITCH_CLEAR_VALUE,
  LIGHTER_DEPOSIT_ROLLOUT_ENABLE_VALUE,
  LIGHTER_DEPOSIT_ROLLOUT_ENV,
  configureLighterDepositRolloutPolicy,
  readLighterDepositRolloutDecision,
  readLighterDepositRolloutPolicyFromEnv,
} from "@tools/lighter/wallet-funding/deposit-rollout-policy.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const OTHER_WALLET = "0x0000000000000000000000000000000000000001";

function openEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    [LIGHTER_DEPOSIT_ROLLOUT_ENV.policy]: LIGHTER_DEPOSIT_ROLLOUT_ENABLE_VALUE,
    [LIGHTER_DEPOSIT_ROLLOUT_ENV.killSwitch]: LIGHTER_DEPOSIT_KILL_SWITCH_CLEAR_VALUE,
    [LIGHTER_DEPOSIT_ROLLOUT_ENV.walletAllowlist]: WALLET,
    [LIGHTER_DEPOSIT_ROLLOUT_ENV.perDepositCapUsdc]: "2.5",
    [LIGHTER_DEPOSIT_ROLLOUT_ENV.rolling24hCapUsdc]: "5",
    ...overrides,
  };
}

afterEach(() => {
  const uninstall = configureLighterDepositRolloutPolicy(() => ({
    allowed: false,
    source: "default_closed",
    reason: "reset",
    perDepositCapUnits: null,
    rolling24hCapUnits: null,
  }));
  uninstall();
});

describe("Lighter deposit rollout policy", () => {
  it("fails closed when no privileged reader is installed", () => {
    expect(readLighterDepositRolloutDecision({
      walletAddress: WALLET,
      amountUnits: "1000000",
    })).toMatchObject({ allowed: false, source: "default_closed" });
  });

  it("allows only an allowlisted wallet under both configured caps", () => {
    expect(readLighterDepositRolloutPolicyFromEnv(
      { walletAddress: WALLET, amountUnits: "2500000" },
      openEnv(),
    )).toEqual({
      allowed: true,
      source: "privileged_runtime",
      reason: "The wallet and amount satisfy the current internal Lighter deposit rollout policy.",
      perDepositCapUnits: "2500000",
      rolling24hCapUnits: "5000000",
    });
  });

  it("treats a missing or non-clear kill switch as engaged", () => {
    const decision = readLighterDepositRolloutPolicyFromEnv(
      { walletAddress: WALLET, amountUnits: "1000000" },
      openEnv({ [LIGHTER_DEPOSIT_ROLLOUT_ENV.killSwitch]: "engaged" }),
    );
    expect(decision).toMatchObject({ allowed: false });
    expect(decision.reason).toContain("kill switch is engaged");
  });

  it("refuses a wallet outside the allowlist without exposing the configured list", () => {
    const decision = readLighterDepositRolloutPolicyFromEnv(
      { walletAddress: OTHER_WALLET, amountUnits: "1000000" },
      openEnv(),
    );
    expect(decision).toMatchObject({ allowed: false });
    expect(JSON.stringify(decision)).not.toContain(WALLET);
  });

  it("refuses a deposit above the per-deposit cap", () => {
    const decision = readLighterDepositRolloutPolicyFromEnv(
      { walletAddress: WALLET, amountUnits: "2500001" },
      openEnv(),
    );
    expect(decision).toMatchObject({
      allowed: false,
      perDepositCapUnits: "2500000",
      rolling24hCapUnits: "5000000",
    });
    expect(decision.reason).toContain("per-deposit rollout cap");
  });

  it("fails closed on malformed addresses, amounts, or cap relationships", () => {
    const malformed = [
      openEnv({ [LIGHTER_DEPOSIT_ROLLOUT_ENV.walletAllowlist]: "not-an-address" }),
      openEnv({ [LIGHTER_DEPOSIT_ROLLOUT_ENV.perDepositCapUsdc]: "1.0000001" }),
      openEnv({ [LIGHTER_DEPOSIT_ROLLOUT_ENV.rolling24hCapUsdc]: "1" }),
    ];
    for (const env of malformed) {
      expect(readLighterDepositRolloutPolicyFromEnv(
        { walletAddress: WALLET, amountUnits: "2000000" },
        env,
      )).toMatchObject({ allowed: false, perDepositCapUnits: null, rolling24hCapUnits: null });
    }
  });

  it("fails closed if an installed reader claims allow without complete limits", () => {
    const uninstall = configureLighterDepositRolloutPolicy(() => ({
      allowed: true,
      source: "privileged_runtime",
      reason: "bad reader",
      perDepositCapUnits: null,
      rolling24hCapUnits: null,
    }));
    expect(readLighterDepositRolloutDecision({
      walletAddress: WALLET,
      amountUnits: "1000000",
    })).toMatchObject({ allowed: false, source: "default_closed" });
    uninstall();
  });
});
