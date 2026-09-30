/**
 * Wallet read handler - live balance snapshot for configured wallets.
 *
 * Chain scope is INCLUSIVE (Khalani-first, local-registry fallback): chains the
 * Khalani registry covers scan via the Khalani multi-chain read; chains only in
 * the local EVM registry (`tools/evm-chains/registry.ts`, e.g. Robinhood 4663)
 * scan direct-RPC through the SAME shared reader the background sync uses
 * (`tools/evm-chains/balances.ts`), so live reads and projections can never
 * disagree on how a local chain is read.
 *
 * SOLANA follows the same doctrine and for the same reason. It is read direct
 * from RPC through the shared snapshot service
 * (`tools/solana-ecosystem/balances/wallet-snapshot.ts`), the one the Solana
 * balance sync also projects from. It is NOT read through Khalani: Khalani's
 * Solana scan answers ZERO tokens, so this tool reported `tokenCount: 0,
 * totalUsd: 0` for a funded wallet whose true balance the Portfolio sidebar was
 * showing at the same moment (owner screenshot, 2026-08-28). Khalani remains
 * the enumerator for its EVM chains, which have no per-chain RPC reader, and a
 * price-only source underneath the Solana reader.
 */

import { formatUnits } from "viem";
import { z } from "zod";
import { resolveSelectedAddressForRead } from "./resolve.js";
import {
  type BalanceChainSelection,
  type TokenBalanceScanResult,
  calculateTokensTotalUsd,
  getSelectedChainIdsForFamily,
  getTokenBalancesAcrossChains,
  parseBalanceChainSelection,
} from "@tools/khalani/balances.js";
import { enrichKhalaniBalancePrices } from "@tools/khalani/balance-price-enrichment.js";
import type { ChainFamily, KhalaniRejectedTokenBalanceEntry } from "@tools/khalani/types.js";
import { readLocalChainBalances } from "@tools/evm-chains/balances.js";
import {
  readSolanaWalletSnapshot,
  type SolanaBalanceRow,
  type SolanaWalletSnapshotReader,
} from "@tools/solana-ecosystem/balances/wallet-snapshot.js";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../constants/solana-chain.js";
import { getLocalChain, listLocalChains } from "@tools/evm-chains/registry.js";
import { resolveInclusiveEvmChain } from "@tools/evm-chains/resolver.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import { localChainInventorySources } from "@vex-agent/wallet-inventory/local-chain.js";
import {
  LOCAL_CHAIN_SCAN_CONCURRENCY,
  readLocalChainSnapshot,
  type LocalChainSnapshot,
  type TokenReadError,
} from "./local-chain-snapshot.js";
import { responseFormatSchema } from "@vex-agent/response-format.js";
import {
  type ConciseKhalaniToken,
  projectTokens,
} from "../../protocols/khalani/projectors.js";
import { isTokenDecimals, projectBalanceRow } from "../../protocols/amount-display.js";
import {
  combineWalletCompleteness,
  computeWalletCompleteness,
  hasUsdPrice,
  holdsBalance,
  type CompletenessEnvelope,
  type InventorySource,
} from "@vex-agent/wallet-inventory/completeness.js";
import {
  REJECTED_ENTRIES_NOTE,
  boundRejectedEntries,
} from "@vex-agent/wallet-inventory/rejected-entries.js";
import { solanaRowToWalletToken } from "./solana-row.js";
import {
  TRUNCATION_NOTE,
  trimTokens,
  type ProjectedTokenRow,
  type WalletTokenRow,
} from "./token-trim.js";
import { summarizeProtocolError } from "../../protocols/runtime/errors.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { fail, ok } from "../types.js";
import { formatZodIssueForModel } from "../arg-validation.js";
import { mapWithConcurrency } from "@utils/concurrency.js";
import { throwIfAborted } from "@utils/cancellation.js";
import { runWithinDeadline } from "@utils/deadline.js";
import type { KhalaniChainScanTiming } from "@tools/khalani/balances/scan.js";
import type { KhalaniToken } from "@tools/khalani/types.js";
import {
  WALLET_READ_KHALANI_CONCURRENCY,
  WALLET_READ_PRICING_CHAIN_CONCURRENCY,
  readWalletReadBounds,
  type AgentWalletReadBounds,
} from "./leg-bounds.js";

/** Entries -> the CSV the chain resolver reads; all-empty reads as omitted. */
function joinChainList(entries: readonly unknown[]): string | undefined {
  const joined = entries
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .join(",");
  return joined === "" ? undefined : joined;
}

const WalletReadArgs = z.object({
  walletFamily: z.enum(["eip155", "solana", "all"]).optional().default("all"),
  // Empty / whitespace-only `chainIds` is treated as omission (scan all chains).
  // LLM serializers often emit `""` for "no value" - see plan PR-balance-toolkit.
  //
  // An ARRAY is accepted alongside the CSV string (`acceptsStringArray`
  // semantics, SPEC §2.10 item 12): the manifest advertises both, and a model
  // that holds a list of chains must not lose a turn learning it had to join
  // them itself. Empty entries are dropped; an all-empty list reads as omitted.
  chainIds: z.preprocess(
    (v) => {
      if (Array.isArray(v)) return joinChainList(v);
      if (typeof v !== "string") return v;
      const trimmed = v.trim();
      if (trimmed === "") return undefined;
      // Some serializers hand the ARRAY BACK AS TEXT: `"[\"robinhood\"]"`.
      // Unwrapped here for the same reason the array form is accepted at all -
      // a model that holds a list of chains should not lose a turn to the
      // encoding it happened to use. Observed live: two wasted WalletBalances
      // calls, both answered "Unsupported chain: [\"robinhood\"]", for a chain
      // that resolves perfectly well by slug and by id.
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (Array.isArray(parsed)) return joinChainList(parsed);
        } catch {
          // Not JSON; fall through and let the resolver name what it got.
        }
      }
      return v;
    },
    z.string().trim().min(1, { message: "chainIds must be a non-empty comma-separated string, or an array of chain slugs/ids" }).optional(),
  ),
  // Optional cap on the number of tokens returned per wallet snapshot. Only
  // applied when response_format is 'concise' (see below); ignored in the
  // compatibility-first 'detailed' default so existing callers keep every row.
  limit: z.number().int().positive({
    message:
      "limit must be a positive whole number of tokens, and it only applies with "
      + "response_format:\"concise\" - the default 'detailed' format returns every row. "
      + "Omit limit to keep them all",
  }).optional(),
  // 'detailed' (DEFAULT, compatibility-first) returns every projected token.
  // 'concise' enables the `limit` trim to the top-N tokens by held USD value.
  //
  // The `detailed` default is the RATIFIED EXCEPTION of D17, not drift: see the
  // state-2 note in `@vex-agent/response-format.js`.
  response_format: responseFormatSchema("detailed"),
}).strict();

/**
 * One TOKEN ACCOUNT the read could not trust. Deliberately NOT a `tokenError`:
 * that shape's `tokenAddress` means a MINT, while this carries an ACCOUNT
 * pubkey, and crushing one into the other would tell the agent a mint is
 * broken when what failed was one of the wallet's accounts holding it. The
 * holdings behind these accounts are ABSENT from `tokens`, which is exactly why
 * they are reported rather than dropped.
 */
interface AccountReadError {
  chainId: number;
  accountAddress: string;
  reason: string;
}

/**
 * Same bound and same reason as `MAX_TOKEN_ERRORS_PER_SNAPSHOT`: a broken read
 * can fail on every account a wallet owns, and the agent needs to know it
 * happened and on which accounts, not to have its context filled with the list.
 */
const MAX_ACCOUNT_ERRORS_PER_SNAPSHOT = 20;

/**
 * One wallet's snapshot.
 *
 * It EXTENDS {@link CompletenessEnvelope} rather than restating its eight
 * fields: the snapshot and the top-level envelope must carry the identical
 * completeness contract, and a second hand-written copy of the field list is
 * how the two drift apart.
 */
interface WalletSnapshot extends CompletenessEnvelope {
  wallet: ChainFamily;
  address: string;
  tokenCount: number;
  totalUsd: number;
  scannedChainIds: number[];
  chainErrors: Array<{ chainId: number; chainName?: string; message: string }>;
  tokenErrors: TokenReadError[];
  /** Present only when the bound below dropped entries. */
  tokenErrorsOmitted?: number;
  /** Token ACCOUNTS the read could not trust (Solana). Always present. */
  accountErrors: AccountReadError[];
  /** Present only when the 20-row `accountErrors` bound dropped entries. */
  accountErrorsOmitted?: number;
  /**
   * Held-but-unpriced rows the CONCISE TRIM's 20-row cap dropped. Present only
   * when non-zero, and it is a drop counter, NOT a census: the full number of
   * held rows with no price feed is `unpricedHeldCount`, which is reported on
   * every path including `detailed`, where nothing is dropped at all.
   */
  unpricedOmitted?: number;
  /**
   * Balance entries the Khalani boundary refused for their `decimals` alone.
   * Their identity and exact atomic amount are still true facts about the
   * wallet, so they are reported rather than dropped; the bad scale itself is
   * never echoed and never guessed (C1.2).
   */
  rejectedEntryCount: number;
  rejectedEntries: KhalaniRejectedTokenBalanceEntry[];
  /** Present only when the 20-row `rejectedEntries` bound dropped entries. */
  rejectedEntriesOmitted?: number;
  /**
   * Whether this snapshot is short of what a full answer would carry (D16,
   * bounded_non_pageable class): rows missing from `tokens` after the concise
   * trim, or rejected entries the 20-row bound left out. ALWAYS PRESENT,
   * including as `false` on the `detailed` path and on a `{limit}` call that
   * carried no `response_format`: an absent field would read as "no answer",
   * and the whole point of the field is that the agent can tell a complete
   * answer from a bounded one without re-deriving the rules. There is no
   * continuation to fetch; `truncationNote` names the narrowing action instead.
   */
  truncated: boolean;
  /** The recovery instruction. Present only when `truncated` is true. */
  truncationNote?: string;
  /**
   * Read legs that missed the per-leg deadline, by chain. Present only when a
   * deadline fired; each named chain is ALSO in `chainErrors` (and, for a
   * balance leg, `failedChainIds`), so its holdings read as unknown, not zero.
   */
  legsNotAnswered?: LegNotAnswered[];
  tokens: WalletTokenRow[];
}

/**
 * A broken scan set can fail on hundreds of tokens; the agent needs to know it
 * happened and on which tokens, not to have its context filled with the list.
 */
const MAX_TOKEN_ERRORS_PER_SNAPSHOT = 20;

// ── Chain scope (Khalani-first, local fallback) ─────────────────

interface BalanceChainScope {
  /** Khalani-side selection - never contains local-only chains. */
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
    // there) - the family loop below must then skip the Khalani scan entirely,
    // never fall through to "no filter = scan all Khalani chains".
    selection: await parseBalanceChainSelection(
      khalaniParts.length > 0 ? khalaniParts.join(",") : undefined,
    ),
    localChainIds,
    rawProvided: true,
  };
}

// ── Solana live snapshot ────────────────────────────────────────

/**
 * The narrow, optional dependencies this handler takes so a test can drive the
 * REAL handler over a scripted RPC and pinned leg bounds. Production callers
 * pass nothing.
 */
export interface WalletBalancesDependencies {
  readonly readSolanaSnapshot?: SolanaWalletSnapshotReader;
  /** Leg bounds; production reads them from the environment per call. */
  readonly legBounds?: AgentWalletReadBounds;
}

// ── Legs (Kairos Phase 6, W-1) ─────────────────────────────────

/**
 * One read leg that missed its deadline. Named so the agent can say WHICH
 * chain or price pass is missing: its holdings (or prices) are UNKNOWN, never
 * zero. Present on a snapshot only when a deadline fired.
 */
interface LegNotAnswered {
  leg: "khalani_scan" | "native_balance" | "price_enrichment" | "solana_rpc" | "local_chain_rpc";
  chainId: number;
  timeoutMs: number;
}

/** The recovery note that travels with any leg that missed its deadline. */
const PARTIAL_LEGS_NOTE =
  "Partial result: some read legs did not answer in time (see wallets[].legsNotAnswered). "
  + "Holdings on a chain listed there are UNKNOWN, not zero, and a price pass listed there "
  + "left its rows unpriced; totalUsd counts only what answered. Retry WalletBalances "
  + "with chainIds set to the missing chains for their balances.";

/** Sanitized per-leg timings for one family: numbers, chain ids, provider names. */
interface FamilyLegTimings {
  family: ChainFamily;
  khalaniScanMs?: number;
  khalaniChains?: number;
  khalaniSlowestChainId?: number;
  khalaniSlowestChainMs?: number;
  nativeSlowestChainId?: number;
  nativeSlowestChainMs?: number;
  pricingMs?: number;
  pricingChains?: number;
  pricingSlowestChainId?: number;
  pricingSlowestChainMs?: number;
  solanaMs?: number;
  localChainsMs?: number;
  localChainIds?: number[];
  timedOutLegs: number;
}

type SolanaLane =
  | { kind: "read"; snapshot: Awaited<ReturnType<SolanaWalletSnapshotReader>> }
  | { kind: "failed"; message: string }
  | { kind: "deadline" };

type LocalLaneResult = LocalChainSnapshot | { kind: "deadline" } | undefined;

interface FamilyPlan {
  family: ChainFamily;
  khalaniChainIds: readonly number[] | undefined;
  localChainIds: number[];
  khalaniRequested: boolean;
  solanaRequested: boolean;
}

type FamilyOutcome =
  | { kind: "snapshot"; snapshot: WalletSnapshot }
  | { kind: "error"; family: ChainFamily; message: string };

// ── WalletBalances ─────────────────────────────────────────────

export async function handleWalletBalances(
  params: Record<string, unknown>,
  context: InternalToolContext,
  dependencies: WalletBalancesDependencies = {},
): Promise<ToolResult> {
  const parsed = WalletReadArgs.safeParse(params);
  if (!parsed.success) {
    return fail(`WalletBalances: ${formatZodIssueForModel(parsed.error.issues[0], params)}`);
  }

  let scope: BalanceChainScope;
  try {
    scope = await partitionBalanceChainScope(parsed.data.chainIds);
  } catch (err) {
    return fail(`WalletBalances: ${err instanceof Error ? err.message : String(err)}`);
  }
  const bounds = dependencies.legBounds ?? readWalletReadBounds();
  const startedAt = Date.now();

  // Which families read, decided up front from the scope alone (no I/O), so the
  // one early failure below can never land after another family already read.
  const plans: FamilyPlan[] = [];
  for (const family of requestedWalletFamilies(parsed.data.walletFamily)) {
    const khalaniChainIds = getSelectedChainIdsForFamily(scope.selection, family);
    const localChainIds = family === "eip155" ? scope.localChainIds : [];
    // With a filter present, the scan runs only when the filter kept chains for
    // this family (an all-local filter must NOT widen into an unfiltered
    // all-Khalani scan). Solana resolves through the SAME Khalani chain
    // selection - the chain id and its aliases are Khalani's - but is READ
    // direct from RPC, so the two branches are exclusive by family.
    const familyChainsRequested =
      !scope.rawProvided || (scope.selection.rawProvided && (khalaniChainIds?.length ?? 0) > 0);
    const solanaRequested = family === "solana" && familyChainsRequested;
    const khalaniRequested = family !== "solana" && familyChainsRequested;
    if (!khalaniRequested && !solanaRequested && localChainIds.length === 0) {
      if (parsed.data.walletFamily === family) {
        return fail(`WalletBalances: no ${family} chains matched chainIds="${parsed.data.chainIds}".`);
      }
      continue;
    }
    plans.push({ family, khalaniChainIds, localChainIds, khalaniRequested, solanaRequested });
  }

  const timings: FamilyLegTimings[] = [];
  const readPlan = (plan: FamilyPlan): Promise<FamilyOutcome> =>
    readFamilySnapshot(plan, parsed.data, context, dependencies, bounds, timings);
  // Families are independent reads of different chains: with parallel legs
  // they run together, and the answer is still assembled in family order.
  const outcomes: FamilyOutcome[] = [];
  if (bounds.parallelLegs) {
    outcomes.push(...(await Promise.all(plans.map(readPlan))));
  } else {
    for (const plan of plans) outcomes.push(await readPlan(plan));
  }

  const snapshots: WalletSnapshot[] = [];
  const walletErrors: Array<{ wallet: ChainFamily; message: string }> = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "snapshot") {
      snapshots.push(outcome.snapshot);
      continue;
    }
    if (parsed.data.walletFamily === outcome.family) {
      return fail(`${outcome.family} wallet error: ${outcome.message}`);
    }
    walletErrors.push({ wallet: outcome.family, message: outcome.message });
  }

  logger.info("wallet.balances.timing", {
    parallelLegs: bounds.parallelLegs,
    legTimeoutMs: bounds.legTimeoutMs,
    totalMs: Date.now() - startedAt,
    families: timings,
  });

  if (snapshots.length === 0) {
    return fail(`WalletBalances: no requested wallet snapshots were available.${formatWalletErrors(walletErrors)}`);
  }

  const anyLegNotAnswered = snapshots.some((snapshot) => (snapshot.legsNotAnswered?.length ?? 0) > 0);
  return ok({
    // Echoes the PARAM the caller filled in, under the same name.
    walletFamily: parsed.data.walletFamily,
    walletCount: snapshots.length,
    // Kept a NUMBER for compatibility, and it now always travels with the
    // basis that says what it counted: an unknown slice never silently reads
    // as a complete portfolio value (C3.2, C3.3).
    totalUsd: snapshots.reduce((sum, snapshot) => sum + snapshot.totalUsd, 0),
    // A family that produced no snapshot at all is the ENVELOPE's inventory
    // failure, and outranks every per-wallet reason.
    ...combineWalletCompleteness(snapshots, walletErrors.length),
    // Present only when a leg missed its deadline: the answer is PARTIAL, and
    // the note says so in words next to the numbers it qualifies.
    ...(anyLegNotAnswered ? { partial: true, partialNote: PARTIAL_LEGS_NOTE } : {}),
    walletErrors,
    wallets: snapshots,
  });
}

/**
 * Read ONE wallet family into its snapshot.
 *
 * Its three lanes (Khalani scan plus its price pass, Solana RPC, local-chain
 * RPC) are independent reads of different chains. With `parallelLegs` they run
 * together; without, in the original order. Either way their results are
 * MERGED in the original order (Khalani, then Solana, then local), so the
 * snapshot is identical whatever finished first.
 */
async function readFamilySnapshot(
  plan: FamilyPlan,
  args: z.infer<typeof WalletReadArgs>,
  context: InternalToolContext,
  dependencies: WalletBalancesDependencies,
  bounds: AgentWalletReadBounds,
  timings: FamilyLegTimings[],
): Promise<FamilyOutcome> {
  const { family, khalaniChainIds, localChainIds, khalaniRequested, solanaRequested } = plan;
  const legTimeoutMs = bounds.legTimeoutMs;
  const legsNotAnswered: LegNotAnswered[] = [];
  const timing: FamilyLegTimings = { family, timedOutLegs: 0 };
  timings.push(timing);
  try {
    const address = resolveSelectedAddressForRead(context.walletResolution, context.walletPolicy, family);

    // ── Lane 1: Khalani scan, then its price pass (the pass needs the rows).
    const khalaniLane = async (): Promise<{
      scan: TokenBalanceScanResult;
      enrichedTokens: KhalaniToken[];
    }> => {
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
        const scanStartedAt = Date.now();
        const chainTimings: KhalaniChainScanTiming[] = [];
        scan = await getTokenBalancesAcrossChains({
          address,
          family,
          chainIds: khalaniChainIds,
          includeNative: true,
          // The legacy read passes none of these, so its scan is the exact call
          // it always made.
          ...(bounds.parallelLegs ? { concurrency: WALLET_READ_KHALANI_CONCURRENCY } : {}),
          ...(legTimeoutMs > 0 ? { legTimeoutMs, signal: context.abortSignal } : {}),
          onChainTiming: (chainTiming) => chainTimings.push(chainTiming),
        });
        timing.khalaniScanMs = Date.now() - scanStartedAt;
        timing.khalaniChains = chainTimings.length;
        const slowest = slowestBy(chainTimings, (entry) => entry.khalaniMs);
        if (slowest !== undefined) {
          timing.khalaniSlowestChainId = slowest.chainId;
          timing.khalaniSlowestChainMs = slowest.khalaniMs;
        }
        const slowestNative = slowestBy(
          chainTimings.filter((entry) => entry.nativeMs !== null),
          (entry) => entry.nativeMs ?? 0,
        );
        if (slowestNative !== undefined) {
          timing.nativeSlowestChainId = slowestNative.chainId;
          timing.nativeSlowestChainMs = slowestNative.nativeMs ?? 0;
        }
        for (const chainTiming of chainTimings) {
          if (chainTiming.timedOut === null) continue;
          legsNotAnswered.push({
            leg: chainTiming.timedOut === "khalani" ? "khalani_scan" : "native_balance",
            chainId: chainTiming.chainId,
            timeoutMs: legTimeoutMs,
          });
        }
      }
      // Fill the prices Khalani left null, through the SAME pass the background
      // sync runs (`tools/khalani/balance-price-enrichment.ts`). It ran only on
      // the sync path until 2026-08-31, so this tool reported a smaller
      // portfolio than the sidebar for the same wallet at the same moment.
      // Before the projection, so a filled row counts as PRICED for the
      // valuation axis; Khalani's own prices are untouched, row order is the
      // scan's, and provider failures are fail-soft per chain.
      const pricingStartedAt = Date.now();
      const pricingTimings: Array<{ chainId: number; ms: number }> = [];
      const enrichment = await enrichKhalaniBalancePrices(scan.tokens, {
        signal: context.abortSignal,
        ...(bounds.parallelLegs ? { chainConcurrency: WALLET_READ_PRICING_CHAIN_CONCURRENCY } : {}),
        ...(legTimeoutMs > 0 ? { chainTimeoutMs: legTimeoutMs } : {}),
        onChainTiming: (chainTiming) => pricingTimings.push(chainTiming),
      });
      if (pricingTimings.length > 0) {
        timing.pricingMs = Date.now() - pricingStartedAt;
        timing.pricingChains = pricingTimings.length;
        const slowestPricing = slowestBy(pricingTimings, (entry) => entry.ms);
        if (slowestPricing !== undefined) {
          timing.pricingSlowestChainId = slowestPricing.chainId;
          timing.pricingSlowestChainMs = slowestPricing.ms;
        }
      }
      for (const chainId of enrichment.timedOutChainIds ?? []) {
        legsNotAnswered.push({ leg: "price_enrichment", chainId, timeoutMs: legTimeoutMs });
      }
      return { scan, enrichedTokens: enrichment.rows.map((row) => row.token) };
    };

    // ── Lane 2: Solana, direct RPC through the shared snapshot service, never
    // Khalani. A failure here is a per-chain error like any other, so the
    // family snapshot survives it rather than the whole call failing.
    const solanaLane = async (): Promise<SolanaLane | null> => {
      if (!solanaRequested) return null;
      throwIfAborted(context.abortSignal);
      const readSnapshot = dependencies.readSolanaSnapshot ?? readSolanaWalletSnapshot;
      const solanaStartedAt = Date.now();
      try {
        const outcome = await runWithinDeadline(legTimeoutMs, context.abortSignal, (signal) =>
          readSnapshot(address, { signal }));
        timing.solanaMs = Date.now() - solanaStartedAt;
        if (outcome.kind === "deadline") return { kind: "deadline" };
        return { kind: "read", snapshot: outcome.value };
      } catch (err) {
        timing.solanaMs = Date.now() - solanaStartedAt;
        // An operator Stop is the caller's, not this chain's: it must abort
        // the whole call rather than be filed as a Solana chain error.
        throwIfAborted(context.abortSignal);
        // SECURITY: a raw Solana RPC error can carry the configured RPC URL
        // (with its key) and HTML bodies. Only the scrubbed summary is
        // returned, exactly as the local-EVM branch does.
        const summary = summarizeProtocolError(err);
        logger.warn("wallet.solana_read.failed", {
          chainId: SOLANA_SYNTHETIC_CHAIN_ID,
          category: summary.category,
          error: summary.message,
        });
        return { kind: "failed", message: summary.message };
      }
    };

    // ── Lane 3: local (non-Khalani) chains - direct RPC, same failure surface
    // as a Khalani per-chain error (the family snapshot survives a dead chain).
    //
    // Bounded-concurrency, not serial: each chain costs a scan-set build, an
    // RPC read and a DexScreener price batch, and running N of them one after
    // another is the `WalletBalances` latency complaint. The bound matches
    // the Khalani scan's own (4) so the provider rate limits are not the new
    // failure mode, and results are written into slots keyed by index so the
    // output order stays chain order rather than completion order.
    const localLane = async (): Promise<LocalLaneResult[]> => {
      throwIfAborted(context.abortSignal);
      const localResults = new Array<LocalLaneResult>(localChainIds.length);
      if (localChainIds.length === 0) return localResults;
      const localStartedAt = Date.now();
      await mapWithConcurrency(localChainIds, LOCAL_CHAIN_SCAN_CONCURRENCY, async (localChainId, index) => {
        throwIfAborted(context.abortSignal);
        const outcome = await runWithinDeadline(legTimeoutMs, context.abortSignal, (signal) =>
          readLocalChainSnapshot(address, localChainId, signal));
        localResults[index] = outcome.kind === "settled" ? outcome.value : { kind: "deadline" };
      });
      timing.localChainsMs = Date.now() - localStartedAt;
      timing.localChainIds = [...localChainIds];
      return localResults;
    };

    let khalani: Awaited<ReturnType<typeof khalaniLane>>;
    let solana: SolanaLane | null;
    let localResults: LocalLaneResult[];
    if (bounds.parallelLegs) {
      [khalani, solana, localResults] = await Promise.all([khalaniLane(), solanaLane(), localLane()]);
    } else {
      khalani = await khalaniLane();
      solana = await solanaLane();
      localResults = await localLane();
    }
    const { scan, enrichedTokens } = khalani;

    // Slim each row at the handler seam (P1-7): reuse the Khalani projector so
    // the model sees identity + lifted priceUsd/balance, not the heavy logoURI
    // / open `extensions` bag. `tokenCount` / `totalUsd` stay computed off the
    // FULL scan so an optional `limit` trim never distorts the held totals.
    const projected: ProjectedTokenRow[] = projectTokens(enrichedTokens);
    // Recomputed off the ENRICHED rows through the scan's own reduce, so the
    // compatibility number cannot disagree with `pricedTotalUsd`, which the
    // completeness axis derives from the projected rows.
    let totalUsd = calculateTokensTotalUsd(enrichedTokens);
    const scannedChainIds = [...scan.scannedChainIds];
    const chainErrors = [...scan.chainErrors];
    const tokenErrors: TokenReadError[] = [];
    let tokenErrorsOmitted = 0;
    const accountErrors: AccountReadError[] = [];
    let accountErrorsOmitted = 0;
    // The inventory axis is evidence, not inference: every lane records what
    // its own enumeration did, and a FAILED read is never stamped with a
    // fresh observation time (C3.5) - that is how a gap gets renamed fresh
    // and the retry is suppressed.
    const inventorySources: InventorySource[] = [];
    const rejectedEntries: KhalaniRejectedTokenBalanceEntry[] = [...(scan.rejectedEntries ?? [])];
    if (khalaniRequested) {
      const khalaniObservedAt = new Date().toISOString();
      for (const scannedChainId of scan.scannedChainIds) {
        inventorySources.push({
          chainId: scannedChainId,
          source: "khalani_registry_scan",
          result: "read",
          exhaustive: true,
          observedAt: khalaniObservedAt,
        });
      }
      for (const chainError of scan.chainErrors) {
        inventorySources.push({
          chainId: chainError.chainId,
          source: "khalani_registry_scan",
          result: "failed",
          exhaustive: true,
          observedAt: null,
        });
      }
    }

    if (solana !== null && solana.kind === "read") {
      const snapshot = solana.snapshot;
      projected.push(...snapshot.rows.map(solanaRowToWalletToken));
      totalUsd += snapshot.totalUsd;
      scannedChainIds.push(SOLANA_SYNTHETIC_CHAIN_ID);
      // Exhaustive: the snapshot service enumerates every token ACCOUNT the
      // wallet owns plus the account balance, so a holding is never outside
      // the set it looked at.
      inventorySources.push({
        chainId: SOLANA_SYNTHETIC_CHAIN_ID,
        source: "solana_rpc_accounts",
        result: "read",
        exhaustive: true,
        observedAt: new Date().toISOString(),
      });
      // A partial read still returns its readable rows. The sync lane's
      // skip-the-chain policy is deliberately NOT copied: it exists because
      // the sync REPLACES the whole chain, and this tool has nothing to
      // destroy. Copying it would recreate the $0 answer under a new
      // mechanism.
      for (const failure of snapshot.accountFailures) {
        if (accountErrors.length < MAX_ACCOUNT_ERRORS_PER_SNAPSHOT) {
          accountErrors.push({
            chainId: SOLANA_SYNTHETIC_CHAIN_ID,
            accountAddress: failure.pubkey,
            reason: failure.reason,
          });
        } else accountErrorsOmitted += 1;
      }
    } else if (solana !== null) {
      if (solana.kind === "deadline") {
        legsNotAnswered.push({ leg: "solana_rpc", chainId: SOLANA_SYNTHETIC_CHAIN_ID, timeoutMs: legTimeoutMs });
      }
      chainErrors.push({
        chainId: SOLANA_SYNTHETIC_CHAIN_ID,
        chainName: "Solana",
        message: solana.kind === "deadline"
          ? `Solana RPC read timed out after ${legTimeoutMs}ms; holdings on this chain are unknown (not zero)`
          : `Solana RPC read failed: ${solana.message}`,
      });
      inventorySources.push({
        chainId: SOLANA_SYNTHETIC_CHAIN_ID,
        source: "solana_rpc_accounts",
        result: "failed",
        exhaustive: true,
        observedAt: null,
      });
    }

    localChainIds.forEach((localChainId, index) => {
      const local = localResults[index];
      // `undefined` is unreachable while `mapWithConcurrency` visits every
      // index; treated as a per-chain failure rather than asserted, because the
      // alternative is losing a whole family snapshot to a bookkeeping slip. A
      // missed deadline takes the same failed-chain shape with its own words.
      if (local === undefined || "kind" in local) {
        const timedOut = local !== undefined;
        if (timedOut) {
          legsNotAnswered.push({ leg: "local_chain_rpc", chainId: localChainId, timeoutMs: legTimeoutMs });
        }
        chainErrors.push({
          chainId: localChainId,
          message: timedOut
            ? `local chain RPC read timed out after ${legTimeoutMs}ms; holdings on this chain are unknown (not zero)`
            : "local chain scan produced no result",
        });
        inventorySources.push({
          chainId: localChainId,
          source: "local_chain_seed_and_pins",
          result: "failed",
          exhaustive: false,
          observedAt: null,
        });
        return;
      }
      // The enumeration owner decides what this chain may CLAIM: seeds and
      // pins alone are never exhaustive (a token outside them is invisible
      // here, not absent), and only a complete indexer answer lets 4663 say
      // it saw every holding. A scan set that never got built (the chain
      // failed before enumeration) reports the bounded source it fell back
      // to, never a fresh claim.
      inventorySources.push(
        ...(local.scan === null
          ? [{
              chainId: localChainId,
              source: "local_chain_seed_and_pins" as const,
              result: "failed" as const,
              exhaustive: false,
              observedAt: null,
            }]
          : localChainInventorySources({
              scan: local.scan,
              chainRead: local.ok ? "read" : "failed",
              observedAt: new Date().toISOString(),
            })),
      );
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

    const trimmed = trimTokens(projected, args.limit, args.response_format);
    // Both axes are computed off the FULL PRE-TRIM row set: a display trim
    // must never be able to move a completeness field, or "I asked for fewer
    // rows" would read as "the wallet became fully priced".
    const completeness = computeWalletCompleteness({
      rows: projected,
      sources: inventorySources,
      tokenErrorCount: tokenErrors.length + tokenErrorsOmitted,
      accountErrorCount: accountErrors.length + accountErrorsOmitted,
      rejectedEntries,
    });
    const bounded = boundRejectedEntries(rejectedEntries);
    // Rows measured against the FULL projected set, so it covers all three
    // ways a row can be missing: the priced overflow past `limit`, the 20-row
    // unpriced cap, and the zero-balance unpriced rows the trim drops (which
    // `unpricedOmitted` deliberately does not count). Every note that applies
    // is carried; a bound that reported only the first would hide the other.
    const truncationNotes = [
      ...(trimmed.tokens.length < projected.length ? [TRUNCATION_NOTE] : []),
      ...(bounded.rejectedEntriesOmitted !== undefined ? [REJECTED_ENTRIES_NOTE] : []),
    ];
    const truncated = truncationNotes.length > 0;
    timing.timedOutLegs = legsNotAnswered.length;
    legsNotAnswered.sort((left, right) => left.chainId - right.chainId || compareLeg(left.leg, right.leg));
    return {
      kind: "snapshot",
      snapshot: {
        ...completeness,
        wallet: family,
        address,
        tokenCount: projected.length,
        totalUsd,
        scannedChainIds,
        chainErrors,
        tokenErrors,
        ...(tokenErrorsOmitted > 0 ? { tokenErrorsOmitted } : {}),
        accountErrors,
        ...(accountErrorsOmitted > 0 ? { accountErrorsOmitted } : {}),
        ...(trimmed.unpricedOmitted > 0 ? { unpricedOmitted: trimmed.unpricedOmitted } : {}),
        ...bounded,
        truncated,
        ...(truncated ? { truncationNote: truncationNotes.join(" ") } : {}),
        ...(legsNotAnswered.length > 0 ? { legsNotAnswered } : {}),
        tokens: trimmed.tokens,
      },
    };
  } catch (err) {
    // An operator Stop is the TURN's outcome, not this family's. It leaves
    // the handler as a THROW so the dispatcher produces its one canonical
    // user-stop result. Converting it here would report a cancellation to
    // the model as a wallet FAILURE it might retry, and under
    // `walletFamily: "all"` would bury it in `walletErrors` while the other
    // family's snapshot was returned as a success.
    throwIfAborted(context.abortSignal);
    return { kind: "error", family, message: err instanceof Error ? err.message : String(err) };
  }
}

function slowestBy<T>(entries: readonly T[], ms: (entry: T) => number): T | undefined {
  let slowest: T | undefined;
  for (const entry of entries) {
    if (slowest === undefined || ms(entry) > ms(slowest)) slowest = entry;
  }
  return slowest;
}

function compareLeg(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requestedWalletFamilies(wallet: "eip155" | "solana" | "all"): ChainFamily[] {
  if (wallet === "all") return ["eip155", "solana"];
  return [wallet];
}

function formatWalletErrors(errors: Array<{ wallet: ChainFamily; message: string }>): string {
  if (errors.length === 0) return "";
  return ` Errors: ${errors.map((entry) => `${entry.wallet}: ${entry.message}`).join("; ")}`;
}
