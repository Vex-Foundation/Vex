import { afterEach, describe, expect, it } from "vitest";

import {
  LIGHTER_DEPOSIT_RELEASE_GATE,
  LIGHTER_KEY_REGISTRATION_RELEASE_GATE,
  LIGHTER_ONBOARDING_GATE_ENV,
  readLighterOnboardingGateStatus,
} from "@tools/lighter/wallet-funding/release-gates.js";

const uninstallers: Array<() => void> = [];
afterEach(() => {
  while (uninstallers.length) uninstallers.pop()!();
});

describe("Lighter onboarding release gates", () => {
  it("is closed by default", () => {
    expect(LIGHTER_DEPOSIT_RELEASE_GATE.isEnabled()).toBe(false);
    expect(LIGHTER_DEPOSIT_RELEASE_GATE.getStatus().source).toBe("default_closed");
  });

  it("opens only through an installed privileged reader", () => {
    uninstallers.push(
      LIGHTER_DEPOSIT_RELEASE_GATE.configure(() => ({
        enabled: true,
        source: "privileged_runtime",
        reason: "test open",
      })),
    );
    expect(LIGHTER_DEPOSIT_RELEASE_GATE.isEnabled()).toBe(true);
  });

  it("enabling deposit never enables another capability", () => {
    uninstallers.push(
      LIGHTER_DEPOSIT_RELEASE_GATE.configure(() => ({
        enabled: true,
        source: "privileged_runtime",
        reason: "test open",
      })),
    );
    expect(LIGHTER_DEPOSIT_RELEASE_GATE.isEnabled()).toBe(true);
    expect(LIGHTER_KEY_REGISTRATION_RELEASE_GATE.isEnabled()).toBe(false);
  });

  it("fails closed when the reader throws", () => {
    uninstallers.push(
      LIGHTER_DEPOSIT_RELEASE_GATE.configure(() => {
        throw new Error("boom");
      }),
    );
    expect(LIGHTER_DEPOSIT_RELEASE_GATE.isEnabled()).toBe(false);
  });

  it("uninstalling restores the default-closed reader", () => {
    const uninstall = LIGHTER_DEPOSIT_RELEASE_GATE.configure(() => ({
      enabled: true,
      source: "privileged_runtime",
      reason: "test open",
    }));
    expect(LIGHTER_DEPOSIT_RELEASE_GATE.isEnabled()).toBe(true);
    uninstall();
    expect(LIGHTER_DEPOSIT_RELEASE_GATE.isEnabled()).toBe(false);
  });
});

describe("readLighterOnboardingGateStatus", () => {
  it("opens only for the exact enable value", () => {
    const { envKey, enableValue } = LIGHTER_ONBOARDING_GATE_ENV.deposit;
    expect(readLighterOnboardingGateStatus("deposit", {}).enabled).toBe(false);
    expect(readLighterOnboardingGateStatus("deposit", { [envKey]: "yes" }).enabled).toBe(false);
    expect(readLighterOnboardingGateStatus("deposit", { [envKey]: enableValue }).enabled).toBe(true);
  });

  it("uses a distinct env key and value per capability", () => {
    const keys = Object.values(LIGHTER_ONBOARDING_GATE_ENV).map((g) => g.envKey);
    const values = Object.values(LIGHTER_ONBOARDING_GATE_ENV).map((g) => g.enableValue);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(values).size).toBe(values.length);
  });
});
