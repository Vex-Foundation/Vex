/**
 * The curation answer must be ABOUT THE MARKET THAT WAS ASKED ABOUT.
 *
 * `listed: true` is the trust root of the whole Blue market gate, and it is a
 * statement about one market. Every case here is the same question from a
 * different angle: can an answer describing some OTHER market, or no market at
 * all, authorize the one Vex is about to put funds into. It must not.
 */

import { describe, it, expect } from "vitest";

import { VexError, ErrorCodes } from "../../../errors.js";
import { validateMorphoMarketCuration } from "../../../tools/morpho/client/curation.js";

const MARKET = "0x3a85e619751152991742810df6ec69ce473daef99e28a64ab2340d7b7ccfee49";
const OTHER_MARKET = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
const SUBJECT = { marketId: MARKET, chainId: 1 };

function answer(market: Record<string, unknown> | null) {
  return { data: { marketById: market } };
}

function refusal(body: unknown): VexError {
  try {
    validateMorphoMarketCuration(body, SUBJECT);
  } catch (caught) {
    return caught as VexError;
  }
  throw new Error("expected a refusal, and the validator accepted the answer");
}

describe("Morpho curation identity binding", () => {
  it("accepts an answer that names the market that was asked about", () => {
    const curation = validateMorphoMarketCuration(
      answer({ marketId: MARKET, listed: true, chain: { id: 1 } }), SUBJECT,
    );

    expect(curation).toEqual({ marketId: MARKET, chainId: 1, listed: true });
  });

  it("matches the id case-insensitively, because a checksum is not a different market", () => {
    const curation = validateMorphoMarketCuration(
      answer({ marketId: MARKET.toUpperCase().replace("0X", "0x"), listed: true, chain: { id: 1 } }), SUBJECT,
    );

    expect(curation?.listed).toBe(true);
  });

  it("REFUSES an answer carrying NO market id rather than substituting the requested one", () => {
    // The original defect: the validator filled in the id it was meant to be
    // checking, so a response with no identity authorized the requested market.
    const error = refusal(answer({ listed: true }));

    expect(error.code).toBe(ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION);
    expect(error.message).toContain('FAILING PREDICATE "curation-identity"');
    expect(error.message).toContain("carries no market id of its own");
  });

  it("REFUSES an answer describing a DIFFERENT market, however curated that one is", () => {
    const error = refusal(answer({ marketId: OTHER_MARKET, listed: true, chain: { id: 1 } }));

    expect(error.code).toBe(ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION);
    expect(error.message).toContain(OTHER_MARKET);
    expect(error.message).toContain("vouches for the market it names");
  });

  it("REFUSES an answer about the same id on ANOTHER CHAIN", () => {
    // A market id is chain-scoped: the same id elsewhere is different collateral
    // behind a different oracle.
    const error = refusal(answer({ marketId: MARKET, listed: true, chain: { id: 8453 } }));

    expect(error.message).toContain("chain 8453");
    expect(error.message).toContain("chain-scoped");
  });

  it("does not fail shut when the answer omits the chain, since the id binding is the proof", () => {
    const curation = validateMorphoMarketCuration(answer({ marketId: MARKET, listed: true }), SUBJECT);

    expect(curation).toEqual({ marketId: MARKET, chainId: null, listed: true });
  });

  it("still refuses a non-boolean `listed` as UNKNOWN rather than false", () => {
    const error = refusal(answer({ marketId: MARKET, listed: null, chain: { id: 1 } }));

    expect(error.code).toBe(ErrorCodes.MORPHO_INVALID_RESPONSE);
  });

  it("maps a missing market to null, which the caller turns into its own not-found", () => {
    expect(validateMorphoMarketCuration(answer(null), SUBJECT)).toBeNull();
  });

  it("refuses a mismatched identity even when `listed` is FALSE, so the reason stays true", () => {
    // A refusal reported under the wrong predicate teaches the agent the wrong
    // lesson: "Morpho does not curate this" is not what happened here.
    const error = refusal(answer({ marketId: OTHER_MARKET, listed: false, chain: { id: 1 } }));

    expect(error.message).toContain('FAILING PREDICATE "curation-identity"');
  });
});
