/**
 * The on-chain half of `pools.token`: what the locker and the token contract
 * know that the REST API does not.
 *
 * Four reads, batched through Multicall3 at ONE pinned block so the answer is
 * internally consistent and auditable:
 *   PartyLocker.getPoolInfo(token)   canonical pool, paired asset ADDRESS,
 *                                    creator, fee recipient, locked LP ids
 *   PartyLocker.getPoolSplits(token) fee split in basis points
 *   PartyToken.decimals()            the financial-grade number the API omits
 *   PartyToken.metadataUri()         the launcher's metadata pointer
 *
 * THREE OUTCOMES, NOT TWO (rule 90, decline over guess). Every read here can end
 * three different ways, and collapsing the last two is how a tool starts lying:
 *
 *   registered   the locker answered, with a real pool - a fact.
 *   unregistered the locker answered, with the all-zero row it returns for a
 *                token it never registered - also a fact, and the expected
 *                answer for a SushiLaunchpad token.
 *   unavailable  the call did not answer at all (node down, wrong ABI, chain
 *                unreachable) - NOT a fact about the token, and the one case
 *                that must never be reported as either of the others.
 *
 * An earlier version mapped a FAILED call to `registered: false`, which told the
 * agent "this token is not a pools.fun token" on the strength of an RPC error.
 * The same collapse applied to `decimals` and `metadataUri`: a failed read
 * became `null`, indistinguishable from a contract that genuinely has no
 * `metadataUri`. Each of those now carries its own outcome.
 *
 * The Robinhood chain wiring is NOT duplicated here: `evm-chains/registry.ts`
 * owns the RPC, the user's RPC override and the Multicall3 address, exactly as
 * kyberswap and uniswap consume it.
 */

import type { Address, Chain, PublicClient, Transport } from "viem";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getLocalPublicClient } from "@tools/evm-chains/evm-client.js";
import { PARTY_LOCKER_ABI, PARTY_TOKEN_ABI } from "../abi.js";
import { POOLS_CHAIN_ID, POOLS_LOCKER_ADDRESS } from "../constants.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Fee split of the pool's 1% fee, in basis points, as the locker reports it. */
export interface PoolsFeeSplitBps {
  creator: number;
  platform: number;
  buyback: number;
  community: number;
  /** Stock-paired curves split differently: creator vs protocol, no community leg. */
  stockCreator: number;
  stockProtocol: number;
}

/** What the locker knows about a token it registered. */
export interface PoolsLockerInfo {
  pairedAssetAddress: string;
  pool: string;
  creator: string;
  feeRecipient: string;
  /** LP position ids the locker holds forever for this token. */
  lockedPositionIds: string[];
  /**
   * Tri-state, for the same reason the registration is: the splits are a
   * SECOND call and can fail while `getPoolInfo` succeeds. `null` here means
   * that call did not answer, and the handler says so rather than implying the
   * token has no fee split.
   */
  feeSplitBps: PoolsFeeSplitBps | null;
  feeSplitAvailable: boolean;
}

/** One read that either produced a value or explicitly did not. */
export type PoolsRead<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "unavailable" };

/** The locker's answer about a token: a registration, a denial, or silence. */
export type PoolsLockerRegistration =
  | { readonly status: "registered"; readonly info: PoolsLockerInfo }
  | { readonly status: "unregistered" }
  | { readonly status: "unavailable" };

/**
 * The on-chain snapshot for one token, pinned to `blockNumber`.
 *
 * Every member is independently tri-state because every member is an
 * independent call inside the batch: `allowFailure` is on so one reverting
 * contract cannot take the others down, which means "the others succeeded" and
 * "this one failed" must both be representable.
 */
export interface PoolsOnChainSnapshot {
  blockNumber: string;
  locker: PoolsLockerRegistration;
  decimals: PoolsRead<number>;
  /** `ok` with `null` means the contract answered with no URI; `unavailable` means it did not answer. */
  metadataUri: PoolsRead<string | null>;
}

function isZeroAddress(value: string): boolean {
  return value.toLowerCase() === ZERO_ADDRESS;
}

/** The Robinhood public client, from the shared registry. Throws if 4663 is missing. */
function poolsPublicClient(): PublicClient<Transport, Chain> {
  const config = getLocalChain(POOLS_CHAIN_ID);
  if (config === undefined) {
    throw new Error(`Local chain ${POOLS_CHAIN_ID} (Robinhood) is not registered.`);
  }
  return getLocalPublicClient(config);
}

/**
 * Read the locker registration, fee splits, decimals and metadata URI for one
 * token, all at the same pinned block.
 *
 * A THROWN error from this function means the batch itself could not be sent
 * (no chain, no node); a per-call failure inside the batch is reported as
 * `unavailable` on that member instead.
 */
export async function readPoolsOnChainSnapshot(token: Address): Promise<PoolsOnChainSnapshot> {
  const client = poolsPublicClient();
  const blockNumber = await client.getBlockNumber();
  const locker = POOLS_LOCKER_ADDRESS as Address;

  const [poolInfo, splits, decimals, metadataUri] = await client.multicall({
    allowFailure: true,
    blockNumber,
    contracts: [
      { address: locker, abi: PARTY_LOCKER_ABI, functionName: "getPoolInfo", args: [token] },
      { address: locker, abi: PARTY_LOCKER_ABI, functionName: "getPoolSplits", args: [token] },
      { address: token, abi: PARTY_TOKEN_ABI, functionName: "decimals" },
      { address: token, abi: PARTY_TOKEN_ABI, functionName: "metadataUri" },
    ],
  });

  return {
    blockNumber: blockNumber.toString(),
    locker: readRegistration(poolInfo, splits),
    decimals: decimals.status === "success"
      ? { status: "ok", value: Number(decimals.result) }
      : { status: "unavailable" },
    // An empty string is the contract answering "no URI", which is a fact and is
    // reported as `ok` with `null`. Only a failed call is `unavailable`.
    metadataUri: metadataUri.status === "success"
      ? { status: "ok", value: metadataUri.result === "" ? null : metadataUri.result }
      : { status: "unavailable" },
  };
}

/**
 * One token's ERC-20 decimals, read from the token itself.
 *
 * Separate from the snapshot above because the launch path needs exactly this
 * one number, on a client it already holds, for a token that came into existence
 * seconds ago - and it must be READ rather than assumed. A raw amount without
 * its decimals is unreadable (rule 90), so a caller that cannot read them says
 * so instead of rendering a number at a guessed scale.
 *
 * THROWS when the call does not answer. The caller decides what an unreadable
 * display means; this function never invents a scale.
 */
export async function readPoolsTokenDecimals(
  client: PublicClient<Transport, Chain>,
  token: Address,
): Promise<number> {
  const decimals = await client.readContract({
    address: token,
    abi: PARTY_TOKEN_ABI,
    functionName: "decimals",
  });
  return Number(decimals);
}

type MulticallResult<T> = { status: "success"; result: T } | { status: "failure" };

/**
 * Turn the two locker calls into one registration verdict.
 *
 * The all-zero `pool` is read as the locker's own DENIAL - it is the documented
 * shape for a token registered with the older SushiLaunchpad - while a failed
 * call is silence and is kept separate.
 */
function readRegistration(
  poolInfo: MulticallResult<readonly [string, string, string, string, readonly bigint[]]>,
  splits: MulticallResult<readonly [number, number, number, number, number, number]>,
): PoolsLockerRegistration {
  if (poolInfo.status !== "success") return { status: "unavailable" };

  const [pairedAssetAddress, pool, creator, feeRecipient, tokenIds] = poolInfo.result;
  if (isZeroAddress(pool)) return { status: "unregistered" };

  return {
    status: "registered",
    info: {
      pairedAssetAddress,
      pool,
      creator,
      feeRecipient,
      lockedPositionIds: tokenIds.map((id) => id.toString()),
      feeSplitAvailable: splits.status === "success",
      feeSplitBps: splits.status === "success"
        ? {
          creator: Number(splits.result[0]),
          platform: Number(splits.result[1]),
          buyback: Number(splits.result[2]),
          community: Number(splits.result[3]),
          stockCreator: Number(splits.result[4]),
          stockProtocol: Number(splits.result[5]),
        }
        : null,
    },
  };
}
