/**
 * Solana/Jupiter PREDICTION mutation execute — staged Solana write path (W5
 * design `w5-design.md` §2/§3/§5, REVISION 1 R1/R2, REVISION 2 R2b/R4b).
 * Converts `solana.predict.buy`/`.sell`/`.claim`/`.closeAll` from the legacy
 * `_tradeCapture` pipeline to durable `agent_activity` recording on the K2
 * primitives: `createAgentActivityIntent` (record BEFORE signing) ->
 * `prepareVersionedTx` (sign-only, REPLACE/MANDATORY-HEIGHT mode — Jupiter
 * Prediction responses carry no evidence Vex trusts without a fresh fetch,
 * per REVISION 2 R2b: "one code path for every provider-built Solana tx") ->
 * `markActivitySolanaBroadcast` (persist signature + blockhash evidence
 * BEFORE submit, CAS) -> `broadcastStagedSolanaTx` (the RPC lane for these
 * tipless provider-built transactions; a signature mismatch or an ambiguous
 * transport failure NEVER terminalizes the row — it stays `pending` for the
 * Solana sweep, K3).
 *
 * Split out of `handlers/predict.ts` (read handlers + dispatch map) so both
 * files stay under the 500-line cap, mirroring this directory's established
 * sibling-extraction pattern (`predict-projector.ts`/`predict-params.ts`/
 * `predict-region-block.ts`) and the sibling `handlers/lend.ts` (K6) — same
 * K2 write sequence, same private per-domain helper (no cross-protocol
 * shared abstraction; two concrete uses is too early to generalize). The N-row
 * `closeAll` mutation lives in the sibling `predict-execute-close-all.ts`
 * (same 500-line-cap reason) and imports this file's shared staged-write
 * primitives (`sharedFields`/`failPreBroadcast`/`stageAndSubmit`/
 * `resolveSessionAndWallet`/`isToolResult`/`usdEst`) rather than duplicating
 * them.
 *
 * Every outcome here is TRUTHFUL-PENDING: nothing in this module ever calls
 * `confirmActivityEvent` — K3's sweep (`sync/solana-activity-repair.ts`) is
 * the SOLE owner of terminality once a signature is staged. `success:true`
 * never appears for a broadcast attempt.
 *
 * MANAGED EXECUTION (corrected 2026-07-25, live-proven): a build response that
 * carries an `execution` object MUST submit through the provider's managed
 * execute endpoint with that object's `context`, passed unchanged.
 * `resolveManagedExecution` (`prediction-api/managed-execution.ts`) is the
 * routing gate and `submit-managed-execute.ts` is the submit step. This file
 * previously routed only on `executionModel: "atomic_swap"` (Forecast/bisonfi)
 * and asserted that keeper-filled kalshi/polymarket orders "never carry an
 * `execution` object" — that assertion was FALSE and is why NO prediction
 * mutation had ever executed: the keeper-filled order fell through to the raw
 * RPC lane and then hit the sole-signer guard, which correctly refused a
 * transaction Jupiter co-signs.
 *
 * Those builds are PROVIDER-CO-SIGNED and Vex is NOT the fee payer. Signing
 * therefore runs in `prepareVersionedTx`'s `coSigned` contract with VERIFY-mode
 * blockhash evidence from the response's own `txMeta` — never REPLACE mode,
 * which would invalidate the signatures Jupiter has already placed in the blob.
 * The staged seam is UNCHANGED: because the provider only asks Vex for the last
 * outstanding signature, the fee payer's slot is already filled, so
 * `signatures[0]` is a real transaction id available before submit.
 */

import { Keypair } from "@solana/web3.js";

import {
  requestJupiterPredictionCreateOrderTransaction,
  requestJupiterPredictionClosePositionTransaction,
  requestJupiterPredictionClaimPositionTransaction,
  requireTransaction,
  resolveManagedExecution,
  type JupiterPredictionManagedExecution,
} from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js";
import { JUPITER_PREDICTION_USDC_MINT } from "@tools/solana-ecosystem/jupiter/jupiter-prediction/constants.js";
import { prepareVersionedTx, type PreparedSolanaTx } from "@tools/solana-ecosystem/shared/solana-transaction.js";
import { solanaExplorerUrl } from "@tools/solana-ecosystem/shared/solana-validation.js";
import {
  createAgentActivityIntent,
  createAgentActivityPreBroadcastFailure,
  markActivitySolanaBroadcast,
  failActivityEvent,
  type AgentActivityEventRole,
  type CreatePendingActivityEventInput,
} from "@vex-agent/db/repos/agent-activity.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import { walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../constants/solana-chain.js";

import type { ToolResult } from "../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../types.js";
import { str, num, fail } from "../handler-helpers.js";
import { broadcastStagedSolanaTx } from "./staged-broadcast.js";
import { walletAddress, walletSecret } from "./handlers/core.js";
import { microUsdToDollarString } from "./predict-projector.js";
import logger from "@utils/logger.js";

const PROTOCOL = "jupiter";
const NAMESPACE = "solana";

/** The ONE entry point for provider-error text reaching an output/log/reason (scrub boundary). */
function predictFailureMessage(err: unknown): string {
  return summarizeProtocolError(err).message;
}

/** Decimals for a supported deposit mint (USDC-only today) — explicit branch, never a bare magic number; `null` for an unsupported mint (unreachable: buy always deposits USDC). */
function depositMintDecimals(mint: string): number | null {
  if (mint === JUPITER_PREDICTION_USDC_MINT) return 6;
  return null;
}

/** dollar string, coercing `microUsdToDollarString`'s `null` (unparseable) to `undefined` for optional-string fields. Exported for `predict-execute-close-all.ts`. */
export function usdEst(raw: string | number | null | undefined): string | undefined {
  return microUsdToDollarString(raw) ?? undefined;
}

export interface SharedEventInput {
  readonly eventRole: AgentActivityEventRole;
  readonly walletAddress: string;
  readonly sessionId: string;
}

/** Every prediction row shares the same chain identity (single-chain, non-bridge — R1). Exported for `predict-execute-close-all.ts`. */
export function sharedFields(input: SharedEventInput) {
  return {
    eventRole: input.eventRole,
    kind: "prediction" as const,
    protocol: PROTOCOL,
    chainId: SOLANA_SYNTHETIC_CHAIN_ID,
    chainSlug: "solana",
    chainFamily: "solana" as const,
    walletAddress: input.walletAddress,
    sessionId: input.sessionId,
  };
}

/**
 * A pre-broadcast failure (invalid params, provider rejects the order/close/
 * claim build before signing) — atomically creates the intent + a hashless
 * `definitively_failed` row (R1's stage/error mapping table: pre-broadcast
 * provider rejection -> `route_not_found`, detail in `failure_reason`).
 * Exported for `predict-execute-close-all.ts`.
 */
export async function failPreBroadcast(
  toolId: string,
  p: Record<string, unknown>,
  input: SharedEventInput,
  err: unknown,
): Promise<ToolResult> {
  const reason = predictFailureMessage(err);
  const { executionId } = await createAgentActivityPreBroadcastFailure({
    toolId, namespace: NAMESPACE, intentParams: p,
    event: { ...sharedFields(input), eventIndex: 0, failureCode: "route_not_found", failureReason: reason },
  });
  return { success: false, output: `${toolId} failed: ${reason}.`, data: { _executionId: executionId } };
}

/** Best-effort post-intent finalize — a throw here is logged, never propagated (mirrors kyberswap/khalani/lend). */
async function finalizeAsFailed(toolId: string, rowId: number, reason: string): Promise<void> {
  try {
    await failActivityEvent(rowId, { failureCode: "unknown", failureReason: reason });
  } catch (err) {
    logger.warn(`${toolId}.finalize_failed_row_failed`, { rowId, error: predictFailureMessage(err) });
  }
}

interface StagedOutcome {
  /**
   * `pending` — the bytes may be in flight (accepted, signature mismatch, or
   * an ambiguous transport failure); the sweep resolves the row.
   * `rejected` — the landing service ANSWERED and refused; nothing went
   * on-chain, so the caller must NOT claim a pending broadcast. The row still
   * stays pending: the sweep remains the sole terminality authority.
   * `failed` — a POST-INTENT local failure (sign refusal / staging CAS miss);
   * nothing was ever submitted.
   */
  readonly status: "pending" | "rejected" | "failed";
  readonly signature?: string;
  readonly explorerUrl?: string;
  readonly reason?: string;
}

/**
 * Sign (REPLACE mode) -> persist (CAS) -> submit for ONE already-created
 * pending row. Never throws — every failure mode finalizes/logs internally
 * and returns a `StagedOutcome` the caller reports truthfully.
 *
 * `managed` routes BOTH steps, and they must agree: present -> the provider
 * co-signed this transaction, so sign under the `coSigned` contract with
 * VERIFY-mode evidence and submit through the managed execute endpoint;
 * absent -> today's unchanged lane (sole-signer contract, REPLACE-mode fresh
 * blockhash, raw RPC). A prediction transaction carries NO Jupiter tip, so it
 * can never reach `/tx/v1/submit` — the endpoint that silently dropped tipless
 * transactions before 2026-07-24, and which the type system makes unreachable
 * from here (landing-lane design D1/D2).
 * Exported for `predict-execute-close-all.ts`.
 */
export async function stageAndSubmit(
  toolId: string,
  rowId: number,
  base64Tx: string,
  signer: Keypair,
  managed: JupiterPredictionManagedExecution | null = null,
): Promise<StagedOutcome> {
  let prepared: PreparedSolanaTx;
  try {
    prepared = managed
      ? await prepareVersionedTx(base64Tx, signer, {
          knownBlockhash: managed.blockhash,
          signerContract: { kind: "coSigned", requiredSigners: managed.requiredSigners },
        })
      : await prepareVersionedTx(base64Tx, signer);
  } catch (err) {
    const reason = predictFailureMessage(err);
    await finalizeAsFailed(toolId, rowId, reason);
    return { status: "failed", reason };
  }

  const staged = await markActivitySolanaBroadcast(rowId, {
    txHash: prepared.signature,
    fromAddress: signer.publicKey.toBase58(),
    recentBlockhash: prepared.recentBlockhash,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
  });
  if (!staged.applied) {
    // CAS miss — the row is no longer in the state this write expects (a
    // race with the sweep, most likely). Refuse to submit untracked; do NOT
    // also call failActivityEvent (mirrors handlers/lend.ts — a second write
    // against a row already resolved by someone else is more likely to be
    // wrong than helpful).
    logger.warn(`${toolId}.staging_cas_miss`, { rowId });
    return { status: "failed", reason: "an internal error left this attempt unrecorded before broadcast" };
  }

  const broadcast = await broadcastStagedSolanaTx({
    toolId,
    rowId,
    prepared,
    lane: managed
      ? { kind: "jupiter_managed_execute", context: managed.context }
      : { kind: "rpc" },
  });
  if (broadcast.kind === "rejected_before_broadcast") {
    return { status: "rejected", reason: broadcast.reason };
  }

  return { status: "pending", signature: prepared.signature, explorerUrl: solanaExplorerUrl(prepared.signature) };
}

/** Resolve session + wallet + signer, or a `ToolResult` failure to return immediately. Exported for `predict-execute-close-all.ts`. */
export function resolveSessionAndWallet(
  toolId: string,
  p: Record<string, unknown>,
  ctx: ProtocolExecutionContext,
): { sessionId: string; addr: string; secret: Uint8Array } | ToolResult {
  const sessionId = ctx.sessionId;
  if (!sessionId) return fail(`${toolId} requires an active session.`);
  try {
    return { sessionId, addr: walletAddress(p, ctx), secret: walletSecret(ctx) };
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
}

/** Exported for `predict-execute-close-all.ts`. */
export function isToolResult(value: unknown): value is ToolResult {
  return typeof value === "object" && value !== null && "success" in value;
}

type EventPatch = Partial<
  Pick<CreatePendingActivityEventInput, "tokenIn" | "tokenOut" | "usdInEst" | "usdOutEst" | "usdFeeEst" | "usdSource">
>;

/** Phase-A result for a single-row mutation — the unsigned tx + the agent_activity/output fields it feeds. */
interface PreparedMutation {
  readonly transaction: string;
  /** Non-null whenever the build carried an `execution` object — see `resolveManagedExecution`. */
  readonly managed: JupiterPredictionManagedExecution | null;
  readonly eventPatch: EventPatch;
  readonly successNote: string;
  readonly successFields: Record<string, unknown>;
}

/** Shared runner for the three SINGLE-ROW mutations (buy/sell/claim). Phase A (caller's `buildIntent`) requests the unsigned tx — a throw there is pre-broadcast (nothing recorded). Phase B creates the intent row, then signs/stages/submits — a throw or CAS miss there is POST-intent (`stageAndSubmit` finalizes the existing row). */
async function runStagedPredictionMutation(
  toolId: string,
  eventRole: AgentActivityEventRole,
  p: Record<string, unknown>,
  addr: string,
  secret: Uint8Array,
  sessionId: string,
  buildIntent: () => Promise<PreparedMutation>,
): Promise<ToolResult> {
  const shared: SharedEventInput = { eventRole, walletAddress: addr, sessionId };

  let prepared: PreparedMutation;
  try {
    prepared = await buildIntent();
  } catch (err) {
    return failPreBroadcast(toolId, p, shared, err);
  }

  const { executionId, events } = await createAgentActivityIntent({
    toolId, namespace: NAMESPACE, intentParams: p,
    events: [{ ...sharedFields(shared), eventIndex: 0, ...prepared.eventPatch }],
  });
  const rowId = events[0]!.id;

  const signer = Keypair.fromSecretKey(secret);
  const staged = await stageAndSubmit(toolId, rowId, prepared.transaction, signer, prepared.managed);
  if (staged.status === "failed") {
    return {
      success: false,
      output: `${toolId} failed after being recorded: ${staged.reason}. Check execution ${executionId}; do not retry blindly.`,
      data: { _executionId: executionId, status: "failed" },
    };
  }
  if (staged.status === "rejected") {
    // The landing service ANSWERED and refused: nothing went on-chain, so
    // this must never be dressed up as a pending broadcast. The row stays
    // pending — the sweep owns terminality (design D4).
    return {
      success: false,
      output: `${toolId} was rejected before broadcast — nothing went on-chain: ${staged.reason}. Recorded (execution ${executionId}); do not retry until the cause is fixed.`,
      data: { _executionId: executionId, status: "rejected_before_broadcast", reason: staged.reason },
    };
  }
  return {
    success: false,
    output: `${prepared.successNote} broadcast — signature ${staged.signature}. Confirmation pending, tracked automatically. Do not retry.`,
    data: {
      _executionId: executionId, status: "pending",
      signature: staged.signature, explorerUrl: staged.explorerUrl,
      ...prepared.successFields,
    },
  };
}

// ── solana.predict.buy ────────────────────────────────────────────

export const executePredictBuy: ProtocolHandler = async (p, ctx) => {
  const toolId = "solana.predict.buy";
  const marketId = str(p, "marketId"), side = str(p, "side");
  const amount = num(p, "amountUsdc");
  if (!marketId || !side || amount == null) return fail("Missing required: marketId, side, amountUsdc");
  const normalizedSide = side.toLowerCase();
  if (normalizedSide !== "yes" && normalizedSide !== "no") return fail('side must be "yes" or "no"');
  const isYes = normalizedSide === "yes";
  const depositMint = JUPITER_PREDICTION_USDC_MINT;
  const depositDecimals = depositMintDecimals(depositMint);
  if (depositDecimals === null) return fail(`Unsupported prediction deposit mint: ${depositMint}`);
  const depositAmount = Math.round(amount * 10 ** depositDecimals);

  const resolved = resolveSessionAndWallet(toolId, p, ctx);
  if (isToolResult(resolved)) return resolved;
  const { sessionId, addr, secret } = resolved;

  return runStagedPredictionMutation(toolId, "predict_buy", p, addr, secret, sessionId, async () => {
    const raw = await requestJupiterPredictionCreateOrderTransaction({
      ownerPubkey: addr, marketId, isYes, isBuy: true, depositAmount, depositMint,
    });
    const transaction = requireTransaction(raw.transaction, "Create order");
    const managed = resolveManagedExecution(raw, "Create order");
    const order = raw.order;
    return {
      transaction,
      managed,
      eventPatch: {
        tokenIn: {
          tokenAddress: depositMint, tokenSymbol: "USDC", tokenDecimals: depositDecimals,
          amountHuman: amount.toFixed(depositDecimals), amountRaw: String(depositAmount),
        },
        usdInEst: usdEst(order.orderCostUsd),
        usdFeeEst: usdEst(order.estimatedTotalFeeUsd),
        usdSource: "jupiter_prediction_order_preview",
      },
      successNote: `Buy order for market ${marketId} (${normalizedSide.toUpperCase()})`,
      successFields: {
        marketId, side: normalizedSide,
        estimatedSizeUsd: usdEst(order.newSizeUsd) ?? null,
        estimatedFeeUsd: usdEst(order.estimatedTotalFeeUsd) ?? null,
      },
    };
  });
};

// ── solana.predict.sell (close one position) ───────────────────────

export const executePredictSell: ProtocolHandler = async (p, ctx) => {
  const toolId = "solana.predict.sell";
  const pk = str(p, "positionPubkey");
  if (!pk) return fail("Missing required: positionPubkey");

  const resolved = resolveSessionAndWallet(toolId, p, ctx);
  if (isToolResult(resolved)) return resolved;
  const { sessionId, addr, secret } = resolved;

  return runStagedPredictionMutation(toolId, "predict_sell", p, addr, secret, sessionId, async () => {
    const raw = await requestJupiterPredictionClosePositionTransaction(pk, { ownerPubkey: addr });
    const transaction = requireTransaction(raw.transaction, "Close position");
    const managed = resolveManagedExecution(raw, "Close position");
    const order = raw.order;
    return {
      transaction,
      managed,
      eventPatch: {
        // Payout leg estimate: prediction settles in USDC, so the projected
        // micro-USD payout is numerically the raw USDC unit amount (both
        // 1e6-scaled) — an ESTIMATE from the provider's order preview, not
        // decoder-proven executed truth (K3's sweep owns that correction).
        tokenOut: {
          tokenAddress: JUPITER_PREDICTION_USDC_MINT, tokenSymbol: "USDC", tokenDecimals: 6,
          amountHuman: usdEst(order.newPayoutUsd), amountRaw: order.newPayoutUsd,
        },
        usdOutEst: usdEst(order.newPayoutUsd),
        usdFeeEst: usdEst(order.estimatedTotalFeeUsd),
        usdSource: "jupiter_prediction_order_preview",
      },
      successNote: `Close of position ${pk}`,
      successFields: { positionPubkey: pk, estimatedPayoutUsd: usdEst(order.newPayoutUsd) ?? null },
    };
  });
};

// ── solana.predict.claim ────────────────────────────────────────────

export const executePredictClaim: ProtocolHandler = async (p, ctx) => {
  const toolId = "solana.predict.claim";
  const pk = str(p, "positionPubkey");
  if (!pk) return fail("Missing required: positionPubkey");

  const resolved = resolveSessionAndWallet(toolId, p, ctx);
  if (isToolResult(resolved)) return resolved;
  const { sessionId, addr, secret } = resolved;

  return runStagedPredictionMutation(toolId, "predict_claim", p, addr, secret, sessionId, async () => {
    const raw = await requestJupiterPredictionClaimPositionTransaction(pk, { ownerPubkey: addr });
    const transaction = requireTransaction(raw.transaction, "Claim position");
    const position = raw.position;
    return {
      transaction,
      // A claim build was NOT observable live (the gate wallet holds no
      // position), so "claims are always keeper-executed" is UNVERIFIED — and
      // the identically-shaped assertion about polymarket orders was already
      // proven false. Read the response instead of assuming: `null` here only
      // when the provider genuinely returned no `execution` object.
      managed: resolveManagedExecution(raw, "Claim position"),
      eventPatch: {
        tokenOut: {
          tokenAddress: JUPITER_PREDICTION_USDC_MINT, tokenSymbol: "USDC", tokenDecimals: 6,
          amountHuman: usdEst(position.payoutAmountUsd), amountRaw: position.payoutAmountUsd,
        },
        usdOutEst: usdEst(position.payoutAmountUsd),
        usdSource: "jupiter_prediction_order_preview",
      },
      successNote: `Claim for position ${pk}`,
      successFields: { positionPubkey: pk, estimatedPayoutUsd: usdEst(position.payoutAmountUsd) ?? null },
    };
  });
};

// `solana.predict.closeAll` lives in the sibling `predict-execute-close-all.ts`
// (500-line cap) — it imports the exported primitives above.
