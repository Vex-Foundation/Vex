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
 * DECLINE OVER GUESS: pools.fun runs three contract suites side by side, and
 * which one holds a token is DETECTED (locker and gateway must agree) rather
 * than assumed from a pinned address. A token no suite claims is reported in
 * those words; a token two suites claim, or one suite half-claims, is reported
 * as the contradiction it is. The API half still answers in every case, because
 * the row is real - it is only the on-chain fields that are unavailable.
 *
 * The chain read never fails the tool: an unreachable node costs the `onchain`
 * group and says why, rather than denying the agent the market row it could
 * have had.
 */

import type { Address } from "viem";
import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import { POOLS_CHAIN_SLUG, POOLS_POOL_FEE_BPS } from "@tools/pools-fun/constants.js";
import {
  POOLS_UNREGISTERED_SENTENCE,
  readPoolsOnChainSnapshot,
} from "@tools/pools-fun/evm/token-registration.js";
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
 *   `registered`   exactly one suite's locker AND gateway agree that they hold
 *                  this token; `suite`, the pool, creator and fee fields are facts.
 *   `unregistered` every known suite answered and none holds it - a real fact
 *                  about the token, and the answer for a token from another
 *                  launchpad on this chain.
 *   `ambiguous`    two suites claim it, or one suite disagrees with itself.
 *                  Something true is not described here; no pool fields are emitted.
 *   `unavailable`  at least one suite could not be asked. NOTHING about the
 *                  registration was proven, and this does NOT mean unregistered.
 */
function projectOnChain(
  snapshot: PoolsOnChainSnapshot,
  apiPlatform: string | null,
): Record<string, unknown> {
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
        `${snapshot.locker.detail} Retry before drawing any conclusion about its pool, creator or fees.`,
    };
  }

  // A CONTRADICTION IS ITS OWN ANSWER. Two suites claiming one token, or one
  // suite's locker and gateway disagreeing, is a state no single set of pool
  // fields describes - so none are emitted, and the disagreement is the finding.
  if (snapshot.locker.status === "ambiguous") {
    return {
      ...base,
      lockerStatus: "ambiguous",
      lockerNote:
        `${snapshot.locker.detail} No pool, creator, fee recipient or fee split is reported, because reporting `
        + "one suite's answer would hide the disagreement.",
    };
  }

  if (snapshot.locker.status === "unregistered") {
    return {
      ...base,
      lockerStatus: "unregistered",
      // Every known suite ANSWERED and none claimed it. That is a fact, reported
      // as words rather than as 0x000...0 fields that read as data.
      //
      // THE SUSHI SENTENCE IS EARNED, NOT INFERRED. The old wording told every
      // caller that an absent registration meant "the older sushi launcher",
      // which is how a V3 token got described as a sushi token (measured
      // 2026-09-04). The launcher is now named only when the launchpad's OWN row
      // says `platform: "sushi"`; otherwise the answer stops at what was proven.
      lockerNote:
        `This token is ${POOLS_UNREGISTERED_SENTENCE}: every suite's locker and gateway answered at this block `
        + "and none of them holds it. The pool, creator, fee recipient and fee split are UNAVAILABLE from here "
        + "rather than zero, and pools.fun creator fees cannot be claimed for it. The launchpad row above still "
        + "describes it."
        + (apiPlatform === "sushi"
          ? " The launchpad row labels it platform=sushi, so it belongs to the older SushiLaunchpad, which keeps"
            + " its own registry."
          : ""),
    };
  }

  const info = snapshot.locker.info;
  return {
    ...base,
    lockerStatus: "registered",
    // WHICH suite, named. Two contracts had to agree for this to be reported,
    // and a caller that needs the addresses (a claim, a decoder) uses this
    // rather than re-deriving them.
    suite: {
      version: snapshot.locker.suite.version,
      gateway: snapshot.locker.suite.gateway,
      factory: snapshot.locker.suite.factory,
      locker: snapshot.locker.suite.locker,
      ...(snapshot.locker.suite.holderRewardsDeployer === undefined
        ? {}
        : { holderRewardsDeployer: snapshot.locker.suite.holderRewardsDeployer }),
    },
    launcher: snapshot.locker.launcher,
    pool: info.pool,
    pairedAssetAddress: info.pairedAssetAddress,
    creator: info.creator,
    feeRecipient: info.feeRecipient,
    lockedPositionIds: info.lockedPositionIds,
    poolFeeBps: POOLS_POOL_FEE_BPS,
    ...(info.feeSplitAvailable && info.feeSplitBps !== null
      ? {
        feeSplitBps: info.feeSplitBps,
        // The split is READ LIVE per token and it CHANGED with the suites: V1
        // pools split 2000/2500/3000/2500 with a real community bucket, while
        // pools created on V2/V3 split 9000/500/500/0 - the community bucket is
        // zero there, not missing. A reader who knows the old numbers would
        // otherwise assume a failed read, so the zero is stated in words.
        feeSplitNote:
            info.feeSplitBps.community === 0
              ? "Read live from this pool's own locker entry: community bucket 0 on this pool. That is the "
                + "pool's actual configuration, not an unread field."
              : "Read live from this pool's own locker entry; this pool carries a non-zero community bucket, "
                + "the split pools.fun used for its earlier pools.",
      }
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
    onchain = projectOnChain(
      await readPoolsOnChainSnapshot(tokenAddress as Address),
      // The launchpad's own platform label, and the ONLY evidence allowed to
      // name the older sushi launcher in the unregistered note.
      typeof apiRow?.platform === "string" ? apiRow.platform : null,
    );
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
