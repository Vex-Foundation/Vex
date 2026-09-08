import {
  createPublicClient,
  createWalletClient,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { KhalaniChain } from "./types.js";
import { getChainRpcUrl } from "./chains.js";
import { buildEvmTransport, buildPinnedEvmTransport } from "../evm-chains/rpc-transport.js";

function toViemChain(chain: KhalaniChain, rpcUrl: string): Chain {
  return {
    id: chain.id,
    name: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: chain.blockExplorers?.default
      ? {
          default: {
            name: chain.blockExplorers.default.name,
            url: chain.blockExplorers.default.url,
          },
        }
      : undefined,
  };
}

// Explicit return annotations (mirroring kyberswap/evm/config.ts): viem's
// inferred client types reference internal action modules and are not
// portable across declaration emit (TS2742).
export function createDynamicWalletClient(
  chain: KhalaniChain,
  chains: KhalaniChain[],
  privateKey: Hex,
): WalletClient<Transport, Chain, Account> {
  const rpcUrl = getChainRpcUrl(chain.id, chains);
  // Khalani's registry url enters as a PROVIDER-tier entry behind the user's
  // own endpoint and any bundled entry for the chain, so a bridge leg on a
  // chain Vex already knows uses the same measured endpoints every other venue
  // does. Pinned, because this client signs.
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: toViemChain(chain, rpcUrl),
    transport: buildPinnedEvmTransport(chain.id, { providerUrls: [rpcUrl] }),
  }) as WalletClient<Transport, Chain, Account>;
}

export function createDynamicPublicClient(
  chain: KhalaniChain,
  chains: KhalaniChain[],
): PublicClient<Transport, Chain> {
  const rpcUrl = getChainRpcUrl(chain.id, chains);
  return createPublicClient({
    chain: toViemChain(chain, rpcUrl),
    transport: buildEvmTransport(chain.id, { providerUrls: [rpcUrl] }),
  }) as PublicClient<Transport, Chain>;
}
