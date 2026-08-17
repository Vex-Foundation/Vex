import type { LighterEnvironment } from "@tools/lighter/types.js";

export interface PreparedLighterRegistrationCredentialMetadata {
  readonly intentId: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly vaultCredentialId: string;
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
  readonly outcome: "generated" | "recovered_pending" | "already_persisted";
}

export interface LighterKeyRegistrationCredentialPreparer {
  prepare(input: {
    readonly sessionId: string;
    readonly intentId: string;
  }): Promise<PreparedLighterRegistrationCredentialMetadata>;
}

let configuredPreparer: LighterKeyRegistrationCredentialPreparer | null = null;

/**
 * Main-process-only injection point. The agent layer receives structural public
 * metadata and never receives the generated API private key or vault password.
 */
export function configureLighterKeyRegistrationCredentialPreparer(
  preparer: LighterKeyRegistrationCredentialPreparer,
): () => void {
  configuredPreparer = preparer;
  return () => {
    if (configuredPreparer === preparer) configuredPreparer = null;
  };
}

export function getConfiguredLighterKeyRegistrationCredentialPreparer():
  LighterKeyRegistrationCredentialPreparer | null {
  return configuredPreparer;
}
