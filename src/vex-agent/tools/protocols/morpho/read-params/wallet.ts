/**
 * Input contract for `morpho.wallet.balance`.
 *
 * `chain` IS REQUIRED AND SINGLE. Balances and allowances are per chain facts,
 * and the same token symbol on two chains is two different contracts with two
 * different approvals. A tool that guessed a chain would answer confidently
 * about the wrong one.
 *
 * `tokenAddress` IS A CSV OF CONTRACT ADDRESSES, NEVER SYMBOLS. A symbol does not
 * identify a contract: several tokens on one chain answer to "USDC", and an
 * allowance reported against the wrong one is a false safety signal. The native
 * sentinel is accepted and folded into the native read, because that is the
 * spelling every other EVM tool in the tree uses for the chain's own coin.
 */

import {
  readAddressCsv,
  readOptionalString,
  reject,
  type MorphoParams,
} from "./_primitives.js";
import { describeUnsupportedChain, morphoChainSlug, resolveMorphoChainId } from "@tools/morpho/chains.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";

/** Most token contracts one call will read. Refused, never trimmed. */
export const MORPHO_WALLET_MAX_TOKENS = 12;

export interface MorphoWalletBalanceQuery {
  walletAddress: string;
  chainId: number;
  chainSlug: string;
  tokenAddresses: string[];
  echo: Record<string, unknown>;
}

export function parseMorphoWalletBalanceParams(
  params: Record<string, unknown>,
): MorphoParams<MorphoWalletBalanceQuery> {
  const wallet = readOptionalString(params["walletAddress"]);
  if (wallet === undefined) {
    return reject("walletAddress", "`walletAddress` is required: a balance is always read for one named account.");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return reject("walletAddress", `\`walletAddress\` must be a 0x-prefixed 40-hex EVM address. Received "${wallet}".`);
  }

  const chainInput = readOptionalString(params["chain"]);
  if (chainInput === undefined) {
    return reject(
      "chain",
      "`chain` is required: a balance and an approval exist per chain, and the same symbol on two chains is two "
      + "different contracts with two different allowances.",
    );
  }
  const chainId = resolveMorphoChainId(chainInput);
  if (chainId === undefined) return reject("chain", `\`chain\`: ${describeUnsupportedChain(chainInput)}`);

  const tokens = readAddressCsv(params["tokenAddress"], "tokenAddress");
  if (!tokens.ok) return tokens;
  const tokenAddresses = tokens.value ?? [];
  if (tokenAddresses.length > MORPHO_WALLET_MAX_TOKENS) {
    return reject(
      "tokenAddress",
      `\`tokenAddress\` names ${tokenAddresses.length} contracts, but one call reads at most `
      + `${MORPHO_WALLET_MAX_TOKENS}. Each token costs one balance read plus one read per Morpho spender in the same `
      + "batch. Narrow the list - Vex refuses it rather than silently dropping the extras.",
    );
  }

  const chainSlug = morphoChainSlug(chainId) ?? String(chainId);
  const nativeOnly = tokenAddresses.every((a) => a === NATIVE_TOKEN_ADDRESS.toLowerCase());

  return {
    ok: true,
    value: {
      walletAddress: wallet.toLowerCase(),
      chainId,
      chainSlug,
      tokenAddresses,
      echo: {
        walletAddress: wallet.toLowerCase(),
        chain: chainSlug,
        tokenAddress: tokenAddresses,
        // Stated rather than implied: with no ERC-20 named, the answer is the
        // native balance alone, and an agent that expected token rows must be
        // able to see that it asked for none.
        nativeOnly: tokenAddresses.length === 0 || nativeOnly,
      },
    },
  };
}
