/**
 * Chain → verified Uniswap deployment, and route → router address.
 *
 * The router is never taken from a provider response: it is read from the
 * deployment table for the route version we ourselves chose, which is what
 * keeps `validateUniswapSpender`'s allowlist meaningful.
 */

import { getAddress, type Address } from "viem";

import { resolveUniswapDeployment } from "@tools/uniswap/chains.js";
import type { UniswapDeployment } from "@tools/uniswap/deployments.js";
import type { UniswapRoute } from "@tools/uniswap/types.js";

import { VexError, ErrorCodes } from "../../../../../../errors.js";

/** Resolve the chain param to a deployment, or throw a clean error. */
export function requireDeployment(chain: string): UniswapDeployment {
  const deployment = resolveUniswapDeployment(chain);
  if (!deployment) {
    throw new VexError(
      ErrorCodes.KYBER_UNSUPPORTED_CHAIN,
      `Uniswap has no verified deployment for chain "${chain}".`,
      "Uniswap is a hidden fallback venue, available after an eligible KyberSwap swap failure: a route or token KyberSwap cannot price, an unsafe or pre-sign-refused build, the Kyber swap transaction reverting on-chain, or KyberSwap being unavailable to us at all.",
    );
  }
  return deployment;
}

export function routerFor(deployment: UniswapDeployment, route: UniswapRoute): Address {
  const router = route.version === "v2" ? deployment.v2?.router02 : deployment.v3?.swapRouter02;
  if (!router) throw new VexError(ErrorCodes.SWAP_FAILED, `No ${route.version} router on ${deployment.name}.`);
  return getAddress(router);
}
