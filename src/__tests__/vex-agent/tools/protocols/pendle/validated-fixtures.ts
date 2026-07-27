import {
  validateAssets,
  validateClaim,
  validateConvert,
} from "@tools/pendle/validation.js";
import type {
  PendleAsset,
  PendleClaimResponse,
  PendleConvertResponse,
} from "@tools/pendle/types.js";

/**
 * Validate captured wire data through the production boundary before a test
 * mutates it. The clone keeps the normalized result isolated per test.
 */
export function mutableConvertFixture(raw: unknown): PendleConvertResponse {
  const response = validateConvert(raw);
  if (response === null) {
    throw new Error("Pendle convert fixture did not pass production validation");
  }
  return structuredClone(response);
}

/** Validate and isolate a captured Pendle claim response for mutation tests. */
export function mutableClaimFixture(raw: unknown): PendleClaimResponse {
  const response = validateClaim(raw);
  if (response === null) {
    throw new Error("Pendle claim fixture did not pass production validation");
  }
  return structuredClone(response);
}

/**
 * Validate a captured `/v1/{chainId}/assets/all` body through the production
 * boundary. Asserts the fixture is NON-EMPTY: a fixture that only encodes the
 * empty collection proves nothing (rule 90, "Verification Discipline").
 */
export function validatedAssetsFixture(raw: unknown): PendleAsset[] {
  const assets = validateAssets(raw);
  if (assets.length === 0) {
    throw new Error("Pendle asset fixture is empty — capture a non-empty response");
  }
  return structuredClone(assets);
}

/**
 * Pick one row out of a validated catalogue. Fails loudly when a re-capture drops
 * the row a test depends on, instead of asserting through a non-null assertion.
 */
export function requireAsset(
  assets: readonly PendleAsset[],
  describeRow: string,
  match: (asset: PendleAsset) => boolean,
): PendleAsset {
  const found = assets.find(match);
  if (found === undefined) {
    throw new Error(`Pendle asset fixture no longer contains ${describeRow}`);
  }
  return found;
}
