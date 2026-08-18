/**
 * The CURATION answer, validated strictly.
 *
 * `listed` appears on several Morpho reads, and everywhere else it is a display
 * field read tolerantly - a screen that shows a null as "unknown" loses
 * nothing. Here it decides whether real funds enter a permissionless lending
 * market, and rules/90 splits the two cases explicitly: a display field a
 * provider may legitimately send as null is read tolerantly, a field a signing
 * decision consumes is read strictly.
 *
 * So an absent, null, or non-boolean `listed` is a REFUSAL, never a falsy "no"
 * and never an optimistic "yes". Reading a missing flag as `false` would look
 * safe and would in fact be wrong in the one direction that matters least,
 * while hiding a schema change behind a plausible answer.
 */

import { VexError, ErrorCodes } from "../../../errors.js";
import { isRecord } from "../../../utils/validation-helpers.js";

export interface MorphoMarketCuration {
  readonly marketId: string;
  /** Morpho's own statement that it curates this market. */
  readonly listed: boolean;
}

/**
 * Pull `{ marketId, listed }` out of the GraphQL envelope.
 *
 * @throws {VexError} `MORPHO_INVALID_RESPONSE` when `listed` is not a boolean.
 * The caller maps a missing `marketById` to its own not-found refusal.
 */
export function validateMorphoMarketCuration(body: unknown, fallbackMarketId: string): MorphoMarketCuration | null {
  const data = isRecord(body) ? body["data"] : undefined;
  const raw = isRecord(data) ? data["marketById"] : undefined;
  if (raw === null || raw === undefined) return null;

  const listed = isRecord(raw) ? raw["listed"] : undefined;
  if (typeof listed !== "boolean") {
    throw new VexError(
      ErrorCodes.MORPHO_INVALID_RESPONSE,
      "Morpho answered the market curation check without a boolean `listed` field, so whether it curates this "
      + "market is UNKNOWN rather than false.",
      "Nothing was signed or sent. Vex does not enter a Blue market it cannot confirm Morpho lists, and it does "
      + "not read a missing flag as either answer.",
    );
  }

  const marketId = isRecord(raw) && typeof raw["marketId"] === "string" ? raw["marketId"] : fallbackMarketId;
  return { marketId, listed };
}
