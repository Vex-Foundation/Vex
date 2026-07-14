import type { Address } from "viem";

/** Hyperliquid endpoints and local runtime network selection. */

export type HyperliquidNetwork = "mainnet" | "testnet";

export interface HyperliquidEndpoints {
  readonly info: string;
  readonly exchange: string;
  readonly websocket: string;
  readonly signatureChainId: `0x${string}`;
  readonly hyperliquidChain: "Mainnet" | "Testnet";
}

export const HYPERLIQUID_NETWORK_ENV = "VEX_HYPERLIQUID_NETWORK";

export const HYPERLIQUID_ENDPOINTS: Readonly<Record<HyperliquidNetwork, HyperliquidEndpoints>> = {
  mainnet: {
    info: "https://api.hyperliquid.xyz/info",
    exchange: "https://api.hyperliquid.xyz/exchange",
    websocket: "wss://api.hyperliquid.xyz/ws",
    signatureChainId: "0x1",
    hyperliquidChain: "Mainnet",
  },
  testnet: {
    info: "https://api.hyperliquid-testnet.xyz/info",
    exchange: "https://api.hyperliquid-testnet.xyz/exchange",
    websocket: "wss://api.hyperliquid-testnet.xyz/ws",
    signatureChainId: "0x66eee",
    hyperliquidChain: "Testnet",
  },
};

/**
 * Mainnet is deliberate default. Testnet exists only for explicit development
 * configuration; release verification is governed by the product gate.
 */
export function resolveHyperliquidNetwork(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HyperliquidNetwork {
  const raw = env[HYPERLIQUID_NETWORK_ENV]?.trim();
  if (raw === undefined || raw === "") return "mainnet";
  if (raw === "mainnet" || raw === "testnet") return raw;
  throw new Error(`${HYPERLIQUID_NETWORK_ENV} must be "mainnet" or "testnet".`);
}

export function endpointsForNetwork(network: HyperliquidNetwork): HyperliquidEndpoints {
  return HYPERLIQUID_ENDPOINTS[network];
}

export const HYPERLIQUID_MIN_NOTIONAL_USD = "10";
export const HYPERLIQUID_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Mainnet Bridge2 deposit constants. Source: Hyperliquid Bridge2 docs
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/bridge2
 * and the linked Bridge2 contract
 * https://arbiscan.io/address/0x2df1c51e09aecf9cacb7bc98cb1742757f163df7,
 * plus native USDC
 * https://arbiscan.io/token/0xaf88d065e77c8cC2239327C5EDb3A432268e5831 .
 *
 * Bridge2 credits a native-USDC ERC-20 transfer to the SENDER's Hyperliquid
 * account. These are intentionally constants, never model-supplied params.
 */
export const ARBITRUM_ONE_CHAIN_ID = 42_161;
export const ARBITRUM_NATIVE_USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;
export const HYPERLIQUID_BRIDGE2_MAINNET_ADDRESS = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7" as Address;
export const HYPERLIQUID_BRIDGE2_MIN_DEPOSIT_USDC = "5";

