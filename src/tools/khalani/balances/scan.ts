/**
 * Khalani multi-chain token-balance scan (with opt-in EVM native top-up).
 *
 * Moved VERBATIM from the original `balances.ts` god-file. Shared helpers live
 * in `./_shared.js` (`tokenUsd`, `chainNotInRegistryError`) and the totalUsd
 * reduce in `./aggregate.js` — both imported here, neither duplicated. The
 * inline "chain not in registry" throw in `resolveTargetChains` is the
 * single-sourced `chainNotInRegistryError` (identical to the selection parser).
 */

import { VexError, ErrorCodes } from "../../../errors.js";
import { getKhalaniClient } from "../client.js";
import { getCachedKhalaniChains } from "../chains.js";
import { createDynamicPublicClient } from "../evm-client.js";
import { NATIVE_TOKEN_ADDRESS } from "../../kyberswap/constants.js";
import type { ChainFamily, KhalaniChain, KhalaniToken } from "../types.js";
import { chainNotInRegistryError, tokenUsd } from "./_shared.js";
import { calculateTokensTotalUsd } from "./aggregate.js";
import type { BalanceChainError, TokenBalanceScanResult } from "./types.js";
import { mapWithConcurrency } from "../../../utils/concurrency.js";

const DEFAULT_BALANCE_SCAN_CONCURRENCY = 4;

/**
 * EVM native-coin sentinel (lowercased once for dedupe comparisons).
 * Reuses the KyberSwap native sentinel so the whole toolkit agrees on the
 * pseudo-address used to represent ETH/POL/BNB/etc. in a token list.
 */
const NATIVE_SENTINEL_LOWER = NATIVE_TOKEN_ADDRESS.toLowerCase();

export async function getTokenBalancesAcrossChains(input: {
  address: string;
  family: ChainFamily;
  chainIds?: readonly number[];
  concurrency?: number;
  /**
   * Top up EVM balances with the chain's native coin (ETH/POL/BNB/…) read
   * straight from RPC. Defaults to `false`.
   *
   * MUST stay `false` on the sync/projection path ({@link syncWalletBalances}):
   * that path does a full per-chain REPLACE of proj_balances from the returned
   * tokens, so a transient native RPC failure would otherwise delete a cached
   * synthetic native row. Only the live wallet-read path opts in.
   */
  includeNative?: boolean;
}): Promise<TokenBalanceScanResult> {
  const chains = await getCachedKhalaniChains();
  const targetChains = resolveTargetChains(chains, input.family, input.chainIds);
  if (targetChains.length === 0) {
    return {
      address: input.address,
      family: input.family,
      tokens: [],
      scannedChainIds: [],
      chainErrors: [],
      totalUsd: 0,
    };
  }

  const concurrency = input.concurrency ?? DEFAULT_BALANCE_SCAN_CONCURRENCY;
  const client = getKhalaniClient();
  const tokens: KhalaniToken[] = [];
  const scannedChainIds: number[] = [];
  const chainErrors: BalanceChainError[] = [];

  await mapWithConcurrency(targetChains, concurrency, async (chain) => {
    try {
      const chainTokens = await client.getTokenBalances(input.address, [chain.id]);
      tokens.push(...chainTokens);
      scannedChainIds.push(chain.id);
    } catch (err) {
      chainErrors.push({
        chainId: chain.id,
        chainName: chain.name,
        message: err instanceof Error ? err.message : String(err),
      });
      // Khalani token scan failed for this chain: skip the native top-up too,
      // the chain is already recorded as an error and is not "scanned".
      return;
    }

    // EVM-only native top-up, opt-in via `includeNative`. Best-effort: a failed
    // native RPC call records a per-chain error but must NOT discard the Khalani
    // token balances above or mark the chain unscanned. Solana native is
    // intentionally out of scope, and the sync/projection path never opts in (it
    // would risk deleting cached native rows on a transient RPC failure).
    if (!input.includeNative || input.family !== "eip155") return;

    const nativeToken = await fetchEvmNativeToken({
      address: input.address,
      chain,
      chains,
      existingTokens: tokens,
    });
    if (nativeToken.kind === "token") {
      tokens.push(nativeToken.token);
    } else if (nativeToken.kind === "error") {
      chainErrors.push(nativeToken.error);
    }
    // kind === "skip": Khalani already returned a native entry — no-op.
  });

  if (scannedChainIds.length === 0 && chainErrors.length > 0) {
    throw new VexError(
      ErrorCodes.KHALANI_API_ERROR,
      `Khalani balance scan failed for every ${input.family} chain.`,
      chainErrors.map((entry) => `${entry.chainName ?? entry.chainId}: ${entry.message}`).join("; "),
    );
  }

  const sortedTokens = [...tokens].sort((left, right) => tokenUsd(right) - tokenUsd(left));
  return {
    address: input.address,
    family: input.family,
    tokens: sortedTokens,
    scannedChainIds: scannedChainIds.sort((left, right) => left - right),
    chainErrors: chainErrors.sort((left, right) => left.chainId - right.chainId),
    totalUsd: calculateTokensTotalUsd(sortedTokens),
  };
}

type NativeTokenOutcome =
  | { kind: "token"; token: KhalaniToken }
  | { kind: "skip" }
  | { kind: "error"; error: BalanceChainError };

/**
 * Fetch the EVM native-coin balance for `address` on `chain` and shape it as a
 * synthetic {@link KhalaniToken} so downstream sorting/totalUsd/UI treat it like
 * any ERC-20 entry. Fully fail-soft: any RPC error (429/timeout/missing RPC) is
 * returned as a {@link BalanceChainError} instead of throwing.
 *
 * Dedupe: if Khalani already returned a native entry for this chain (matched by
 * the native sentinel address or the chain's native symbol), this is a no-op.
 *
 * USD pricing is intentionally omitted — fetching a native price would require an
 * extra network round-trip. `tokenUsd()` already treats a priceless token as $0,
 * so the native amount still shows in the snapshot and contributes 0 to totalUsd.
 */
async function fetchEvmNativeToken(input: {
  address: string;
  chain: KhalaniChain;
  chains: readonly KhalaniChain[];
  existingTokens: readonly KhalaniToken[];
}): Promise<NativeTokenOutcome> {
  const { address, chain } = input;
  const nativeSymbolLower = chain.nativeCurrency.symbol.toLowerCase();

  const alreadyPresent = input.existingTokens.some(
    (token) =>
      token.chainId === chain.id &&
      (token.address.toLowerCase() === NATIVE_SENTINEL_LOWER ||
        token.symbol.toLowerCase() === nativeSymbolLower),
  );
  if (alreadyPresent) return { kind: "skip" };

  try {
    // Khalani registry is mutable; pass a mutable copy for the viem chain builder.
    const client = createDynamicPublicClient(chain, [...input.chains]);
    const balanceWei = await client.getBalance({ address: address as `0x${string}` });
    // Skip zero native balances: Khalani only returns non-zero token balances,
    // so a synthetic 0-balance native entry would just add noise to the snapshot.
    if (balanceWei === 0n) return { kind: "skip" };
    return {
      kind: "token",
      token: {
        address: NATIVE_TOKEN_ADDRESS,
        chainId: chain.id,
        name: chain.nativeCurrency.name,
        symbol: chain.nativeCurrency.symbol,
        decimals: chain.nativeCurrency.decimals,
        extensions: { balance: balanceWei.toString() },
      },
    };
  } catch (err) {
    // SECURITY: never embed the raw provider error. It can carry HTML bodies,
    // RPC URLs, viem versions, or API-key-shaped query strings. Map to a bounded,
    // safe class instead — see {@link classifyNativeError}.
    return {
      kind: "error",
      error: {
        chainId: chain.id,
        chainName: chain.name,
        message: `native balance: ${classifyNativeError(err)}`,
      },
    };
  }
}

type NativeErrorClass = "rate limited" | "timeout" | "missing RPC" | "unavailable";

/**
 * Reduce an arbitrary caught native-RPC failure to a fixed, non-sensitive class.
 *
 * The caught value is treated as `unknown` and inspected defensively (message,
 * status, code, name) without trusting any concrete error class. The return
 * value is ALWAYS one of the four literal {@link NativeErrorClass} strings, so no
 * raw provider text (URLs, HTML, API keys, versions) can ever reach the surfaced
 * {@link BalanceChainError}.
 */
function classifyNativeError(err: unknown): NativeErrorClass {
  // Missing-RPC: getChainRpcUrl throws a VexError for chains with no RPC metadata.
  // Detect via the structured `code` rather than substring-matching the message.
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (code === ErrorCodes.KHALANI_UNSUPPORTED_CHAIN) return "missing RPC";
  }

  const status = readNumericField(err, "status");
  if (status === 429) return "rate limited";

  const haystack = describeError(err).toLowerCase();

  if (
    status === 408 ||
    haystack.includes("etimedout") ||
    haystack.includes("timed out") ||
    haystack.includes("timeout")
  ) {
    return "timeout";
  }

  if (
    status === 429 ||
    haystack.includes("rate limit") ||
    haystack.includes("ratelimit") ||
    haystack.includes("too many requests")
  ) {
    return "rate limited";
  }

  if (
    haystack.includes("does not expose an rpc url") ||
    haystack.includes("no rpc") ||
    haystack.includes("missing rpc")
  ) {
    return "missing RPC";
  }

  return "unavailable";
}

/**
 * Build a lowercase-safe haystack from the error's own `message`/`name` fields
 * only. We classify on stable keywords; the caller never surfaces this string, so
 * even though it may contain raw provider text it is used purely for matching.
 */
function describeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (typeof err !== "object" || err === null) return String(err);

  const record = err as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.name === "string") parts.push(record.name);
  if (typeof record.message === "string") parts.push(record.message);
  if (typeof record.shortMessage === "string") parts.push(record.shortMessage);
  if (typeof record.details === "string") parts.push(record.details);
  return parts.join(" ");
}

function readNumericField(err: unknown, field: string): number | undefined {
  if (typeof err !== "object" || err === null || !(field in err)) return undefined;
  const value = (err as Record<string, unknown>)[field];
  return typeof value === "number" ? value : undefined;
}

function resolveTargetChains(
  chains: readonly KhalaniChain[],
  family: ChainFamily,
  chainIds: readonly number[] | undefined,
): KhalaniChain[] {
  if (!chainIds) {
    return chains.filter((chain) => chain.type === family);
  }

  const result: KhalaniChain[] = [];
  for (const chainId of chainIds) {
    const chain = chains.find((entry) => entry.id === chainId);
    if (!chain) {
      throw chainNotInRegistryError(chainId);
    }
    if (chain.type !== family) {
      throw new VexError(
        ErrorCodes.KHALANI_UNSUPPORTED_CHAIN,
        `Chain ${chain.name} (${chain.id}) is ${chain.type}, but this balance scan is for ${family}.`,
      );
    }
    result.push(chain);
  }

  return result;
}
