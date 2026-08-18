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
import {
  MORPHO_AGGREGATOR_V3_ABI,
  MORPHO_CHAINLINK_ORACLE_V2_ABI,
  MORPHO_FEED_MAX_AGE_SECONDS,
  MORPHO_ORACLE_FEED_GETTERS,
  type MorphoOracleFeedGetter,
} from "../oracle-legs.js";
import { getMorphoClient } from "../client.js";
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

/**
 * How a market's oracle earned its acceptance. Never absent on an accepted
 * market.
 *
 * `owner-allowlist` differs from `curated-standard-live` in ONE of those three
 * facts and no more: the implementation was vouched for by a human reading
 * verified source rather than by the pinned factory. The market is still curated
 * and the price legs still answered.
 *
 * `curated-standard-live` is THREE facts together, and no one of them is
 * enough: Morpho CURATES the market (`listed: true`, read live), the pinned
 * factory MINTED the oracle so its implementation is Morpho's audited bytecode,
 * and every price leg that oracle reads ANSWERED with a live positive price.
 * The factory half used to stand alone under the name
 * `chainlink-oracle-factory`, which overstated it badly: that factory's
 * creation function is unrestricted, so it can only ever attest to the
 * implementation. See `../oracle-legs.ts` for why the three layers are not
 * redundant.
 */
export type MorphoOracleProvenance = "curated-standard-live" | "owner-allowlist";

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

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

/**
 * LAYER 1: is this a market Morpho actually curates?
 *
 * ASKED LIVE, AT EXECUTION TIME, not inherited from discovery. Morpho Blue is
 * permissionless, so `listed` is the difference between a market a curator
 * stands behind and one anybody opened this morning. The discovery lane already
 * defaults to listed markets, but a market id can reach an execute tool by any
 * route at all, and the id proves only that five parameters hash to it.
 *
 * WHY THIS IS THE MAIN FILTER, measured rather than assumed: the two ruinous
 * markets found in the 2026-08-17 survey, K/USDC on Arbitrum with a 335-day
 * stale feed and sdeUSD/USDC on Ethereum with a reverting one, are both
 * `listed: false`.
 *
 * AN UNREACHABLE API IS A REFUSAL, NOT A BYPASS. If the curation check cannot
 * be performed, the market is refused and the reason says the check could not
 * run. Vex does NOT fall back to signing on the implementation and liveness
 * layers alone, and it does not accept a cached flag: the uncached read in
 * `MorphoClient.getMarketCuration` is what makes "at execution time" true.
 */
async function assertMorphoCuratesMarket(chainId: number, marketId: string): Promise<void> {
  let listed: boolean;
  try {
    listed = (await getMorphoClient().getMarketCuration({ chainId, marketId })).listed;
  } catch (error) {
    throw new VexError(
      ErrorCodes.MORPHO_RPC_ERROR,
      `Refusing the market: Vex could not ask Morpho whether it curates market ${marketId.toLowerCase()} on chain `
      + `${chainId}, so its curation status is UNKNOWN rather than acceptable.`,
      "Nothing was signed or sent. This is a refusal to proceed without the check, not a judgement on the market: "
      + "Vex will not enter a permissionless lending market on the strength of the other checks alone. Retry once "
      + `Morpho's API answers. The read failed with: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!listed) {
    policyViolation(
      `Refusing the market: FAILING PREDICATE "listed". Morpho does not curate market ${marketId.toLowerCase()} on `
      + `chain ${chainId}. The market EXISTS and is perfectly real - Morpho Blue lets anyone create one by naming `
      + "five parameters - but nobody has vouched for its oracle, its collateral or its risk. The markets carrying "
      + "the worst broken price feeds Vex has measured were all uncurated ones exactly like this.",
      NOTHING_HAPPENED_HINT,
    );
  }
}

/**
 * Read one immutable feed leg off the oracle. A getter that does not answer is
 * a leg Vex cannot read, which is refused as UNPROVEN rather than treated as
 * absent: "I could not tell what price this reads" is not "it reads nothing".
 */
async function readOracleFeed(
  client: MorphoActionClient,
  oracle: Address,
  getter: MorphoOracleFeedGetter,
  chainId: number,
): Promise<string> {
  try {
    const value = await client.readContract({
      address: oracle,
      abi: MORPHO_CHAINLINK_ORACLE_V2_ABI,
      functionName: getter,
    });
    return String(value).toLowerCase();
  } catch (error) {
    throw new VexError(
      ErrorCodes.MORPHO_RPC_ERROR,
      `Refusing the market: Vex could not read ${getter}() from its oracle ${oracle.toLowerCase()} on chain `
      + `${chainId}, so which price source that oracle actually reads is UNKNOWN rather than acceptable.`,
      "Nothing was signed or sent. Retry once the RPC is reachable. Vex does not enter a Blue market whose price "
      + "legs it could not read, because those legs decide when the collateral is seized. The read failed with: "
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * LAYER 3: is every price leg ANSWERING NOW?
 *
 * The only layer that sees the present moment. Curation is a judgement made
 * once and the implementation check is about bytecode; neither notices a feed
 * that went silent afterwards, and the 2026-08-17 survey found feeds 25, 76,
 * 149, 241 and 335 days stale still pricing funded markets.
 *
 * A REVERTING FEED IS A REFUSAL BY NAME, not a skipped check. An oracle whose
 * price source will not answer cannot be shown to price the collateral at all.
 *
 * `updatedAt == 0` IS NOT STALENESS. See `../oracle-legs.ts`: an exchange-rate
 * adapter derives its answer from live chain state and has no round, so it is
 * judged on a positive answer alone. That exemption rides on layers 1 and 2
 * having already established a curated market behind a standard oracle.
 */
async function assertOracleFeedsLive(
  client: MorphoActionClient,
  chainId: number,
  oracle: Address,
): Promise<void> {
  for (const getter of MORPHO_ORACLE_FEED_GETTERS) {
    const feed = await readOracleFeed(client, oracle, getter, chainId);
    if (feed === ZERO_ADDRESS) continue;

    let answer: bigint;
    let updatedAt: bigint;
    try {
      const round = await client.readContract({
        address: feed as Address,
        abi: MORPHO_AGGREGATOR_V3_ABI,
        functionName: "latestRoundData",
      });
      answer = round[1];
      updatedAt = round[3];
    } catch {
      policyViolation(
        `Refusing the market: FAILING PREDICATE "oracle-feed-live". The price feed ${feed} its oracle uses as `
        + `${getter} did not answer latestRoundData() at all. A feed that reverts cannot price the collateral, and a `
        + "position whose collateral cannot be priced is one whose liquidation nobody can predict.",
        NOTHING_HAPPENED_HINT,
      );
    }

    if (answer <= 0n) {
      policyViolation(
        `Refusing the market: FAILING PREDICATE "oracle-feed-live". The price feed ${feed} its oracle uses as `
        + `${getter} reports ${answer}, which is not a positive price. A feed answering zero prices the collateral `
        + "at nothing, and collateral worth nothing is a position that can be liquidated in full.",
        NOTHING_HAPPENED_HINT,
      );
    }

    // No round at all: an exchange-rate adapter reading live chain state. There
    // is no timestamp to judge, so the positive answer above is the whole test.
    if (updatedAt === 0n) continue;

    const ageSeconds = BigInt(Math.floor(Date.now() / 1000)) - updatedAt;
    if (ageSeconds > BigInt(MORPHO_FEED_MAX_AGE_SECONDS)) {
      policyViolation(
        `Refusing the market: FAILING PREDICATE "oracle-feed-live". The price feed ${feed} its oracle uses as `
        + `${getter} last reported ${Number(ageSeconds) / 86_400} days ago, beyond Vex's `
        + `${MORPHO_FEED_MAX_AGE_SECONDS / 86_400}-day limit. A stale price does not stop the market: it keeps `
        + "liquidating positions against a number that stopped tracking reality.",
        NOTHING_HAPPENED_HINT,
      );
    }
  }
}

/**
 * Assert the market's oracle is acceptable: LAYERS 2 AND 3.
 *
 * TWO QUESTIONS, BOTH ASKED OF THE CHAIN, because the answer to the first is
 * not the answer to the second:
 *
 *   1. Did the pinned factory mint this oracle? Proves the implementation is
 *      Morpho's audited `MorphoChainlinkOracleV2` and nothing else. It does NOT
 *      prove anything about the prices: the factory's creation function takes
 *      caller-chosen feeds, vaults, decimals and salt and has no access control
 *      whatsoever, so anyone can mint a "true" oracle over feeds they control.
 *   2. Is every price leg that oracle reads ANSWERING NOW, with a positive
 *      price and a round inside the freshness bound? Read off the oracle and
 *      then off the feeds themselves.
 *
 * Together with the curation layer the caller applies first, they say the
 * collateral's price comes from a curated market, through reviewed math, from a
 * source that is still reporting.
 *
 * THE MANUAL OWNER ALLOWLIST SATISFIES QUESTION 1 AND ONLY QUESTION 1. It is a
 * human standing in for the factory's answer about the IMPLEMENTATION, which is
 * the one thing a human can actually check by reading verified source. It is not
 * a statement that the oracle's feeds are alive, and liveness is the property
 * that decays: an entry vouched for last quarter says nothing about whether the
 * feed answered this morning. So an allowlisted oracle still goes through the
 * liveness read below, and layer 1 still ran before this function was called.
 *
 * A FAILED READ IS NOT A "NO", AND IT IS NOT A "YES" EITHER. If either call
 * cannot be completed, the market is refused as UNPROVEN under a transport error
 * code rather than as a policy violation. Rules/90: a definitive refusal and an
 * ambiguous transport failure must not be collapsed into one another, and a
 * money path that cannot prove its oracle declines rather than assuming.
 */
/**
 * A market that declares NO ORACLE AT ALL is refused before anything tries to
 * vouch for one.
 *
 * OBSERVED, not hypothetical: Morpho's API returned `oracle: null` for market
 * 0x85da4c8b...c648 on chain 4663 - a market that HAS a collateral asset and so
 * genuinely needs a price to liquidate against. On chain the same absence reads
 * as the zero address. Either way there is nothing to ask the oracle factory
 * about, and without this the failure is either a `TypeError` on a null
 * dereference or a policy refusal that reports the market's oracle as
 * "0x0000...0000" and leaves the reader to work out what that means.
 *
 * A missing oracle is not a stricter version of an unvouched one; it is a
 * different fact, so it gets its own name.
 */
function assertMarketDeclaresAnOracle(chainId: number, marketId: string, oracle: string | null | undefined): void {
  // A TOTAL TEST, never a numeric parse. `BigInt(oracle)` would throw its own
  // opaque SyntaxError on anything that is not hex, which is precisely the
  // malformed-input case this guard exists to name.
  const declared = typeof oracle === "string" ? oracle.trim() : "";
  if (declared !== "" && !/^0x0+$/i.test(declared)) return;
  policyViolation(
    `Refusing the market: FAILING PREDICATE "oracle". Market ${marketId.toLowerCase()} on chain ${chainId} declares `
    + "NO ORACLE at all, so there is no price feed to vouch for and nothing that could say what its collateral is "
    + "worth. Morpho Blue is permissionless and a market may be created this way; Vex does not enter one, because "
    + "the oracle is what decides when the collateral is seized.",
    "Nothing was read further, signed or sent. Use a market that names an oracle - `morpho.markets.discover` lists "
    + "the curated ones per chain.",
  );
}

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
      await assertOracleFeedsLive(client, chainId, oracle);
      return { oracle: actual, provenance: "curated-standard-live" };
    }
  }

  const allowlisted = MORPHO_MANUAL_ORACLE_ALLOWLIST[chainId] ?? [];
  if (allowlisted.some((entry) => entry.oracle.toLowerCase() === actual)) {
    await assertOracleFeedsLive(client, chainId, oracle);
    return { oracle: actual, provenance: "owner-allowlist" };
  }

  const factoryClause = factory === null
    ? `Vex has no pinned Morpho Chainlink oracle factory for chain ${chainId} to ask`
    : `the chain's pinned Morpho Chainlink oracle factory ${factory.toLowerCase()} did not mint it`;
  const allowlistClause = allowlisted.length === 0
    ? "which is empty"
    : `which holds ${allowlisted.length} other oracle(s) on this chain`;
  policyViolation(
    `Refusing the market: FAILING PREDICATE "oracle". Its price oracle is ${actual}, ${factoryClause}, and it is not `
    + `on Vex's owner-vouched oracle allowlist for this chain, ${allowlistClause}. Morpho Blue is permissionless: the `
    + "oracle names the collateral's price, so an oracle nobody vouched for can report a collapse and have the "
    + "collateral liquidated in full.",
    NOTHING_HAPPENED_HINT,
  );
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
 * than after a round trip per feed. See `../oracle-legs.ts` for why all three
 * layers are kept even though each looks redundant beside the others.
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
  const { oracle, provenance } = await assertAcceptableOracle(client, chainId, params.oracle);
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
