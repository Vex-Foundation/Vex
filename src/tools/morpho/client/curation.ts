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
 * supplies the value it is meant to be checking is not checking anything.
 *
 * ── WHY THE CHAIN IS BOUND JUST AS HARD, AND MUST BE PRESENT ────────────────
 *
 * An earlier revision bound the chain only WHEN THE ANSWER CARRIED IT, and read
 * an omission as a schema change rather than a refusal. That was a fail-open on
 * the one field that separates two different markets, because a Blue market id
 * is the hash of the FIVE MARKET PARAMETERS and the chain id is not one of them.
 * Identical parameter addresses on two chains therefore produce the IDENTICAL
 * market id, and cross-chain address reuse is ordinary rather than exotic:
 * Morpho Blue itself is deployed at the same address on Ethereum and on Base. So
 * an answer about that id on ANOTHER chain, with its `chain` field absent, would
 * have passed the market-id binding untouched and supplied the `listed: true`
 * trust root for the chain Vex was about to fund.
 *
 * The market-id binding is consequently NOT sufficient on its own, and the chain
 * is now required to be PRESENT and exactly equal. The execution query asks for
 * `chain { id }` ({@link MORPHO_MARKET_CURATION_QUERY}), the answer is consumed
 * by a signing decision, and rules/90 is explicit that such a field is read
 * strictly. An absence is UNKNOWN, and unknown on a money path is a refusal.
 */

import { VexError, ErrorCodes } from "../../../errors.js";
import { isRecord } from "../../../utils/validation-helpers.js";

export interface MorphoMarketCuration {
  readonly marketId: string;
  /** The chain the answer named. Never null: an omission is refused above. */
  readonly chainId: number;
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

  // THE CHAIN MUST BE PRESENT AND MUST MATCH. It is not a second opinion on the
  // market-id binding, it is the half of the identity that binding CANNOT prove:
  // the id is the hash of the five market parameters and the chain is not among
  // them, so the same id on another chain is a different market wearing the same
  // name. See the header for why an omission is a refusal rather than a pass.
  const chain = isRecord(raw) ? raw["chain"] : undefined;
  const returnedChainId = isRecord(chain) && typeof chain["id"] === "number" ? chain["id"] : null;
  if (returnedChainId === null) {
    identityViolation(
      `Refusing the market: FAILING PREDICATE "curation-identity". Morpho's curation answer for market `
      + `${requestedMarketId} on chain ${subject.chainId} carries NO CHAIN ID of its own. A Blue market id is the `
      + "hash of the five market parameters and the chain is not one of them, so the same id on another chain is a "
      + "different market with different collateral and a different oracle. Without the chain the answer cannot "
      + "prove which of them its `listed` flag vouches for.",
    );
  }
  if (returnedChainId !== subject.chainId) {
    identityViolation(
      `Refusing the market: FAILING PREDICATE "curation-identity". Vex asked about market ${requestedMarketId} on `
      + `chain ${subject.chainId}, and Morpho's curation answer is about chain ${returnedChainId}. A market id is `
      + "chain-scoped, so the same id on another chain is a different market with different collateral and a "
      + "different oracle.",
    );
  }

  return { marketId: returnedMarketId, chainId: returnedChainId, listed };
}
