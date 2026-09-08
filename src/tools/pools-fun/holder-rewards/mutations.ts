/**
 * The two MUTATIONS a pools.fun holder-rewards distributor exposes to anybody:
 * `claim()` for the holder and the permissionless `distribute()`. This module
 * builds their calldata, simulates them, and reads the facts a preview has to
 * state. IT SIGNS NOTHING - the handlers own the signer.
 *
 * TWO DISTRIBUTOR RUNTIMES ARE LIVE AND THEIR ABIs DIFFER ON THE MONEY PATH.
 * This is not a stylistic detail; it is why every function here measures the
 * return instead of assuming it. Measured on chain 4663, 2026-09-04
 * (`agents-colab/agents_dm/pools-holder-rewards-2026-09-04/probe_calls.json`):
 *
 *   13962-byte runtime (`0x25ff1A3D...`, Sourcify-verified)
 *     `claim()`      returns ONE word  (the token leg)
 *     `distribute()` returns FOUR words: the verified ABI names them
 *                    `(feesToken, feesPaired, bought, notified)`
 *     no `CALLER_BOUNTY_BPS()`, no `earnedPaired`, no `rewardMode()`
 *   22171-byte runtime (`0xB02caa9F...`, `0xb7633B96...`, `0x7b53d176...`; not
 *   on Sourcify)
 *     `claim()`      returns TWO words (the token leg and the paired leg)
 *     `distribute()` returns FIVE words - the extra word's MEANING IS NOT
 *                    ESTABLISHED and this module never names it
 *     `CALLER_BOUNTY_BPS()` = 50
 *
 * So a claim is simulated with a RAW `eth_call` and decoded by the LENGTH of
 * what came back. Decoding a one-word return against a two-output ABI throws,
 * and picking an ABI from a guess about which runtime a distributor is would put
 * that guess on the money path. The bytes decide.
 *
 * A MISSING PAIRED WORD IS THE ABSENCE OF A LEG, NEVER A ZERO. The 13962-byte
 * runtime has no paired leg to pay at all; reporting `0` would be a claim the
 * chain did not make.
 *
 * THE NAMED REVERTS ARE ANSWERS, NOT FAILURES. `NothingToClaim()` means the
 * distributor owes this wallet nothing right now - a fact about the wallet, and
 * the selector is measured (`0x969bf728`, confirmed against the verified ABI's
 * own error list by preimage). Anything that does not answer is `unavailable`
 * and must NEVER be read as "nothing to claim".
 */

import {
  decodeAbiParameters,
  encodeFunctionData,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";

/**
 * `claim()` - the HOLDER's own claim. `claimFor(address)` exists on both
 * runtimes and is deliberately NOT here: the agent path never claims on behalf
 * of a third party, so the only calldata this module can produce pays the
 * account that signs it.
 */
export const POOLS_DISTRIBUTOR_CLAIM_ABI = [
  {
    inputs: [],
    name: "claim",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/** `distribute()` - permissionless. Outputs as the VERIFIED ABI declares them. */
export const POOLS_DISTRIBUTOR_DISTRIBUTE_ABI = [
  {
    inputs: [],
    name: "distribute",
    outputs: [
      { internalType: "uint256", name: "feesToken", type: "uint256" },
      { internalType: "uint256", name: "feesPaired", type: "uint256" },
      { internalType: "uint256", name: "bought", type: "uint256" },
      { internalType: "uint256", name: "notified", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/**
 * `CALLER_BOUNTY_BPS()` - the newer runtime's keeper incentive, in basis points.
 *
 * Read live rather than pinned: 50 today on all three 22171-byte distributors
 * measured, absent (the call reverts with empty data) on the 13962-byte one.
 * Absence means the runtime has no bounty at all, which is a different statement
 * from a bounty of zero, and both are reported as themselves.
 */
export const POOLS_DISTRIBUTOR_BOUNTY_ABI = [
  {
    inputs: [],
    name: "CALLER_BOUNTY_BPS",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * `locker()` - the SUITE BINDING this module adds to what the read lane already
 * proves (`./read.ts` reads `token()` and `factory()`).
 *
 * Measured 2026-09-04: `0x25ff1A3D...` answers the V2 locker and every V3-era
 * distributor answers the V3 locker, so this value pins a distributor to the
 * suite that detection chose. A distributor whose locker belongs to another
 * suite is not the contract this token's suite deployed, and a claim sent there
 * is a claim against a contract nobody verified.
 */
export const POOLS_DISTRIBUTOR_LOCKER_ABI = [
  {
    inputs: [],
    name: "locker",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * The distributor's own named errors, from the Sourcify-verified ABI of
 * `0x25ff1A3D...` (`captures/sourcify_0x25ff1A3D.json`). Transcribed from the
 * machine artifact, never spelled from convention, and
 * `holder-rewards-wire-names` pins each selector against that file.
 */
export const POOLS_DISTRIBUTOR_ERROR_ABI = [
  { type: "error", name: "NothingToClaim", inputs: [] },
  { type: "error", name: "NothingToDistribute", inputs: [] },
  { type: "error", name: "ExcludedAccount", inputs: [] },
  { type: "error", name: "ClaimForContractNotAllowed", inputs: [] },
  { type: "error", name: "NotRegistered", inputs: [] },
  { type: "error", name: "BuybackTooSoon", inputs: [] },
  { type: "error", name: "NothingToBuyBack", inputs: [] },
  { type: "error", name: "NothingBought", inputs: [] },
  { type: "error", name: "NothingToNotify", inputs: [] },
  { type: "error", name: "PoolNotBound", inputs: [] },
  { type: "error", name: "PriceAboveReference", inputs: [] },
  { type: "error", name: "ReferenceUnavailable", inputs: [] },
  { type: "error", name: "StockNotTradable", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
] as const;

/**
 * Error selector -> name, measured by keccak preimage over the verified ABI's
 * error list on 2026-09-04. A table rather than a viem decode because the only
 * thing an `eth_call` failure hands back is four bytes, and mapping them here
 * keeps the whole revert vocabulary in one reviewable place.
 */
export const POOLS_DISTRIBUTOR_ERROR_SELECTORS: Readonly<Record<string, string>> = {
  "0x969bf728": "NothingToClaim",
  "0x01663f24": "NothingToDistribute",
  "0xb7594bec": "ExcludedAccount",
  "0x0693245d": "ClaimForContractNotAllowed",
  "0xaba47339": "NotRegistered",
  "0x24b8e825": "BuybackTooSoon",
  "0xc9d2c505": "NothingToBuyBack",
  "0x87f36a18": "NothingBought",
  "0x6a414977": "NothingToNotify",
  "0xdad1ced0": "PoolNotBound",
  "0x5d76223d": "PriceAboveReference",
  "0xa99c2ec9": "ReferenceUnavailable",
  "0xe4b0d3e7": "StockNotTradable",
};

/** `claim()` calldata. Built from the ABI; the test pins it to `0x4e71d92d`. */
export function poolsHolderRewardsClaimCalldata(): Hex {
  return encodeFunctionData({ abi: POOLS_DISTRIBUTOR_CLAIM_ABI, functionName: "claim" });
}

/** `distribute()` calldata. Built from the ABI; the test pins it to `0xe4fc6b6d`. */
export function poolsHolderRewardsDistributeCalldata(): Hex {
  return encodeFunctionData({ abi: POOLS_DISTRIBUTOR_DISTRIBUTE_ABI, functionName: "distribute" });
}

/**
 * The revert data of a failed `eth_call`, or `null` when the failure was not a
 * revert at all.
 *
 * viem wraps a reverting `call` in a `CallExecutionError` whose cause chain
 * carries the raw bytes, and the shape of that cause differs between the
 * contract and raw arms. Walking for a hex string is what makes this work on
 * both without depending on which class the node's error happened to produce -
 * and returning `null` for everything else is what keeps a transport failure
 * from being read as a named answer.
 */
export function poolsDistributorRevertData(err: unknown): Hex | null {
  const seen = new Set<unknown>();
  let node: unknown = err;
  for (let depth = 0; depth < 12 && node !== null && node !== undefined; depth += 1) {
    if (seen.has(node)) break;
    seen.add(node);
    if (typeof node === "object") {
      const candidate = (node as { data?: unknown }).data;
      if (typeof candidate === "string" && candidate.startsWith("0x")) return candidate as Hex;
      if (
        typeof candidate === "object"
        && candidate !== null
        && typeof (candidate as { data?: unknown }).data === "string"
      ) {
        const inner = (candidate as { data: string }).data;
        if (inner.startsWith("0x")) return inner as Hex;
      }
      node = (node as { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return null;
}

/** The distributor's own name for a revert, or `null` when it is not one of them. */
export function poolsDistributorRevertName(err: unknown): string | null {
  const data = poolsDistributorRevertData(err);
  if (data === null || data.length < 10) return null;
  return POOLS_DISTRIBUTOR_ERROR_SELECTORS[data.slice(0, 10).toLowerCase()] ?? null;
}

/** The short cause of a failure, with nothing in it that leaks a node URL or a body. */
function shortReason(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const named = err as { shortMessage?: unknown; name?: unknown };
    if (typeof named.shortMessage === "string" && named.shortMessage.trim() !== "") {
      return named.shortMessage.trim();
    }
    if (typeof named.name === "string") return named.name;
  }
  return "the node did not say why";
}

/** Split a returndata blob into 32-byte words, or `null` when it is not a whole number of them. */
function returnWords(data: Hex): readonly bigint[] | null {
  const body = data.slice(2);
  if (body.length === 0 || body.length % 64 !== 0) return null;
  const count = body.length / 64;
  const types = Array.from({ length: count }, () => ({ type: "uint256" } as const));
  try {
    return decodeAbiParameters(types, data) as readonly bigint[];
  } catch {
    return null;
  }
}

/** What simulating `claim()` established. */
export type PoolsHolderRewardsClaimSimulation =
  | {
      readonly kind: "would_pay";
      /** The launched-token leg. Present on BOTH runtimes. */
      readonly tokenAmountRaw: bigint;
      /**
       * The paired leg, or `null` when this runtime's `claim()` has no second
       * return word - the absence of a leg, never a zero.
       */
      readonly pairedAmountRaw: bigint | null;
      /** 1 or 2. Reported so the caller can say which runtime answered. */
      readonly returnWordCount: 1 | 2;
    }
  /** The distributor itself says there is nothing to pay this account. A fact. */
  | { readonly kind: "nothing_to_claim"; readonly revert: string }
  /** The account is excluded from rewards. Also a fact, and a different one. */
  | { readonly kind: "excluded"; readonly revert: string }
  /** Nothing was established. NEVER to be read as "nothing to claim". */
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Simulate `claim()` AS `account`, at one pinned block.
 *
 * A RAW `eth_call` rather than `simulateContract`, because which ABI is right is
 * exactly what the call is being asked: the two live runtimes return one word
 * and two, and a two-output ABI throws on a one-word return. So the bytes come
 * back undecoded and their LENGTH selects the shape. Simulating from anyone but
 * the claiming account would answer a different question - `claim()` pays
 * `msg.sender`.
 */
export async function simulatePoolsHolderRewardsClaim(
  client: PublicClient<Transport, Chain>,
  input: {
    readonly account: Address;
    readonly distributor: Address;
    readonly blockNumber: bigint;
  },
): Promise<PoolsHolderRewardsClaimSimulation> {
  let data: Hex;
  try {
    const result = await client.call({
      account: input.account,
      to: input.distributor,
      data: poolsHolderRewardsClaimCalldata(),
      blockNumber: input.blockNumber,
    });
    if (result.data === undefined) {
      return {
        kind: "unavailable",
        reason: "the distributor's claim() answered with no returndata at all, so what it would pay is unknown",
      };
    }
    data = result.data;
  } catch (err) {
    const named = poolsDistributorRevertName(err);
    if (named === "NothingToClaim") return { kind: "nothing_to_claim", revert: named };
    if (named === "ExcludedAccount") return { kind: "excluded", revert: named };
    if (named !== null) {
      return {
        kind: "unavailable",
        reason: `the distributor refused the simulated claim with ${named}()`,
      };
    }
    return { kind: "unavailable", reason: shortReason(err) };
  }

  const words = returnWords(data);
  if (words === null || (words.length !== 1 && words.length !== 2)) {
    return {
      kind: "unavailable",
      reason:
        `the distributor's claim() returned ${(data.length - 2) / 2} bytes, which is neither of the two shapes `
        + "measured on this chain (one word on the older runtime, two on the newer). Vex will not guess how to "
        + "read a payout",
    };
  }

  const tokenAmountRaw = words[0]!;
  if (words.length === 1) {
    return { kind: "would_pay", tokenAmountRaw, pairedAmountRaw: null, returnWordCount: 1 };
  }
  return { kind: "would_pay", tokenAmountRaw, pairedAmountRaw: words[1]!, returnWordCount: 2 };
}

/** What simulating `distribute()` established. */
export type PoolsRewardDistributeSimulation =
  | {
      readonly kind: "would_distribute";
      /**
       * The distributor's own accounting words, RAW and in order.
       *
       * The verified 13962-byte ABI names its four
       * (`feesToken, feesPaired, bought, notified`); the 22171-byte runtime
       * returns FIVE and its member names are NOT in any machine artifact this
       * repository has, so they are reported as an ordered list under
       * `wordsUnnamed` rather than labelled from a guess.
       */
      readonly words: readonly bigint[];
      readonly named: boolean;
    }
  /** The distributor says it has nothing to push right now. A fact about the pool. */
  | { readonly kind: "nothing_to_distribute"; readonly revert: string }
  /** Nothing was established. */
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Simulate `distribute()` AS `account`, at one pinned block.
 *
 * `distribute()` is permissionless, so the account only decides who would
 * receive the caller bounty; it is passed anyway because the gas a real call
 * would cost depends on the sender's own state.
 */
export async function simulatePoolsRewardDistribute(
  client: PublicClient<Transport, Chain>,
  input: {
    readonly account: Address;
    readonly distributor: Address;
    readonly blockNumber: bigint;
  },
): Promise<PoolsRewardDistributeSimulation> {
  let data: Hex;
  try {
    const result = await client.call({
      account: input.account,
      to: input.distributor,
      data: poolsHolderRewardsDistributeCalldata(),
      blockNumber: input.blockNumber,
    });
    if (result.data === undefined) {
      return {
        kind: "unavailable",
        reason: "the distributor's distribute() answered with no returndata at all",
      };
    }
    data = result.data;
  } catch (err) {
    const named = poolsDistributorRevertName(err);
    if (named === "NothingToDistribute" || named === "NothingToBuyBack" || named === "NothingToNotify") {
      return { kind: "nothing_to_distribute", revert: named };
    }
    if (named !== null) {
      return {
        kind: "unavailable",
        reason: `the distributor refused the simulated distribute with ${named}()`,
      };
    }
    return { kind: "unavailable", reason: shortReason(err) };
  }

  const words = returnWords(data);
  if (words === null || words.length < 4) {
    return {
      kind: "unavailable",
      reason:
        `the distributor's distribute() returned ${(data.length - 2) / 2} bytes, which is neither of the two `
        + "shapes measured on this chain (four words on the older runtime, five on the newer)",
    };
  }
  return { kind: "would_distribute", words, named: words.length === 4 };
}

/**
 * The distributor's suite binding and its keeper bounty, at one pinned block.
 *
 * `locker` and `pairedAsset` are the two facts `./read.ts` does not carry, and
 * `bountyBps` is the only ON-CHAIN statement about the caller incentive - the
 * launchpad's `paysCallerBounty` disagreed with it on a measured token, so it is
 * read here rather than echoed.
 *
 * Every field is nullable and a `null` means "this runtime did not answer that
 * call", never a zero: the two runtimes differ, and the difference is a fact.
 */
/** `pairedAsset()`, kept beside the binding reads that use it. */
const POOLS_HOLDER_REWARDS_PAIRED_ASSET_ABI = [
  {
    inputs: [],
    name: "pairedAsset",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface PoolsDistributorBinding {
  readonly locker: Address | null;
  readonly pairedAsset: Address | null;
  readonly bountyBps: number | null;
}

export async function readPoolsDistributorBinding(
  client: PublicClient<Transport, Chain>,
  input: { readonly distributor: Address; readonly blockNumber: bigint },
): Promise<PoolsDistributorBinding> {
  const results = await client.multicall({
    allowFailure: true,
    blockNumber: input.blockNumber,
    contracts: [
      { address: input.distributor, abi: POOLS_DISTRIBUTOR_LOCKER_ABI, functionName: "locker" },
      { address: input.distributor, abi: POOLS_HOLDER_REWARDS_PAIRED_ASSET_ABI, functionName: "pairedAsset" },
      { address: input.distributor, abi: POOLS_DISTRIBUTOR_BOUNTY_ABI, functionName: "CALLER_BOUNTY_BPS" },
    ],
  });
  const at = <T>(index: number): T | null => {
    const call = results[index];
    return call !== undefined && call.status === "success" ? (call.result as T) : null;
  };
  const bounty = at<bigint>(2);
  return {
    locker: at<Address>(0),
    pairedAsset: at<Address>(1),
    bountyBps: bounty === null ? null : Number(bounty),
  };
}
