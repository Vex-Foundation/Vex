/**
 * The ON-CHAIN half of `pools__holder_rewards_get` (READ-ONLY).
 *
 * WHY THIS EXISTS AT ALL, given the launchpad has an endpoint for it: the
 * authority table (plan v3 section 2, A5) puts the MODE on the suite's
 * HolderRewardsDeployer event and the WALLET's earned amounts on the
 * distributor contract, and the API on neither. That is not a stylistic
 * preference. Two measurements from 2026-09-04 make it operational:
 *
 *  1. `GET /pools-fun/holder-rewards?token=&wallet=` answers HTTP 502
 *     `Could not load holder rewards` for EVERY token measured - token, paired
 *     and both modes - while the same URL without `wallet` answers 200. The
 *     provider currently has no working wallet leg at all, so `earned(wallet)`
 *     on the distributor is not a cross-check here, it is the only answer.
 *  2. `distributor.rewardMode()` and the deployer's
 *     `DistributorDeployed(token, distributor, uint8 rewardMode)` event agree
 *     with each other and with the API's string on every token measured. When
 *     they ever stop agreeing, the event wins and the disagreement is reported.
 *
 * THE MODE ORDINALS ARE READ FROM THE CHAIN, NOT SPELLED FROM CONVENTION
 * (rule 10 point 2). `HolderRewardsDeployer.modeFor(sentinel)` is a pure
 * function mapping each fee-recipient sentinel to its ordinal, and it answered
 * on the live V3 deployer `0x5aeE24bD…` on 2026-09-04:
 *
 *   FEES_TO_HOLDERS        0x968b0c1e…ffc2 -> 0  "token"
 *   FEES_TO_HOLDERS_PAIRED 0x968b0c1e…ffc3 -> 1  "paired"
 *   FEES_TO_HOLDERS_BOTH   0x968b0c1e…ffc4 -> 2  "both"
 *
 * The same ordering is what the launchpad's own `launches/config` publishes as
 * `holderRewardsPayoutModes: ["token","paired","both"]`, and what the three
 * `DistributorDeployed` events read back for a token-, a paired- and a
 * both-mode token carried. `POOLS_HOLDER_REWARD_MODES` below is that table, and
 * `src/__tests__/pools-fun/holder-rewards-wire-names.test.ts` pins it against
 * the captured artifacts.
 *
 * TWO DISTRIBUTOR IMPLEMENTATIONS ARE LIVE, which is why every optional call is
 * `allowFailure` and reports absence as absence:
 *   13962-byte runtime (e.g. `0x25ff1A3D…`, Sourcify-verified): `earned`,
 *     `rewardExcluded`, `eligibleSupply`, `periodFinish`, `rewardRate`,
 *     `remainingStream`, `token`, `pairedAsset`, `isStockPair`, `factory`,
 *     `locker`. NO `rewardMode()` and NO `earnedPaired()`.
 *   22171-byte runtime (e.g. `0xF7747B39…`, `0x7b53d176…`, not on Sourcify):
 *     all of the above PLUS `rewardMode()`, `earnedPaired(address)`,
 *     `remainingStreamPaired()`, `surplusPaired()`.
 * A missing `earnedPaired` therefore means "this distributor has no paired
 * reward leg to read", never "the paired leg is zero".
 */

import type { Address, Chain, PublicClient, Transport } from "viem";

import { getLocalPublicClient } from "../../evm-chains/evm-client.js";
import { getLocalChain } from "../../evm-chains/registry.js";
import {
  POOLS_CHAIN_ID,
  POOLS_SUITES,
  type PoolsContractSuite,
} from "../constants.js";

/**
 * Reward mode by WIRE ORDINAL. Index IS the `uint8` the deployer emits and
 * `modeFor` returns; see the module header for where each row was read from.
 */
export const POOLS_HOLDER_REWARD_MODES = ["token", "paired", "both"] as const;
export type PoolsHolderRewardMode = (typeof POOLS_HOLDER_REWARD_MODES)[number];

/** The mode an ordinal names, or `null` for a value this build does not know. */
export function poolsHolderRewardModeFromWire(value: number): PoolsHolderRewardMode | null {
  return POOLS_HOLDER_REWARD_MODES[value] ?? null;
}

/**
 * `DistributorDeployed` - the MODE AND DISTRIBUTOR AUTHORITY.
 *
 * Copied from the Sourcify-verified ABI of the V3 deployer
 * (`captures/sourcify_0x5aeE24bD.json`), including which arguments are indexed:
 * `token` being indexed is what makes the per-token lookup a topic filter
 * rather than a scan.
 */
export const POOLS_DISTRIBUTOR_DEPLOYED_EVENT_ABI = {
  type: "event",
  name: "DistributorDeployed",
  anonymous: false,
  inputs: [
    { name: "token", type: "address", indexed: true, internalType: "address" },
    { name: "distributor", type: "address", indexed: true, internalType: "address" },
    { name: "rewardMode", type: "uint8", indexed: false, internalType: "uint8" },
  ],
} as const;

/**
 * The distributor views this module reads. Every one of them is a `view`, and
 * nothing here can sign, claim or distribute - that is PR6's surface.
 */
export const POOLS_HOLDER_REWARDS_DISTRIBUTOR_ABI = [
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "earned",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  // Present only on the newer distributor runtime. Its ABSENCE is a fact about
  // the distributor, reported as such rather than as a zero.
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "earnedPaired",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "rewardExcluded",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  // The distributor's own claim about its mode. A SECOND on-chain witness, not
  // the authority: the deployer's event is.
  {
    inputs: [],
    name: "rewardMode",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "pairedAsset",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "factory",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "eligibleSupply",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "periodFinish",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "rewardRate",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "remainingStream",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "isStockPair",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/** `decimals()`/`symbol()` for the two reward legs. */
const ERC20_DISPLAY_ABI = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/** One reward leg's amount, with everything needed to render it honestly. */
export interface PoolsRewardLeg {
  /** The asset the leg pays in. */
  readonly asset: string;
  readonly symbol: string | null;
  /** `null` means the token's `decimals()` did not answer - never assume 18. */
  readonly decimals: number | null;
  /** Base units, as a decimal string. Never a JS number. */
  readonly earnedRaw: string;
}

/**
 * Render a raw base-unit amount at a possibly-unknown scale, WITHOUT floating
 * point.
 *
 * `null` decimals means the scale is unknown, and an unknown scale produces NO
 * human figure at all: a number at a guessed scale is worse than none, because a
 * reader cannot tell it was guessed (rule 90). String arithmetic throughout -
 * these are uint256 values and `Number` loses them.
 *
 * Lives beside {@link PoolsRewardLeg} because it is the one rendering that type
 * needs and every consumer must do it the same way; a second copy in a handler
 * is how two tools start disagreeing about what a wallet is owed.
 */
export function poolsRewardAmountHuman(raw: string, decimals: number | null): string | null {
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 77) return null;
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * The outcome of the on-chain read.
 *
 * FIVE STATES, because collapsing them is how a read tool starts lying:
 *   `ok`                  the deployer named a distributor and it answered.
 *   `no_holder_rewards`   the suite's deployer emitted NO event for this token.
 *                         A fact: this token does not stream fees to holders.
 *   `suite_without_holder_rewards`  the token is registered on a suite that has
 *                         no HolderRewardsDeployer at all (V1). Also a fact,
 *                         and a different one.
 *   `token_not_registered` no pools.fun suite holds this token, so there is no
 *                         deployer to ask. Not the same as "no rewards".
 *   `unavailable`         something did not answer. NOTHING was proven.
 */
export type PoolsHolderRewardsOnChain =
  | {
      readonly status: "ok";
      readonly blockNumber: string;
      readonly suiteVersion: PoolsContractSuite["version"];
      readonly deployer: string;
      readonly distributor: string;
      /** From the deployer's event. The MODE authority. */
      readonly rewardMode: PoolsHolderRewardMode | null;
      /** The raw ordinal, kept so an unknown future mode is still reportable. */
      readonly rewardModeWire: number;
      /** `distributor.rewardMode()`, when that runtime has it. A second witness. */
      readonly distributorSelfReportedMode: PoolsHolderRewardMode | null;
      /** The wallet whose amounts were read, lowercased. */
      readonly wallet: string;
      /** `earned(wallet)` and its asset. Always present - it is in every runtime. */
      readonly tokenLeg: PoolsRewardLeg;
      /**
       * `earnedPaired(wallet)`. `null` when this distributor has no such
       * function, which means the leg does not exist to be read, NOT zero.
       */
      readonly pairedLeg: PoolsRewardLeg | null;
      /** `rewardExcluded(wallet)`; `null` when the call did not answer. */
      readonly walletExcluded: boolean | null;
      readonly eligibleSupplyRaw: string | null;
      readonly rewardRateRaw: string | null;
      readonly remainingStreamRaw: string | null;
      /** Unix seconds the current stream ends; `0` means no active stream. */
      readonly periodFinish: number | null;
      readonly isStockPair: boolean | null;
      /** `distributor.token()`; compared against the requested token by the caller. */
      readonly distributorToken: string | null;
      /** `distributor.factory()`; must be the suite's factory. */
      readonly distributorFactory: string | null;
    }
  | {
      readonly status: "no_holder_rewards";
      readonly blockNumber: string;
      readonly suiteVersion: PoolsContractSuite["version"];
      readonly deployer: string;
    }
  | { readonly status: "suite_without_holder_rewards"; readonly suiteVersion: PoolsContractSuite["version"] }
  | { readonly status: "token_not_registered" }
  | { readonly status: "unavailable"; readonly detail: string };

function poolsPublicClient(): PublicClient<Transport, Chain> {
  const config = getLocalChain(POOLS_CHAIN_ID);
  if (config === undefined) {
    throw new Error(`Local chain ${POOLS_CHAIN_ID} (Robinhood) is not registered.`);
  }
  return getLocalPublicClient(config);
}

function errorName(err: unknown): string {
  return err instanceof Error ? (err.name || "Error") : "unknown error";
}

/** The suite a version names, from the shared table. */
function suiteOf(version: number): PoolsContractSuite | undefined {
  return POOLS_SUITES.find((suite) => suite.version === version);
}

/**
 * Read one token's holder-rewards state from the chain, for one wallet, at ONE
 * pinned block.
 *
 * `suiteVersion` comes from the caller's own suite detection
 * (`readPoolsOnChainSnapshot`), so this function never re-decides which suite a
 * token belongs to - two independent answers to that question is exactly the
 * second source of truth the suite table exists to prevent.
 *
 * Never throws for a chain-side failure: an unreachable node is `unavailable`
 * with the reason named. It throws only when chain 4663 is not registered at
 * all, which is a build-time fault rather than a runtime state.
 */
export async function readPoolsHolderRewardsOnChain(input: {
  readonly token: Address;
  readonly wallet: Address;
  readonly suiteVersion: PoolsContractSuite["version"] | null;
}): Promise<PoolsHolderRewardsOnChain> {
  if (input.suiteVersion === null) return { status: "token_not_registered" };
  const suite = suiteOf(input.suiteVersion);
  if (suite === undefined) {
    return {
      status: "unavailable",
      detail: `suite V${input.suiteVersion} is not in the suite table, so its holder-rewards deployer is unknown`,
    };
  }
  if (suite.holderRewardsDeployer === undefined) {
    return { status: "suite_without_holder_rewards", suiteVersion: suite.version };
  }
  const deployer = suite.holderRewardsDeployer as Address;

  const client = poolsPublicClient();
  let blockNumber: bigint;
  try {
    blockNumber = await client.getBlockNumber();
  } catch (err) {
    return { status: "unavailable", detail: `the chain's current block could not be read (${errorName(err)})` };
  }

  // The event is filtered by the INDEXED token topic, so this is a point lookup
  // rather than a scan of the deployer's whole history.
  let logs: readonly { args: { distributor?: Address | undefined; rewardMode?: number | undefined } }[];
  try {
    logs = await client.getLogs({
      address: deployer,
      event: POOLS_DISTRIBUTOR_DEPLOYED_EVENT_ABI,
      args: { token: input.token },
      fromBlock: 0n,
      toBlock: blockNumber,
    });
  } catch (err) {
    return {
      status: "unavailable",
      detail:
        `the HolderRewardsDeployer's DistributorDeployed log for this token could not be read (${errorName(err)}). `
        + "Whether this token has a distributor was NOT established.",
    };
  }

  const event = logs[logs.length - 1];
  if (logs.length === 0 || event === undefined) {
    return {
      status: "no_holder_rewards",
      blockNumber: blockNumber.toString(),
      suiteVersion: suite.version,
      deployer,
    };
  }
  const distributor = event.args.distributor;
  const rewardModeWire = Number(event.args.rewardMode ?? -1);
  if (distributor === undefined) {
    return {
      status: "unavailable",
      detail: "the DistributorDeployed event carried no distributor address, which its ABI does not allow",
    };
  }

  let results: readonly { status: "success" | "failure"; result?: unknown }[];
  try {
    results = await client.multicall({
      allowFailure: true,
      blockNumber,
      contracts: [
        { address: distributor, abi: POOLS_HOLDER_REWARDS_DISTRIBUTOR_ABI, functionName: "earned", args: [input.wallet] },
        { address: distributor, abi: POOLS_HOLDER_REWARDS_DISTRIBUTOR_ABI, functionName: "earnedPaired", args: [input.wallet] },
        { address: distributor, abi: POOLS_HOLDER_REWARDS_DISTRIBUTOR_ABI, functionName: "rewardExcluded", args: [input.wallet] },
        { address: distributor, abi: POOLS_HOLDER_REWARDS_DISTRIBUTOR_ABI, functionName: "rewardMode" },
        { address: distributor, abi: POOLS_HOLDER_REWARDS_DISTRIBUTOR_ABI, functionName: "token" },
        { address: distributor, abi: POOLS_HOLDER_REWARDS_DISTRIBUTOR_ABI, functionName: "pairedAsset" },
        { address: distributor, abi: POOLS_HOLDER_REWARDS_DISTRIBUTOR_ABI, functionName: "factory" },
        { address: distributor, abi: POOLS_HOLDER_REWARDS_DISTRIBUTOR_ABI, functionName: "eligibleSupply" },
        { address: distributor, abi: POOLS_HOLDER_REWARDS_DISTRIBUTOR_ABI, functionName: "periodFinish" },
        { address: distributor, abi: POOLS_HOLDER_REWARDS_DISTRIBUTOR_ABI, functionName: "rewardRate" },
        { address: distributor, abi: POOLS_HOLDER_REWARDS_DISTRIBUTOR_ABI, functionName: "remainingStream" },
        { address: distributor, abi: POOLS_HOLDER_REWARDS_DISTRIBUTOR_ABI, functionName: "isStockPair" },
        { address: input.token, abi: ERC20_DISPLAY_ABI, functionName: "decimals" },
        { address: input.token, abi: ERC20_DISPLAY_ABI, functionName: "symbol" },
      ],
    }) as unknown as readonly { status: "success" | "failure"; result?: unknown }[];
  } catch (err) {
    return {
      status: "unavailable",
      detail: `the distributor's state could not be read at block ${blockNumber} (${errorName(err)})`,
    };
  }

  const at = <T>(index: number): T | null => {
    const call = results[index];
    return call !== undefined && call.status === "success" ? (call.result as T) : null;
  };
  const raw = (index: number): string | null => {
    const value = at<bigint>(index);
    return value === null ? null : value.toString();
  };

  const earnedToken = at<bigint>(0);
  if (earnedToken === null) {
    return {
      status: "unavailable",
      detail:
        `the distributor ${distributor} did not answer earned(${input.wallet}) at block ${blockNumber}. `
        + "The wallet's reward balance is UNKNOWN, which is not the same as zero.",
    };
  }
  const pairedAsset = at<Address>(5);
  const earnedPaired = at<bigint>(1);

  // The paired leg needs BOTH a paired asset and an `earnedPaired` that
  // answered. Either one missing means there is no paired leg to report, and a
  // zero here would be a claim the chain did not make.
  let pairedLeg: PoolsRewardLeg | null = null;
  if (pairedAsset !== null && earnedPaired !== null) {
    let pairedDecimals: number | null = null;
    let pairedSymbol: string | null = null;
    try {
      const legMeta = await client.multicall({
        allowFailure: true,
        blockNumber,
        contracts: [
          { address: pairedAsset, abi: ERC20_DISPLAY_ABI, functionName: "decimals" },
          { address: pairedAsset, abi: ERC20_DISPLAY_ABI, functionName: "symbol" },
        ],
      });
      const d = legMeta[0];
      const s = legMeta[1];
      pairedDecimals = d?.status === "success" ? Number(d.result) : null;
      pairedSymbol = s?.status === "success" ? (s.result as string) : null;
    } catch {
      // The amount is already proven; only its label is missing, and a missing
      // label is reported as `null` rather than costing the amount.
      pairedDecimals = null;
      pairedSymbol = null;
    }
    pairedLeg = {
      asset: pairedAsset,
      symbol: pairedSymbol,
      decimals: pairedDecimals,
      earnedRaw: earnedPaired.toString(),
    };
  }

  const selfMode = at<number>(3);

  return {
    status: "ok",
    blockNumber: blockNumber.toString(),
    suiteVersion: suite.version,
    deployer,
    distributor,
    rewardMode: poolsHolderRewardModeFromWire(rewardModeWire),
    rewardModeWire,
    distributorSelfReportedMode: selfMode === null ? null : poolsHolderRewardModeFromWire(Number(selfMode)),
    wallet: input.wallet.toLowerCase(),
    tokenLeg: {
      asset: input.token,
      symbol: at<string>(13),
      decimals: at<number>(12) === null ? null : Number(at<number>(12)),
      earnedRaw: earnedToken.toString(),
    },
    pairedLeg,
    walletExcluded: at<boolean>(2),
    eligibleSupplyRaw: raw(7),
    rewardRateRaw: raw(9),
    remainingStreamRaw: raw(10),
    periodFinish: at<bigint>(8) === null ? null : Number(at<bigint>(8)),
    isStockPair: at<boolean>(11),
    distributorToken: at<Address>(4),
    distributorFactory: at<Address>(6),
  };
}
