/**
 * Uniswap viem client factory (public + wallet), per chain.
 *
 * Client policy (LOCKED Wave-2 note): where the LOCAL chain registry knows the
 * chain (Robinhood 4663), defer to it — it honours the user's RPC override and
 * wires Multicall3. Otherwise build a viem chain inline via `defineChain` from
 * the verified deployment's bundled RPC (documented provenance in
 * `./deployments.ts`).
 *
 * Gas rule: NEVER cache/hardcode gas limits — viem estimates fresh at send time
 * (its default). Robinhood is an Arbitrum-Orbit L2 with a fluctuating L1-data
 * fee component, so a cached limit would be wrong block to block.
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
import type { UniswapDeployment } from "./deployments.js";

const RPC_TIMEOUT_MS = 30_000;
const RPC_RETRY_COUNT = 2;

export interface UniswapEvmClients {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
}

function toViemChain(deployment: UniswapDeployment): Chain {
  return defineChain({
    id: deployment.chainId,
    name: deployment.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [deployment.defaultRpcUrl] } },
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
    transport: http(deployment.defaultRpcUrl, {
      timeout: RPC_TIMEOUT_MS,
      retryCount: RPC_RETRY_COUNT,
    }),
  }) as PublicClient<Transport, Chain>;
}

/**
 * Read-only client for durable receipt and event-log evidence.
 *
 * It never signs or broadcasts. Deployments without a separately reviewed
 * historical endpoint retain the normal public-client behavior.
 */
export function getUniswapHistoricalPublicClient(
  deployment: UniswapDeployment,
): PublicClient<Transport, Chain> {
  if (deployment.historicalRpcUrl === undefined) {
    return getUniswapPublicClient(deployment);
  }
  return createPublicClient({
    chain: toViemChain(deployment),
    transport: http(deployment.historicalRpcUrl, {
      timeout: RPC_TIMEOUT_MS,
      retryCount: RPC_RETRY_COUNT,
    }),
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
  const publicClient = createPublicClient({
    chain,
    transport: http(deployment.defaultRpcUrl, {
      timeout: RPC_TIMEOUT_MS,
      retryCount: RPC_RETRY_COUNT,
    }),
  }) as PublicClient<Transport, Chain>;
  const walletClient = createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain,
    transport: http(deployment.defaultRpcUrl, {
      timeout: RPC_TIMEOUT_MS,
      retryCount: RPC_RETRY_COUNT,
    }),
  }) as WalletClient<Transport, Chain, Account>;
  return { publicClient, walletClient };
}
