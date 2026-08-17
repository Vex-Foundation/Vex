/**
 * The viem public client the Morpho on-chain reads use.
 *
 * Structurally the same as `src/tools/pendle/evm-client.ts`, and it exists
 * separately for the same reason Pendle's does: the chain table, the RPC choice
 * and the Multicall3 wiring are venue decisions, and a shared client that
 * guessed them would be wrong for somebody.
 *
 * `contracts.multicall3` IS WIRED UNCONDITIONALLY, which is the one thing that
 * must not be copied from `src/tools/kyberswap/evm/config.ts`. That module wires
 * Multicall3 for Robinhood alone, so `client.multicall(...)` fails on the other
 * eight chains, and it hardcodes `nativeCurrency` as ETH/18 everywhere, which
 * misnames POL, MON and HYPE. Both matter here: this lane reads many tokens and
 * many spenders in one batch, and it reports a native balance by symbol.
 *
 * The `as PublicClient<Transport, Chain>` cast at the end is the repo-wide,
 * deliberate one (TS2742 declaration-emit portability), documented in
 * `src/tools/evm-chains/evm-client.ts`.
 */

import { createPublicClient, http, type Chain, type PublicClient, type Transport } from "viem";

import { VexError, ErrorCodes } from "../../errors.js";
import {
  MORPHO_DEFAULT_RPC,
  MORPHO_MULTICALL3,
  MORPHO_NATIVE_SYMBOL,
} from "./constants.js";
import { MORPHO_CHAINS, describeUnsupportedChain } from "./chains.js";

const RPC_TIMEOUT_MS = 30_000;
const RPC_RETRY_COUNT = 2;

const BY_ID = new Map(MORPHO_CHAINS.map((chain) => [chain.chainId, chain]));

function buildViemChain(chainId: number): Chain {
  const chain = BY_ID.get(chainId);
  const rpcUrl = MORPHO_DEFAULT_RPC[chainId];
  if (chain === undefined || rpcUrl === undefined) {
    throw new VexError(
      ErrorCodes.MORPHO_UNSUPPORTED_CHAIN,
      `Morpho: ${describeUnsupportedChain(String(chainId))}`,
      "Name one of the supported chain slugs, or its numeric chain id.",
    );
  }
  const symbol = MORPHO_NATIVE_SYMBOL[chainId] ?? "ETH";
  return {
    id: chain.chainId,
    name: chain.morphoNetwork,
    nativeCurrency: { name: symbol, symbol, decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: MORPHO_MULTICALL3 } },
  };
}

/** A budgeted, Multicall3-wired public client for a supported Morpho chain. */
export function getMorphoPublicClient(chainId: number): PublicClient<Transport, Chain> {
  const chain = buildViemChain(chainId);
  return createPublicClient({
    chain,
    transport: http(chain.rpcUrls.default.http[0], {
      timeout: RPC_TIMEOUT_MS,
      retryCount: RPC_RETRY_COUNT,
    }),
  }) as PublicClient<Transport, Chain>;
}
