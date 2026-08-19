/**
 * The two `eth_call` simulations the verifier's points 9, 10 and 8 depend on.
 *
 * WHY TWO. The first runs the launch with `devBuyMinOut` forced to ZERO, which
 * is the only way to learn what the prebuy would ACTUALLY fill: a simulation
 * against the provider's own floor answers "does its number pass its own
 * number", which proves nothing. That fill is then required to equal the floor
 * the provider pinned (point 9), so the floor is the exact simulated amount and
 * never a percentage band (rule 90).
 *
 * The second runs the FINAL bytes - the exact `(to, data, value)` that will be
 * signed, untouched. Vex never rewrites the provider's calldata: a floor we
 * substituted would be a tuple nobody's salt was mined for, and the whole
 * verifier rests on judging the bytes as given.
 *
 * A simulation that does not answer is NOT a pass. Both helpers report the
 * failure with the revert reason the node gave, and the verifier turns that into
 * a refusal; nothing here returns a default.
 */

import { encodeFunctionData, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";

import { POOLS_GATEWAY_ABI } from "../abi.js";
import { decodeLaunchCalldata } from "./verify-calldata.js";
import type { PoolsLaunchTuple } from "./verifier-types.js";

export interface PoolsSimulationRequest {
  readonly publicClient: PublicClient<Transport, Chain>;
  /** The wallet the launch is simulated AS. Balance and identity both matter. */
  readonly account: Address;
  readonly gateway: Address;
  readonly data: Hex;
  readonly valueWei: bigint;
  /** The anchored block, so the simulation describes the state the anchors describe. */
  readonly blockNumber: bigint;
}

/** What one successful `launch` simulation returns, as the ABI declares it. */
export interface PoolsLaunchSimulationOutput {
  readonly tokenAddress: Address;
  readonly poolAddress: Address;
  readonly devBuyOut: bigint;
}

export type PoolsLaunchSimulationResult =
  | { readonly ok: true; readonly value: PoolsLaunchSimulationOutput }
  | { readonly ok: false; readonly reason: string };

/** Re-encode a tuple with the dev-buy floor removed, for the fill-discovery call. */
export function encodeLaunchWithoutMinOut(tuple: PoolsLaunchTuple): Hex {
  return encodeFunctionData({
    abi: POOLS_GATEWAY_ABI,
    functionName: "launch",
    args: [{ ...tuple, devBuyMinOut: 0n }],
  });
}

export async function simulatePoolsLaunch(
  request: PoolsSimulationRequest,
): Promise<PoolsLaunchSimulationResult> {
  try {
    const { result } = await request.publicClient.simulateContract({
      account: request.account,
      address: request.gateway,
      abi: POOLS_GATEWAY_ABI,
      functionName: "launch",
      args: decodeArgsFromData(request.data),
      value: request.valueWei,
      blockNumber: request.blockNumber,
    });
    const [tokenAddress, poolAddress, devBuyOut] = result as readonly [Address, Address, bigint];
    return { ok: true, value: { tokenAddress, poolAddress, devBuyOut } };
  } catch (err) {
    return { ok: false, reason: simulationFailureReason(err) };
  }
}

/**
 * The tuple these exact bytes carry.
 *
 * The simulation is driven from the DECODED bytes rather than from a tuple the
 * caller kept alongside them, so what is simulated cannot drift from what is
 * signed - the two would be a copy and its original.
 */
function decodeArgsFromData(data: Hex): readonly [PoolsLaunchTuple] {
  // The verifier's own decoder, so there is exactly ONE implementation of "what
  // does this calldata mean".
  const tuple = decodeLaunchCalldata(data);
  if (tuple === null) {
    throw new Error("the calldata does not decode as PoolsFunLaunchGateway.launch");
  }
  return [tuple] as const;
}

/**
 * The reason a simulation failed, in words an agent can act on and with nothing
 * in it that leaks a node URL, a request body or an auth header.
 */
function simulationFailureReason(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const named = err as { shortMessage?: unknown; name?: unknown };
    if (typeof named.shortMessage === "string" && named.shortMessage.trim() !== "") {
      return named.shortMessage.trim();
    }
    if (typeof named.name === "string") return named.name;
  }
  return "the node did not say why";
}
