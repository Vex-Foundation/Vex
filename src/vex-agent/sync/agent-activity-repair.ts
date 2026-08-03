/**
 * `agent_activity` EVM repair sweep — a STATUS-ONLY pending-transaction
 * resolver (owner decree 2026-07-30).
 *
 * ONE QUESTION PER ROW: take the pending row's tx hash, resolve a read-only RPC
 * for the chain the transaction was made on, and ask the chain whether it
 * succeeded or reverted. Success → `confirmed`. Mined revert →
 * `definitively_failed`. Nothing else. The sweep is PROTOCOL-AGNOSTIC: it holds
 * no venue knowledge, decodes nothing, and reads no amounts.
 *
 * WHY THE DECODERS WENT AWAY. This sweep used to confirm only when a registered
 * per-protocol settlement decoder could turn the receipt into executed amounts.
 * A decoder that declined left the row `pending` FOREVER — which is exactly what
 * happened to a KyberSwap CAT→native-ETH swap on Robinhood Chain (4663) that was
 * mined `success` on-chain: the native-out leg arrives as a wrapped-native burn
 * with no Withdrawal event to the router, so the decoder could not prove it. A
 * lifecycle sweep that cannot report a settled transaction as settled is worse
 * than one that reports the status without the amounts.
 *
 * AMOUNTS ARE DEFERRED, NOT FAKED (owner decree; rule `90-vex-project.md`). A
 * status-only confirm writes NO `executed_*` column — see
 * `confirmActivityEventStatusOnly`. Agent Scan then shows the QUOTED amount
 * explicitly labelled "estimated". Copying the quote into the executed columns
 * would record a quote as a settlement, which is the one thing that seam exists
 * to prevent.
 *
 * LOOKUP-ONLY, by construction: the dependency surface is exactly ONE function,
 * a receipt lookup by hash. This module holds no signer, never imports a
 * send/broadcast/sign capability, and never re-quotes or re-executes.
 *
 * AMBIGUITY NEVER TERMINALIZES (FIX-SPINE C1): a missing receipt (not yet
 * mined), an unreadable receipt status, or a lookup error (transient RPC
 * failure) NEVER finalizes the row — it stays `pending`, re-checked on the next
 * sweep, only `last_checked_at` moves. There is NO time-based escalation to
 * `confirmation_timeout` (that failure_code stays in the closed enum but is
 * reserved — never auto-set here or anywhere).
 *
 * EVERY DEAD END TOUCHES `last_checked_at`: the candidate query orders by it
 * under a LIMIT, so a row that cannot be resolved this tick must rotate to the
 * BACK of the queue. Otherwise a handful of permanently-unresolvable rows pin
 * the window and starve every newer pending row behind them.
 *
 * A MINED REVERT is the sweep's ONE definitive-failure path
 * (`failure_code = 'mined_revert'`, distinct from `simulation_reverted`, which
 * is a PRE-broadcast revert recorded by the handler itself).
 *
 * DUPLICATE-CAS AWARENESS (C7): the finalizers return `{applied, row}` — an
 * `applied:false` here means a concurrent process (another sweep instance, or
 * the handler's own late finalize) already settled this row; the sweep logs it
 * and moves on without double-counting.
 *
 * ERROR LOGGING (FIX5-SPINE): the lookup catch routes its `error` field through
 * `summarizeProtocolError(err).message` (`runtime/errors.ts`'s canonical scrub
 * boundary), never a bare `redact()` call — a provider/RPC error can carry URLs,
 * request/response bodies, and auth headers that `redact()` alone (secret-SHAPE
 * detection only) does not strip.
 */

import {
  confirmActivityEventStatusOnly,
  failActivityEvent,
  listPendingOlderThan,
  touchLastChecked,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import {
  MINED_REVERT_ROLE_NEUTRAL_REASON,
  MINED_REVERT_SWAP_LEG_REASON,
} from "@vex-agent/tools/protocols/runtime/mined-revert-reason.js";
import logger from "@utils/logger.js";

/**
 * Repair-sweep candidacy: re-check a pending row once its signed submit is at
 * least this old.
 *
 * DELIBERATELY NOT SHORTENED with the 30s cadence. This margin protects the
 * HAPPY path: a broadcast handler is still decoding its own receipt for the
 * first ~seconds after submit, and a status-only sweep that won the CAS against
 * that in-flight strict confirm would permanently forfeit the executed amounts
 * the handler was about to write. 90s + a 30s tick still resolves a genuinely
 * stuck row within ~90-120s of broadcast.
 */
export const REPAIR_CANDIDATE_AGE_MS = 90_000;

/**
 * Bounded batch per sweep run (FIX-SPINE C11 — finding 12): the sweep does
 * serial RPC calls per run inside the shared sync worker — an unbounded backlog
 * would starve balance/Jupiter sync sharing the same drain. Any remainder is
 * picked up on the NEXT periodic tick; `listPendingOlderThan` orders by
 * least-recently-checked so the window rotates instead of re-serving the same
 * rows.
 */
export const REPAIR_BATCH_LIMIT = 25;

export interface ReceiptCheckInput {
  readonly chainId: number;
  readonly txHash: string;
}

/**
 * `null` means "no answer yet" (not yet mined, or a transient lookup error) —
 * the row stays pending. The receipt itself is NOT carried: a status-only sweep
 * has no consumer for it.
 */
export type ReceiptCheckResult =
  | { readonly status: "success" }
  | { readonly status: "reverted" };

export interface RepairDeps {
  /** The ONLY dependency this sweep may have. Read-only — never a send/broadcast/sign capability. */
  readonly checkReceiptByHash: (input: ReceiptCheckInput) => Promise<ReceiptCheckResult | null>;
}

export interface RepairSweepResult {
  readonly checked: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly stillPending: number;
}

export async function repairPendingActivity(deps: RepairDeps): Promise<RepairSweepResult> {
  // W5 design REVISION 1 R3: this sweep owns ONLY EVM ('eip155') rows — the
  // Solana activity sweep (`solana-activity-repair.ts`) owns every
  // chain_family='solana' staged row via its own disjoint candidate query.
  const candidates = await listPendingOlderThan(REPAIR_CANDIDATE_AGE_MS, REPAIR_BATCH_LIMIT, "eip155");
  let confirmed = 0;
  let failed = 0;
  let stillPending = 0;

  for (const event of candidates) {
    const outcome = await resolveEvmPendingRow(event, deps);
    if (outcome === "confirmed") confirmed++;
    else if (outcome === "failed") failed++;
    else if (outcome === "pending") stillPending++;
    // "duplicate": a concurrent process already settled this row — logged in
    // `logDuplicateCas`; never double-counted here.
  }

  return { checked: candidates.length, confirmed, failed, stillPending };
}

/** What one candidate's resolution attempt concluded. Mirrors the Solana sweep's own outcome union. */
export type EvmRepairOutcome = "confirmed" | "failed" | "pending" | "duplicate";

/**
 * Resolve ONE pending EVM row — the sweep's entire per-row policy, extracted so
 * the Wave P fast lane asks the chain exactly the same question, through exactly
 * the same deps, and terminalizes under exactly the same rules.
 *
 * EXTRACTION IS THE POINT: a second implementation of "when may a status-only
 * observation terminalize a row" is precisely the kind of duplicated money logic
 * that drifts. The fast lane owns *when* to call this; this function owns *what
 * it means*.
 *
 * The caller is responsible for the 90 s candidate-age gate
 * (`REPAIR_CANDIDATE_AGE_MS`). The sweep enforces it in its candidate query; the
 * fast lane enforces it explicitly before calling here — see `fast-lane.ts`.
 */
export async function resolveEvmPendingRow(
  event: PendingEvmRow,
  deps: RepairDeps,
): Promise<EvmRepairOutcome> {
  if (!event.txHash) {
    // No signed hash was ever persisted (crash before step 2) — nothing to
    // look up yet; leave it for a later sweep once/if a hash lands.
    return "pending";
  }

  let receipt: ReceiptCheckResult | null;
  try {
    receipt = await deps.checkReceiptByHash({ chainId: event.chainId, txHash: event.txHash });
  } catch (err) {
    logger.warn("agent_activity.repair.lookup_failed", {
      id: event.id,
      chainId: event.chainId,
      error: summarizeProtocolError(err).message,
    });
    // Rotate even though nothing was learned — same fairness contract as the
    // Solana sweep. `listPendingOlderThan` orders by `last_checked_at` under a
    // LIMIT, so a row whose lookup keeps throwing must move to the back of the
    // queue instead of pinning the window against newer pending rows. The
    // production dep swallows its own errors today, but an injected or future
    // one may throw, and the fairness contract must not depend on that.
    await touchLastChecked(event.id, "lookup_error");
    return "pending";
  }

  if (receipt === null) {
    // Ambiguity NEVER terminalizes (FIX-SPINE C1) — no time-based escalation.
    // The reason is what makes a permanently unverifiable row SAYABLE (migration
    // 065): "not yet mined" and "no RPC could answer" both leave the row
    // pending, and only one of them is worth telling the user about.
    await touchLastChecked(event.id, "receipt_not_found");
    return "pending";
  }

  if (receipt.status === "reverted") {
    const outcome = await failActivityEvent(event.id, {
      failureCode: "mined_revert",
      // A `swap` row gets the swap remedy — the same event deserves the same
      // explanation however Vex noticed it. Every other role stays NEUTRAL:
      // this sweep holds only a row (it sees approvals, bridge deposits and
      // fee transfers alike) and has no venue knowledge to spend, so it
      // states only what is certainly true. Owner:
      // `tools/protocols/runtime/mined-revert-reason.ts`.
      failureReason: event.eventRole === "swap"
        ? MINED_REVERT_SWAP_LEG_REASON
        : MINED_REVERT_ROLE_NEUTRAL_REASON,
    });
    if (outcome.applied) return "failed";
    logDuplicateCas(event.id, "fail");
    return outcome.row.status === "pending" ? "pending" : "duplicate";
  }

  // Mined success. The chain has answered the only question this sweep asks.
  const outcome = await confirmActivityEventStatusOnly(event.id);
  if (outcome.applied) return "confirmed";
  logDuplicateCas(event.id, "confirm");
  return outcome.row.status === "pending" ? "pending" : "duplicate";
}

/** The fields `resolveEvmPendingRow` actually reads — narrower than the full row on purpose. */
export type PendingEvmRow = Pick<
  AgentActivityEvent,
  "id" | "chainId" | "txHash" | "eventRole"
>;

function logDuplicateCas(id: number, attempted: "confirm" | "fail"): void {
  // Not a failure — a concurrent process (another sweep run, or the handler's
  // own late finalize) already settled this row before this sweep got to it.
  logger.info("agent_activity.repair.duplicate_cas_miss", { id, attempted });
}

/**
 * Production `checkReceiptByHash` — a read-only viem client per chain,
 * `getTransactionReceipt` only. Never holds a signer/wallet client.
 * `null` on "not yet mined" (`TransactionReceiptNotFoundError`), on any
 * transient lookup error, AND on a receipt whose `status` is not one of the two
 * literals we can read — all leave the row `pending` for the next sweep.
 *
 * PER-RUN CLIENT MEMO: the resolved client is cached per `chainId` for the
 * lifetime of ONE sweep run (this closure), so Khalani chain discovery costs at
 * most one round trip per distinct chain per run rather than one per candidate
 * row. A new run builds new deps and re-resolves, so a chain-list change is
 * picked up on the next tick.
 */
export function buildProductionRepairDeps(): RepairDeps {
  const clientsByChainId = new Map<number, Promise<ReceiptLookupClient | null>>();
  const resolveClient = (chainId: number): Promise<ReceiptLookupClient | null> => {
    let cached = clientsByChainId.get(chainId);
    if (!cached) {
      cached = resolveReadOnlyReceiptClient(chainId);
      clientsByChainId.set(chainId, cached);
    }
    return cached;
  };

  return {
    checkReceiptByHash: async ({ chainId, txHash }): Promise<ReceiptCheckResult | null> => {
      try {
        const client = await resolveClient(chainId);
        if (!client) return null;
        const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
        // ONLY the two literal statuses are proof. viem's receipt formatter
        // yields `null` for a status value it does not recognize, and an RPC can
        // return a shape we did not anticipate — mapping "not success" to
        // "reverted" would turn an unreadable receipt into an IRREVERSIBLE
        // `definitively_failed` write. Anything else is ambiguity: `null`, and
        // the row stays pending for the next sweep.
        if (receipt.status === "success") return { status: "success" };
        if (receipt.status === "reverted") return { status: "reverted" };
        return null;
      } catch {
        return null;
      }
    },
  };
}

/** Just enough of a viem public client for a receipt lookup — this sweep must never reach a broadcast/sign capability. */
interface ReceiptLookupClient {
  // `status` is deliberately widened to `unknown`: viem types it as a
  // "success" | "reverted" union, but its formatter genuinely emits `null` for
  // an unrecognized on-chain value, so the narrow type would let an unreadable
  // receipt through a `!== "success"` check unexamined.
  getTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<{ status?: unknown }>;
}

/**
 * THREE CHAIN SOURCES, ONE POSTURE. Each is a CHAIN SOURCE — a way to obtain a
 * read-only RPC for a chain id — never per-protocol verification; the sweep's
 * behavior is identical whichever one answers.
 *
 *   1. Khalani's live chain list (the bridge venue's own registry) answers first.
 *   2. The LOCAL `evm-chains` registry — chains Vex operates on directly without
 *      Khalani. Robinhood Chain (4663) lives ONLY here, which is why the stuck
 *      row that motivated this change could not even get a client before.
 *   3. The Pendle registry, for the chains neither of the above carries. Pendle
 *      executes on 11 chains, some of which Khalani has never heard of (Monad,
 *      143) — without this source those rows could never be repaired at all.
 *
 * `null` when no source knows the chain. Only the chain SOURCE widens here: an
 * actual RPC failure still returns `null` and still leaves the row pending.
 */
async function resolveReadOnlyReceiptClient(chainId: number): Promise<ReceiptLookupClient | null> {
  try {
    const { getKhalaniClient } = await import("@tools/khalani/client.js");
    const { getChain } = await import("@tools/khalani/chains.js");
    const { createDynamicPublicClient } = await import("@tools/khalani/evm-client.js");
    const chains = await getKhalaniClient().getChains();
    const chain = getChain(chainId, chains);
    return createDynamicPublicClient(chain, chains);
  } catch {
    // Khalani does not carry this chain (or its chain list is unavailable) —
    // fall through to the next chain source rather than reporting "no answer".
  }
  try {
    const { getLocalChain } = await import("@tools/evm-chains/registry.js");
    const local = getLocalChain(chainId);
    if (local) {
      const { getLocalPublicClient } = await import("@tools/evm-chains/evm-client.js");
      return getLocalPublicClient(local);
    }
  } catch {
    // Same posture — try the last source.
  }
  try {
    const { getPendleChain } = await import("@tools/pendle/chains.js");
    if (!getPendleChain(chainId)) return null;
    const { getPendlePublicClient } = await import("@tools/pendle/evm-client.js");
    return getPendlePublicClient(chainId);
  } catch {
    return null;
  }
}
