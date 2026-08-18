/**
 * Privileged main-process installer for the Lighter onboarding release gates.
 *
 * Each fund-moving onboarding capability has its own default-closed gate. Only
 * the main process installs the env-based reader, so no chat/tool/renderer
 * argument can open a gate. The deposit gate opens only when
 * VEX_LIGHTER_DEPOSIT_RELEASE_GATE holds the exact enable value
 * (wallet-funded-deposit-v1); anything else fails closed.
 *
 * Deposit execution also requires the independent rollout policy:
 * VEX_LIGHTER_DEPOSIT_ROLLOUT_POLICY=allowlisted-v1,
 * VEX_LIGHTER_DEPOSIT_KILL_SWITCH=clear-v1, a valid wallet allowlist, and
 * valid per-deposit and rolling-24-hour USDC caps. Opening the release gate
 * alone never opens the rollout policy.
 *
 * Key registration has its own independently installed exact-value gate. Swap
 * and withdrawal remain uninstalled, default-closed, and unopenable.
 */

import {
  LIGHTER_DEPOSIT_RELEASE_GATE,
  LIGHTER_KEY_REGISTRATION_RELEASE_GATE,
  readLighterOnboardingGateStatus,
} from "@tools/lighter/wallet-funding/release-gates.js";
import {
  configureLighterDepositRolloutPolicy,
  readLighterDepositRolloutPolicyFromEnv,
} from "@tools/lighter/wallet-funding/deposit-rollout-policy.js";

export function installLighterOnboardingReleaseGates(): () => void {
  const uninstallDeposit = LIGHTER_DEPOSIT_RELEASE_GATE.configure(() =>
    readLighterOnboardingGateStatus("deposit"),
  );
  const uninstallKeyRegistration = LIGHTER_KEY_REGISTRATION_RELEASE_GATE.configure(() =>
    readLighterOnboardingGateStatus("key_registration"),
  );
  const uninstallDepositRollout = configureLighterDepositRolloutPolicy((input) =>
    readLighterDepositRolloutPolicyFromEnv(input),
  );
  return () => {
    uninstallDepositRollout();
    uninstallKeyRegistration();
    uninstallDeposit();
  };
}
