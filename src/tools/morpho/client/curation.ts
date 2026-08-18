/**
 * The CURATION answer, validated strictly and BOUND TO THE MARKET IT IS ABOUT.
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
 *
 * ── WHY THE IDENTITY IS RE-CHECKED RATHER THAN ASSUMED ──────────────────────
 *
 * `listed: true` is a statement ABOUT A MARKET, and it authorizes funds only for
 * THAT market. An earlier revision took the flag on its own and substituted the
 * requested id when the answer did not carry one, so any response describing
 * some OTHER curated market - misrouted, replayed from a cache, or returned by a
 * compromised endpoint - would have authorized the market that was asked about.
 * The flag was read strictly while the subject of the sentence was not read at
 * all.
 *
 * The answer must therefore name the market that was asked about. A MISSING id
 * is a refusal, not a licence to fill in the expected one: a validator that
 * supplies the value it is meant to be checking is not checking anything. The
 * chain is bound the same way when the answer carries it, which it does today -
 * `chain { id }` is requested by {@link MORPHO_MARKET_CURATION_QUERY} - because
 * a market id is chain-scoped and the same id on two chains is two markets.
 */

import { VexError, ErrorCodes } from "../../../errors.js";
import { isRecord } from "../../../utils/validation-helpers.js";

export interface MorphoMarketCuration {
  readonly marketId: string;
  readonly chainId: number | null;
  /** Morpho's own statement that it curates this market. */
  readonly listed: boolean;
}

export interface MorphoCurationSubject {
  readonly marketId: string;
  readonly chainId: number;
}

const IDENTITY_HINT =
  "Nothing was signed or sent. Vex will not let a curation answer about one market authorize another, so this is a "
  + "refusal rather than a retryable failure. Report it if it persists: it means Morpho's API answered a different "
  + "question than the one that was asked.";

function identityViolation(message: string): never {
  throw new VexError(ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION, message, IDENTITY_HINT);
}

/**
 * Pull `{ marketId, chainId, listed }` out of the GraphQL envelope, refusing any
 * answer that is not about the market that was asked about.
 *
 * @throws {VexError} `MORPHO_INVALID_RESPONSE` when `listed` is not a boolean,
 * `MORPHO_MARKET_POLICY_VIOLATION` when the answer carries no market identity or
 * carries a different one. The caller maps a missing `marketById` to its own
 * not-found refusal.
 */
export function validateMorphoMarketCuration(
  body: unknown,
  subject: MorphoCurationSubject,
): MorphoMarketCuration | null {
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

  const requestedMarketId = subject.marketId.trim().toLowerCase();
  const returnedMarketId = isRecord(raw) && typeof raw["marketId"] === "string"
    ? raw["marketId"].trim().toLowerCase()
    : null;
  if (returnedMarketId === null) {
    identityViolation(
      `Refusing the market: FAILING PREDICATE "curation-identity". Morpho's curation answer for market `
      + `${requestedMarketId} on chain ${subject.chainId} carries no market id of its own, so there is nothing to `
      + "prove the `listed` flag it returned describes the market Vex asked about rather than some other curated one.",
    );
  }
  if (returnedMarketId !== requestedMarketId) {
    identityViolation(
      `Refusing the market: FAILING PREDICATE "curation-identity". Vex asked Morpho whether it curates market `
      + `${requestedMarketId} on chain ${subject.chainId}, and the answer describes market ${returnedMarketId} `
      + "instead. A `listed` flag vouches for the market it names and for no other.",
    );
  }

  // THE CHAIN IS BOUND WHEN THE ANSWER CARRIES IT. The query asks for it, so
  // today it is always present; an absence is treated as a schema change rather
  // than a refusal, because the market-id binding above is the primary proof and
  // failing shut on a field Morpho stopped sending would close the money path
  // over a display-shaped change.
  const chain = isRecord(raw) ? raw["chain"] : undefined;
  const returnedChainId = isRecord(chain) && typeof chain["id"] === "number" ? chain["id"] : null;
  if (returnedChainId !== null && returnedChainId !== subject.chainId) {
    identityViolation(
      `Refusing the market: FAILING PREDICATE "curation-identity". Vex asked about market ${requestedMarketId} on `
      + `chain ${subject.chainId}, and Morpho's curation answer is about chain ${returnedChainId}. A market id is `
      + "chain-scoped, so the same id on another chain is a different market with different collateral and a "
      + "different oracle.",
    );
  }

  return { marketId: returnedMarketId, chainId: returnedChainId, listed };
}
