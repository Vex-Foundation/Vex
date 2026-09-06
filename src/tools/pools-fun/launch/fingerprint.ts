/**
 * Verifier point 13 - the handshake between what was PROVED and what gets
 * signed.
 *
 * The verifier returns the tuple it proved. This module turns that, plus the
 * response's own `(to, data, value)`, into the exact call the C0 authorization
 * covers and the fingerprint that names it. Nothing is re-derived on the way:
 * re-encoding a tuple here and signing THOSE bytes would sign something the
 * verifier never saw, and the provider's salt was mined for the bytes it sent.
 *
 * THE ORDER THIS EXISTS TO PROTECT is: verify -> authorize this fingerprint ->
 * broadcast this fingerprint. On the pools.fun path the fingerprint IS the gate,
 * because a "re-derive the plan and compare" gate is unavailable: a
 * second `prepare` pins a second persistent IPFS object and mines a DIFFERENT
 * salt, so the re-derivation would describe a different token at a different
 * address. What replaces it is that the verifier runs immediately before the
 * authorization, over these exact bytes, and the broadcaster is handed nothing
 * else.
 */

import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";

import { nativeValueCallFingerprint } from "@tools/evm-chains/native-value-authorization/index.js";
import { POOLS_GATEWAY_ABI } from "../abi.js";
import { POOLS_CHAIN_ID } from "../constants.js";
import type { PoolsLaunchTuple } from "./verifier-types.js";

/** The exact transaction an authorization covers, and its identity. */
export interface PoolsAuthorizedLaunchCall {
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex;
  readonly valueWei: bigint;
  /** `(chainId, to, data, value)`, hashed. Different in any respect, different hash. */
  readonly fingerprint: Hex;
}

/**
 * Bind the verified tuple to the bytes that will be signed.
 *
 * THROWS when the tuple does not re-encode to the calldata. That is not an input
 * condition - the verifier's point 3 already proved byte-identical re-encoding,
 * so reaching it means this function was called with a tuple and a response that
 * do not belong together, which is a programming error and must not be
 * papered over on a signing path.
 */
export function bindPoolsLaunchCall(
  verifiedTuple: PoolsLaunchTuple,
  response: { readonly to: string; readonly data: string; readonly value: string },
): PoolsAuthorizedLaunchCall {
  const data = response.data as Hex;
  const reencoded = encodeFunctionData({
    abi: POOLS_GATEWAY_ABI,
    functionName: "launch",
    args: [verifiedTuple],
  });
  if (reencoded.toLowerCase() !== data.toLowerCase()) {
    throw new Error(
      "Refusing to bind a pools.fun launch authorization: the verified tuple does not re-encode to the "
        + "calldata it was verified against.",
    );
  }

  const to = getAddress(response.to);
  const valueWei = BigInt(response.value);
  return {
    chainId: POOLS_CHAIN_ID,
    to,
    data,
    valueWei,
    fingerprint: nativeValueCallFingerprint({ chainId: POOLS_CHAIN_ID, to, data, valueWei }),
  };
}
