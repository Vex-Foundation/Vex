import {
  validateClaim,
  validateConvert,
} from "@tools/pendle/validation.js";
import type {
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
