/**
 * Per-capability default-closed release gates for Lighter wallet-funded
 * onboarding (Phase 7). One gate per fund-moving capability so enabling one
 * never enables another (see `.context/lighter_wallet_funding_plan.md` §3.2).
 *
 * Each gate mirrors the live-trading gate: a module-level status reader that is
 * default-closed and installed only by the privileged main process; it fails
 * closed if the reader throws. No chat/tool/renderer argument can open a gate.
 */

export const LIGHTER_ONBOARDING_CAPABILITIES = [
  "deposit",
  "key_registration",
  "swap",
  "withdrawal",
] as const;

export type LighterOnboardingCapability = (typeof LIGHTER_ONBOARDING_CAPABILITIES)[number];

export type LighterReleaseGateSource = "default_closed" | "privileged_runtime";

export interface LighterReleaseGateStatus {
  readonly enabled: boolean;
  readonly source: LighterReleaseGateSource;
  readonly reason: string;
}

export interface LighterReleaseGate {
  readonly capability: LighterOnboardingCapability;
  /** Install a privileged status reader; returns an uninstaller. */
  configure(readStatus: () => LighterReleaseGateStatus): () => void;
  getStatus(): LighterReleaseGateStatus;
  isEnabled(): boolean;
}

function createLighterReleaseGate(capability: LighterOnboardingCapability): LighterReleaseGate {
  const closed: LighterReleaseGateStatus = {
    enabled: false,
    source: "default_closed",
    reason: `Lighter ${capability} is closed by default.`,
  };
  let reader = (): LighterReleaseGateStatus => closed;

  return {
    capability,
    configure(readStatus) {
      reader = readStatus;
      return () => {
        if (reader === readStatus) reader = () => closed;
      };
    },
    getStatus() {
      try {
        return reader();
      } catch {
        return {
          enabled: false,
          source: "default_closed",
          reason: `Lighter ${capability} release-gate status could not be read, so it failed closed.`,
        };
      }
    },
    isEnabled() {
      return this.getStatus().enabled;
    },
  };
}

export const LIGHTER_DEPOSIT_RELEASE_GATE = createLighterReleaseGate("deposit");
export const LIGHTER_KEY_REGISTRATION_RELEASE_GATE = createLighterReleaseGate("key_registration");
export const LIGHTER_SWAP_RELEASE_GATE = createLighterReleaseGate("swap");
export const LIGHTER_WITHDRAWAL_RELEASE_GATE = createLighterReleaseGate("withdrawal");

/** Environment keys and exact enable values for the privileged main-process readers. */
export const LIGHTER_ONBOARDING_GATE_ENV: Record<
  LighterOnboardingCapability,
  { readonly envKey: string; readonly enableValue: string }
> = {
  deposit: { envKey: "VEX_LIGHTER_DEPOSIT_RELEASE_GATE", enableValue: "wallet-funded-deposit-v1" },
  key_registration: {
    envKey: "VEX_LIGHTER_KEY_REGISTRATION_RELEASE_GATE",
    enableValue: "wallet-funded-key-registration-v1",
  },
  swap: { envKey: "VEX_LIGHTER_SWAP_RELEASE_GATE", enableValue: "wallet-funded-swap-v1" },
  withdrawal: {
    envKey: "VEX_LIGHTER_WITHDRAWAL_RELEASE_GATE",
    enableValue: "wallet-funded-withdrawal-v1",
  },
};

/**
 * Pure reader for a capability gate from an environment map, used by the
 * privileged main process to install a gate. Missing/unrecognized values fail
 * closed; only the exact enable value opens the gate.
 */
export function readLighterOnboardingGateStatus(
  capability: LighterOnboardingCapability,
  env: Record<string, string | undefined> = process.env,
): LighterReleaseGateStatus {
  const { envKey, enableValue } = LIGHTER_ONBOARDING_GATE_ENV[capability];
  const raw = env[envKey]?.trim() ?? "";
  if (raw.length === 0) {
    return {
      enabled: false,
      source: "privileged_runtime",
      reason: `The privileged Lighter ${capability} release gate is not enabled.`,
    };
  }
  if (raw === enableValue) {
    return {
      enabled: true,
      source: "privileged_runtime",
      reason: `The privileged Lighter ${capability} release gate is enabled.`,
    };
  }
  return {
    enabled: false,
    source: "privileged_runtime",
    reason: `The privileged Lighter ${capability} release gate value is not recognized.`,
  };
}
