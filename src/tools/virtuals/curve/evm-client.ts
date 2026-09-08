/**
 * viem clients for the Virtuals curve chains.
 *
 * Same policy as `uniswap/evm-client.ts`, and for the same reason: where the
 * LOCAL chain registry knows the chain (Robinhood 4663) it owns the client, so
 * the wired Multicall3 and explorer come from there; every chain, 4663 and
 * Base alike, takes its TRANSPORT from the shared RPC owner
 * (`@tools/evm-chains/rpc-endpoints.ts`).
 *
 * BASE HAD NO USER OVERRIDE PATH AND A DEAD DEFAULT until this rewiring. The
 * deployment pinned `base.drpc.org`, which answered `eth_call`,
 * `eth_getStorageAt` and `eth_getLogs` with a free-plan timeout and a twelve of
 * twelve HTTP 408 burst, and `getLocalChain(8453)` is undefined so nothing
 * consulted the user's config either. Both are properties of the owner now.
 *
 * Gas is never cached. Robinhood is an Arbitrum-Orbit L2 whose L1 data-fee
 * component moves block to block, so every leg estimates fresh.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getLocalEvmClients, getLocalPublicClient } from "@tools/evm-chains/evm-client.js";
import { resolveRpcEndpoints } from "@tools/evm-chains/rpc-endpoints.js";
import { buildEvmTransport, buildPinnedEvmTransport } from "@tools/evm-chains/rpc-transport.js";

import type { VirtualsCurveDeployment } from "./deployments.js";

export interface VirtualsCurveClients {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, Account>;
}

function toViemChain(deployment: VirtualsCurveDeployment): Chain {
  // Chain METADATA only; the transport reaches the whole resolved list.
  const first = resolveRpcEndpoints(deployment.chainId)[0];
  if (first === undefined) {
    throw new Error(
      `Virtuals curve: no RPC endpoint is bundled or configured for chain ${deployment.chainId}.`,
    );
  }
  return defineChain({
    id: deployment.chainId,
    name: deployment.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [first.url] } },
  });
}

// Explicit return annotations mirror the sibling venues: viem's inferred client
// types reference internal action modules and are not portable across
// declaration emit (TS2742).

export function getVirtualsCurvePublicClient(
  deployment: VirtualsCurveDeployment,
): PublicClient<Transport, Chain> {
  const local = getLocalChain(deployment.chainId);
  if (local) return getLocalPublicClient(local);
  return createPublicClient({
    chain: toViemChain(deployment),
    transport: buildEvmTransport(deployment.chainId),
  });
}

export function getVirtualsCurveClients(
  deployment: VirtualsCurveDeployment,
  privateKey: Hex,
): VirtualsCurveClients {
  const local = getLocalChain(deployment.chainId);
  if (local) {
    const clients = getLocalEvmClients(local, privateKey);
    return { publicClient: clients.publicClient, walletClient: clients.walletClient };
  }
  const chain = toViemChain(deployment);
  // PINNED: a launch or a curve trade reads its state, estimates, signs and
  // broadcasts through one node (see `evm-chains/rpc-transport.ts`).
  const transport = buildPinnedEvmTransport(deployment.chainId);
  return {
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ account: privateKeyToAccount(privateKey), chain, transport }),
  };
}
