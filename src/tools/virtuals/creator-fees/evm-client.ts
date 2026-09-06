/**
 * Read-only viem client for an AgentTaxV2 deployment.
 *
 * Client policy copied from `tools/uniswap/evm-client.ts` deliberately, because
 * it is the policy this repository already settled: where the LOCAL chain
 * registry knows the chain (Robinhood 4663), DEFER to it - that path honours the
 * user's own RPC override and wires Multicall3. Otherwise build the chain inline
 * from the deployment's bundled RPC.
 *
 * MULTICALL3 IS WIRED ON THE INLINE PATH TOO, because this module's contract is
 * "one answer, one block": a dozen getters spread across several round trips can
 * straddle a swap and report a `pending` that never existed. The canonical
 * deployment 0xcA11bde05977b3631167028862bE2a173976CA11 was exercised live on
 * both Base and Robinhood on 2026-09-04; the local registry already wires the
 * same address for 4663.
 *
 * READ-ONLY BY CONSTRUCTION. There is no wallet-client factory here and no
 * private key reaches this module: a creator-fee read never signs, and the one
 * mutation a creator might want is refused by the contract's own role check.
 */

import {
  createPublicClient,
  defineChain,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";

import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getLocalPublicClient } from "@tools/evm-chains/evm-client.js";
import { resolveRpcEndpoints } from "@tools/evm-chains/rpc-endpoints.js";
import { buildEvmTransport } from "@tools/evm-chains/rpc-transport.js";
import type { VirtualsTaxDeployment } from "./deployments.js";

/** Canonical Multicall3, live-verified on 8453 and 4663 on 2026-09-04. */
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/**
 * Explicit return annotation, same reason as every other client factory in the
 * tree: viem's inferred client type references internal action modules and does
 * not survive declaration emit (TS2742).
 */
export function getVirtualsTaxPublicClient(
  deployment: VirtualsTaxDeployment,
): PublicClient<Transport, Chain> {
  const local = getLocalChain(deployment.chainId);
  if (local) return getLocalPublicClient(local);
  const first = resolveRpcEndpoints(deployment.chainId)[0];
  if (first === undefined) {
    throw new Error(
      `Virtuals creator fees: no RPC endpoint is bundled or configured for chain ${deployment.chainId}.`,
    );
  }
  return createPublicClient({
    chain: defineChain({
      id: deployment.chainId,
      name: deployment.slug,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [first.url] } },
      contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
    }),
    transport: buildEvmTransport(deployment.chainId),
  }) as PublicClient<Transport, Chain>;
}
