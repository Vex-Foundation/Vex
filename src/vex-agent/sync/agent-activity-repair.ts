/**
 * `agent_activity` repair sweep (plan §4.1 / §11.1; FIX-SPINE round 1
 * hardened the ambiguity/settlement contract per Codex findings 4/7/12).
 *
 * LOOKUP-ONLY, by construction: `repairPendingActivity`'s dependency surface
 * is exactly ONE function, a receipt lookup by hash. This module holds no
 * signer, never imports a send/broadcast/sign capability, and never falls
 * back to re-quoting or re-executing a swap — it exists so a `pending` row
 * whose confirmation could not be determined at broadcast time (the
 * `receipt-guard.ts:29` "could not be determined" case) still gets finalized
 * once the chain actually settles it, without turning the background worker
 * into a second transaction-issuing surface.
 *
 * AMBIGUITY NEVER TERMINALIZES (FIX-SPINE C1 — finding 7): a missing receipt
 * (not yet mined) or a lookup error (transient RPC failure) NEVER finalizes
 * the row — it stays `pending` forever, re-checked on the next sweep, only
 * `last_checked_at` moves. There is NO time-based escalation to
 * `confirmation_timeout` (that failure_code stays in the closed enum but is
 * reserved — never auto-set here or anywhere in this repo).
 *
 * SETTLEMENT DECODING (FIX-SPINE C2 — finding 4): a "success" receipt is
 * NEVER enough on its own to confirm — this sweep has no venue-specific
 * knowledge of how to turn a raw receipt into executed amounts. It looks up
 * a registered decoder (`settlement-decoders.ts`) by the row's own
 * `protocol` and confirms ONLY when that decoder returns amounts; a missing
 * decoder or a decoder that declines to decode this receipt leaves the row
 * `pending` (warn-logged), same as an ambiguous receipt.
 *
 * A MINED REVERT is the sweep's ONE definitive-failure path
 * (`failure_code = 'mined_revert'`, distinct from `simulation_reverted`,
 * which is a PRE-broadcast/simulate-time revert recorded by the handler
 * itself, never by this sweep).
 *
 * DUPLICATE-CAS AWARENESS (C7): `confirmActivityEvent`/`failActivityEvent`
 * return `{applied, row}` — an `applied:false` here means a concurrent
 * process (another sweep instance, or the handler's own late finalize)
 * already settled this row; the sweep logs it and moves on without
 * double-counting.
 *
 * ERROR LOGGING (FIX5-SPINE — Codex final-review round 4 finding 2): both
 * catch blocks (RPC lookup failure, decoder throw) route their `error` field
 * through `summarizeProtocolError(err).message` (`runtime/errors.ts`'s
 * canonical scrub boundary), never a bare `redact()` call — a provider/RPC
 * error can carry URLs, request/response bodies, and auth headers that
 * `redact()` alone (secret-SHAPE detection only) does not strip.
 */

import {
  confirmActivityEvent,
  failActivityEvent,
  listPendingOlderThan,
  touchLastChecked,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import { getSettlementDecoder, type DecodedSettlement } from "./settlement-decoders.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

/** Repair-sweep candidacy: re-check a pending row once its signed submit is at least this old. */
export const REPAIR_CANDIDATE_AGE_MS = 90_000;

/**
 * Bounded batch per sweep run (FIX-SPINE C11 — finding 12): the sweep does
 * serial RPC calls per run inside the shared sync worker — an unbounded
 * backlog would starve balance/Jupiter/Hyperliquid sync sharing the same
 * drain. Any remainder is picked up on the NEXT periodic tick.
 */
export const REPAIR_BATCH_LIMIT = 25;

export interface ReceiptCheckInput {
  readonly chainId: number;
  readonly txHash: string;
}

/**
 * `null` means "no answer yet" (not yet mined, or a transient lookup error) —
 * the row stays pending. A "success" receipt is opaque here (`unknown`) —
 * this sweep does NOT decode it; the raw value is handed verbatim to the
 * registered settlement decoder for the row's `protocol` (C2).
 */
export type ReceiptCheckResult =
  | { readonly status: "success"; readonly receipt: unknown }
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
  const candidates = await listPendingOlderThan(REPAIR_CANDIDATE_AGE_MS, REPAIR_BATCH_LIMIT);
  let confirmed = 0;
  let failed = 0;
  let stillPending = 0;

  for (const event of candidates) {
    if (!event.txHash) {
      // No signed hash was ever persisted (crash before step 2) — nothing to
      // look up yet; leave it for a later sweep once/if a hash lands.
      stillPending++;
      continue;
    }

    let receipt: ReceiptCheckResult | null;
    try {
      receipt = await deps.checkReceiptByHash({ chainId: event.chainId, txHash: event.txHash });
    } catch (err) {
      logger.warn("agent_activity.repair.lookup_failed", {
        id: event.id,
        chainId: event.chainId,
        // FIX5-SPINE (Codex final-review round 4 finding 2): route through the
        // canonical scrub boundary, not a bare redact() — a provider/RPC error
        // can carry URLs, request/response bodies, and auth headers that
        // redact() alone (secret-SHAPE detection only) does not strip.
        error: summarizeProtocolError(err).message,
      });
      stillPending++;
      continue;
    }

    if (receipt === null) {
      // Ambiguity NEVER terminalizes (FIX-SPINE C1) — no time-based escalation.
      await touchLastChecked(event.id);
      stillPending++;
      continue;
    }

    if (receipt.status === "reverted") {
      const outcome = await failActivityEvent(event.id, {
        failureCode: "mined_revert",
        failureReason: "mined revert (repair sweep receipt lookup)",
      });
      if (outcome.applied) {
        failed++;
      } else {
        logDuplicateCas(event.id, "fail");
        if (outcome.row.status === "pending") stillPending++;
      }
      continue;
    }

    const decoded = await decodeSettlement(event, receipt.receipt);
    if (!decoded) {
      logger.warn("agent_activity.repair.no_settlement_decoder", {
        id: event.id,
        protocol: event.protocol,
        hint: "no registered decoder (or it declined to decode this receipt) — leaving row pending",
      });
      await touchLastChecked(event.id);
      stillPending++;
      continue;
    }

    const outcome = await confirmActivityEvent(event.id, {
      executedAmountInHuman: decoded.executedAmountInHuman,
      executedAmountInRaw: decoded.executedAmountInRaw,
      executedAmountOutHuman: decoded.executedAmountOutHuman,
      executedAmountOutRaw: decoded.executedAmountOutRaw,
    });
    if (outcome.applied) {
      confirmed++;
    } else {
      logDuplicateCas(event.id, "confirm");
      if (outcome.row.status === "pending") stillPending++;
    }
  }

  return { checked: candidates.length, confirmed, failed, stillPending };
}

function logDuplicateCas(id: number, attempted: "confirm" | "fail"): void {
  // Not a failure — a concurrent process (another sweep run, or the handler's
  // own late finalize) already settled this row before this sweep got to it.
  logger.info("agent_activity.repair.duplicate_cas_miss", { id, attempted });
}

/** Look up the registered decoder for this row's protocol and ask it to turn the raw receipt into executed amounts. `null` on no decoder / decoder decline / decoder throw. */
async function decodeSettlement(
  event: AgentActivityEvent,
  receipt: unknown,
): Promise<DecodedSettlement | null> {
  const decoder = getSettlementDecoder(event.protocol);
  if (!decoder) return null;
  try {
    const decoded = await decoder({
      receipt,
      protocolExecutionId: event.protocolExecutionId,
      chainId: event.chainId,
      walletAddress: event.walletAddress,
      tokenInAddress: event.tokenInAddress,
      tokenOutAddress: event.tokenOutAddress,
    });
    if (!decoded || (!decoded.executedAmountInRaw && !decoded.executedAmountOutRaw)) {
      return null;
    }
    return decoded;
  } catch (err) {
    logger.warn("agent_activity.repair.decoder_threw", {
      id: event.id,
      protocol: event.protocol,
      // FIX5-SPINE (finding 2): same canonical-boundary fix as the lookup
      // catch above — a decoder can rethrow a raw provider/RPC error too.
      error: summarizeProtocolError(err).message,
    });
    return null;
  }
}

/**
 * Production `checkReceiptByHash` — a read-only Khalani-resolved viem client
 * per chain, `getTransactionReceipt` only. Never holds a signer/wallet client.
 * `null` on "not yet mined" (`TransactionReceiptNotFoundError`) AND on any
 * transient lookup error — both leave the row `pending` for the next sweep.
 * The raw receipt is passed through UNDECODED on success — see the module
 * doc's settlement-decoder contract (C2).
 */
export function buildProductionRepairDeps(): RepairDeps {
  return {
    checkReceiptByHash: async ({ chainId, txHash }): Promise<ReceiptCheckResult | null> => {
      try {
        const { getKhalaniClient } = await import("@tools/khalani/client.js");
        const { getChain } = await import("@tools/khalani/chains.js");
        const { createDynamicPublicClient } = await import("@tools/khalani/evm-client.js");
        const chains = await getKhalaniClient().getChains();
        const chain = getChain(chainId, chains);
        const client = createDynamicPublicClient(chain, chains);
        const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
        return receipt.status === "success" ? { status: "success", receipt } : { status: "reverted" };
      } catch {
        return null;
      }
    },
  };
}
