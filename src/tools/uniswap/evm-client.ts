/**
 * Uniswap viem client factory (public + wallet), per chain.
 *
 * Client policy: the SHARED RPC OWNER (`@tools/evm-chains/rpc-endpoints.ts`)
 * decides which endpoints a chain has, in what order, with what method scopes,
 * and where the user's own override sits. Robinhood 4663 keeps deferring to the
 * local chain registry, which wires Multicall3 and the explorer; every other
 * chain now gets the same owner instead of a url copied into `./deployments.ts`.
 * That is what fixes the defect this venue carried: Base pointed at
 * `base.drpc.org`, which answered every `eth_call` with a free-plan timeout, and
 * no Uniswap chain except 4663 could see a user's RPC override at all.
 *
 * Gas rule: NEVER cache/hardcode gas limits — viem estimates fresh at send time
 * (its default). Robinhood is an Arbitrum-Orbit L2 with a fluctuating L1-data
 * fee component, so a cached limit would be wrong block to block.
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
import type { UniswapDeployment } from "./deployments.js";

export interface UniswapEvmClients {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
}

function toViemChain(deployment: UniswapDeployment): Chain {
  // Chain METADATA only. The transport reaches the whole resolved endpoint
  // list; this url is the first of them, which is what viem's `Chain` wants.
  const endpoints = resolveRpcEndpoints(deployment.chainId);
  const first = endpoints[0];
  if (first === undefined) {
    throw new Error(`Uniswap: no RPC endpoint is bundled or configured for chain ${deployment.chainId}.`);
  }
  return defineChain({
    id: deployment.chainId,
    name: deployment.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [first.url] } },
  });
}

// Explicit return annotations mirror kyberswap/evm/config.ts + evm-chains: viem's
// inferred client types reference internal action modules and are not portable
// across declaration emit (TS2742).

/** Read-only public client for on-chain quoting (QuoterV2 / getAmountsOut / metadata). */
export function getUniswapPublicClient(
  deployment: UniswapDeployment,
): PublicClient<Transport, Chain> {
  const local = getLocalChain(deployment.chainId);
  if (local) return getLocalPublicClient(local);
  return createPublicClient({
    chain: toViemChain(deployment),
    transport: buildEvmTransport(deployment.chainId),
  }) as PublicClient<Transport, Chain>;
}

/** Public + wallet clients for broadcast. Decrypts nothing beyond the passed key. */
export function getUniswapEvmClients(
  deployment: UniswapDeployment,
  privateKey: Hex,
): UniswapEvmClients {
  const local = getLocalChain(deployment.chainId);
  if (local) return getLocalEvmClients(local, privateKey);

  const chain = toViemChain(deployment);
  // ONE pinned transport for both clients: the quote, the estimate, the nonce
  // and the broadcast are the same node's opinion, and no silent endpoint
  // switch can make the simulation stale between them.
  const transport = buildPinnedEvmTransport(deployment.chainId);
  const publicClient = createPublicClient({ chain, transport }) as PublicClient<Transport, Chain>;
  const walletClient = createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain,
    transport,
  }) as WalletClient<Transport, Chain, Account>;
  return { publicClient, walletClient };
}
