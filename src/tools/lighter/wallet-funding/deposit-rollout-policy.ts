/**
 * Privileged rollout controls for production Lighter deposits.
 *
 * The tool/renderer cannot open this boundary. Electron main installs the
 * environment-backed reader; without it (or with any malformed value) deposits
 * fail closed before provider preflight, wallet-key resolution, or signing.
 */

import { getAddress } from "viem";

export const LIGHTER_DEPOSIT_ROLLOUT_ENV = {
  policy: "VEX_LIGHTER_DEPOSIT_ROLLOUT_POLICY",
  killSwitch: "VEX_LIGHTER_DEPOSIT_KILL_SWITCH",
  walletAllowlist: "VEX_LIGHTER_DEPOSIT_WALLET_ALLOWLIST",
  perDepositCapUsdc: "VEX_LIGHTER_DEPOSIT_MAX_USDC",
  rolling24hCapUsdc: "VEX_LIGHTER_DEPOSIT_ROLLING_24H_MAX_USDC",
} as const;

export const LIGHTER_DEPOSIT_ROLLOUT_ENABLE_VALUE = "allowlisted-v1";
export const LIGHTER_DEPOSIT_KILL_SWITCH_CLEAR_VALUE = "clear-v1";
const USDC_DECIMALS = 6;
const MAX_CONFIGURED_USDC = 1_000_000n;

export interface LighterDepositRolloutDecision {
  readonly allowed: boolean;
  readonly source: "default_closed" | "privileged_runtime";
  readonly reason: string;
  readonly perDepositCapUnits: string | null;
  readonly rolling24hCapUnits: string | null;
}

export interface LighterDepositRolloutInput {
  readonly walletAddress: string;
  readonly amountUnits: string;
}

export type LighterDepositRolloutPolicyReader = (
  input: LighterDepositRolloutInput,
) => LighterDepositRolloutDecision;

const DEFAULT_CLOSED: LighterDepositRolloutDecision = {
  allowed: false,
  source: "default_closed",
  reason: "The privileged Lighter deposit rollout policy is not installed.",
  perDepositCapUnits: null,
  rolling24hCapUnits: null,
};

let configuredReader: LighterDepositRolloutPolicyReader = () => DEFAULT_CLOSED;

export function configureLighterDepositRolloutPolicy(
  reader: LighterDepositRolloutPolicyReader,
): () => void {
  configuredReader = reader;
  return () => {
    if (configuredReader === reader) configuredReader = () => DEFAULT_CLOSED;
  };
}

export function readLighterDepositRolloutDecision(
  input: LighterDepositRolloutInput,
): LighterDepositRolloutDecision {
  try {
    const decision = configuredReader(input);
    if (
      decision.allowed
      && (decision.perDepositCapUnits === null || decision.rolling24hCapUnits === null)
    ) {
      return {
        ...DEFAULT_CLOSED,
        reason: "The privileged Lighter deposit rollout policy returned incomplete limits.",
      };
    }
    return decision;
  } catch {
    return {
      ...DEFAULT_CLOSED,
      reason: "The privileged Lighter deposit rollout policy could not be read, so it failed closed.",
    };
  }
}

/** Pure privileged-runtime reader. Never include raw environment values in its result. */
export function readLighterDepositRolloutPolicyFromEnv(
  input: LighterDepositRolloutInput,
  env: Record<string, string | undefined> = process.env,
): LighterDepositRolloutDecision {
  const closed = (reason: string): LighterDepositRolloutDecision => ({
    allowed: false,
    source: "privileged_runtime",
    reason,
    perDepositCapUnits: null,
    rolling24hCapUnits: null,
  });

  if (env[LIGHTER_DEPOSIT_ROLLOUT_ENV.policy]?.trim() !== LIGHTER_DEPOSIT_ROLLOUT_ENABLE_VALUE) {
    return closed("The privileged Lighter deposit rollout policy is not enabled.");
  }
  if (
    env[LIGHTER_DEPOSIT_ROLLOUT_ENV.killSwitch]?.trim()
    !== LIGHTER_DEPOSIT_KILL_SWITCH_CLEAR_VALUE
  ) {
    return closed("The privileged Lighter deposit kill switch is engaged.");
  }

  let walletAddress: string;
  let allowlist: Set<string>;
  let perDepositCapUnits: bigint;
  let rolling24hCapUnits: bigint;
  let amountUnits: bigint;
  try {
    walletAddress = getAddress(input.walletAddress).toLowerCase();
    allowlist = new Set(
      (env[LIGHTER_DEPOSIT_ROLLOUT_ENV.walletAllowlist] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .map((value) => getAddress(value).toLowerCase()),
    );
    if (allowlist.size === 0) throw new Error("empty allowlist");
    perDepositCapUnits = usdcToUnits(
      env[LIGHTER_DEPOSIT_ROLLOUT_ENV.perDepositCapUsdc],
    );
    rolling24hCapUnits = usdcToUnits(
      env[LIGHTER_DEPOSIT_ROLLOUT_ENV.rolling24hCapUsdc],
    );
    if (rolling24hCapUnits < perDepositCapUnits) throw new Error("daily cap below per-deposit cap");
    if (!/^[1-9][0-9]*$/.test(input.amountUnits)) throw new Error("invalid amount");
    amountUnits = BigInt(input.amountUnits);
  } catch {
    return closed("The privileged Lighter deposit rollout policy is malformed.");
  }

  const limits = {
    perDepositCapUnits: perDepositCapUnits.toString(),
    rolling24hCapUnits: rolling24hCapUnits.toString(),
  };
  if (!allowlist.has(walletAddress)) {
    return {
      allowed: false,
      source: "privileged_runtime",
      reason: "This wallet is not in the current internal Lighter deposit rollout.",
      ...limits,
    };
  }
  if (amountUnits > perDepositCapUnits) {
    return {
      allowed: false,
      source: "privileged_runtime",
      reason: "This deposit exceeds the current per-deposit rollout cap.",
      ...limits,
    };
  }
  return {
    allowed: true,
    source: "privileged_runtime",
    reason: "The wallet and amount satisfy the current internal Lighter deposit rollout policy.",
    ...limits,
  };
}

function usdcToUnits(value: string | undefined): bigint {
  const normalized = value?.trim() ?? "";
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(normalized);
  if (match === null) throw new Error("invalid USDC cap");
  const whole = BigInt(match[1]!);
  const fraction = (match[2] ?? "").padEnd(USDC_DECIMALS, "0");
  const units = whole * 10n ** BigInt(USDC_DECIMALS) + BigInt(fraction || "0");
  if (units <= 0n || units > MAX_CONFIGURED_USDC * 10n ** BigInt(USDC_DECIMALS)) {
    throw new Error("USDC cap outside supported range");
  }
  return units;
}
