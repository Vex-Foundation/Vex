/**
 * The FRESH, ACCRUED Blue market and position every borrow-lane decision is
 * computed from.
 *
 * ── THE MARKET'S PARAMETERS COME FROM THE CHAIN, NEVER FROM THE CALLER ──────
 *
 * A caller (and therefore, upstream, a model) can name a market id. It must not
 * be able to name the market's ORACLE, because the oracle decides what the
 * collateral is worth and therefore when the position is liquidated. So the id
 * is the only thing accepted, and the five parameters are read back from Morpho
 * Blue's own `idToMarketParams`, then re-hashed locally and required to equal
 * the id that was asked for. Only then does `./market-policy.ts` get to vouch
 * for them. A market whose parameters were supplied alongside its id would let
 * an attacker pass a real id with a hostile oracle.
 *
 * ── INTEREST IS ACCRUED BEFORE ANYTHING IS COMPUTED ─────────────────────────
 *
 * Same doctrine as `./vault-state.ts`. Morpho stores a market's totals as of its
 * last update, so a health factor computed from stored figures is a health
 * factor from the past. Every number here comes from state accrued to now, which
 * is the state the transaction will actually meet.
 *
 * ── THE MaxUint256 SENTINEL, NORMALISED ONCE, HERE ──────────────────────────
 *
 * `AccrualPosition.healthFactor` is typed `bigint | undefined`. On the fork, a
 * position holding collateral and NO DEBT returned MaxUint256 instead
 * (2026-08-17). A sentinel that large passes a floor comparison, so the bug
 * would have produced the right answer for the wrong reason and stayed invisible
 * until some later consumer formatted it as a number and printed
 * 115792089237316195423570985008687907853269984665640564039457.58. It is turned
 * into `null` at this boundary, once, so nothing downstream ever meets it.
 */

import { MarketParams } from "@morpho-org/blue-sdk";
import { blueAbi } from "@morpho-org/blue-sdk-viem";
import type { Address } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import { ERC20_READ_ABI } from "../../evm-chains/erc20-reads.js";
import { MORPHO_CONTRACTS } from "../constants.js";
import type { MorphoActionClient } from "./client.js";
import { assertMorphoMarketExecutable, type MorphoMarketPolicyVerdict } from "./market-policy.js";
import type {
  MorphoMarketIdentity,
  MorphoMarketSnapshot,
  MorphoPositionSnapshot,
} from "./borrow-types.js";

/** The sentinel a debt-free position reports instead of an absent health factor. */
const MAX_UINT_256 = 2n ** 256n - 1n;

/** A market, vouched for and read fresh, with the handle to act on it. */
export interface MorphoBlueMarketState {
  readonly identity: MorphoMarketIdentity;
  readonly policy: MorphoMarketPolicyVerdict;
  readonly snapshot: MorphoMarketSnapshot;
  /** The SDK's own market params object, used to build and to read positions. */
  readonly marketParams: MarketParams;
}

/**
 * Turn the SDK's health factor into the one shape the rest of the lane accepts.
 *
 * `undefined` (the typed absence) and MaxUint256 (the observed sentinel) both
 * mean the same thing: this position carries no debt, so it cannot be
 * liquidated and there is no ratio to compare.
 */
export function normalizeHealthFactor(value: bigint | undefined): bigint | null {
  if (value === undefined) return null;
  if (value >= MAX_UINT_256) return null;
  return value;
}

export function requireMorphoBlue(chainId: number): Address {
  const address = MORPHO_CONTRACTS[chainId]?.morphoBlue;
  if (address === null || address === undefined) {
    throw new VexError(
      ErrorCodes.MORPHO_UNSUPPORTED_CHAIN,
      `Vex has no pinned Morpho Blue address for chain ${chainId}, so no market on it can be read or operated on.`,
      "Nothing was read or sent. Use a chain Vex supports for Morpho.",
    );
  }
  return address;
}

/**
 * Read one Blue market: parameters from the chain, policy verdict, token
 * metadata and accrued totals.
 *
 * @throws {VexError} `MORPHO_MARKET_NOT_FOUND` when the id resolves to nothing,
 * `MORPHO_MARKET_POLICY_VIOLATION` when the market fails the IRM or oracle
 * predicate, `MORPHO_RPC_ERROR` when a scale could not be read.
 */
export async function readMorphoBlueMarket(
  client: MorphoActionClient,
  chainId: number,
  marketId: string,
): Promise<MorphoBlueMarketState> {
  const blueAddress = requireMorphoBlue(chainId);
  const id = marketId.toLowerCase() as `0x${string}`;

  // Morpho Blue returns MULTIPLE NAMED VALUES here, not a struct, so viem hands
  // back a POSITIONAL TUPLE. Reading it as an object yields `undefined` for
  // every field and fails much later, inside `new MarketParams`, as "cannot
  // convert undefined to a BigInt". Found on the fork 2026-08-17.
  const [loanToken, collateralToken, oracle, irm, lltv] = await client.readContract({
    address: blueAddress,
    abi: blueAbi,
    functionName: "idToMarketParams",
    args: [id],
  });

  if (loanToken === "0x0000000000000000000000000000000000000000") {
    throw new VexError(
      ErrorCodes.MORPHO_MARKET_NOT_FOUND,
      `No Morpho Blue market exists at id ${id} on chain ${chainId}. Morpho Blue answered with an empty parameter `
      + "set, which is what it returns for an id that was never created.",
      "Check the market id and the chain together: a market id is chain-scoped, and the same id on the wrong chain "
      + "resolves to nothing. `morpho.markets.discover` lists real markets per chain.",
    );
  }

  const marketParams = new MarketParams({ loanToken, collateralToken, oracle, irm, lltv });

  // THE ID IS RE-DERIVED AND REQUIRED TO MATCH. `idToMarketParams` is a mapping
  // read, so this cannot normally disagree, and that is exactly why a
  // disagreement would mean something is badly wrong (a wrong Blue address, a
  // chain mismatch, an SDK hashing change). It costs nothing to prove.
  if (marketParams.id.toLowerCase() !== id) {
    throw new VexError(
      ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION,
      `Refusing the market: the parameters Morpho Blue returned for id ${id} hash to ${marketParams.id.toLowerCase()} `
      + "instead. Vex will not operate on a market whose identity it cannot reproduce.",
      "Nothing was read further or sent. Report this as a Morpho Blue or SDK behaviour change rather than retrying.",
    );
  }

  const policy = await assertMorphoMarketExecutable(client, chainId, id, {
    loanToken, collateralToken, oracle, irm, lltv,
  });

  const [loanDecimals, loanSymbol, collateralDecimals, collateralSymbol] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: loanToken, abi: ERC20_READ_ABI, functionName: "decimals" },
      { address: loanToken, abi: ERC20_READ_ABI, functionName: "symbol" },
      { address: collateralToken, abi: ERC20_READ_ABI, functionName: "decimals" },
      { address: collateralToken, abi: ERC20_READ_ABI, functionName: "symbol" },
    ],
  });

  // A SYMBOL IS DISPLAY-ONLY AND MAY BE ABSENT. A SCALE IS NOT. An amount whose
  // decimals could not be read cannot be shown or reasoned about at any scale,
  // so it is a refusal rather than a default of 18.
  const readScale = (
    result: (typeof loanDecimals) | (typeof collateralDecimals),
    token: Address,
    role: string,
  ): number => {
    if (result?.status === "success" && typeof result.result === "number") return result.result;
    throw new VexError(
      ErrorCodes.MORPHO_RPC_ERROR,
      `The market's ${role} token ${token.toLowerCase()} did not answer decimals(), so no amount denominated in it `
      + "can be read at any scale. The operation is refused rather than computed with a guessed scale.",
      "Retry the read. A raw amount without its decimals is off by a factor of a thousand or more, so Vex will not "
      + "act on one.",
    );
  };
  const readSymbol = (result: (typeof loanSymbol)): string | null =>
    result?.status === "success" && typeof result.result === "string" ? result.result : null;

  const market = await client.morpho.blue(marketParams, chainId).getMarketData();
  const totalSupplyAssetsRaw = market.totalSupplyAssets;
  const totalBorrowAssetsRaw = market.totalBorrowAssets;

  return {
    identity: {
      chainId,
      marketId: id,
      loanToken,
      loanDecimals: readScale(loanDecimals, loanToken, "loan"),
      loanSymbol: readSymbol(loanSymbol),
      collateralToken,
      collateralDecimals: readScale(collateralDecimals, collateralToken, "collateral"),
      collateralSymbol: readSymbol(collateralSymbol),
      oracle,
      irm,
      lltvRaw: lltv.toString(),
    },
    policy,
    snapshot: {
      totalSupplyAssetsRaw,
      totalBorrowAssetsRaw,
      // Clamped at zero deliberately. A market whose borrows exceed its supplies
      // by an accounting edge has NO free liquidity, and reporting a negative
      // number here would flow into a comparison as if it were a quantity.
      availableLiquidityRaw:
        totalSupplyAssetsRaw > totalBorrowAssetsRaw ? totalSupplyAssetsRaw - totalBorrowAssetsRaw : 0n,
    },
    marketParams,
  };
}

/** Read the wallet's position on a market, accrued to now, sentinel normalised. */
export async function readMorphoBluePosition(
  client: MorphoActionClient,
  chainId: number,
  marketParams: MarketParams,
  userAddress: Address,
): Promise<MorphoPositionSnapshot> {
  const position = await client.morpho.blue(marketParams, chainId).getPositionData(userAddress);
  return {
    collateralRaw: position.collateral,
    borrowSharesRaw: position.borrowShares,
    borrowAssetsRaw: position.borrowAssets,
    // THE SUPPLIER SIDE, read from the SAME accrued position. `supplyAssets` is
    // a derived getter over `supplyShares` at the market's current accrued
    // state, which is exactly what a withdrawal denominated in assets must be
    // measured against: the share count alone cannot say how much the wallet may
    // take out.
    supplySharesRaw: position.supplyShares,
    supplyAssetsRaw: position.supplyAssets,
    healthFactorWad: normalizeHealthFactor(position.healthFactor),
    // LTV carries no sentinel: it is simply absent on a position with no debt.
    // Normalised through its own expression rather than the health-factor
    // helper, so a future change to the sentinel rule cannot silently reinterpret
    // a ratio that never had one.
    ltvWad: position.ltv ?? null,
    maxBorrowAssetsRaw: position.maxBorrowAssets ?? null,
  };
}
