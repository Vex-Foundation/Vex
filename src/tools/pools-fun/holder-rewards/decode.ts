/**
 * What a holder-reward CLAIM and a permissionless DISTRIBUTE actually did,
 * proven from the receipt's own logs.
 *
 * THE RULE IS DECLINE, NEVER GUESS - the same rule
 * `sync/pools-settlement-decoder.ts` applies to a launch and a creator-fee
 * claim, for the same reason: a confirmed transaction whose amounts cannot be
 * proven leaves the row pending for the repair sweep rather than recording the
 * simulation as though it were a settlement.
 *
 * EMITTER PINNING. Every log is filtered to the ONE distributor the suite's
 * `HolderRewardsDeployer` named in its `DistributorDeployed` event before
 * anything is decoded. Any contract can emit a same-signature event; an unpinned
 * emitter would let an arbitrary address be recorded as the user's payout.
 *
 * EXACTLY ONE, not "the first one". A receipt carrying two claims for the same
 * account cannot be attributed to one row, and picking the first would be a
 * guess wearing a decoder's clothes.
 *
 * ── TWO CLAIM EVENT SHAPES, BOTH MEASURED ──────────────────────────────────
 *
 * The two live distributor runtimes emit DIFFERENT `RewardClaimed` events, and
 * a decoder that knew only one would decline every real receipt from the other -
 * silently, after the money had already moved. Both topics were read out of live
 * logs on chain 4663 on 2026-09-04
 * (`agents-colab/agents_dm/pools-holder-rewards-2026-09-04/probe_distributor_logs.json`)
 * and each signature was then confirmed by keccak PREIMAGE against that topic:
 *
 *   0x106f923f993c2149d49b4255ff723acafa1f2d94393f561d3eda32ae348f7241
 *     = `RewardClaimed(address,uint256)`      - the 13962-byte runtime, also in
 *       its Sourcify-verified ABI. ONE payout leg.
 *   0xf01da32686223933d8a18a391060918c7f11a3648639edd87ae013e2e2731743
 *     = `RewardClaimed(address,uint256,uint256)` - the 22171-byte runtime, which
 *       is NOT on Sourcify. TWO payout legs, the launched token then the paired
 *       asset. A live paired-mode receipt carried `(0, 7047...)` and a live
 *       both-mode receipt `(2118..., 991...)`, which is what proves the order.
 *
 * The observed topic COUNT (two) is what proves `account` is the indexed
 * argument on both. The parameter NAMES below are ours - a topic hash proves the
 * event name and the argument TYPES and nothing else - so they are labels for
 * reading this file and carry no wire meaning.
 *
 * ── THE CALLER BOUNTY ──────────────────────────────────────────────────────
 *
 *   0xb086364920ef62fba3dfe887892063a6385f14a0c3b2895c622a5aba78517ca4
 *     = `CallerBounty(address,uint256)`, on the 22171-byte runtime only.
 *
 * MEASURED, and it contradicts the launchpad: on the live distribute
 * `0x8022a2e0...` the caller `0x491a5b36...` received 1468600694080745304774 of
 * the LAUNCHED TOKEN, exactly 0.5 percent of the 293720138816149060954828 the
 * distributor moved, matching that runtime's `CALLER_BOUNTY_BPS()` of 50 - while
 * the launchpad's `paysCallerBounty` reads `false` on a distributor carrying the
 * same constant. The event itself names no asset; the asset above is the
 * receipt's own ERC-20 `Transfer` to the caller in that transaction, and this
 * decoder therefore reports the AMOUNT the distributor declared and does not
 * assert an asset the event does not carry.
 */

import { decodeEventLog, getAddress, toEventSelector, type Address, type Hex } from "viem";

/** One receipt log, as these decoders read it. Mirrors `PoolsSettlementLog`. */
export interface PoolsHolderRewardsLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/** The 13962-byte runtime's claim event: ONE payout leg. */
export const POOLS_REWARD_CLAIMED_SINGLE_EVENT_ABI = {
  type: "event",
  name: "RewardClaimed",
  anonymous: false,
  inputs: [
    { name: "account", type: "address", indexed: true, internalType: "address" },
    { name: "amount", type: "uint256", indexed: false, internalType: "uint256" },
  ],
} as const;

/** The 22171-byte runtime's claim event: the token leg THEN the paired leg. */
export const POOLS_REWARD_CLAIMED_DUAL_EVENT_ABI = {
  type: "event",
  name: "RewardClaimed",
  anonymous: false,
  inputs: [
    { name: "account", type: "address", indexed: true, internalType: "address" },
    { name: "amount", type: "uint256", indexed: false, internalType: "uint256" },
    { name: "amountPaired", type: "uint256", indexed: false, internalType: "uint256" },
  ],
} as const;

/** The permissionless caller's incentive, on the 22171-byte runtime only. */
export const POOLS_CALLER_BOUNTY_EVENT_ABI = {
  type: "event",
  name: "CallerBounty",
  anonymous: false,
  inputs: [
    { name: "caller", type: "address", indexed: true, internalType: "address" },
    { name: "amount", type: "uint256", indexed: false, internalType: "uint256" },
  ],
} as const;

export const POOLS_REWARD_CLAIMED_SINGLE_TOPIC = toEventSelector("RewardClaimed(address,uint256)");
export const POOLS_REWARD_CLAIMED_DUAL_TOPIC = toEventSelector("RewardClaimed(address,uint256,uint256)");
export const POOLS_CALLER_BOUNTY_TOPIC = toEventSelector("CallerBounty(address,uint256)");

/** A holder-reward claim proven to be ours. */
export interface DecodedPoolsHolderRewardClaim {
  readonly account: Address;
  readonly distributor: Address;
  readonly tokenAmountRaw: bigint;
  /** `null` on the single-leg runtime: the absence of a leg, never a zero. */
  readonly pairedAmountRaw: bigint | null;
  readonly shape: "single" | "dual";
}

/** What a distribute receipt proved. A distribute has no leg the caller is owed. */
export interface DecodedPoolsRewardDistribution {
  readonly distributor: Address;
  /**
   * The bounty the distributor declared it paid this caller, or `null` when it
   * declared none - which is the ordinary case: the bounty comes out of the
   * buyback, so a distribute that bought nothing back pays nothing.
   *
   * The event carries no asset, so neither does this. The measured case paid the
   * launched token.
   */
  readonly bountyAmountRaw: bigint | null;
}

export type PoolsHolderRewardsDecodeOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

function logsFrom(
  logs: readonly PoolsHolderRewardsLog[],
  emitter: string,
  topic: string,
): readonly PoolsHolderRewardsLog[] {
  return logs.filter((log) => sameAddress(log.address, emitter) && log.topics[0] === topic);
}

/**
 * Decode a holder-reward claim receipt, proving it is OURS.
 *
 * `distributor` is the address the deployer's `DistributorDeployed` event named
 * and the transaction was actually sent to - the caller knows it, because it
 * simulated and broadcast against exactly that address. It is REQUIRED: without
 * it there is no way to tell a real payout from a same-signature event any
 * contract in the receipt could have emitted.
 *
 * A claim of zero is a legitimate outcome and decodes successfully; the caller
 * reports the zero. What never decodes is a receipt that does not prove which
 * amounts this account was paid.
 */
export function decodePoolsHolderRewardClaim(
  logs: readonly PoolsHolderRewardsLog[],
  expected: { readonly account: Address; readonly distributor: Address },
): PoolsHolderRewardsDecodeOutcome<DecodedPoolsHolderRewardClaim> {
  const single = logsFrom(logs, expected.distributor, POOLS_REWARD_CLAIMED_SINGLE_TOPIC);
  const dual = logsFrom(logs, expected.distributor, POOLS_REWARD_CLAIMED_DUAL_TOPIC);

  // ONE runtime emitted this receipt. A distributor answering with both shapes
  // is not a contract this repository has measured, and reading one of the two
  // would be choosing which account of the payout to believe.
  if (single.length > 0 && dual.length > 0) {
    return {
      ok: false,
      reason:
        `the distributor ${expected.distributor} emitted BOTH RewardClaimed shapes in one receipt `
        + "(the one-leg and the two-leg event); no single reading of what it paid can be trusted",
    };
  }
  if (single.length === 0 && dual.length === 0) {
    return {
      ok: false,
      reason: `no RewardClaimed event from the pinned distributor ${expected.distributor} in this receipt`,
    };
  }

  const shape: "single" | "dual" = dual.length > 0 ? "dual" : "single";
  const candidates = shape === "dual" ? dual : single;
  const abi = shape === "dual"
    ? POOLS_REWARD_CLAIMED_DUAL_EVENT_ABI
    : POOLS_REWARD_CLAIMED_SINGLE_EVENT_ABI;

  const decoded: DecodedPoolsHolderRewardClaim[] = [];
  for (const log of candidates) {
    let args;
    try {
      args = decodeEventLog({
        abi: [abi],
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      }).args as { account: Address; amount: bigint; amountPaired?: bigint };
    } catch {
      // A log that does not decode against the measured ABI is not evidence of
      // anything; it is skipped rather than allowed to fail a receipt that may
      // still carry our real claim.
      continue;
    }
    if (!sameAddress(args.account, expected.account)) continue;
    decoded.push({
      account: getAddress(args.account),
      distributor: getAddress(expected.distributor),
      tokenAmountRaw: args.amount,
      pairedAmountRaw: shape === "dual" ? (args.amountPaired ?? 0n) : null,
      shape,
    });
  }

  if (decoded.length === 0) {
    return {
      ok: false,
      reason:
        `the receipt carries RewardClaimed events from the distributor ${expected.distributor}, but none paid to `
        + `${expected.account}`,
    };
  }
  if (decoded.length > 1) {
    return {
      ok: false,
      reason:
        `${decoded.length} RewardClaimed events for this account from one distributor in one receipt; the payout `
        + "cannot be attributed to a single claim row",
    };
  }
  return { ok: true, value: decoded[0]! };
}

/**
 * Read what a permissionless distribute did for its caller.
 *
 * NEVER a refusal, and that asymmetry is deliberate: a distribute owes its
 * caller NOTHING, so there is no leg whose absence could mean the receipt was
 * misread. The only question this answers is whether the distributor declared a
 * bounty for this caller, and "it declared none" is a complete answer.
 *
 * More than one bounty for the same caller in one receipt IS a refusal, because
 * then the receipt describes more than one distribute and no single number is
 * this row's.
 */
export function decodePoolsRewardDistribution(
  logs: readonly PoolsHolderRewardsLog[],
  expected: { readonly caller: Address; readonly distributor: Address },
): PoolsHolderRewardsDecodeOutcome<DecodedPoolsRewardDistribution> {
  const bounties: bigint[] = [];
  for (const log of logsFrom(logs, expected.distributor, POOLS_CALLER_BOUNTY_TOPIC)) {
    try {
      const args = decodeEventLog({
        abi: [POOLS_CALLER_BOUNTY_EVENT_ABI],
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      }).args as { caller: Address; amount: bigint };
      if (!sameAddress(args.caller, expected.caller)) continue;
      bounties.push(args.amount);
    } catch {
      continue;
    }
  }

  if (bounties.length > 1) {
    return {
      ok: false,
      reason:
        `${bounties.length} CallerBounty events for ${expected.caller} from the distributor in one receipt; no `
        + "single amount belongs to this row",
    };
  }
  return {
    ok: true,
    value: {
      distributor: getAddress(expected.distributor),
      bountyAmountRaw: bounties[0] ?? null,
    },
  };
}
