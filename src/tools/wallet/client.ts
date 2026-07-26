import { createPublicClient, http, type PublicClient, type Chain } from "viem";
import { loadConfig } from "../../config/store.js";
import { minLogger as logger } from "../../utils/logger-shim.js";

const RPC_TIMEOUT = 10_000; // 10 seconds

let cachedClient: PublicClient | null = null;
let cachedRpcUrl: string | null = null;

function createConfiguredEvmChain(config: ReturnType<typeof loadConfig>): Chain {
  return {
    id: config.chain.chainId,
    name: config.chain.name,
    nativeCurrency: config.chain.nativeCurrency,
    rpcUrls: {
      default: {
        http: [config.chain.rpcUrl],
      },
    },
    blockExplorers: {
      default: {
        name: `${config.chain.name} Explorer`,
        url: config.chain.explorerUrl,
      },
    },
  };
}

export function getPublicClient(): PublicClient {
  const config = loadConfig();
  const rpcUrl = config.chain.rpcUrl;

  // Return cached client if RPC URL hasn't changed
  if (cachedClient && cachedRpcUrl === rpcUrl) {
    return cachedClient;
  }

  logger.debug(`Creating viem client for ${rpcUrl}`);

  const chain = createConfiguredEvmChain(config);

  cachedClient = createPublicClient({
    chain,
    transport: http(rpcUrl, {
      timeout: RPC_TIMEOUT,
      retryCount: 2,
      retryDelay: 1000,
    }),
  });

  cachedRpcUrl = rpcUrl;
  return cachedClient;
}

export function clearClientCache(): void {
  cachedClient = null;
  cachedRpcUrl = null;
}
