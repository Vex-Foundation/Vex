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
 * else. Two predicates must hold, both checked here, both refused BY NAME.
 *
 * ── WHY THE HEALTH FLOOR IS 1.25 AND NOT SOMETHING JUST ABOVE 1.0 ───────────
 *
 * Morpho Blue HAS NO CLOSE FACTOR. On most lending protocols crossing the
 * liquidation threshold lets a liquidator repay some fraction of the debt, which
 * gives a position a partial haircut and a chance to recover. On Blue, crossing
 * a health factor of 1.0 permits the position to be liquidated IN FULL, in one
 * transaction, with a liquidation incentive of up to 15% paid out of the
 * borrower's collateral. There is no cushion and there is no second chance.
 *
 * So the floor is not "close to liquidation is fine as long as we are above it".
 * It is a distance chosen so that ordinary price movement between Vex deciding
 * to borrow and the transaction landing cannot cross the cliff. 1.25 leaves the
 * collateral room to fall about 20% before liquidation becomes possible.
 *
 * OWNER-TUNABLE, DELIBERATELY NOT AGENT-TUNABLE. The number below is a product
 * decision and lives in one place so it can be changed in one reviewed edit. It
 * is never read from a tool parameter, a prompt, or model output: a floor the
 * borrower can talk its way past is not a floor, and rules/90 puts limit
 * parameters outside model reach for exactly this reason.
 *
 * ── WHAT THIS MODULE DOES NOT DO ────────────────────────────────────────────
 *
 * It does not read positions, build transactions or decide amounts. It answers
 * two questions and nothing else: may Vex operate on this market, and is this
 * projected health factor acceptable. The engine that owns the operation asks
 * both and passes the answers on.
 */

import { formatUnits, type Address } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import {
  MORPHO_MANUAL_ORACLE_ALLOWLIST,
  MORPHO_MARKET_POLICY_CONTRACTS,
} from "../constants.js";
import type { MorphoActionClient } from "./client.js";

/**
 * The minimum health factor a position may hold AFTER an operation Vex
 * performs, in WAD (18 decimals), matching the scale the Morpho SDK reports a
 * health factor in.
 *
 * 1.25. See the module note for why the distance from 1.0 is this large.
 */
export const MORPHO_MIN_HEALTH_FACTOR_WAD = 1_250_000_000_000_000_000n;

/** The same floor as a decimal string, for messages a person and an agent read. */
export const MORPHO_MIN_HEALTH_FACTOR_DECIMAL = "1.25";

/** WAD, the fixed-point scale Morpho states health factors and LLTVs in. */
const WAD = 10n ** 18n;

/**
 * The factory's on-chain predicate.
 *
 * DECLARED HERE BECAUSE THE PINNED SDK DOES NOT SHIP IT. `@morpho-org/blue-sdk-viem`
 * exports ABIs for Blue, the vaults, the adapters and the pre-liquidation
 * factory, but none for the Chainlink oracle factory (checked 2026-08-17). The
 * selector was recovered from the deployed Base bytecode and confirmed live the
 * same day: `isMorphoChainlinkOracleV2` is `0x4cf4a264`, it answered `true` for
 * the oracles of three real Base markets and `false` for GeneralAdapter1, which
 * is the negative control that proves the call discriminates at all.
 */
const CHAINLINK_ORACLE_FACTORY_ABI = [
  {
    type: "function",
    name: "isMorphoChainlinkOracleV2",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** The five parameters that ARE a Blue market. Lower-cased by the caller. */
export interface MorphoMarketParamsInput {
  readonly loanToken: Address;
  readonly collateralToken: Address;
  readonly oracle: Address;
  readonly irm: Address;
  readonly lltv: bigint;
}

/** How a market's oracle earned its acceptance. Never absent on an accepted market. */
export type MorphoOracleProvenance = "chainlink-oracle-factory" | "owner-allowlist";

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

const NOTHING_HAPPENED_HINT =
  "Nothing was approved, signed or sent. This is a policy refusal rather than a transient failure, so retrying the "
  + "same market produces the same answer.";

function policyViolation(message: string, hint: string): never {
  throw new VexError(ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION, message, hint);
}

/** A WAD fixed-point number as a plain decimal string, trailing zeros trimmed. */
export function formatWad(value: bigint): string {
  const text = formatUnits(value, 18);
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/**
 * Assert the market's IRM is the chain's pinned AdaptiveCurveIRM.
 *
 * EXACT EQUALITY, no family match and no heuristic. The IRM decides what the
 * borrower pays; an IRM Vex does not recognise is one whose rate curve nobody
 * reviewed, and a market can name any contract at all here.
 */
function assertPinnedIrm(chainId: number, irm: Address): string {
  const pinned = MORPHO_MARKET_POLICY_CONTRACTS[chainId];
  if (pinned === undefined) {
    policyViolation(
      `Refusing the market: Vex has no pinned Morpho market-policy contracts for chain ${chainId}, so neither its `
      + "interest rate model nor its oracle can be checked against anything.",
      NOTHING_HAPPENED_HINT,
    );
  }
  const actual = irm.toLowerCase();
  const expected = pinned.adaptiveCurveIrm.toLowerCase();
  if (actual !== expected) {
    policyViolation(
      `Refusing the market: FAILING PREDICATE "irm". Its interest rate model is ${actual}, and Vex borrows only `
      + `against the chain's pinned AdaptiveCurveIRM ${expected}. Morpho Blue is permissionless, so a market may `
      + "name any contract as its rate model, including one that can charge an arbitrary rate.",
      NOTHING_HAPPENED_HINT,
    );
  }
  return actual;
}

/**
 * Assert the market's oracle is acceptable, preferring the chain's own answer.
 *
 * THE CHAIN IS ASKED FIRST, and the manual list is only reached when there is no
 * factory to ask. A fact the chain can prove is not worth maintaining by hand.
 *
 * A FAILED READ IS NOT A "NO", AND IT IS NOT A "YES" EITHER. If the factory call
 * cannot be completed, the market is refused as UNPROVEN under a transport error
 * code rather than as a policy violation. Rules/90: a definitive refusal and an
 * ambiguous transport failure must not be collapsed into one another, and a
 * money path that cannot prove its oracle declines rather than assuming.
 */
async function assertAcceptableOracle(
  client: MorphoActionClient,
  chainId: number,
  oracle: Address,
): Promise<{ readonly oracle: string; readonly provenance: MorphoOracleProvenance }> {
  const pinned = MORPHO_MARKET_POLICY_CONTRACTS[chainId];
  const actual = oracle.toLowerCase();
  const factory = pinned?.chainlinkOracleFactory ?? null;

  if (factory !== null) {
    let minted: boolean;
    try {
      minted = await client.readContract({
        address: factory,
        abi: CHAINLINK_ORACLE_FACTORY_ABI,
        functionName: "isMorphoChainlinkOracleV2",
        args: [oracle],
      });
    } catch (error) {
      throw new VexError(
        ErrorCodes.MORPHO_RPC_ERROR,
        `Refusing the market: Vex could not reach the pinned Morpho Chainlink oracle factory ${factory.toLowerCase()} `
        + `on chain ${chainId} to ask whether it minted this market's oracle ${actual}, so whether the oracle is one `
        + "Vex accepts is UNKNOWN rather than false.",
        "Nothing was signed or sent. Retry once the RPC is reachable. Vex does not enter a Blue market whose price "
        + `feed it could not vouch for, because that feed is what decides when the collateral is seized. The read `
        + `failed with: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (minted) {
      return { oracle: actual, provenance: "chainlink-oracle-factory" };
    }
  }

  const allowlisted = MORPHO_MANUAL_ORACLE_ALLOWLIST[chainId] ?? [];
  if (allowlisted.some((entry) => entry.toLowerCase() === actual)) {
    return { oracle: actual, provenance: "owner-allowlist" };
  }

  const factoryClause = factory === null
    ? `Vex has no pinned Morpho Chainlink oracle factory for chain ${chainId} to ask`
    : `the chain's pinned Morpho Chainlink oracle factory ${factory.toLowerCase()} did not mint it`;
  policyViolation(
    `Refusing the market: FAILING PREDICATE "oracle". Its price oracle is ${actual}, ${factoryClause}, and it is not `
    + "on Vex's owner-vouched oracle allowlist for this chain, which is empty. Morpho Blue is permissionless: the "
    + "oracle names the collateral's price, so an oracle nobody vouched for can report a collapse and have the "
    + "collateral liquidated in full.",
    NOTHING_HAPPENED_HINT,
  );
}

/**
 * The whole market gate. Both predicates, in one call, before any amount exists.
 *
 * @throws {VexError} `MORPHO_MARKET_POLICY_VIOLATION` naming the exact failing
 * predicate, or `MORPHO_RPC_ERROR` when the oracle could not be checked at all.
 */
export async function assertMorphoMarketExecutable(
  client: MorphoActionClient,
  chainId: number,
  marketId: string,
  params: MorphoMarketParamsInput,
): Promise<MorphoMarketPolicyVerdict> {
  const irm = assertPinnedIrm(chainId, params.irm);
  const { oracle, provenance } = await assertAcceptableOracle(client, chainId, params.oracle);
  const lltvDecimal = formatWad(params.lltv);

  const provenanceClause = provenance === "chainlink-oracle-factory"
    ? "its oracle was minted by the chain's pinned Morpho Chainlink oracle factory"
    : "its oracle is on Vex's owner-vouched allowlist for this chain";

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

/**
 * The position's health after the operation, measured against the floor.
 *
 * `healthFactorWad` is `null` when the position carries NO DEBT, which is not a
 * failure and not an infinite number to be compared: a position that owes
 * nothing cannot be liquidated, so it passes. Modelling that as `null` rather
 * than as a very large number keeps the caller from ever comparing a sentinel.
 *
 * @throws {VexError} `MORPHO_HEALTH_FACTOR_FLOOR` carrying the projected number
 * and the floor, so the agent can size a smaller operation instead of guessing.
 */
export function assertMorphoHealthFactorFloor(
  healthFactorWad: bigint | null,
  operation: string,
): void {
  if (healthFactorWad === null) return;
  if (healthFactorWad >= MORPHO_MIN_HEALTH_FACTOR_WAD) return;

  const projected = formatWad(healthFactorWad);
  const belowOne = healthFactorWad < WAD;
  const severity = belowOne
    ? "That is below 1.0, which means the position would be liquidatable the moment the transaction lands."
    : "That is above 1.0, so the position would not be instantly liquidatable, but it sits inside the margin Vex "
      + "keeps for ordinary price movement.";

  throw new VexError(
    ErrorCodes.MORPHO_HEALTH_FACTOR_FLOOR,
    `Refusing this ${operation}: it would leave the position at a health factor of ${projected}, below Vex's floor `
    + `of ${MORPHO_MIN_HEALTH_FACTOR_DECIMAL}. ${severity} Morpho Blue has no close factor, so a position that `
    + "crosses 1.0 can be liquidated IN FULL in a single transaction, with a liquidation incentive of up to 15% "
    + "taken out of the collateral.",
    `Nothing was signed or sent. Borrow less, or supply more collateral first, so the health factor after the `
    + `operation stays at or above ${MORPHO_MIN_HEALTH_FACTOR_DECIMAL}.`,
  );
}
