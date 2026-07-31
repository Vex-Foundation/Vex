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

import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { fail, ok } from "../types.js";
import { formatZodIssueForModel } from "../arg-validation.js";

const WalletReadArgs = z.object({
  wallet: z.enum(["eip155", "solana", "all"]).optional().default("all"),
  // Empty / whitespace-only `chainIds` is treated as omission (scan all chains).
  // LLM serializers often emit `""` for "no value" — see plan PR-balance-toolkit.
  chainIds: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().min(1, { message: "chainIds must be a non-empty comma-separated string" }).optional(),
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

interface WalletSnapshot {
  wallet: ChainFamily;
  address: string;
  tokenCount: number;
  totalUsd: number;
  scannedChainIds: number[];
  chainErrors: Array<{ chainId: number; chainName?: string; message: string }>;
  tokens: ConciseKhalaniToken[];
}

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
  | { ok: true; tokens: ConciseKhalaniToken[]; totalUsd: number }
  | { ok: false; chainName?: string; message: string };

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
    return { ok: true, tokens, totalUsd };
  } catch {
    return { ok: false, chainName: config.name, message: "local chain RPC read failed" };
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
  const walletFamilies = requestedWalletFamilies(parsed.data.wallet);
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
      if (parsed.data.wallet === family) {
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

      // Local (non-Khalani) chains — direct RPC, same failure surface as a
      // Khalani per-chain error (the family snapshot survives a dead chain).
      for (const localChainId of localChainIds) {
        const local = await readLocalChainSnapshot(address, localChainId);
        if (local.ok) {
          projected.push(...local.tokens);
          totalUsd += local.totalUsd;
          scannedChainIds.push(localChainId);
        } else {
          chainErrors.push({ chainId: localChainId, chainName: local.chainName, message: local.message });
        }
      }

      snapshots.push({
        wallet: family,
        address,
        tokenCount: projected.length,
        totalUsd,
        scannedChainIds,
        chainErrors,
        tokens: trimTokens(projected, parsed.data.limit, parsed.data.response_format),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (parsed.data.wallet === family) {
        return fail(`${family} wallet error: ${message}`);
      }
      walletErrors.push({ wallet: family, message });
    }
  }

  if (snapshots.length === 0) {
    return fail(`wallet_balances: no requested wallet snapshots were available.${formatWalletErrors(walletErrors)}`);
  }

  return ok({
    wallet: parsed.data.wallet,
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
 * Optionally trim a projected token list to the top-N by held USD value.
 *
 * Compatibility-first: a trim only happens when `response_format` is 'concise'
 * AND a positive `limit` was supplied. The default 'detailed' format (or an
 * omitted `limit`) returns every row untouched, so existing callers are
 * unaffected. The sort is a stable copy (no in-place mutation of the input).
 */
function trimTokens(
  tokens: ConciseKhalaniToken[],
  limit: number | undefined,
  responseFormat: "concise" | "detailed",
): ConciseKhalaniToken[] {
  if (responseFormat === "detailed" || limit === undefined) return tokens;
  return [...tokens]
    .sort((a, b) => projectedTokenUsd(b) - projectedTokenUsd(a))
    .slice(0, limit);
}

function formatWalletErrors(errors: Array<{ wallet: ChainFamily; message: string }>): string {
  if (errors.length === 0) return "";
  return ` Errors: ${errors.map((entry) => `${entry.wallet}: ${entry.message}`).join("; ")}`;
}
