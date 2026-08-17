import type { WalletResolution } from "@tools/wallet/multi-auth.js";
import type { WalletPolicy } from "@vex-agent/engine/types.js";

export type LighterKeyRegistrationExecutionStatus =
  | "active"
  | "submitted_pending_verification"
  | "ambiguity_unresolved"
  | "registered_key_conflict"
  | "key_verified_pending_nonce";

export interface LighterKeyRegistrationExecutionResult {
  readonly source: "vex_lighter_key_registration";
  readonly status: LighterKeyRegistrationExecutionStatus;
  readonly intentId: string;
  readonly executionState: string;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly txHash: string | null;
  readonly postRegistrationNonce: string | null;
  readonly message: string;
}

export interface LighterKeyRegistrationExecutor {
  execute(input: {
    readonly sessionId: string;
    readonly intentId: string;
    readonly walletResolution: WalletResolution;
    readonly walletPolicy: WalletPolicy;
    readonly abortSignal?: AbortSignal;
  }): Promise<LighterKeyRegistrationExecutionResult>;
}

let configuredExecutor: LighterKeyRegistrationExecutor | null = null;

/**
 * Main-process-only injection point. The agent layer supplies public wallet
 * selection policy and receives public lifecycle evidence only. It never
 * receives wallet keys, the Lighter private key, signatures, or txInfo.
 */
export function configureLighterKeyRegistrationExecutor(
  executor: LighterKeyRegistrationExecutor,
): () => void {
  configuredExecutor = executor;
  return () => {
    if (configuredExecutor === executor) configuredExecutor = null;
  };
}

export function getConfiguredLighterKeyRegistrationExecutor():
  LighterKeyRegistrationExecutor | null {
  return configuredExecutor;
}
