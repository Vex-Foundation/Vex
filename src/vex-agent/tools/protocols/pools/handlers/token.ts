/**
 * `pools.token` handler - one token, joined across the launchpad and the chain
 * (READ-ONLY).
 *
 * The output is split into two labelled groups because the two halves have
 * different evidential weight: `api` is the provider's display-grade market row,
 * `onchain` is what the PartyLocker and the token contract actually say at a
 * named block. Merging them would hand the agent a single object in which a
 * guessed price sits beside a proven decimals value with nothing to tell them
 * apart - rule 90's display-versus-financial split, made visible in the payload.
 *
 * DECLINE OVER GUESS: a `platform=sushi` token belongs to the older
 * SushiLaunchpad's own registry, so this locker answers with zero addresses for
 * it. That is reported in words. The API half still answers, because the row is
 * real - it is only the locker fields that are unavailable.
 *
 * The chain read never fails the tool: an unreachable node costs the `onchain`
 * group and says why, rather than denying the agent the market row it could
 * have had.
 */

import type { Address } from "viem";
import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import { POOLS_CHAIN_SLUG, POOLS_LOCKER_ADDRESS, POOLS_POOL_FEE_BPS } from "@tools/pools-fun/constants.js";
import { readPoolsOnChainSnapshot } from "@tools/pools-fun/evm/token-registration.js";
import type { PoolsOnChainSnapshot } from "@tools/pools-fun/evm/token-registration.js";
import { ok, fail } from "../../handler-helpers.js";
import { poolsFailureDetail } from "./failure.js";
import { projectToken } from "./project.js";
import type { ProtocolExecutionContext } from "../../types.js";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The `onchain` group. Every field group carries its own outcome, and a read
 * that did not answer is never rendered as a value.
 *
 * `lockerStatus` is the field the agent should branch on:
 *   `registered`   the locker holds this token; the pool/creator/fee fields are facts.
 *   `unregistered` the locker answered and has no entry - expected for a sushi
 *                  launcher token, and a real fact about the token.
 *   `unavailable`  the call did not answer. NOTHING about the registration was
 *                  proven, and in particular this does NOT mean unregistered.
 */
function projectOnChain(snapshot: PoolsOnChainSnapshot): Record<string, unknown> {
  const base: Record<string, unknown> = {
    source: "onchain",
    blockNumber: snapshot.blockNumber,
    ...(snapshot.decimals.status === "ok"
      ? { decimals: snapshot.decimals.value }
      : {
        decimalsUnavailable:
            "The token's decimals() call did not answer at this block. The decimals are UNKNOWN, not absent - "
            + "do not assume 18.",
      }),
    ...(snapshot.metadataUri.status === "ok"
      ? { metadataUri: snapshot.metadataUri.value }
      : {
        metadataUriUnavailable:
            "The token's metadataUri() call did not answer at this block. This is not the same as a token "
            + "without metadata.",
      }),
  };

  if (snapshot.locker.status === "unavailable") {
    return {
      ...base,
      lockerStatus: "unavailable",
      // The distinction this whole tri-state exists for: a failed call is not
      // evidence that the token is unregistered, and saying so would put a
      // claim in front of the agent that nothing supports.
      lockerNote:
        `The PartyLocker read (${POOLS_LOCKER_ADDRESS}) did not answer at this block. Whether this token is `
        + "registered with pools.fun was NOT determined - this is a failed read, not a token without a "
        + "registration. Retry before drawing any conclusion about its pool, creator or fees.",
    };
  }

  if (snapshot.locker.status === "unregistered") {
    return {
      ...base,
      lockerStatus: "unregistered",
      // The locker ANSWERED here, with its all-zero row. That is a fact, and it
      // is reported as words rather than as 0x000...0 fields that read as data.
      lockerNote:
        `The PartyLocker (${POOLS_LOCKER_ADDRESS}) answered and has no entry for this token. That is expected `
        + "for a token launched by the older sushi launcher, which keeps its own registry: the pool, creator, "
        + "fee recipient and fee split are UNAVAILABLE from here rather than zero. The launchpad row above "
        + "still describes it.",
    };
  }

  const info = snapshot.locker.info;
  return {
    ...base,
    lockerStatus: "registered",
    pool: info.pool,
    pairedAssetAddress: info.pairedAssetAddress,
    creator: info.creator,
    feeRecipient: info.feeRecipient,
    lockedPositionIds: info.lockedPositionIds,
    poolFeeBps: POOLS_POOL_FEE_BPS,
    ...(info.feeSplitAvailable
      ? { feeSplitBps: info.feeSplitBps }
      : {
        feeSplitUnavailable:
            "The getPoolSplits() call did not answer at this block, although the registration did. The fee "
            + "split is UNKNOWN for now; the pool still charges its 1 percent fee.",
      }),
  };
}

export async function poolsTokenHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const tokenAddress = typeof p.tokenAddress === "string" ? p.tokenAddress.trim() : "";
  if (!tokenAddress) {
    return fail("Missing required: tokenAddress (the contract address of the token to inspect).");
  }
  if (!EVM_ADDRESS.test(tokenAddress)) {
    return fail(
      `"tokenAddress" must be a contract address (0x followed by 40 hex characters), received "${tokenAddress}". `
        + "Resolve a name or symbol to an address with pools__tokens_search first.",
    );
  }

  // The API half. `platform: "all"` because the caller may hand over a token
  // from either launcher and the tool must not decide which one they meant.
  let apiRow: ReturnType<typeof projectToken> | null = null;
  try {
    const page = await getPoolsFunClient().discover(
      { platform: "all", query: tokenAddress, limit: 10 },
      { signal: context.abortSignal },
    );
    const now = Date.now();
    const match = page.results.find(
      (row) => row.tokenAddress.toLowerCase() === tokenAddress.toLowerCase(),
    );
    apiRow = match ? projectToken(match, now) : null;
  } catch (err) {
    return fail(`pools.fun token detail unavailable (${poolsFailureDetail("pools__token_get", err)})`);
  }

  // The chain half. Guarded separately so a node problem costs one group, not
  // the whole answer - and so the reason is NAMED instead of silently missing.
  let onchain: Record<string, unknown>;
  try {
    onchain = projectOnChain(await readPoolsOnChainSnapshot(tokenAddress as Address));
  } catch (err) {
    onchain = {
      source: "onchain",
      unavailable: `The on-chain read failed: ${poolsFailureDetail("pools__token_get", err)}. `
        + "Nothing about the pool, creator, fee split or decimals was proven either way.",
    };
  }

  return ok({
    chain: POOLS_CHAIN_SLUG,
    token: tokenAddress,
    api: apiRow
      ? { source: "api", ...apiRow }
      : {
        source: "api",
        unavailable:
            "The pools.fun launchpad has no row for this address. It may not be a token from either launcher on "
            + "this chain, or the launchpad has not indexed it yet.",
      },
    onchain,
    note: "The api group is the launchpad's own display-grade market data; the onchain group was read from the "
      + "contracts at the stated block. Every pools.fun pool charges a 1 percent fee, split as feeSplitBps. "
      + "Trade these tokens with kyberswap; research the pool with dexscreener.",
  });
}
