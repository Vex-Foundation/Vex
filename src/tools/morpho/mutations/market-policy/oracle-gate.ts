/**
 * LAYER 2 plus the market's own oracle declaration: WHO VOUCHES for the contract
 * that decides what the collateral is worth.
 *
 * The factory answer proves the oracle's IMPLEMENTATION is Morpho's audited
 * `MorphoChainlinkOracleV2` and nothing more: that factory's creation function
 * takes caller-chosen feeds and has no access control, so anyone can mint a
 * "true" oracle over feeds they control. See `../../oracle-legs.ts` for what
 * each layer does and does not prove.
 */

import type { Address } from "viem";

import { VexError, ErrorCodes } from "../../../../errors.js";
import {
  MORPHO_MANUAL_ORACLE_ALLOWLIST,
  MORPHO_MARKET_POLICY_CONTRACTS,
} from "../../constants.js";
import type { MorphoActionClient } from "../client.js";
import { assertOracleFeedsLive } from "./feed-liveness.js";
import { NOTHING_HAPPENED_HINT, policyViolation } from "./refusal.js";

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

/**
 * How a market's oracle earned its acceptance. Never absent on an accepted
 * market.
 *
 * `curated-standard-live` is THREE facts together, and no one of them is
 * enough: Morpho CURATES the market (`listed: true`, read live), the pinned
 * factory MINTED the oracle so its implementation is Morpho's audited bytecode,
 * and every price leg that oracle reads ANSWERED with a live positive price.
 *
 * `owner-allowlist` differs in ONE of those three facts and no more: the
 * implementation was vouched for by a human reading verified source rather than
 * by the pinned factory. The market is still curated and the price legs still
 * answered.
 */
export type MorphoOracleProvenance = "curated-standard-live" | "owner-allowlist";

/**
 * A market that declares NO ORACLE AT ALL is refused before anything tries to
 * vouch for one.
 *
 * OBSERVED, not hypothetical: Morpho's API returned `oracle: null` for market
 * 0x85da4c8b...c648 on chain 4663 - a market that HAS a collateral asset and so
 * genuinely needs a price to liquidate against. On chain the same absence reads
 * as the zero address. A missing oracle is not a stricter version of an
 * unvouched one; it is a different fact, so it gets its own name.
 */
export function assertMarketDeclaresAnOracle(
  chainId: number,
  marketId: string,
  oracle: string | null | undefined,
): void {
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
    "Nothing was read further, signed or sent. Use a market that names an oracle - `morpho__markets_discover` lists "
    + "the curated ones per chain.",
  );
}

/**
 * Assert the market's oracle is acceptable: LAYERS 2 AND 3.
 *
 * THE MANUAL OWNER ALLOWLIST SATISFIES THE IMPLEMENTATION QUESTION AND ONLY
 * THAT QUESTION. It is a human standing in for the factory's answer about the
 * IMPLEMENTATION, which is the one thing a human can actually check by reading
 * verified source. It is not a statement that the oracle's feeds are alive, and
 * liveness is the property that decays. So an allowlisted oracle still goes
 * through the liveness read below, and layer 1 still ran before this was called.
 *
 * AND IT VOUCHES FOR ONE MARKET, NOT FOR AN ADDRESS. The entry is matched on the
 * FULL TRIPLE `(chainId, marketId, oracle)`: the chain by the table it sits in,
 * the market and the oracle by value. An earlier revision matched the oracle
 * address alone while storing the market id beside it as a label, so the single
 * owner approval of WBTC/USDC on Ethereum silently vouched for every other
 * curated Ethereum market reusing that oracle. The owner read one market's
 * collateral, feeds and scale; that is the claim, and it does not travel.
 *
 * A FAILED READ IS NOT A "NO", AND IT IS NOT A "YES" EITHER. If the factory call
 * cannot be completed, the market is refused as UNPROVEN under a transport error
 * code rather than as a policy violation. Rules/90: a definitive refusal and an
 * ambiguous transport failure must not be collapsed into one another.
 */
export async function assertAcceptableOracle(
  client: MorphoActionClient,
  chainId: number,
  marketId: string,
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

  const market = marketId.trim().toLowerCase();
  const allowlisted = MORPHO_MANUAL_ORACLE_ALLOWLIST[chainId] ?? [];
  const vouched = allowlisted.find(
    (entry) => entry.oracle.toLowerCase() === actual && entry.marketId.trim().toLowerCase() === market,
  );
  if (vouched !== undefined) {
    await assertOracleFeedsLive(client, chainId, oracle);
    return { oracle: actual, provenance: "owner-allowlist" };
  }

  const factoryClause = factory === null
    ? `Vex has no pinned Morpho Chainlink oracle factory for chain ${chainId} to ask`
    : `the chain's pinned Morpho Chainlink oracle factory ${factory.toLowerCase()} did not mint it`;
  const sameOracleElsewhere = allowlisted.filter((entry) => entry.oracle.toLowerCase() === actual);
  const allowlistClause = sameOracleElsewhere.length > 0
    ? "The owner DID vouch for that same oracle contract, but for a different market ("
      + `${sameOracleElsewhere.map((entry) => entry.market).join(", ")}, market id `
      + `${sameOracleElsewhere.map((entry) => entry.marketId.toLowerCase()).join(", ")}). That approval was a `
      + "judgement about one market's collateral, feeds and scale, so it does not carry to this one."
    : allowlisted.length === 0
      ? "Vex's owner-vouched oracle allowlist for this chain is empty."
      : `Vex's owner-vouched oracle allowlist for this chain holds ${allowlisted.length} other entry/entries, none `
        + "of them for this market and this oracle together.";
  policyViolation(
    `Refusing the market: FAILING PREDICATE "oracle". The oracle of market ${market} is ${actual}, and `
    + `${factoryClause}. ${allowlistClause} Morpho Blue is permissionless: the oracle names the collateral's price, `
    + "so an oracle nobody vouched for can report a collapse and have the collateral liquidated in full.",
    NOTHING_HAPPENED_HINT,
  );
}
