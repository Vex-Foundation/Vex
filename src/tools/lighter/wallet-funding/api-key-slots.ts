import { createHash } from "node:crypto";

import { ErrorCodes, VexError } from "../../../errors.js";
import {
  LIGHTER_API_KEY_INDEX_ALL,
  type LighterEnvironment,
} from "../constants.js";
import {
  LIGHTER_TRADING_API_KEY_INDEX_MAX,
  LIGHTER_TRADING_API_KEY_INDEX_MIN,
} from "../trading-credentials.js";
import type { LighterApiKeysResponse } from "../types.js";

const LIGHTER_PUBLIC_KEY_HEX_PATTERN = /^(?:0x)?[0-9a-fA-F]{80}$/;

export interface LighterApiKeySlotReader {
  getApiKeys(
    environment: LighterEnvironment,
    params: { readonly accountIndex: number; readonly apiKeyIndex: number },
  ): Promise<LighterApiKeysResponse>;
}

/** Public provider evidence used to reserve one local trading-key slot. */
export interface LighterApiKeySlotObservation {
  readonly accountIndex: number;
  readonly occupiedApiKeyIndexes: readonly number[];
  readonly observationHash: string;
  readonly observedAt: Date;
}

/**
 * Fetch the all-slots sentinel explicitly. A single-slot response is never
 * sufficient evidence that another trading-key index is free.
 */
export async function readLighterApiKeySlotObservation(input: {
  readonly client: LighterApiKeySlotReader;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly observedAt?: Date;
}): Promise<LighterApiKeySlotObservation> {
  assertAccountIndex(input.accountIndex);
  const response = await input.client.getApiKeys(input.environment, {
    accountIndex: input.accountIndex,
    apiKeyIndex: LIGHTER_API_KEY_INDEX_ALL,
  });
  return inspectLighterApiKeySlots(
    response,
    input.accountIndex,
    input.observedAt ?? new Date(),
  );
}

/**
 * Validate and canonicalize a full public API-key response. Every returned row
 * is treated as occupied; a zero-looking nonce or an unfamiliar public key is
 * never interpreted as an empty slot.
 */
export function inspectLighterApiKeySlots(
  response: LighterApiKeysResponse,
  expectedAccountIndex: number,
  observedAt: Date,
): LighterApiKeySlotObservation {
  assertAccountIndex(expectedAccountIndex);
  if (response.code !== 200) {
    throw invalidResponse("Lighter API-key slot inspection did not return code 200.");
  }
  if (!Number.isFinite(observedAt.getTime())) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Lighter API-key slot observation requires a valid timestamp.",
    );
  }

  const publicKeysByIndex = new Map<number, string>();
  for (const apiKey of response.api_keys) {
    if (apiKey.account_index !== expectedAccountIndex) {
      throw invalidResponse(
        "Lighter API-key slot response included a different account index.",
      );
    }
    if (
      !Number.isInteger(apiKey.api_key_index)
      || apiKey.api_key_index < 0
      || apiKey.api_key_index >= LIGHTER_API_KEY_INDEX_ALL
    ) {
      throw invalidResponse("Lighter API-key slot response included an invalid key index.");
    }
    if (publicKeysByIndex.has(apiKey.api_key_index)) {
      throw invalidResponse("Lighter API-key slot response included a duplicate key index.");
    }
    publicKeysByIndex.set(apiKey.api_key_index, normalizePublicKey(apiKey.public_key));
  }

  const occupiedApiKeyIndexes = [...publicKeysByIndex.keys()].sort((a, b) => a - b);
  const canonicalRows = occupiedApiKeyIndexes.map(
    (apiKeyIndex) => `${apiKeyIndex}:${publicKeysByIndex.get(apiKeyIndex)}`,
  );
  const observationHash = createHash("sha256")
    .update(`lighter-api-key-slots-v1|${expectedAccountIndex}|${canonicalRows.join(",")}`)
    .digest("hex");

  return {
    accountIndex: expectedAccountIndex,
    occupiedApiKeyIndexes,
    observationHash,
    observedAt,
  };
}

/** Select the lowest conservatively usable slot after provider and DB evidence. */
export function selectAvailableLighterApiKeyIndex(
  observation: LighterApiKeySlotObservation,
  locallyReservedApiKeyIndexes: readonly number[],
): number {
  assertAccountIndex(observation.accountIndex);
  const unavailable = new Set(observation.occupiedApiKeyIndexes);
  for (const apiKeyIndex of locallyReservedApiKeyIndexes) {
    if (
      !Number.isInteger(apiKeyIndex)
      || apiKeyIndex < LIGHTER_TRADING_API_KEY_INDEX_MIN
      || apiKeyIndex > LIGHTER_TRADING_API_KEY_INDEX_MAX
    ) {
      throw new VexError(
        ErrorCodes.LIGHTER_INVALID_RESPONSE,
        "Local Lighter API-key reservation state contains an invalid trading-key index.",
      );
    }
    unavailable.add(apiKeyIndex);
  }

  for (
    let apiKeyIndex = LIGHTER_TRADING_API_KEY_INDEX_MIN;
    apiKeyIndex <= LIGHTER_TRADING_API_KEY_INDEX_MAX;
    apiKeyIndex += 1
  ) {
    if (!unavailable.has(apiKeyIndex)) return apiKeyIndex;
  }

  throw new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    "No unused Lighter trading API-key slot is available from 4 to 254.",
    "Remove or rotate an existing key deliberately before retrying registration.",
  );
}

function normalizePublicKey(value: string): string {
  if (value !== value.trim() || !LIGHTER_PUBLIC_KEY_HEX_PATTERN.test(value)) {
    throw invalidResponse(
      "Lighter API-key slot response included a malformed 40-byte public key.",
    );
  }
  return value.toLowerCase().replace(/^0x/, "");
}

function assertAccountIndex(accountIndex: number): void {
  if (!Number.isSafeInteger(accountIndex) || accountIndex <= 0) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Lighter API-key slot inspection requires a positive safe account index.",
    );
  }
}

function invalidResponse(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_RESPONSE,
    message,
    "Treat the slot as unavailable and retry only after a fresh full account-key read.",
  );
}
