import type { LighterEnvironment } from "@tools/lighter/constants.js";

export type LighterManagedTradingReadinessReason =
  | "ready"
  | "privileged_resolver_unavailable"
  | "active_managed_credential_missing"
  | "durable_activation_missing"
  | "live_key_mismatch"
  | "client_check_failed"
  | "nonce_not_synchronized"
  | "nonce_not_reservable"
  | "verification_unavailable";

export interface LighterManagedTradingReadiness {
  readonly ready: boolean;
  readonly reason: LighterManagedTradingReadinessReason;
  readonly activeManagedCredential: boolean;
  readonly durableActivation: boolean;
  readonly exactPublicKeyMatch: boolean;
  readonly clientCheckPassed: boolean;
  readonly nonceSynchronized: boolean;
  readonly nonceReservable: boolean;
}

export interface LighterManagedTradingReadinessResolver {
  readonly read: (
    environment: LighterEnvironment,
    accountIndex: number,
  ) => Promise<LighterManagedTradingReadiness>;
}

const UNAVAILABLE: LighterManagedTradingReadiness = {
  ready: false,
  reason: "privileged_resolver_unavailable",
  activeManagedCredential: false,
  durableActivation: false,
  exactPublicKeyMatch: false,
  clientCheckPassed: false,
  nonceSynchronized: false,
  nonceReservable: false,
};

let configuredResolver: LighterManagedTradingReadinessResolver | null = null;

export function configureLighterManagedTradingReadinessResolver(
  resolver: LighterManagedTradingReadinessResolver | null,
): () => void {
  configuredResolver = resolver;
  return () => {
    if (configuredResolver === resolver) configuredResolver = null;
  };
}

export async function readLighterManagedTradingReadiness(
  environment: LighterEnvironment,
  accountIndex: number,
): Promise<LighterManagedTradingReadiness> {
  return configuredResolver === null
    ? UNAVAILABLE
    : configuredResolver.read(environment, accountIndex);
}
