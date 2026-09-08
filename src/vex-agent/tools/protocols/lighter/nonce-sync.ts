import { getLighterClient, type LighterClient } from "@tools/lighter/client.js";
import type { LighterEnvironment } from "@tools/lighter/types.js";
import * as lighterNonceStateRepo from "@vex-agent/db/repos/lighter-nonce-state.js";

export interface SyncLighterPublicApiKeyNoncesInput {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex?: number;
}

export interface SyncLighterPublicApiKeyNoncesDeps {
  readonly client: Pick<LighterClient, "getApiKeys">;
  readonly nonceState: Pick<typeof lighterNonceStateRepo, "recordObserved">;
}

export interface SyncLighterPublicApiKeyNoncesResult {
  readonly environment: LighterEnvironment;
  readonly requestedAccountIndex: number;
  readonly requestedApiKeyIndex: number | null;
  readonly observedCount: number;
  readonly recordedCount: number;
}

export async function syncLighterPublicApiKeyNonces(
  input: SyncLighterPublicApiKeyNoncesInput,
  deps: SyncLighterPublicApiKeyNoncesDeps = defaultDeps(),
): Promise<SyncLighterPublicApiKeyNoncesResult> {
  const response = await deps.client.getApiKeys(input.environment, {
    accountIndex: input.accountIndex,
    ...(input.apiKeyIndex === undefined ? {} : { apiKeyIndex: input.apiKeyIndex }),
  });

  let recordedCount = 0;
  for (const apiKey of response.api_keys) {
    await deps.nonceState.recordObserved({
      environment: input.environment,
      accountIndex: apiKey.account_index,
      apiKeyIndex: apiKey.api_key_index,
      nonce: apiKey.nonce,
      publicKey: apiKey.public_key,
      transactionTime: apiKey.transaction_time,
    });
    recordedCount += 1;
  }

  return {
    environment: input.environment,
    requestedAccountIndex: input.accountIndex,
    requestedApiKeyIndex: input.apiKeyIndex ?? null,
    observedCount: response.api_keys.length,
    recordedCount,
  };
}

function defaultDeps(): SyncLighterPublicApiKeyNoncesDeps {
  return {
    client: getLighterClient(),
    nonceState: lighterNonceStateRepo,
  };
}
