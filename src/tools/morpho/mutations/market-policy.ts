/**
 * WHICH Morpho Blue MARKETS Vex will put real funds into, and HOW HEALTHY a
 * position must stay.
 *
 * ── WHY THIS MODULE EXISTS AT ALL ───────────────────────────────────────────
 *
 * A Morpho VAULT is curated: somebody chose its markets and its risk. A Morpho
 * BLUE MARKET is not. Blue is permissionless by design: a market is created by
 * naming five parameters (loan token, collateral token, oracle, IRM, LLTV) and
 * its id is nothing more than their hash. Anyone can deploy an oracle that
 * reports any price they choose, pair it with an IRM that charges any rate they
 * choose, and open a market around them that looks exactly like a real one from
 * the outside.
 *
 * The oracle is the dangerous half. It is the contract that decides what the
 * collateral is worth, so it is the contract that decides when the position is
 * liquidated. A market whose oracle can be told to report a collapse is a market
 * whose collateral can be seized on demand. THIS IS WHY A MARKET IS NEVER
 * ENTERED BY ID ALONE: the id proves the parameters hash to it, and nothing
 * else.
 *
 * ── THE GATE, AND WHERE EACH PART LIVES ─────────────────────────────────────
 *
 * This file is the ORCHESTRATION and the public entry point. Each gate owns its
 * own file beside it, because they fail for different reasons and are read for
 * different reasons:
 *
 *   `./market-policy/irm-gate.ts`       layer 0, the pinned rate model;
 *   `./market-policy/curation-gate.ts`  layer 1, does Morpho curate this market;
 *   `./market-policy/oracle-gate.ts`    layer 2, who vouches for the oracle;
 *   `./market-policy/feed-liveness.ts`  layer 3, is every price leg answering;
 *   `./market-policy/health-floor.ts`   the post-operation health floor;
 *   `./market-policy/refusal.ts`        how every gate says no.
 *
 * ── WHAT THIS MODULE DOES NOT DO ────────────────────────────────────────────
 *
 * It does not read positions, build transactions or decide amounts. It answers
 * two questions and nothing else: may Vex operate on this market, and is this
 * projected health factor acceptable. The engine that owns the operation asks
 * both and passes the answers on.
 */

import type { Address } from "viem";

import { assertMorphoCuratesMarket } from "./market-policy/curation-gate.js";
import { assertPinnedIrm } from "./market-policy/irm-gate.js";
import {
  assertAcceptableOracle,
  assertMarketDeclaresAnOracle,
  type MorphoOracleProvenance,
} from "./market-policy/oracle-gate.js";
import { formatWad } from "./market-policy/refusal.js";
import type { MorphoActionClient } from "./client.js";

export { formatWad } from "./market-policy/refusal.js";
export type { MorphoOracleProvenance } from "./market-policy/oracle-gate.js";
export {
  assertMorphoHealthFactorFloor,
  MORPHO_MIN_HEALTH_FACTOR_DECIMAL,
  MORPHO_MIN_HEALTH_FACTOR_WAD,
} from "./market-policy/health-floor.js";

/** The five parameters that ARE a Blue market. Lower-cased by the caller. */
export interface MorphoMarketParamsInput {
  readonly loanToken: Address;
  readonly collateralToken: Address;
  readonly oracle: Address;
  readonly irm: Address;
  readonly lltv: bigint;
}

/** The policy's account of a market it ACCEPTED. A refusal is a thrown `VexError`. */
export interface MorphoMarketPolicyVerdict {
  readonly chainId: number;
  readonly marketId: string;
  readonly irm: string;
  readonly oracle: string;
  readonly oracleProvenance: MorphoOracleProvenance;
  readonly lltvRaw: string;
  readonly lltvDecimal: string;
  /** One line naming what was proved, for the activity row and the agent. */
  readonly explanation: string;
}

/**
 * The whole market gate, in one call, before any amount exists.
 *
 * ORDER IS DELIBERATE AND IT IS CHEAPEST-AND-BROADEST FIRST:
 *
 *   0. the IRM, from pinned constants, needing no network at all;
 *   1. CURATION - does Morpho list this market (one live API read);
 *   2. IMPLEMENTATION - did the pinned factory mint the oracle (one chain read);
 *   3. LIVENESS - is every price leg still answering (up to four chain reads,
 *      each followed by a `latestRoundData`).
 *
 * The uncurated permissionless market, which is the case that carries almost
 * all of the real danger, is therefore refused after a single API call rather
 * than after a round trip per feed. See `../oracle-legs.ts` for what each layer
 * proves, and for the one it cannot: curation is the TRUST ROOT, and layers 2
 * and 3 are mitigations rather than independent proofs of legitimacy.
 *
 * CALLED TWICE ON AN APPROVE-THEN-OPERATE PATH, and deliberately so. Phase 1
 * gates the market before the approval is sent; the signed-broadcast lane calls
 * this again immediately before the operation is signed, because "read at
 * execution time" is a claim about the transaction being signed and not about
 * an earlier one. Nothing here caches, so the second call re-asks rather than
 * re-reports.
 *
 * @throws {VexError} `MORPHO_MARKET_POLICY_VIOLATION` naming the exact failing
 * predicate, or `MORPHO_RPC_ERROR` when a check could not be completed at all.
 * The two are never collapsed: a market Vex could not check is not a market Vex
 * judged.
 */
export async function assertMorphoMarketExecutable(
  client: MorphoActionClient,
  chainId: number,
  marketId: string,
  params: MorphoMarketParamsInput,
): Promise<MorphoMarketPolicyVerdict> {
  const irm = assertPinnedIrm(chainId, params.irm);
  await assertMorphoCuratesMarket(chainId, marketId);
  assertMarketDeclaresAnOracle(chainId, marketId, params.oracle);
  const { oracle, provenance } = await assertAcceptableOracle(client, chainId, marketId, params.oracle);
  const lltvDecimal = formatWad(params.lltv);

  const provenanceClause = provenance === "curated-standard-live"
    ? "Morpho itself curates it (listed), its oracle was minted by the chain's pinned Morpho Chainlink oracle "
      + "factory so it runs Morpho's audited implementation, and every price feed that oracle reads answered with a "
      + "live positive price"
    : "Morpho itself curates it (listed), its oracle is on Vex's owner-vouched allowlist for this chain because a "
      + "human read its verified source where the pinned factory could not vouch for it, and every price feed that "
      + "oracle reads answered with a live positive price";

  return {
    chainId,
    marketId: marketId.toLowerCase(),
    irm,
    oracle,
    oracleProvenance: provenance,
    lltvRaw: params.lltv.toString(),
    lltvDecimal,
    explanation:
      `Market ${marketId.toLowerCase()} on chain ${chainId} is executable: its interest rate model is the pinned `
      + `AdaptiveCurveIRM ${irm}, and ${provenanceClause} (${oracle}). Its liquidation LTV is ${lltvDecimal}, so the `
      + "position is liquidatable in full once the debt reaches that share of the collateral's oracle value.",
  };
}
