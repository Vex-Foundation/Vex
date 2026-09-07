/**
 * The three transactions a Virtuals agent launch can send, built locally.
 *
 * Nothing here comes from a provider. BondingV5 is a pinned address
 * (`../curve/deployments.ts`), the ABI is transcribed from the first-party
 * source (`./abi.ts`), and every argument is a value the caller named or Vex
 * computed. There is no provider `to`/`data` on this lane at all.
 *
 * ## THE ALLOWANCE SPENDER IS BondingV5, NOT FRouterV3
 *
 * This is the one place where the launch lane and the curve TRADE lane
 * disagree, and getting it wrong is a launch that reverts after the approval
 * was already signed. `preLaunch` pulls the purchase with
 * `IERC20(assetToken).safeTransferFrom(msg.sender, address(this), initialPurchase)`
 * - `address(this)` is BondingV5 itself (`BondingV5.sol:381-385`), and the fee
 * leg above it pulls to `bondingConfig.feeTo()` from the same `msg.sender`
 * allowance (`:375-379`). A curve BUY, by contrast, is pulled by FRouterV3.
 * Same token, same wallet, two different spenders. Verified against the source
 * and against the two live launches on disk, whose approve legs both name
 * BondingV5.
 *
 * ## THE NAME ON CHAIN IS NOT ALWAYS THE NAME THE CALLER TYPED
 *
 * `preLaunch` appends `" by Virtuals"` to the token name unless bit 1 of the
 * `extParams_` flags word is set (`_decodeAppendByVirtualsSuffix`,
 * `BondingV5.sol:234-238`, `:391`). That is a user-visible product fact, not an
 * encoding detail: the ERC-20 the wallet ends up holding is named differently
 * from the string the caller passed. So the suffix is an explicit choice here,
 * the resulting on-chain name is computed by {@link onChainTokenName}, and the
 * approval shows THAT string rather than the caller's input.
 */

import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";

import { CURVE_ERC20_ABI } from "../curve/abi.js";
import type { VirtualsCurveDeployment } from "../curve/deployments.js";
import { BONDING_V5_LAUNCH_ABI } from "./abi.js";

export interface BuiltLaunchTx {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/** The suffix `preLaunch` appends when bit 1 of `extParams_` is clear. */
export const VIRTUALS_NAME_SUFFIX = " by Virtuals";

/** `EXT_PARAMS_FLAG_SKIP_SUFFIX` = bit 1 (`BondingV5.sol:210`). */
const EXT_PARAMS_FLAG_SKIP_SUFFIX = 2n;

/** What the caller may say about the venue suffix. */
export type VirtualsNameSuffixChoice = "by_virtuals" | "none";

/**
 * The `extParams_` word for a suffix choice, and nothing else.
 *
 * Every other flag the contract understands (fee delegation bit 0, robotics
 * bit 2, the delegation-type bits and the trailing recipient word) is
 * deliberately NOT reachable from this lane: each one changes who receives an
 * agent's fees, which is a money decision with no measured handler chain behind
 * it. `"by_virtuals"` encodes an EMPTY payload rather than a zero word, because
 * that is byte-for-byte what the venue's own app sends and what both launches
 * on disk carried.
 */
export function encodeLaunchExtParams(suffix: VirtualsNameSuffixChoice): Hex {
  if (suffix === "by_virtuals") return "0x";
  return `0x${EXT_PARAMS_FLAG_SKIP_SUFFIX.toString(16).padStart(64, "0")}` as Hex;
}

/** The name the ERC-20 will actually carry, for the approval to display. */
export function onChainTokenName(name: string, suffix: VirtualsNameSuffixChoice): string {
  return suffix === "by_virtuals" ? `${name}${VIRTUALS_NAME_SUFFIX}` : name;
}

/**
 * Every argument of `preLaunch`, in contract order.
 *
 * A named struct rather than a positional tuple at the call sites, because the
 * function takes fourteen arguments of which four are booleans and three are
 * small integers: a transposition would type-check and launch the wrong agent.
 */
export interface PreLaunchArgs {
  readonly name: string;
  readonly ticker: string;
  readonly cores: readonly number[];
  readonly description: string;
  /** The PUBLIC, content-addressed image URL. Never a caller-supplied string. */
  readonly imageUrl: string;
  /** twitter, telegram, youtube, website - the contract's fixed order. */
  readonly urls: readonly [string, string, string, string];
  /** VIRTUAL committed to the venue: the protocol fee plus the initial purchase. */
  readonly purchaseAmountRaw: bigint;
  /** Seconds since the epoch. Must stay below the scheduled threshold. */
  readonly startTime: bigint;
  readonly antiSniperTaxType: number;
  readonly nameSuffix: VirtualsNameSuffixChoice;
}

/**
 * The positional argument list `preLaunch` is encoded with.
 *
 * The four values this lane PINS rather than exposes - `launchMode_ = 0`
 * (LAUNCH_MODE_NORMAL), `airdropBips_ = 0`, `needAcf_ = false`,
 * `isProject60days_ = false` - are pinned here, once, so no caller and no model
 * can reach them. Owner decision L1: modes 1 and 2 require a privileged
 * launcher the wallet is not (`_validateLaunchMode`, `BondingV5.sol:913-953`),
 * ACF costs 10 VIRTUAL and reserves supply, and a non-zero airdrop moves supply
 * to a wallet Vex does not control. Each returns a typed `unsupported` at the
 * parameter boundary instead of being encoded here.
 */
export function preLaunchArgTuple(args: PreLaunchArgs) {
  return [
    args.name,
    args.ticker,
    [...args.cores],
    args.description,
    args.imageUrl,
    [...args.urls] as [string, string, string, string],
    args.purchaseAmountRaw,
    args.startTime,
    0,
    0,
    false,
    args.antiSniperTaxType,
    false,
    encodeLaunchExtParams(args.nameSuffix),
  ] as const;
}

/** `approve(BondingV5, amount)` on VIRTUAL. EXACT amount, never infinite. */
export function buildLaunchApproveTx(input: {
  readonly deployment: VirtualsCurveDeployment;
  readonly amountRaw: bigint;
}): BuiltLaunchTx {
  return {
    to: input.deployment.virtual,
    data: encodeFunctionData({
      abi: CURVE_ERC20_ABI,
      functionName: "approve",
      args: [input.deployment.bondingV5, input.amountRaw],
    }),
    value: 0n,
  };
}

/** `BondingV5.preLaunch(...)`. `value` is 0: the curve is VIRTUAL-denominated. */
export function buildPreLaunchTx(input: {
  readonly deployment: VirtualsCurveDeployment;
  readonly args: PreLaunchArgs;
}): BuiltLaunchTx {
  return {
    to: input.deployment.bondingV5,
    data: encodeFunctionData({
      abi: BONDING_V5_LAUNCH_ABI,
      functionName: "preLaunch",
      args: preLaunchArgTuple(input.args) as never,
    }),
    value: 0n,
  };
}

/** `BondingV5.cancelLaunch(token)` - creator-only, refunds `initialPurchase`. */
export function buildCancelLaunchTx(input: {
  readonly deployment: VirtualsCurveDeployment;
  readonly token: Address;
}): BuiltLaunchTx {
  return {
    to: input.deployment.bondingV5,
    data: encodeFunctionData({
      abi: BONDING_V5_LAUNCH_ABI,
      functionName: "cancelLaunch",
      args: [input.token],
    }),
    value: 0n,
  };
}

/**
 * The fingerprint an approval commits to: `keccak256(chainId ‖ to ‖ value ‖ data)`.
 *
 * The calldata alone is not enough. `preLaunch` on Base and on Robinhood encode
 * IDENTICALLY for the same arguments, so a digest over `data` only would let a
 * proposal approved for one chain authorize the other; the chain id and the
 * target are therefore inside the hash rather than beside it. Same reasoning as
 * the pools launch fingerprint, which the desktop confirmation renders.
 */
export function launchCalldataFingerprint(input: {
  readonly chainId: number;
  readonly tx: BuiltLaunchTx;
}): Hex {
  const chain = BigInt(input.chainId).toString(16).padStart(16, "0");
  const value = input.tx.value.toString(16).padStart(64, "0");
  return keccak256(`0x${chain}${input.tx.to.slice(2).toLowerCase()}${value}${input.tx.data.slice(2)}` as Hex);
}
