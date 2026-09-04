/**
 * viem clients for the Virtuals curve chains.
 *
 * Same policy as `uniswap/evm-client.ts`, and for the same reason: where the
 * LOCAL chain registry knows the chain (Robinhood 4663) it owns the client, so
 * a user's own RPC override and the wired Multicall3 are honoured; otherwise a
 * chain is built inline from the deployment's bundled RPC.
 *
 * Gas is never cached. Robinhood is an Arbitrum-Orbit L2 whose L1 data-fee
 * component moves block to block, so every leg estimates fresh.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
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

import type { VirtualsCurveDeployment } from "./deployments.js";

const RPC_TIMEOUT_MS = 30_000;
const RPC_RETRY_COUNT = 2;

export interface VirtualsCurveClients {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, Account>;
}

function toViemChain(deployment: VirtualsCurveDeployment): Chain {
  return defineChain({
    id: deployment.chainId,
    name: deployment.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [deployment.defaultRpcUrl] } },
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
    transport: http(deployment.defaultRpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: RPC_RETRY_COUNT }),
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
  const transport = http(deployment.defaultRpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: RPC_RETRY_COUNT });
  return {
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ account: privateKeyToAccount(privateKey), chain, transport }),
  };
}
