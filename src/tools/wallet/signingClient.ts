import { createWalletClient, http } from "viem";
import type { Account, Chain, Hex, Transport, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../../config/store.js";

// Explicit return annotation (mirroring kyberswap/evm/config.ts): viem's
// inferred client type references internal action modules and is not
// portable across declaration emit (TS2742).
export function getSigningClient(privateKey: Hex): WalletClient<Transport, Chain, Account> {
  const cfg = loadConfig();
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: {
      id: cfg.chain.chainId,
      name: cfg.chain.name,
      nativeCurrency: cfg.chain.nativeCurrency,
      rpcUrls: { default: { http: [cfg.chain.rpcUrl] } },
    },
    transport: http(cfg.chain.rpcUrl, { timeout: 30_000, retryCount: 2 }),
  }) as WalletClient<Transport, Chain, Account>;
}
