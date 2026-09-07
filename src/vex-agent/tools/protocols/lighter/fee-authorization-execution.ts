import type { LighterEnvironment } from "@tools/lighter/constants.js";
import type { WalletResolution } from "@tools/wallet/multi-auth.js";
import type { WalletPolicy } from "@vex-agent/engine/types.js";
import type { LighterFeeAuthorizationIntentRow } from "@vex-agent/db/repos/lighter-fee-authorization-intents.js";

export interface LighterFeeAuthorizationSetupInput {
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly walletResolution: WalletResolution;
  readonly walletPolicy: WalletPolicy;
}
export interface LighterFeeAuthorizationExecutionInput extends Omit<
  LighterFeeAuthorizationSetupInput,
  "environment"
> {
  readonly intentId: string;
  readonly abortSignal?: AbortSignal;
}
export interface LighterFeeAuthorizationReadiness {
  readonly status: "disabled" | "ready" | "needs_approval" | "blocked";
  readonly reason: string;
  readonly accountIndex: number | null;
}
export interface LighterFeeAuthorizationResult {
  readonly source: "vex_lighter_fee_authorization";
  readonly status: "active" | "revoked" | "pending_verification" | "failed";
  readonly intentId: string;
  readonly executionState: string;
  readonly txHash: string | null;
  readonly message: string;
}
export interface LighterFeeAuthorizationService {
  inspect(
    input: LighterFeeAuthorizationSetupInput,
  ): Promise<LighterFeeAuthorizationReadiness>;
  prepare(
    input: LighterFeeAuthorizationSetupInput & { readonly revoke?: boolean },
  ): Promise<LighterFeeAuthorizationIntentRow>;
  execute(
    input: LighterFeeAuthorizationExecutionInput,
  ): Promise<LighterFeeAuthorizationResult>;
  /** Provider-state reconciliation only; never signs, changes tiers, or submits. */
  reconcile(
    input: LighterFeeAuthorizationExecutionInput,
  ): Promise<LighterFeeAuthorizationResult>;
}
let configuredService: LighterFeeAuthorizationService | null = null;
export function configureLighterFeeAuthorizationService(
  service: LighterFeeAuthorizationService,
): () => void {
  configuredService = service;
  return () => {
    if (configuredService === service) configuredService = null;
  };
}
export function getConfiguredLighterFeeAuthorizationService(): LighterFeeAuthorizationService | null {
  return configuredService;
}
