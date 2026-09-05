/**
 * The AUTHORITATIVE launch state, read on chain at ONE pinned block.
 *
 * Same discipline as `../curve/state.ts`, and for the same reason: every figure
 * the approval shows and every figure a signature is held to comes from one
 * block, so the fee the user was shown cannot belong to a different block from
 * the threshold it was checked against.
 *
 * ## What is authority here
 *
 * | fact                              | source                                        |
 * |-----------------------------------|-----------------------------------------------|
 * | BondingV5, VIRTUAL                | `../curve/deployments.ts`, pinned             |
 * | the implementations behind them   | EIP-1967 slot, re-read (`../curve/proxy-identity.ts`) |
 * | bondingConfig                     | `BondingV5.bondingConfig()`, never assumed    |
 * | protocol launch fee               | `BondingConfig.calculateLaunchFee(false,false)` |
 * | the scheduled threshold           | `getScheduledLaunchParams().startTimeDelay`   |
 * | the fee recipient                 | `BondingConfig.feeTo()`                       |
 * | wallet VIRTUAL balance, allowance | the ERC-20, at this block                     |
 *
 * `router()` is read and held to the deployment's FRouterV3 as a closed-loop
 * check on the table: a BondingV5 whose router is not the one Vex pinned is a
 * different suite, and the curve lane's quote maths would not describe it.
 *
 * ## Tolerance policy
 *
 * None. Every read on this path is required, and a read that fails is a
 * REFUSAL by name. There is no "unknown fee" that could be treated as zero: a
 * launch signs away a real VIRTUAL balance, and rule 90 makes an unreadable
 * authority a fail-closed condition rather than a default.
 */

import { getAddress, type Address, type Chain, type PublicClient, type Transport } from "viem";

import { CURVE_ERC20_ABI } from "../curve/abi.js";
import type { VirtualsCurveDeployment } from "../curve/deployments.js";
import { checkPinnedImplementations } from "../curve/proxy-identity.js";
import { BONDING_CONFIG_LAUNCH_ABI, BONDING_V5_LAUNCH_ABI } from "./abi.js";

export interface LaunchState {
  readonly ok: true;
  readonly blockNumber: bigint;
  readonly bondingConfig: Address;
  readonly feeTo: Address;
  /** `calculateLaunchFee(false, false)`. Measured 0 on both chains, read anyway. */
  readonly protocolLaunchFeeRaw: bigint;
  /** `startTime_ >= now + startTimeDelay` is what makes a launch SCHEDULED. */
  readonly scheduledStartTimeDelaySeconds: bigint;
  /** `scheduledLaunchParams.normalLaunchFee` - what a scheduled launch would cost. */
  readonly scheduledLaunchFeeRaw: bigint;
  /** `scheduledLaunchParams.acfFee` - what ACF would cost. */
  readonly acfFeeRaw: bigint;
  readonly initialSupply: bigint;
  readonly virtualDecimals: number;
  readonly virtualBalanceRaw: bigint;
  /** The wallet's current allowance to BondingV5 - the launch spender. */
  readonly allowanceRaw: bigint;
  readonly implementations: { readonly bondingV5: Address; readonly frouterV3: Address };
}

export interface LaunchStateRefusal {
  readonly ok: false;
  readonly code: "proxy_moved" | "suite_mismatch" | "unreadable";
  readonly reason: string;
}

export type LaunchStateResult = LaunchState | LaunchStateRefusal;

/** Read every authority row of a launch, at one block, from one wallet's view. */
export async function readLaunchState(input: {
  readonly client: PublicClient<Transport, Chain>;
  readonly deployment: VirtualsCurveDeployment;
  readonly wallet: Address;
}): Promise<LaunchStateResult> {
  const { client, deployment, wallet } = input;

  // The block is pinned FIRST, and every read below names it.
  const blockNumber = await client.getBlockNumber();

  const pins = await checkPinnedImplementations(client, deployment);
  if (!pins.ok) return { ok: false, code: "proxy_moved", reason: pins.reason };

  let bondingConfig: Address;
  let router: Address;
  try {
    [bondingConfig, router] = await Promise.all([
      client.readContract({
        address: deployment.bondingV5, abi: BONDING_V5_LAUNCH_ABI,
        functionName: "bondingConfig", blockNumber,
      }) as Promise<Address>,
      client.readContract({
        address: deployment.bondingV5, abi: BONDING_V5_LAUNCH_ABI,
        functionName: "router", blockNumber,
      }) as Promise<Address>,
    ]);
  } catch (err) {
    return {
      ok: false, code: "unreadable",
      reason: unreadable(deployment, "BondingV5.bondingConfig()/router()", err),
    };
  }

  if (getAddress(router) !== getAddress(deployment.frouterV3)) {
    return {
      ok: false,
      code: "suite_mismatch",
      reason:
        `BondingV5 on ${deployment.name} names router ${getAddress(router)}, but Vex is pinned to `
        + `${getAddress(deployment.frouterV3)}. That is a different contract suite from the one this lane was `
        + "verified against, so nothing was signed.",
    };
  }

  try {
    const [fee, scheduled, feeTo, initialSupply, decimals, balance, allowance] = await Promise.all([
      client.readContract({
        address: bondingConfig, abi: BONDING_CONFIG_LAUNCH_ABI,
        functionName: "calculateLaunchFee", args: [false, false], blockNumber,
      }) as Promise<bigint>,
      client.readContract({
        address: bondingConfig, abi: BONDING_CONFIG_LAUNCH_ABI,
        functionName: "getScheduledLaunchParams", blockNumber,
      }) as Promise<{ startTimeDelay: bigint; normalLaunchFee: bigint; acfFee: bigint }>,
      client.readContract({
        address: bondingConfig, abi: BONDING_CONFIG_LAUNCH_ABI,
        functionName: "feeTo", blockNumber,
      }) as Promise<Address>,
      client.readContract({
        address: bondingConfig, abi: BONDING_CONFIG_LAUNCH_ABI,
        functionName: "initialSupply", blockNumber,
      }) as Promise<bigint>,
      client.readContract({
        address: deployment.virtual, abi: CURVE_ERC20_ABI,
        functionName: "decimals", blockNumber,
      }) as Promise<number>,
      client.readContract({
        address: deployment.virtual, abi: CURVE_ERC20_ABI,
        functionName: "balanceOf", args: [wallet], blockNumber,
      }) as Promise<bigint>,
      client.readContract({
        address: deployment.virtual, abi: CURVE_ERC20_ABI,
        // THE SPENDER IS BondingV5. See `./calldata.ts` for why this is not
        // FRouterV3 the way a curve trade's allowance is.
        functionName: "allowance", args: [wallet, deployment.bondingV5], blockNumber,
      }) as Promise<bigint>,
    ]);

    return {
      ok: true,
      blockNumber,
      bondingConfig: getAddress(bondingConfig),
      feeTo: getAddress(feeTo),
      protocolLaunchFeeRaw: fee,
      scheduledStartTimeDelaySeconds: scheduled.startTimeDelay,
      scheduledLaunchFeeRaw: scheduled.normalLaunchFee,
      acfFeeRaw: scheduled.acfFee,
      initialSupply,
      virtualDecimals: Number(decimals),
      virtualBalanceRaw: balance,
      allowanceRaw: allowance,
      implementations: pins.observed,
    };
  } catch (err) {
    return {
      ok: false, code: "unreadable",
      reason: unreadable(deployment, "the BondingConfig fee table or the VIRTUAL balance and allowance", err),
    };
  }
}

function unreadable(deployment: VirtualsCurveDeployment, what: string, err: unknown): string {
  const detail = err instanceof Error ? err.message.split("\n")[0] ?? "" : "";
  return (
    `Vex could not read ${what} on ${deployment.name}, so it cannot state what a launch would cost or `
    + `whether the wallet can pay for it. Nothing was signed.${detail === "" ? "" : ` (${detail})`}`
  );
}
