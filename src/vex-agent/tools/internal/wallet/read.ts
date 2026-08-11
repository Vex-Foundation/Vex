/**
 * Wallet read handler — live balance snapshot for configured wallets.
 *
 * Chain scope is INCLUSIVE (Khalani-first, local-registry fallback): chains the
 * Khalani registry covers scan via the Khalani multi-chain read; chains only in
 * the local EVM registry (`tools/evm-chains/registry.ts`, e.g. Robinhood 4663)
 * scan direct-RPC through the SAME shared reader the background sync uses
 * (`tools/evm-chains/balances.ts`), so live reads and projections can never
 * disagree on how a local chain is read.
 */

import { formatUnits } from "viem";
import { z } from "zod";
import { resolveSelectedAddressForRead } from "./resolve.js";
import {
  type BalanceChainSelection,
  type TokenBalanceScanResult,
  getSelectedChainIdsForFamily,
  getTokenBalancesAcrossChains,
  parseBalanceChainSelection,
} from "@tools/khalani/balances.js";
import type { ChainFamily } from "@tools/khalani/types.js";
import { readLocalChainBalances } from "@tools/evm-chains/balances.js";
import { getLocalChain, listLocalChains } from "@tools/evm-chains/registry.js";
import { resolveInclusiveEvmChain } from "@tools/evm-chains/resolver.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import { buildTokenScanSet } from "@vex-agent/sync/local-chain-balance-sync.js";
import {
  type ConciseKhalaniToken,
  projectTokens,
} from "../../protocols/khalani/projectors.js";
import { summarizeProtocolError } from "../../protocols/runtime/errors.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { fail, ok } from "../types.js";
import { formatZodIssueForModel } from "../arg-validation.js";
import { mapWithConcurrency } from "@utils/concurrency.js";
import { throwIfAborted } from "@utils/cancellation.js";

const WalletReadArgs = z.object({
  walletFamily: z.enum(["eip155", "solana", "all"]).optional().default("all"),
  // Empty / whitespace-only `chainIds` is treated as omission (scan all chains).
  // LLM serializers often emit `""` for "no value" — see plan PR-balance-toolkit.
  //
  // An ARRAY is accepted alongside the CSV string (`acceptsStringArray`
  // semantics, SPEC §2.10 item 12): the manifest advertises both, and a model
  // that holds a list of chains must not lose a turn learning it had to join
  // them itself. Empty entries are dropped; an all-empty list reads as omitted.
  chainIds: z.preprocess(
    (v) => {
      if (Array.isArray(v)) {
        const joined = v.filter((entry) => typeof entry === "string" && entry.trim() !== "").join(",");
        return joined === "" ? undefined : joined;
      }
      return typeof v === "string" && v.trim() === "" ? undefined : v;
    },
    z.string().trim().min(1, { message: "chainIds must be a non-empty comma-separated string, or an array of chain slugs/ids" }).optional(),
  ),
  // Optional cap on the number of tokens returned per wallet snapshot. Only
  // applied when response_format is 'concise' (see below); ignored in the
  // compatibility-first 'detailed' default so existing callers keep every row.
  limit: z.number().int().positive({
    message:
      "limit must be a positive whole number of tokens, and it only applies with "
      + "response_format:\"concise\" — the default 'detailed' format returns every row. "
      + "Omit limit to keep them all",
  }).optional(),
  // 'detailed' (DEFAULT, compatibility-first) returns every projected token.
  // 'concise' enables the `limit` trim to the top-N tokens by held USD value.
  response_format: z.enum(["concise", "detailed"]).optional().default("detailed"),
}).strict();

/**
 * One token the chain scan could not answer for. Deliberately NOT a
 * `chainError`: the chain itself scanned, and its other tokens and totals are
 * still in the snapshot. Reported so "the read failed" can never be mistaken
 * for "you hold none of it" (the 2026-08-10 incident's core confusion).
 */
interface TokenReadError {
  chainId: number;
  tokenAddress: string;
  reason: string;
}

/**
 * A projected token row as `wallet_balances` emits it. `priceUnavailable` is
 * added only by the concise trim, on a held token with no price feed, so the
 * agent can tell "no USD price" from "not held".
 */
type WalletTokenRow = ConciseKhalaniToken & { priceUnavailable?: true };

interface WalletSnapshot {
  wallet: ChainFamily;
  address: string;
  tokenCount: number;
  totalUsd: number;
  scannedChainIds: number[];
  chainErrors: Array<{ chainId: number; chainName?: string; message: string }>;
  tokenErrors: TokenReadError[];
  /** Present only when the bound below dropped entries. */
  tokenErrorsOmitted?: number;
  /** Held-but-unpriced rows the concise trim's cap dropped. Present only when non-zero. */
  unpricedOmitted?: number;
  tokens: WalletTokenRow[];
}

/**
 * A broken scan set can fail on hundreds of tokens; the agent needs to know it
 * happened and on which tokens, not to have its context filled with the list.
 */
const MAX_TOKEN_ERRORS_PER_SNAPSHOT = 20;

/**
 * Same bound, same reason, for the held-but-unpriced rows the concise trim
 * retains outside the caller's `limit`: the agent must learn that unpriced
 * holdings exist without a dust wallet flooding its context.
 */
const MAX_UNPRICED_TOKENS_PER_SNAPSHOT = 20;

// ── Chain scope (Khalani-first, local fallback) ─────────────────

interface BalanceChainScope {
  /** Khalani-side selection — never contains local-only chains. */
  selection: BalanceChainSelection;
  /** Local-registry (non-Khalani) EVM chain ids to scan direct-RPC. */
  localChainIds: number[];
  /** True when the caller provided any chain filter at all. */
  rawProvided: boolean;
}

/**
 * Partition the requested chains: entries genuinely in the Khalani registry go
 * to the Khalani selection; entries only the local registry knows (e.g.
 * "robinhood"/4663) go to the direct-RPC list. Throws `Unsupported chain: X`
 * when neither registry recognizes an entry. Omitted → all Khalani chains +
 * every local EVM chain.
 */
async function partitionBalanceChainScope(raw: string | undefined): Promise<BalanceChainScope> {
  const parts = (raw ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return {
      selection: await parseBalanceChainSelection(undefined),
      localChainIds: listLocalChains("eip155").map((chain) => chain.id),
      rawProvided: false,
    };
  }

  const khalaniParts: string[] = [];
  const localChainIds: number[] = [];
  for (const part of parts) {
    const resolved = await resolveInclusiveEvmChain(part);
    if (resolved.source === "local") {
      if (!localChainIds.includes(resolved.chainId)) localChainIds.push(resolved.chainId);
    } else {
      khalaniParts.push(part);
    }
  }
  return {
    // An all-local request leaves the Khalani side EMPTY (rawProvided false
    // there) — the family loop below must then skip the Khalani scan entirely,
    // never fall through to "no filter = scan all Khalani chains".
    selection: await parseBalanceChainSelection(
      khalaniParts.length > 0 ? khalaniParts.join(",") : undefined,
    ),
    localChainIds,
    rawProvided: true,
  };
}

// ── Local-chain live snapshot ───────────────────────────────────

type LocalChainSnapshot =
  | { ok: true; tokens: ConciseKhalaniToken[]; totalUsd: number; tokenErrors: TokenReadError[] }
  | { ok: false; chainName?: string; message: string };

/**
 * Matches `DEFAULT_BALANCE_SCAN_CONCURRENCY` in the Khalani scan: the two sides
 * of one `wallet_balances` answer must not race each other into a provider's
 * rate limit.
 */
const LOCAL_CHAIN_SCAN_CONCURRENCY = 4;

function heldUsd(balanceWei: bigint, decimals: number, priceUsd: number | null): number {
  if (priceUsd === null) return 0;
  const human = Number(formatUnits(balanceWei, decimals));
  return Number.isFinite(human) ? human * priceUsd : 0;
}

/**
 * Live-read one local chain into the snapshot token shape. Scans the SAME
 * token set as the background sync (seed ∪ tracked). Failures collapse to a
 * bounded per-chain error — SECURITY: raw provider errors can carry the RPC
 * URL / HTML bodies and never reach the model output.
 */
async function readLocalChainSnapshot(
  address: string,
  chainId: number,
): Promise<LocalChainSnapshot> {
  const config = getLocalChain(chainId);
  if (!config) return { ok: false, message: "unknown local chain" };
  try {
    const scanSet = await buildTokenScanSet(config, address);
    const read = await readLocalChainBalances(config, address, scanSet);

    const tokens: ConciseKhalaniToken[] = [];
    let totalUsd = 0;
    // Zero native balances are skipped (Khalani parity, same as the sync path).
    if (read.nativeWei > 0n) {
      tokens.push({
        symbol: config.nativeCurrency.symbol,
        name: config.nativeCurrency.name,
        address: NATIVE_TOKEN_ADDRESS,
        chainId: config.id,
        decimals: config.nativeCurrency.decimals,
        balance: read.nativeWei.toString(),
        ...(read.nativePriceUsd !== null ? { priceUsd: String(read.nativePriceUsd) } : {}),
      });
      totalUsd += heldUsd(read.nativeWei, config.nativeCurrency.decimals, read.nativePriceUsd);
    }
    for (const token of read.tokens) {
      tokens.push({
        symbol: token.symbol,
        name: token.symbol,
        address: token.address,
        chainId: config.id,
        decimals: token.decimals,
        balance: token.balanceWei.toString(),
        ...(token.priceUsd !== null ? { priceUsd: String(token.priceUsd) } : {}),
      });
      totalUsd += heldUsd(token.balanceWei, token.decimals, token.priceUsd);
    }
    return {
      ok: true,
      tokens,
      totalUsd,
      tokenErrors: read.tokenFailures.map((failure) => ({
        chainId: config.id,
        tokenAddress: failure.address,
        reason: failure.reason,
      })),
    };
  } catch (err) {
    // Owner decree (2026-08-02): the REAL cause reaches the agent. This was a
    // bare `catch {}` — the error object was dropped on the floor, so a dead
    // RPC, a bad token in the scan set and a chain misconfiguration were all
    // reported to the model (and logged nowhere) as the same five words. The
    // provider's text is untrusted, so it is scrubbed + bounded by the
    // runtime's canonical summarizer, exactly as the sibling Khalani-scope
    // failure at `partitionBalanceChainScope` surfaces its own cause.
    const summary = summarizeProtocolError(err);
    logger.warn("wallet.local_chain_read.failed", {
      chainId,
      chainName: config.name,
      category: summary.category,
      error: summary.message,
    });
    return {
      ok: false,
      chainName: config.name,
      message: `local chain RPC read failed: ${summary.message}`,
    };
  }
}

// ── wallet_balances ─────────────────────────────────────────────

export async function handleWalletBalances(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const parsed = WalletReadArgs.safeParse(params);
  if (!parsed.success) {
    return fail(`wallet_balances: ${formatZodIssueForModel(parsed.error.issues[0], params)}`);
  }

  let scope: BalanceChainScope;
  try {
    scope = await partitionBalanceChainScope(parsed.data.chainIds);
  } catch (err) {
    return fail(`wallet_balances: ${err instanceof Error ? err.message : String(err)}`);
  }
  const walletFamilies = requestedWalletFamilies(parsed.data.walletFamily);
  const snapshots: WalletSnapshot[] = [];
  const walletErrors: Array<{ wallet: ChainFamily; message: string }> = [];

  for (const family of walletFamilies) {
    const khalaniChainIds = getSelectedChainIdsForFamily(scope.selection, family);
    const localChainIds = family === "eip155" ? scope.localChainIds : [];
    // With a filter present, the Khalani scan runs only when the filter kept
    // Khalani chains for this family (an all-local filter must NOT widen into
    // an unfiltered all-Khalani scan).
    const khalaniRequested =
      !scope.rawProvided || (scope.selection.rawProvided && (khalaniChainIds?.length ?? 0) > 0);
    if (!khalaniRequested && localChainIds.length === 0) {
      if (parsed.data.walletFamily === family) {
        return fail(`wallet_balances: no ${family} chains matched chainIds="${parsed.data.chainIds}".`);
      }
      continue;
    }

    try {
      const address = resolveSelectedAddressForRead(context.walletResolution, context.walletPolicy, family);
      // Live read: opt into the EVM native-coin top-up. The sync/projection path
      // (syncWalletBalances) deliberately does NOT, to avoid deleting cached
      // native rows on a transient RPC failure.
      let scan: TokenBalanceScanResult = {
        address,
        family,
        tokens: [],
        scannedChainIds: [],
        chainErrors: [],
        totalUsd: 0,
      };
      if (khalaniRequested) {
        scan = await getTokenBalancesAcrossChains({
          address,
          family,
          chainIds: khalaniChainIds,
          includeNative: true,
        });
      }
      // Slim each row at the handler seam (P1-7): reuse the Khalani projector so
      // the model sees identity + lifted priceUsd/balance, not the heavy logoURI
      // / open `extensions` bag. `tokenCount` / `totalUsd` stay computed off the
      // FULL scan so an optional `limit` trim never distorts the held totals.
      const projected = projectTokens(scan.tokens);
      let totalUsd = scan.totalUsd;
      const scannedChainIds = [...scan.scannedChainIds];
      const chainErrors = [...scan.chainErrors];
      const tokenErrors: TokenReadError[] = [];
      let tokenErrorsOmitted = 0;

      // Local (non-Khalani) chains — direct RPC, same failure surface as a
      // Khalani per-chain error (the family snapshot survives a dead chain).
      //
      // Bounded-concurrency, not serial: each chain costs a scan-set build, an
      // RPC read and a DexScreener price batch, and running N of them one after
      // another is the `wallet_balances` latency complaint. The bound matches
      // the Khalani scan's own (4) so the provider rate limits are not the new
      // failure mode, and results are written into slots keyed by index so the
      // output order stays chain order rather than completion order.
      throwIfAborted(context.abortSignal);
      const localResults = new Array<LocalChainSnapshot | undefined>(localChainIds.length);
      await mapWithConcurrency(localChainIds, LOCAL_CHAIN_SCAN_CONCURRENCY, async (localChainId, index) => {
        throwIfAborted(context.abortSignal);
        localResults[index] = await readLocalChainSnapshot(address, localChainId);
      });

      localChainIds.forEach((localChainId, index) => {
        const local = localResults[index];
        // Unreachable while `mapWithConcurrency` visits every index; treated as
        // a per-chain failure rather than asserted, because the alternative is
        // losing a whole family snapshot to a bookkeeping slip.
        if (local === undefined) {
          chainErrors.push({ chainId: localChainId, message: "local chain scan produced no result" });
          return;
        }
        if (local.ok) {
          projected.push(...local.tokens);
          totalUsd += local.totalUsd;
          scannedChainIds.push(localChainId);
          for (const tokenError of local.tokenErrors) {
            if (tokenErrors.length < MAX_TOKEN_ERRORS_PER_SNAPSHOT) tokenErrors.push(tokenError);
            else tokenErrorsOmitted += 1;
          }
        } else {
          chainErrors.push({ chainId: localChainId, chainName: local.chainName, message: local.message });
        }
      });

      const trimmed = trimTokens(projected, parsed.data.limit, parsed.data.response_format);
      snapshots.push({
        wallet: family,
        address,
        tokenCount: projected.length,
        totalUsd,
        scannedChainIds,
        chainErrors,
        tokenErrors,
        ...(tokenErrorsOmitted > 0 ? { tokenErrorsOmitted } : {}),
        ...(trimmed.unpricedOmitted > 0 ? { unpricedOmitted: trimmed.unpricedOmitted } : {}),
        tokens: trimmed.tokens,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (parsed.data.walletFamily === family) {
        return fail(`${family} wallet error: ${message}`);
      }
      walletErrors.push({ wallet: family, message });
    }
  }

  if (snapshots.length === 0) {
    return fail(`wallet_balances: no requested wallet snapshots were available.${formatWalletErrors(walletErrors)}`);
  }

  return ok({
    // Echoes the PARAM the caller filled in, under the same name.
    walletFamily: parsed.data.walletFamily,
    walletCount: snapshots.length,
    totalUsd: snapshots.reduce((sum, snapshot) => sum + snapshot.totalUsd, 0),
    walletErrors,
    wallets: snapshots,
  });
}

function requestedWalletFamilies(wallet: "eip155" | "solana" | "all"): ChainFamily[] {
  if (wallet === "all") return ["eip155", "solana"];
  return [wallet];
}

/**
 * Held USD value of a projected token row: `balance × priceUsd`, normalised to a
 * smallest-unit → human conversion (mirrors the canonical `tokenUsd` used for
 * `totalUsd`). Missing / malformed price or balance is null-safe → `0`, so a
 * row with no price/balance signal sorts last rather than throwing.
 */
function projectedTokenUsd(token: ConciseKhalaniToken): number {
  const { balance, priceUsd, decimals } = token;
  if (!balance || !priceUsd) return 0;
  try {
    const balanceHuman = Number(BigInt(balance)) / Math.pow(10, decimals);
    const price = Number(priceUsd);
    if (!Number.isFinite(balanceHuman) || !Number.isFinite(price)) return 0;
    return balanceHuman * price;
  } catch {
    return 0;
  }
}

/**
 * True when the row carries a usable USD price feed. A finite ZERO is a feed
 * (the provider quoted it), so only a missing, malformed, or negative price
 * counts as "no price".
 */
function hasUsdPrice(token: ConciseKhalaniToken): boolean {
  if (token.priceUsd === undefined || token.priceUsd.trim() === "") return false;
  const price = Number(token.priceUsd);
  return Number.isFinite(price) && price >= 0;
}

/** True when the row reports a balance the wallet actually holds. */
function holdsBalance(token: ConciseKhalaniToken): boolean {
  if (!token.balance) return false;
  try {
    return BigInt(token.balance) !== 0n;
  } catch {
    return false;
  }
}

/**
 * Optionally trim a projected token list to the top-N by held USD value.
 *
 * Compatibility-first: a trim only happens when `response_format` is 'concise'
 * AND a positive `limit` was supplied. The default 'detailed' format (or an
 * omitted `limit`) returns every row untouched, so existing callers are
 * unaffected. The sort is a stable copy (no in-place mutation of the input).
 *
 * A held token with NO price feed scores 0 here, so the limit used to cut it
 * first and the agent could not tell it apart from a token it does not hold
 * (2026-08-10 incident). Such rows are therefore retained, after the priced
 * rows and outside the limit, flagged with `priceUnavailable` so the missing
 * USD figure reads as "no price feed", not "no balance".
 *
 * Retention is bounded BY THE CAP below, not by the scan set: only the local
 * chains scan a bounded set (seed ∪ pinned), while the Khalani read requests
 * every holding the provider knows with no token cap of its own
 * (`tools/khalani/balances/scan.ts`), so a wallet full of unpriced dust would
 * otherwise turn `limit:1` into an unbounded answer. Drops are reported as
 * `unpricedOmitted`, mirroring `tokenErrorsOmitted`.
 *
 * Totals are computed upstream off the full scan and are untouched by this
 * display trim.
 */
function trimTokens(
  tokens: ConciseKhalaniToken[],
  limit: number | undefined,
  responseFormat: "concise" | "detailed",
): { tokens: WalletTokenRow[]; unpricedOmitted: number } {
  if (responseFormat === "detailed" || limit === undefined) return { tokens, unpricedOmitted: 0 };
  // Stable sort: rows with equal held USD (every unpriced row scores 0) keep
  // their scan order, so the retained set is deterministic.
  const sorted = [...tokens].sort((a, b) => projectedTokenUsd(b) - projectedTokenUsd(a));
  const priced = sorted.filter(hasUsdPrice).slice(0, limit);
  const unpricedHeld = sorted.filter((token) => !hasUsdPrice(token) && holdsBalance(token));
  const retained: WalletTokenRow[] = unpricedHeld
    .slice(0, MAX_UNPRICED_TOKENS_PER_SNAPSHOT)
    .map((token) => ({ ...token, priceUnavailable: true as const }));
  return {
    tokens: [...priced, ...retained],
    unpricedOmitted: unpricedHeld.length - retained.length,
  };
}

function formatWalletErrors(errors: Array<{ wallet: ChainFamily; message: string }>): string {
  if (errors.length === 0) return "";
  return ` Errors: ${errors.map((entry) => `${entry.wallet}: ${entry.message}`).join("; ")}`;
}
