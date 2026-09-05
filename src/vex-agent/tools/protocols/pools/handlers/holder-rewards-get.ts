/**
 * `pools.holder_rewards` handler - one fees-to-holders token, read from the
 * CHAIN with the launchpad's answer shown beside it (READ-ONLY, signs nothing).
 *
 * THE AUTHORITY TABLE THIS IMPLEMENTS (plan v3 section 2, A5), verbatim:
 *
 *   fact                | authority                                  | binding
 *   --------------------|--------------------------------------------|------------------------
 *   token, suite        | suite table + locker/gateway agreement      | the result names the suite
 *   distributor         | `DistributorDeployed` log of the suite's    | the result shows the
 *                       | HolderRewardsDeployer                       | distributor address
 *   reward mode         | the `rewardMode` argument of that same log  | the result shows the mode
 *   wallet              | the session wallet; `earned(wallet)` on     | raw + human, with decimals
 *                       | the distributor is the money authority      |
 *   assets, decimals    | token + paired asset read on-chain          | the result echoes both
 *
 * The API value is an ECHO in every row of that table, and a disagreement is
 * REPORTED IN WORDS rather than resolved silently. Both are fetched: the
 * launchpad's read carries pool-level context the contracts do not expose in one
 * call (the buyback backlog, pending fees, the caller bounty), and its wallet
 * figures are shown beside the on-chain ones so a divergence is visible instead
 * of averaged away.
 *
 * FIVE OUTCOMES, NOT TWO. A token with no distributor is a typed
 * "no holder rewards on this token", never a row of zeros; a token on suite V1
 * is named as being on a suite that has no holder rewards at all; a token no
 * suite registers is a different fact again; and a read that did not answer is
 * `unavailable` and says nothing about the token.
 */

import type { Address } from "viem";

import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import { POOLS_CHAIN_SLUG } from "@tools/pools-fun/constants.js";
import { readPoolsOnChainSnapshot } from "@tools/pools-fun/evm/token-registration.js";
import { readPoolsHolderRewardsOnChain } from "@tools/pools-fun/holder-rewards/read.js";
import type {
  PoolsHolderRewardsOnChain,
  PoolsRewardLeg,
} from "@tools/pools-fun/holder-rewards/read.js";
import type { PoolsHolderRewards } from "@tools/pools-fun/types.js";
import { resolveSelectedAddressForRead } from "../../../internal/wallet/resolve.js";
import { ok, fail } from "../../handler-helpers.js";
import { poolsFailureDetail } from "./failure.js";
import { isEvmAddress, readAddressParam } from "./project.js";
import type { ProtocolExecutionContext } from "../../types.js";

/**
 * Render a raw base-unit amount as a decimal string WITHOUT floating point.
 *
 * `null` decimals means the scale is unknown, and an unknown scale produces no
 * human figure at all - a number at a guessed scale is worse than none
 * (rule 90). String arithmetic, never `Number`: these are uint256 values.
 */
function humanAmount(raw: string, decimals: number | null): string | null {
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 77) return null;
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function projectLeg(leg: PoolsRewardLeg): Record<string, unknown> {
  const human = humanAmount(leg.earnedRaw, leg.decimals);
  return {
    asset: leg.asset,
    symbol: leg.symbol,
    decimals: leg.decimals,
    earnedRaw: leg.earnedRaw,
    ...(human !== null
      ? { earned: human }
      : {
        earnedUnavailable:
            "The asset's decimals() did not answer, so the raw amount above cannot be scaled. Do not assume 18.",
      }),
  };
}

/** The launchpad's echo, projected as an echo: labelled, and never merged into the chain group. */
function projectApi(api: PoolsHolderRewards): Record<string, unknown> {
  return {
    source: "api",
    distributor: api.distributor,
    rewardMode: api.rewardMode,
    pairedAsset: api.pairedAsset,
    pairedSymbol: api.pairedSymbol,
    pairedDecimals: api.pairedDecimals,
    conversion: api.conversion,
    paysCallerBounty: api.paysCallerBounty,
    eligibleSupplyRaw: api.eligibleSupply,
    rewardRateRaw: api.rewardRate,
    rewardRatePairedRaw: api.rewardRatePaired,
    remainingStreamRaw: api.remainingStream,
    remainingStreamPairedRaw: api.remainingStreamPaired,
    surplusRaw: api.surplus,
    surplusPairedRaw: api.surplusPaired,
    buybackBacklogRaw: api.buybackBacklog,
    periodFinish: api.periodFinish,
    periodFinishPaired: api.periodFinishPaired,
    lastBuybackAt: api.lastBuybackAt,
    pendingFees: api.pendingFees,
    hasWorkToDistribute: api.hasWorkToDistribute,
    walletEarnedRaw: api.earned,
    walletEarnedPairedRaw: api.earnedPaired,
    walletExcluded: api.walletExcluded,
    note:
      "The launchpad's own numbers, shown for context. Where they overlap with the onchain group above, the "
      + "onchain group is the authority: the distributor's earned(wallet) is what a claim would actually pay, "
      + "and the deployer's event is what names the distributor and the mode.",
  };
}

export async function poolsHolderRewardsGetHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const tokenAddress = typeof p.tokenAddress === "string" ? p.tokenAddress.trim() : "";
  if (!tokenAddress) {
    return fail("Missing required: tokenAddress (the fees-to-holders token to read).");
  }
  if (!isEvmAddress(tokenAddress)) {
    return fail(
      `"tokenAddress" must be a contract address (0x followed by 40 hex characters), received "${tokenAddress}". `
        + "Resolve a name to an address with pools__tokens_search first.",
    );
  }

  // The wallet defaults to the session's, and may be overridden because
  // `earned(account)` is a public view over public chain state - reading another
  // holder's balance discloses nothing the chain does not already publish. The
  // session wallet is the default so the ordinary question needs no argument.
  const walletRead = readAddressParam(p, "walletAddress");
  if (!walletRead.ok) return fail(walletRead.reason);
  let wallet = walletRead.value;
  if (wallet === null) {
    try {
      wallet = resolveSelectedAddressForRead(
        context.walletResolution,
        context.walletPolicy,
        "eip155",
      );
    } catch (err) {
      return fail(
        `pools__holder_rewards_get needs a wallet: ${err instanceof Error ? err.message : String(err)} `
          + "Pass walletAddress to read a specific holder instead.",
      );
    }
  }

  // Which suite holds the token, decided ONCE by the shared detector so this
  // tool cannot disagree with `pools__token_get` about it.
  let suiteVersion: 1 | 2 | 3 | null = null;
  let suiteDetail: string | null = null;
  try {
    const snapshot = await readPoolsOnChainSnapshot(tokenAddress as Address);
    if (snapshot.locker.status === "registered") {
      suiteVersion = snapshot.locker.suite.version;
    } else if (snapshot.locker.status === "unregistered") {
      suiteDetail = "no pools.fun contract suite holds this token, so no suite has a holder-rewards deployer to ask";
    } else {
      suiteDetail = snapshot.locker.detail;
    }
  } catch (err) {
    return fail(
      `pools.fun holder rewards unavailable (${poolsFailureDetail("pools__holder_rewards_get", err)}). `
        + "Which suite holds this token was not established, so nothing about its holder rewards was either.",
    );
  }

  if (suiteVersion === null) {
    return ok({
      chain: POOLS_CHAIN_SLUG,
      token: tokenAddress,
      wallet,
      status: "suite_unresolved",
      detail: `${suiteDetail ?? "the suite could not be established"}.`,
      note:
        "Nothing about this token's holder rewards was proven. This is NOT the same as the token having none - "
        + "read pools__token_get for the registration verdict first.",
    });
  }

  let onchain: PoolsHolderRewardsOnChain;
  try {
    onchain = await readPoolsHolderRewardsOnChain({
      token: tokenAddress as Address,
      wallet: wallet as Address,
      suiteVersion,
    });
  } catch (err) {
    return fail(
      `pools.fun holder rewards unavailable (${poolsFailureDetail("pools__holder_rewards_get", err)})`,
    );
  }

  if (onchain.status === "suite_without_holder_rewards") {
    return ok({
      chain: POOLS_CHAIN_SLUG,
      token: tokenAddress,
      wallet,
      status: "unsupported_on_this_suite",
      suite: { version: onchain.suiteVersion },
      detail:
        `This token is registered on pools.fun contract suite V${onchain.suiteVersion}, which has no holder-rewards `
        + "deployer at all: fees to holders did not exist yet when that suite was deployed. There is no "
        + "distributor to read and none can appear, because the mode is locked at launch.",
    });
  }

  if (onchain.status === "token_not_registered") {
    return ok({
      chain: POOLS_CHAIN_SLUG,
      token: tokenAddress,
      wallet,
      status: "suite_unresolved",
      detail: "no pools.fun contract suite holds this token.",
    });
  }

  if (onchain.status === "unavailable") {
    return fail(
      `pools.fun holder rewards unavailable: ${onchain.detail} Nothing was proven either way; retry before `
        + "concluding this token has no holder rewards.",
    );
  }

  if (onchain.status === "no_holder_rewards") {
    return ok({
      chain: POOLS_CHAIN_SLUG,
      token: tokenAddress,
      wallet,
      status: "no_holder_rewards",
      suite: { version: onchain.suiteVersion, holderRewardsDeployer: onchain.deployer },
      blockNumber: onchain.blockNumber,
      detail:
        "This token does not stream fees to holders. The suite's HolderRewardsDeployer has emitted no "
        + "DistributorDeployed event for it, so there is no distributor and no reward to claim - this is a "
        + "fact about the token, not a failed read. Fees to holders is opted into AT LAUNCH and cannot be "
        + "turned on afterwards.",
    });
  }

  // The launchpad's echo. It is fetched AFTER the chain read and never gates it:
  // a provider outage costs the echo, not the answer.
  let api: PoolsHolderRewards | null = null;
  let apiDetail: string | null = null;
  try {
    api = await getPoolsFunClient().holderRewards(
      { tokenAddress, walletAddress: wallet },
      { signal: context.abortSignal },
    );
  } catch (err) {
    apiDetail = poolsFailureDetail("pools__holder_rewards_get", err);
  }

  const disagreements: string[] = [];
  if (api !== null) {
    if (api.distributor.toLowerCase() !== onchain.distributor.toLowerCase()) {
      disagreements.push(
        `the launchpad names distributor ${api.distributor} while the suite's HolderRewardsDeployer emitted `
          + `${onchain.distributor} for this token - the event is the authority, and this disagreement means the `
          + "launchpad is describing a different contract",
      );
    }
    if (api.rewardMode !== null && onchain.rewardMode !== null && api.rewardMode !== onchain.rewardMode) {
      disagreements.push(
        `the launchpad calls the reward mode "${api.rewardMode}" while the DistributorDeployed event recorded `
          + `"${onchain.rewardMode}" - the event is the authority`,
      );
    }
  }
  if (api !== null && api.earned !== null && api.earned !== onchain.tokenLeg.earnedRaw) {
    // Not necessarily a defect: the two reads are at different instants and this
    // reward streams continuously, so a small difference is expected. It is
    // still SHOWN, because the alternative is an agent quoting one number while
    // a claim pays the other.
    disagreements.push(
      `the launchpad reports ${api.earned} earned in base units where the distributor's earned(wallet) returned `
        + `${onchain.tokenLeg.earnedRaw} at block ${onchain.blockNumber} - rewards stream continuously, so the two `
        + "reads can differ by the time between them; the on-chain figure is what a claim would pay",
    );
  }
  if (
    onchain.distributorSelfReportedMode !== null
    && onchain.rewardMode !== null
    && onchain.distributorSelfReportedMode !== onchain.rewardMode
  ) {
    disagreements.push(
      `the distributor's own rewardMode() says "${onchain.distributorSelfReportedMode}" while the deployer's event `
        + `recorded "${onchain.rewardMode}" - the event is the authority`,
    );
  }
  if (
    onchain.distributorToken !== null
    && onchain.distributorToken.toLowerCase() !== tokenAddress.toLowerCase()
  ) {
    disagreements.push(
      `the distributor's token() is ${onchain.distributorToken}, which is not the token that was asked about`,
    );
  }

  const periodFinishMs = onchain.periodFinish === null ? null : onchain.periodFinish * 1000;

  return ok({
    chain: POOLS_CHAIN_SLUG,
    token: tokenAddress,
    wallet: onchain.wallet,
    status: "ok",
    onchain: {
      source: "onchain",
      blockNumber: onchain.blockNumber,
      suite: { version: onchain.suiteVersion, holderRewardsDeployer: onchain.deployer },
      distributor: onchain.distributor,
      rewardMode: onchain.rewardMode,
      ...(onchain.rewardMode === null ? { rewardModeWire: onchain.rewardModeWire } : {}),
      rewardModeAuthority:
        "the rewardMode argument of the DistributorDeployed event the suite's HolderRewardsDeployer emitted for "
        + "this token, at the block named above",
      earned: {
        token: projectLeg(onchain.tokenLeg),
        ...(onchain.pairedLeg !== null
          ? { paired: projectLeg(onchain.pairedLeg) }
          : {
            pairedUnavailable:
                "This distributor has no earnedPaired(address) function, so it has no paired reward leg to read. "
                + "That is the absence of a leg, not a zero balance.",
          }),
      },
      walletExcluded: onchain.walletExcluded,
      eligibleSupplyRaw: onchain.eligibleSupplyRaw,
      rewardRateRaw: onchain.rewardRateRaw,
      remainingStreamRaw: onchain.remainingStreamRaw,
      periodFinish: onchain.periodFinish,
      ...(periodFinishMs !== null && periodFinishMs > 0
        ? { periodFinishIso: new Date(periodFinishMs).toISOString() }
        : {}),
      isStockPair: onchain.isStockPair,
      distributorFactory: onchain.distributorFactory,
    },
    ...(api !== null ? { api: projectApi(api) } : {}),
    ...(api === null && apiDetail !== null
      ? {
        apiUnavailable:
            `The launchpad's own holder-rewards read failed (${apiDetail}). Every figure above still comes from `
            + "the contracts, so only the provider's context is missing.",
      }
      : {}),
    ...(disagreements.length > 0
      ? {
        disagreements,
        disagreementNote:
            "The chain and the launchpad do not describe the same thing. Nothing above was silently reconciled: "
            + "act on the on-chain values and treat the launchpad's as unreliable for this token.",
      }
      : {}),
    note:
      "Amounts are RAW base units plus a scaled figure where the asset's decimals could be read. earned is what "
      + "the distributor would pay this wallet right now and it streams over 24 hours, so it grows between reads. "
      + "This tool signs nothing and claims nothing.",
  });
}
