/**
 * Privileged main-process installer for the Lighter onboarding release gates.
 *
 * Each fund-moving onboarding capability has its own default-closed gate. Only
 * the main process installs the env-based reader, so no chat/tool/renderer
 * argument can open a gate. The deposit gate opens only when
 * VEX_LIGHTER_DEPOSIT_RELEASE_GATE holds the exact enable value
 * (wallet-funded-deposit-v1); anything else fails closed.
 *
 * Key registration, swap, and withdrawal gates are intentionally NOT installed
 * yet — their executors are not built, so they stay default-closed and unopenable.
 */

import {
  LIGHTER_DEPOSIT_RELEASE_GATE,
  readLighterOnboardingGateStatus,
} from "@tools/lighter/wallet-funding/release-gates.js";

export function installLighterOnboardingReleaseGates(): () => void {
  const uninstallDeposit = LIGHTER_DEPOSIT_RELEASE_GATE.configure(() =>
    readLighterOnboardingGateStatus("deposit"),
  );
  return () => {
    uninstallDeposit();
  };
}
