/**
 * REAL viem clients whose reads are scripted by the test.
 *
 * A suite that needs a `PublicClient` for one production call has, until now,
 * had two bad options: `{...} as unknown as PublicClient` (which makes every
 * method the stub forgot `undefined`, so a production call the test did not
 * anticipate dies on "x is not a function" instead of saying so) or `as never`
 * (which silences the same class of error even more thoroughly).
 *
 * These builders take the third option: construct the ACTUAL viem client over a
 * transport that has no script, then overlay the methods the test wants to
 * answer. The result is typed by viem itself - no cast anywhere in this module -
 * and an unscripted call reaches the transport and throws by name, which is the
 * behaviour a test wants when the code under test grows a read.
 */

import {
  createPublicClient,
  createWalletClient,
  custom,
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { parseAccount } from "viem/accounts";

/**
 * The chain the doubles are built on. Its RPC URL is never dialled: the custom
 * transport below answers every request by throwing.
 */
function doubleChain(chainId: number): Chain {
  return {
    id: chainId,
    name: `test-double-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://127.0.0.1:1"] } },
  };
}

/** Base, the chain every current caller's fixtures were captured on. */
const DEFAULT_DOUBLE_CHAIN_ID = 8453;

function unscriptedTransport(): Transport {
  return custom({
    request: async ({ method }: { method: string }) => {
      throw new Error(`this test double has no script for the JSON-RPC method ${method}`);
    },
  });
}

/**
 * A `PublicClient` whose listed methods are the test's and whose every other
 * method is viem's own, reaching a transport that refuses by name.
 */
export function publicClientDouble<Overrides extends object>(
  overrides: Overrides,
  chainId: number = DEFAULT_DOUBLE_CHAIN_ID,
): PublicClient<Transport, Chain> & Overrides {
  return Object.assign(
    createPublicClient({ chain: doubleChain(chainId), transport: unscriptedTransport() }),
    overrides,
  );
}

/** The `WalletClient` counterpart, account-bound because the signing path requires it. */
export function walletClientDouble<Overrides extends object>(
  address: Address,
  overrides: Overrides,
  chainId: number = DEFAULT_DOUBLE_CHAIN_ID,
): WalletClient<Transport, Chain, Account> & Overrides {
  const account: Account = parseAccount(address);
  return Object.assign(
    createWalletClient({ account, chain: doubleChain(chainId), transport: unscriptedTransport() }),
    overrides,
  );
}
