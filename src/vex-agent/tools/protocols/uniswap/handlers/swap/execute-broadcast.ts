/**
 * One stage of the staged broadcast: sign → persist hash → broadcast → mark
 * accepted → wait for the receipt.
 *
 * The three outcomes are three different truths and the differences are the
 * whole safety of the loop — a mined revert terminalizes, an ambiguous
 * confirmation NEVER does.
 */

import type { Hex } from "viem";

import { getUniswapEvmClients } from "@tools/uniswap/evm-client.js";
import {
  signUniswapTransaction,
  broadcastUniswapTransaction,
  type BuiltSwapTx,
  type SignedUniswapTransaction,
} from "@tools/uniswap/execute.js";
import { DependentLegGasEstimateError } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { waitForSuccessfulReceipt } from "@tools/evm-chains/receipt-guard.js";
import type { UniswapDecodableReceipt } from "@tools/uniswap/receipt-decoder.js";
import { classifyUniswapRevertError, type UniswapRevertFailureCode } from "@tools/uniswap/revert-mapping.js";
import {
  markActivityBroadcast,
  reserveActivityEvmNonce,
  markBroadcastAccepted,
  failActivityEvent,
  type AgentActivityEvent,
  type AgentActivityFailureCode,
} from "@vex-agent/db/repos/agent-activity.js";
import {
  MINED_REVERT_SWAP_LEG_REASON,
  minedRevertApprovalLegReason,
} from "@vex-agent/tools/protocols/runtime/mined-revert-reason.js";
import type { ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import logger from "@utils/logger.js";

import { VexError, ErrorCodes } from "../../../../../../errors.js";
import { uniswapFailureMessage } from "./error-output.js";

/** A revert-mapping-shaped classification, widened to the full closed enum for repo assignment. */
export interface Classification {
  readonly failureCode: AgentActivityFailureCode;
  readonly failureReason: string;
}

/**
 * A refusal that never reached the network. Its code is narrowed to the shared
 * router-revert subset (`classifyUniswapRevertError`'s own return type), which
 * is what makes it a TYPE error — not a review question — to route a
 * broadcast-only code such as `mined_revert` into the "nothing was signed"
 * message.
 */
export interface PreBroadcastClassification extends Classification {
  readonly failureCode: UniswapRevertFailureCode;
}

/**
 * `settledAtBlock` on a confirmed stage is the receipt block the caller threads
 * into the NEXT stage as its read-after-write anchor
 * (`dependent-leg-gas-estimate.ts`).
 */
export type StageOutcome =
  | { readonly kind: "confirmed"; readonly receipt: UniswapDecodableReceipt; readonly txHash: Hex; readonly settledAtBlock: bigint }
  // `stage` is load-bearing, not bookkeeping: BOTH a sign-time refusal
  // (nothing ever reached the network) and a MINED revert (bytes broadcast,
  // gas burned) arrive as `failed`, and they must never be described to the
  // agent in the same words. Discriminated here rather than inferred from
  // `failureCode` so a future code cannot silently join the wrong half.
  | { readonly kind: "failed"; readonly stage: "pre_broadcast"; readonly classification: PreBroadcastClassification }
  | { readonly kind: "failed"; readonly stage: "mined_revert"; readonly classification: Classification }
  | { readonly kind: "ambiguous"; readonly txHash: Hex };

export async function runStagedBroadcast(
  event: AgentActivityEvent,
  tx: BuiltSwapTx,
  clients: ReturnType<typeof getUniswapEvmClients>,
  what: string,
  priorLeg: ConfirmedPriorLeg | undefined,
): Promise<StageOutcome> {
  let signed: SignedUniswapTransaction;
  let broadcastHash: Hex;
  try {
    signed = await signUniswapTransaction(
      clients.publicClient,
      clients.walletClient,
      tx,
      priorLeg,
      (request) => reserveActivityEvmNonce(event.id, request),
    );
  } catch (err) {
    // A leg whose estimate never succeeded after an approval THIS execute
    // confirmed is not a classifiable revert — the whole point of
    // `DependentLegGasEstimateError` is that we could not obtain an answer we
    // trust. Classifying it (the allowance revert string maps straight to
    // `allowance_or_balance`) would assert exactly the conclusion we cannot
    // support, so it goes to the outer C18 handler, which finalizes the
    // never-signed rows as "not attempted" and says so honestly.
    if (err instanceof DependentLegGasEstimateError) throw err;
    // Sign-time only (prepare/estimate/local signing) — no `sendRawTransaction`
    // call has happened yet, so nothing was ever submitted to the network.
    // Unlike a broadcast failure (C15), a sign-time failure is UNAMBIGUOUSLY
    // pre-wire — safe to definitively fail.
    const raw = classifyUniswapRevertError(err);
    // C37 (Codex final-review round 3, finding 1): `raw.failureReason` can be
    // a DECODED on-chain revert string (`extractDecodedRevertReason`) —
    // content a malformed/non-standard contract or a compromised RPC
    // controls, never text Vex authored. It must cross the SAME scrub
    // boundary as any other provider-controlled text before it reaches the
    // DB row (`failActivityEvent`, below) or the ToolResult output (the
    // "failed" branch in the main loop reads this same object's
    // `failureReason`).
    const classification: PreBroadcastClassification = { failureCode: raw.failureCode, failureReason: uniswapFailureMessage(raw.failureReason) };
    await failActivityEvent(event.id, classification);
    return { kind: "failed", stage: "pre_broadcast", classification };
  }

  // C14: a CAS miss aborts before submit, so an untracked signed payload
  // never reaches the network.
  const staged = await markActivityBroadcast(event.id, {
    txHash: signed.txHash,
    fromAddress: signed.fromAddress,
    nonce: signed.nonce,
  });
  if (!staged.applied) {
    throw new Error(
      `agent_activity: markActivityBroadcast CAS miss for event ${event.id} - refusing to broadcast an untracked transaction`,
    );
  }

  try {
    broadcastHash = await broadcastUniswapTransaction(clients.publicClient, signed.serializedTransaction);
  } catch {
    // C29 (Codex final-review round 2, finding 1 — supersedes FIX2's C15
    // implementation): NOTHING `sendRawTransaction` throws here is provably
    // pre-wire. viem mints its RPC-error classes (e.g.
    // `InvalidParamsRpcError`/`InvalidInputRpcError`) from the NODE's own
    // JSON-RPC response, meaning the request already reached the server —
    // `-32000` in particular can mean "already known" (the transaction may
    // already be in the mempool from THIS call). There is no independently
    // branded local error in this flow (a single network round-trip with no
    // local pre-validation ahead of it), so every rejection here is
    // unconditionally ambiguous — the row stays `pending` forever for the
    // repair sweep, never definitively failed. See
    // `@tools/uniswap/revert-mapping.js`'s file-header comment for the full
    // viem `buildRequest.ts` evidence trail.
    return { kind: "ambiguous", txHash: signed.txHash };
  }

  // C39 (Codex final-review round 3, finding 3): `signed.txHash` is derived
  // LOCALLY (`keccak256` of the exact signed bytes we submitted) — it is
  // authoritative end-to-end. `broadcastHash` is only what the NODE echoed
  // back; a faulty/misconfigured/malicious RPC could echo a different hash
  // and, if trusted, would redirect our receipt wait/output to an unrelated
  // transaction while the ALREADY-PERSISTED `agent_activity` row (staged
  // above with `signed.txHash`) silently disagrees. Never swap to the RPC's
  // value — log a mismatch and keep going with the locally-derived hash.
  if (broadcastHash.toLowerCase() !== signed.txHash.toLowerCase()) {
    logger.warn("uniswap.swap.execute.broadcast_hash_mismatch", {
      id: event.id,
      signedTxHash: signed.txHash,
      rpcEchoedHash: broadcastHash,
    });
  }

  // C16 (Codex final-review round 1, finding 2): best-effort bookkeeping — a
  // throw here must NOT be read as a broadcast failure (the transaction IS
  // already in flight), so we keep going to the receipt wait regardless.
  try {
    await markBroadcastAccepted(event.id);
  } catch (err) {
    logger.warn("uniswap.swap.execute.mark_accepted_failed", {
      id: event.id,
      error: uniswapFailureMessage(err),
    });
  }

  try {
    const receipt = await waitForSuccessfulReceipt(clients.publicClient, signed.txHash, {
      code: ErrorCodes.SWAP_FAILED,
      what,
      hint: "Check the transaction hash before retrying — do not resubmit automatically.",
    });
    // `TransactionReceipt.logs` is structurally compatible with
    // `UniswapDecodableReceipt.logs` (`Address`/`Hex` are `string` subtypes) —
    // no cast needed.
    return { kind: "confirmed", receipt, txHash: signed.txHash, settledAtBlock: receipt.blockNumber };
  } catch (err) {
    if (err instanceof VexError && err.code === ErrorCodes.SWAP_FAILED) {
      // A DEFINITIVE mined revert (waitForSuccessfulReceipt's status!=='success' branch).
      // Per-role: this reason is persisted AND read back verbatim in the
      // "failed" branch's output, so it must carry the remedy that is true for
      // THIS leg — the swap's price guard does not exist on an approve.
      // Owner: `runtime/mined-revert-reason.ts`.
      const classification: Classification = {
        failureCode: "mined_revert",
        failureReason: event.eventRole === "swap"
          ? MINED_REVERT_SWAP_LEG_REASON
          : minedRevertApprovalLegReason(event.eventRole),
      };
      await failActivityEvent(event.id, classification);
      return { kind: "failed", stage: "mined_revert", classification };
    }
    // CONFIRMATION_UNKNOWN (or anything unexpected) — the receipt lookup itself
    // failed. Ambiguous NEVER terminalizes: leave the row pending for the
    // repair sweep, which retries the SAME lookup later.
    return { kind: "ambiguous", txHash: signed.txHash };
  }
}
