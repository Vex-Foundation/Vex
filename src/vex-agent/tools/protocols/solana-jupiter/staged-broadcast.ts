/**
 * The ONE broadcast step every Solana/Jupiter mutation handler uses after its
 * `agent_activity` row has been staged (landing-lane design
 * `solana-landing-lanes-design.md` D1/D2/D4/D5). Owns three decisions that
 * were previously copy-pasted — and got copied WRONG — across
 * `handlers/core.ts`, `handlers/lend.ts`, `handlers/lend-borrow.ts` and
 * `predict-execute.ts`:
 *
 *  1. WHICH LANE carries the bytes. Selection is by PROVEN TIP, not by
 *     protocol name: `/tx/v1/submit` is reachable only with a
 *     `JupiterSubmitTipProof`, which only `assertBuildResponseSafeToSign` can
 *     mint. Everything tipless goes out over RPC. Before this module, all four
 *     paths used `/tx/v1/submit` and the three tipless ones silently vanished
 *     on real funds (2026-07-24 funded gate).
 *  2. WHAT THE AGENT IS TOLD. A definitive rejection is never dressed up as
 *     "broadcast, confirmation pending" — that false claim is what hid the
 *     defect. Provider text reaches the caller ONLY through
 *     `summarizeProtocolError`, the repo's scrub boundary (the one each
 *     handler's `lendFailureMessage`/`borrowFailureMessage`/
 *     `predictFailureMessage` already delegates to).
 *  3. RECORDING ACCEPTANCE. `markBroadcastAccepted` on a matching acceptance,
 *     once, best-effort — the convention every EVM path already follows
 *     (kyberswap, uniswap, khalani, relay) and no Solana path did.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: it never terminalizes a row, on
 * ANY outcome. The K3 sweep (`sync/solana-activity-repair.ts`) stays the sole
 * settlement/expiry authority (design D4); a definitive rejection changes only
 * the wording the agent sees, never the row's lifecycle. It also never
 * rebuilds, re-signs, refreshes a blockhash, or re-enters a provider
 * transaction endpoint, and it never logs or returns signed transaction bytes.
 *
 * It must be called only AFTER `markActivitySolanaBroadcast` has succeeded —
 * the staging CAS completes before the first network call at every site.
 */

import { markBroadcastAccepted } from "@vex-agent/db/repos/agent-activity.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import { submitPreparedTx } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/submit-prepared-tx.js";
import type { JupiterSubmitTipProof } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/submit-tip-proof.js";
import { submitPreparedManagedExecute } from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/submit-managed-execute.js";
import {
  submitPreparedTxOverRpc,
  type PreparedSolanaTx,
  type SolanaSubmitOutcome,
} from "@tools/solana-ecosystem/shared/solana-transaction.js";
import { solanaProgramErrorReason } from "@tools/solana-ecosystem/shared/solana-transaction/program-error-reason.js";
import logger from "@utils/logger.js";

/**
 * How a staged transaction reaches the network. A caller cannot select
 * `jupiter_submit` without real tip evidence, and cannot fabricate that
 * evidence — see `submit-tip-proof.ts`.
 */
export type SolanaLandingLane =
  /** Jupiter's tip-gated landing pipeline. Only the fee-bearing `/build` swap qualifies. */
  | { readonly kind: "jupiter_submit"; readonly tipProof: JupiterSubmitTipProof }
  /** Jupiter Prediction managed execution — the provider submits on our behalf. Every prediction build carrying an `execution` object takes this lane. */
  | { readonly kind: "jupiter_managed_execute"; readonly context: Record<string, unknown> }
  /** Plain Solana RPC, byte-for-byte. The lane for every tipless provider-built transaction. */
  | { readonly kind: "rpc" };

/**
 * What the handler should tell the agent. The first three all mean "the bytes
 * may be on their way, stay truthful-pending"; only `rejected_before_broadcast`
 * means the landing service answered and refused.
 */
export type StagedSolanaBroadcastResult =
  | { readonly kind: "accepted"; readonly signature: string }
  | { readonly kind: "signature_mismatch"; readonly signature: string }
  | { readonly kind: "transport_uncertain"; readonly signature: string }
  | {
      readonly kind: "rejected_before_broadcast";
      /** Already scrubbed and bounded — safe for tool output. */
      readonly reason: string;
      /**
       * The RAW thrown value, forwarded unchanged so a venue can CLASSIFY the
       * refusal (see `jupiter-swaps/pre-broadcast-rejection-refusal.ts`, which
       * reads the node's structured program logs). It is NOT safe to print —
       * same contract as `SolanaSubmitOutcome.cause`, which it comes from. A
       * caller that wants text uses `reason`, never this.
       */
      readonly cause: unknown;
    };

export interface StagedSolanaBroadcastInput {
  readonly toolId: string;
  /** The `agent_activity` row id whose signature is already persisted. */
  readonly rowId: number;
  readonly prepared: PreparedSolanaTx;
  readonly lane: SolanaLandingLane;
}

export async function broadcastStagedSolanaTx(
  input: StagedSolanaBroadcastInput,
): Promise<StagedSolanaBroadcastResult> {
  const { toolId, rowId, prepared, lane } = input;
  const outcome = await submitOnLane(prepared, lane);

  switch (outcome.kind) {
    case "accepted":
      await recordAcceptance(toolId, rowId);
      return { kind: "accepted", signature: prepared.signature };

    case "signature_mismatch":
      // Never overwrite the persisted signature, never terminalize: the
      // transaction may already have landed under OUR signature, which stays
      // canonical for the sweep.
      logger.warn(`${toolId}.submit_signature_mismatch`, {
        rowId,
        lane: lane.kind,
        local: outcome.localSignature,
        provider: outcome.providerSignature,
      });
      return { kind: "signature_mismatch", signature: prepared.signature };

    case "rejected_before_broadcast": {
      const reason = failureReason(outcome.cause);
      logger.warn(`${toolId}.submit_rejected_before_broadcast`, { rowId, lane: lane.kind, reason });
      return { kind: "rejected_before_broadcast", reason, cause: outcome.cause };
    }

    case "transport_uncertain":
      logger.warn(`${toolId}.submit_transport_uncertain`, {
        rowId,
        lane: lane.kind,
        error: failureReason(outcome.cause),
      });
      return { kind: "transport_uncertain", signature: prepared.signature };
  }
}

/**
 * The agent-safe reason for a failed submit.
 *
 * When the rejection came from an on-chain program that emitted its own error
 * sentence, that sentence is what the agent gets — web3.js's own formatting
 * buries it inside a `Logs: [...]` span that the scrub boundary (correctly)
 * collapses to `[body]`, leaving only an undecodable `custom program error:
 * 0x…` plus advice to call a method this process cannot call. Recovering the
 * program's words BEFORE the scrub is what makes an Earn dust rejection or a
 * Borrow debt-too-low rejection legible.
 *
 * Everything still passes through `summarizeProtocolError`: the recovered text
 * is chain-controlled input, so it is redacted and bounded exactly like the raw
 * throw. With no program-authored line the input is the raw cause — byte-for-
 * byte the behaviour this function replaced.
 */
function failureReason(cause: unknown): string {
  return summarizeProtocolError(solanaProgramErrorReason(cause) ?? cause).message;
}

function submitOnLane(
  prepared: PreparedSolanaTx,
  lane: SolanaLandingLane,
): Promise<SolanaSubmitOutcome> {
  switch (lane.kind) {
    case "jupiter_submit":
      return submitPreparedTx(prepared, lane.tipProof);
    case "jupiter_managed_execute":
      return submitPreparedManagedExecute(prepared, lane.context);
    case "rpc":
      return submitPreparedTxOverRpc(prepared);
  }
}

/**
 * Best-effort bookkeeping, matching the EVM convention (kyberswap:700,
 * uniswap:432, khalani:352, relay:630): the transaction is already in flight,
 * so a failure here is logged and never rolled back or propagated. Called only
 * on a signature-MATCHING acceptance — recording `broadcast_at` for a
 * signature the provider did not confirm would be a claim we cannot support.
 */
async function recordAcceptance(toolId: string, rowId: number): Promise<void> {
  try {
    const result = await markBroadcastAccepted(rowId);
    if (!result.applied) logger.warn(`${toolId}.broadcast_accept_miss`, { rowId });
    // Migration 067, the whole Solana family at its ONE acceptance spine: the
    // signature is submitted and no commitment has been observed. Nothing here
    // ever confirms a Solana row — the repair sweep owns that — so before this
    // the row sat pending with no stated reason, indistinguishable from a row
    // whose receipt we looked for and could not read.
    await noteHandlerPendingReason(toolId, rowId, "solana_awaiting_confirmation");
  } catch (err) {
    logger.warn(`${toolId}.broadcast_accept_failed`, {
      rowId,
      error: summarizeProtocolError(err).message,
    });
  }
}
