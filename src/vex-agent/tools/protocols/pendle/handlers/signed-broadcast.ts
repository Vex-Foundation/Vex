/**
 * The ONE place a Pendle Router transaction is signed, broadcast, and RECORDED.
 *
 * ── Why the gas bound is ours (G-40 / P0-5, D2) ─────────────────────────────
 *
 * All nine Pendle `sendTransaction` sites passed no `gas`, so viem filled
 * `request.gas` with the node's BARE `eth_estimateGas` result — 0% headroom —
 * on every trade. Pendle reached `gasLimitWithHeadroom` only through its ERC-20
 * approval helper (`@tools/pendle/erc20.ts`); the trade the approval was FOR
 * did not.
 *
 * That is the exact shape of the 2026-07-24 Base incident recorded in
 * `@tools/evm-chains/gas-limit-headroom.ts`: four transactions mined-REVERTED
 * having consumed ~97.3% of a bare-estimate limit, and re-running the same
 * calldata's estimate across twelve consecutive blocks returned a 2.07x spread.
 * Pendle routes carry ~2.6 KB of aggregator `extCalldata` — precisely the shape
 * with that spread — and the Convert response carries NO gas figure of its own
 * (live-verified 2026-07-27: the tx object is only `{data, to, from, value}`),
 * so the bound must be ours. `gasLimitForProviderHintedCall` is therefore NOT
 * the right helper here; there is no provider hint to reconcile.
 *
 * ── Why the ACTIVITY EVIDENCE lives here too (card B1) ──────────────────────
 *
 * Pendle used to sign, broadcast, and then echo the QUOTE back as the result.
 * Nothing durable was written, so `broadcast-unconfirmed.ts` had to tell the
 * agent — truthfully, at the time — that "Vex has NOT recorded this
 * transaction". Every Pendle mutation was therefore invisible to the repair
 * sweep, and a `success: true` result carried a quoted amount under a name that
 * read as a fill.
 *
 * Spreading the fix across the nine call sites would have produced nine
 * almost-identical staged-broadcast blocks, and `gas-limit-headroom.ts` already
 * records why that shape rots: "a copy left behind is under-protected with
 * nothing failing to say so". So the whole §11.1 write protocol runs HERE, once,
 * for every Pendle Router call:
 *
 *   1. `createAgentActivityIntent` — BEFORE anything is signed.
 *   2. `markActivityBroadcast` — the tx hash staged BEFORE the raw submit. A
 *      CAS MISS REFUSES TO BROADCAST (an untracked transaction with real funds
 *      behind it is strictly worse than no transaction).
 *   3. `markBroadcastAccepted` — once the node has accepted the payload.
 *   4. `confirmActivityEvent` / `failActivityEvent` — from a DEFINITIVE receipt
 *      ONLY. Ambiguity NEVER terminalizes; the row stays `pending` for the
 *      repair sweep, forever if need be.
 *
 * Executed amounts come from `sync/pendle-settlement-decoder.ts` — net wallet
 * deltas over the receipt's own logs — never from the route that was quoted.
 * A decode that cannot prove a leg declines the whole confirmation and the row
 * stays `pending`: this module never converts a quote into a result.
 *
 * The estimate is still taken AFTER the caller has granted its allowances, so
 * it prices the call as it will actually run, and a call that would revert
 * fails before a signature exists.
 */

import { formatUnits, getAddress, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from "viem";

import { signStageBroadcast } from "@tools/kyberswap/evm/staged-broadcast.js";
import {
  createAgentActivityIntent,
  createAgentActivityPreBroadcastFailure,
  confirmActivityEvent,
  failActivityEvent,
  markActivityBroadcast,
  markBroadcastAccepted,
  type AgentActivityEventRole,
  type AgentActivityFailureCode,
  type AgentActivityLegInput,
} from "@vex-agent/db/repos/agent-activity.js";
import { decodePendleSettlement } from "@vex-agent/sync/pendle-settlement-decoder.js";
import { pinConfirmedPendleAcquisition } from "@vex-agent/sync/pendle-acquisition-pin.js";
import logger from "@utils/logger.js";

/** The Pendle protocol string stored on every row this module writes. */
export const PENDLE_ACTIVITY_PROTOCOL = "pendle";

/**
 * The six `yield_*` roles (migration 053). Narrowed from the full role union so
 * a Pendle caller cannot accidentally write a `swap`/`lend`/`bridge` row through
 * this path — the `agent_activity_kind_role_binding` CHECK would reject it, but
 * failing at the type boundary beats failing at the database.
 */
export type PendleActivityRole = Extract<
  AgentActivityEventRole,
  "yield_pt" | "yield_yt" | "yield_py" | "yield_lp" | "yield_sy" | "yield_claim"
>;

export interface PendleRouterTx {
  /** The pinned Router (already bound by the fund-safety extractor). */
  readonly to: Address;
  /** The validated calldata — floor-bound before it reaches here. */
  readonly data: Hex;
  /** Native value: non-zero ONLY for a native-input trade. */
  readonly value: bigint;
}

/**
 * Everything the durable row needs, gathered by the handler BEFORE it signs.
 *
 * `tokenIn2`/`tokenOut2` are the Option-C second legs (migration 053) and are
 * valid ONLY on `yield_py`/`yield_lp` — a `py.mint` splits 1→PT+YT and so
 * carries `tokenOut2`; a pre-expiry `py.redeem` burns PT+YT→1 and so carries
 * `tokenIn2`. Populating both, or neither, on a `yield_py` is a shape no Pendle
 * action produces and the DB refuses it.
 *
 * Every amount here is the INTENT (what was asked for / quoted). It is never
 * the result: the executed amounts are decoded from the receipt.
 */
export interface PendleActivityPlan {
  readonly toolId: string;
  readonly eventRole: PendleActivityRole;
  readonly chainId: number;
  readonly chainSlug: string;
  readonly walletAddress: string;
  readonly sessionId: string;
  /** Raw handler params — sanitized inside `createExecutionIntent`, not here. */
  readonly intentParams: Record<string, unknown>;
  readonly tokenIn?: AgentActivityLegInput;
  readonly tokenOut?: AgentActivityLegInput;
  readonly tokenIn2?: AgentActivityLegInput;
  readonly tokenOut2?: AgentActivityLegInput;
  readonly usdInEst?: string;
  readonly usdOutEst?: string;
  /** Venue discriminants the receipt alone cannot supply (e.g. `deliveredPath`, `syAddress`). */
  readonly routeProvenance?: Record<string, unknown>;
}

/** Executed amounts PROVEN from the receipt — raw plus its exact-decimal rendering. */
export interface PendleExecutedAmounts {
  readonly amountInRaw?: string;
  readonly amountInHuman?: string;
  readonly amountOutRaw?: string;
  readonly amountOutHuman?: string;
  readonly amountIn2Raw?: string;
  readonly amountIn2Human?: string;
  readonly amountOut2Raw?: string;
  readonly amountOut2Human?: string;
}

/**
 * `unproven` is the honest third outcome, and it is NOT a failure: the row is
 * `pending`, the repair sweep owns it, and the agent must not retry. It covers
 * three genuinely different situations, distinguished by `reason` so the caller
 * can say which one happened rather than picking one wording for all three:
 *
 *   - `ambiguous`  — we cannot prove the transaction landed at all.
 *   - `undecodable` — it MINED SUCCESSFULLY but the receipt did not prove the
 *     legs, so confirming would mean inventing amounts.
 *   - `no_credit`  — a CLAIM mined successfully and credited nothing decodable.
 */
export type PendleBroadcastResult =
  | {
      readonly kind: "confirmed";
      readonly txHash: Hex;
      readonly executionId: number;
      readonly executed: PendleExecutedAmounts;
    }
  | { readonly kind: "reverted"; readonly txHash: Hex; readonly executionId: number; readonly message: string }
  | {
      readonly kind: "unproven";
      readonly reason: "ambiguous" | "undecodable" | "no_credit";
      readonly txHash: Hex;
      readonly executionId: number;
      readonly message: string;
    };

/**
 * The EXACT sentence a caller must surface when the broadcast's fate is
 * unknown. One constant, because the wording is the contract: it must refuse a
 * retry (the transaction may already have moved real funds) AND promise
 * automatic resolution — a promise Pendle can now keep, since the row exists
 * and the repair sweep has a registered decoder for it.
 */
export const PENDLE_AMBIGUOUS_BROADCAST_MESSAGE =
  "Cannot prove whether this broadcast landed — do not retry; this attempt is recorded as pending and resolves automatically.";

/** A mined-but-unprovable settlement. Distinct from ambiguity: the transaction DID land. */
function undecodableMessage(txHash: Hex): string {
  return (
    `The transaction mined successfully (tx ${txHash}) but its receipt did not prove the amounts that moved, `
    + "so no fill is reported rather than a guessed one. Do not retry; this attempt is recorded as pending and resolves automatically."
  );
}

/** A claim that mined and swept nothing. Honest, and specifically NOT a success. */
function noCreditMessage(txHash: Hex): string {
  return (
    `The claim transaction mined successfully (tx ${txHash}) but credited no decodable token to the wallet, `
    + "so nothing is recorded as claimed. Do not retry; this attempt is recorded as pending and resolves automatically."
  );
}

/**
 * Record a refusal that happened BEFORE anything could be signed — a matured
 * market, no route, no holding, an out-of-policy slippage, a price floor the
 * route could not meet. A hashless `definitively_failed` row in one step: there
 * was never a payload to broadcast, so there is nothing to stage or sweep.
 *
 * Deliberately fail-soft. The refusal itself is the product behavior and it has
 * already been decided by the caller; a bookkeeping error must not convert a
 * clean, funds-untouched refusal into an error the agent might read as
 * something having happened on-chain.
 */
export async function recordPendleRefusal(
  plan: Omit<PendleActivityPlan, "usdInEst" | "usdOutEst" | "routeProvenance">,
  failureCode: AgentActivityFailureCode,
  failureReason: string,
): Promise<number | null> {
  try {
    const { executionId } = await createAgentActivityPreBroadcastFailure({
      toolId: plan.toolId,
      namespace: PENDLE_ACTIVITY_PROTOCOL,
      intentParams: plan.intentParams,
      event: {
        eventIndex: 0,
        eventRole: plan.eventRole,
        kind: "yield",
        protocol: PENDLE_ACTIVITY_PROTOCOL,
        chainId: plan.chainId,
        chainSlug: plan.chainSlug,
        walletAddress: plan.walletAddress,
        sessionId: plan.sessionId,
        ...(plan.tokenIn ? { tokenIn: plan.tokenIn } : {}),
        ...(plan.tokenOut ? { tokenOut: plan.tokenOut } : {}),
        // Option-C second legs whenever the refusal knows them — a `py.mint`
        // refused after its quote knows both minted instruments, and a failed
        // row that names fewer legs than the succeeded one would have is a
        // narrower truth for no reason. A refusal that fires before the second
        // instrument resolves simply omits it; migration 053's
        // `agent_activity_yield_py_has_one_second_leg` exempts exactly this
        // hashless `definitively_failed` shape.
        ...(plan.tokenIn2 ? { tokenIn2: plan.tokenIn2 } : {}),
        ...(plan.tokenOut2 ? { tokenOut2: plan.tokenOut2 } : {}),
        failureCode,
        failureReason,
      },
    });
    return executionId;
  } catch (err) {
    logger.warn("pendle.activity.pre_broadcast_record_failed", {
      toolId: plan.toolId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}

/**
 * Sign, stage, broadcast, await the receipt, and finalize the durable row for
 * ONE validated Pendle Router call.
 *
 * `publicClient` and `walletClient` come from the same `getPendleEvmClients`
 * pair the caller already holds, so the estimate is read from the same chain
 * the transaction is sent to.
 *
 * THROWS only for a pre-signature failure (a failing estimate, a refused stage)
 * — at which point nothing was broadcast and the caller's existing catch is
 * correct. Once a hash exists this function ALWAYS returns a result carrying it
 * (H-4): the hash is produced by `signStageBroadcast` and threaded through every
 * branch, so no post-broadcast throw can swallow it.
 */
export async function sendPendleRouterTx(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain, Account>,
  tx: PendleRouterTx,
  plan: PendleActivityPlan,
): Promise<PendleBroadcastResult> {
  // Step 1 — the durable intent exists BEFORE a signature does. A throw here is
  // pre-signature and propagates: refusing to trade beats trading untracked.
  const { executionId, events } = await createAgentActivityIntent({
    toolId: plan.toolId,
    namespace: PENDLE_ACTIVITY_PROTOCOL,
    intentParams: plan.intentParams,
    events: [
      {
        eventIndex: 0,
        eventRole: plan.eventRole,
        kind: "yield",
        protocol: PENDLE_ACTIVITY_PROTOCOL,
        chainId: plan.chainId,
        chainSlug: plan.chainSlug,
        walletAddress: plan.walletAddress,
        sessionId: plan.sessionId,
        ...(plan.tokenIn ? { tokenIn: plan.tokenIn } : {}),
        ...(plan.tokenOut ? { tokenOut: plan.tokenOut } : {}),
        ...(plan.tokenIn2 ? { tokenIn2: plan.tokenIn2 } : {}),
        ...(plan.tokenOut2 ? { tokenOut2: plan.tokenOut2 } : {}),
        ...(plan.usdInEst !== undefined ? { usdInEst: plan.usdInEst } : {}),
        ...(plan.usdOutEst !== undefined ? { usdOutEst: plan.usdOutEst } : {}),
        usdSource: "pendle",
        ...(plan.routeProvenance ? { routeProvenance: plan.routeProvenance } : {}),
      },
    ],
  });
  const eventRow = events[0]!;

  const outcome = await signStageBroadcast(
    publicClient,
    walletClient,
    { to: tx.to, data: tx.data, value: tx.value },
    {
      // Step 2 — reached AFTER signing and immediately BEFORE the raw submit.
      onHashStaged: async (handles) => {
        const staged = await markActivityBroadcast(eventRow.id, handles);
        if (!staged.applied) {
          // A CAS miss means this row is not in the state we believe it to be.
          // Throwing here aborts `signStageBroadcast` BEFORE
          // `sendRawTransaction` runs — nothing is broadcast. Broadcasting an
          // untracked transaction with real funds behind it would be the worse
          // outcome by a wide margin.
          throw new Error(
            `pendle: markActivityBroadcast CAS miss for event ${eventRow.id} — refusing to broadcast untracked`,
          );
        }
      },
      // Step 3 — bookkeeping only; `signStageBroadcast` swallows a throw here
      // because the transaction is already in flight by then.
      onAccepted: async () => {
        const accepted = await markBroadcastAccepted(eventRow.id);
        if (!accepted.applied) {
          logger.warn("pendle.activity.broadcast_accept_miss", { id: eventRow.id, toolId: plan.toolId });
        }
      },
    },
  );

  if (outcome.kind === "ambiguous") {
    // Ambiguity NEVER terminalizes (§11.1 / FIX-SPINE C1). No `failActivityEvent`,
    // no re-broadcast — the row keeps its staged hash and the sweep resolves it.
    logger.info("pendle.activity.ambiguous", { id: eventRow.id, toolId: plan.toolId, stage: outcome.stage });
    return {
      kind: "unproven",
      reason: "ambiguous",
      txHash: outcome.txHash,
      executionId,
      message: PENDLE_AMBIGUOUS_BROADCAST_MESSAGE,
    };
  }

  if (outcome.kind === "reverted") {
    await finalizeFailSoft(plan.toolId, () =>
      failActivityEvent(eventRow.id, {
        failureCode: "mined_revert",
        // No new failure_code for Pendle (migration 053): a mined revert is a
        // mined revert. The hash is not repeated — the row's own `tx_hash`
        // column carries it.
        failureReason: `${plan.toolId}: the Pendle Router call reverted on-chain.`,
      }),
    );
    return {
      kind: "reverted",
      txHash: outcome.txHash,
      executionId,
      message: `${plan.toolId}: the transaction (${outcome.txHash}) reverted on-chain. No funds moved beyond the gas spent.`,
    };
  }

  // Mined successfully. From here on the transaction HAS settled, so a
  // bookkeeping throw must never be reported as the trade failing.
  const decoded = decodeExecuted(plan, outcome.receipt);
  if (decoded === null) {
    logger.warn("pendle.activity.undecodable_receipt", { id: eventRow.id, toolId: plan.toolId, role: plan.eventRole });
    return {
      kind: "unproven",
      // A claim's specific shape — mined, credited nothing — gets its own
      // wording: "the receipt was unreadable" and "there was nothing to sweep"
      // are different facts and the agent acts differently on each.
      reason: plan.eventRole === "yield_claim" ? "no_credit" : "undecodable",
      txHash: outcome.txHash,
      executionId,
      message: plan.eventRole === "yield_claim"
        ? noCreditMessage(outcome.txHash)
        : undecodableMessage(outcome.txHash),
    };
  }

  await finalizeFailSoft(plan.toolId, () =>
    confirmActivityEvent(eventRow.id, {
      ...(decoded.amountInRaw !== undefined ? { executedAmountInRaw: decoded.amountInRaw } : {}),
      ...(decoded.amountInHuman !== undefined ? { executedAmountInHuman: decoded.amountInHuman } : {}),
      ...(decoded.amountOutRaw !== undefined ? { executedAmountOutRaw: decoded.amountOutRaw } : {}),
      ...(decoded.amountOutHuman !== undefined ? { executedAmountOutHuman: decoded.amountOutHuman } : {}),
      ...(decoded.amountIn2Raw !== undefined ? { executedAmountIn2Raw: decoded.amountIn2Raw } : {}),
      ...(decoded.amountIn2Human !== undefined ? { executedAmountIn2Human: decoded.amountIn2Human } : {}),
      ...(decoded.amountOut2Raw !== undefined ? { executedAmountOut2Raw: decoded.amountOut2Raw } : {}),
      ...(decoded.amountOut2Human !== undefined ? { executedAmountOut2Human: decoded.amountOut2Human } : {}),
    }),
  );

  // Auto-pin AFTER confirmation and fail-soft: an acquired Pendle instrument
  // that never joins the tracked set is invisible to every later balance scan.
  // Never fails the trade — the funds have already moved.
  try {
    await pinConfirmedPendleAcquisition(
      plan.walletAddress,
      plan.chainId,
      [plan.tokenOut, plan.tokenOut2]
        .filter((leg): leg is AgentActivityLegInput => leg?.tokenAddress !== undefined)
        .map((leg) => ({
          address: leg.tokenAddress!,
          symbol: leg.tokenSymbol ?? null,
          decimals: leg.tokenDecimals ?? null,
        })),
    );
  } catch (err) {
    logger.warn("pendle.activity.auto_pin_failed", {
      toolId: plan.toolId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }

  return { kind: "confirmed", txHash: outcome.txHash, executionId, executed: decoded };
}

/**
 * Turn the mined receipt into executed amounts via the shared Pendle decoder,
 * then render each proven raw amount at the decimals the SAME plan leg declared
 * — rules/90: "raw amounts must travel with the decimals needed to read them".
 * A leg whose decimals the plan never stated gets a raw amount and no human
 * rendering, which is honest; guessing 18 would be a thousandfold error.
 *
 * `null` (the decoder declined) propagates as "leave it pending".
 */
function decodeExecuted(
  plan: PendleActivityPlan,
  receipt: { readonly logs: readonly { address: string; topics: readonly string[]; data: string }[] },
): PendleExecutedAmounts | null {
  const decoded = decodePendleSettlement({
    receipt: { logs: receipt.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })) },
    protocolExecutionId: 0,
    chainId: plan.chainId,
    walletAddress: getAddress(plan.walletAddress),
    tokenInAddress: plan.tokenIn?.tokenAddress ?? null,
    tokenOutAddress: plan.tokenOut?.tokenAddress ?? null,
    eventRole: plan.eventRole,
    tokenIn2Address: plan.tokenIn2?.tokenAddress ?? null,
    tokenOut2Address: plan.tokenOut2?.tokenAddress ?? null,
    ...(plan.routeProvenance ? { routeProvenance: plan.routeProvenance } : {}),
  });
  if (!decoded) return null;

  const render = (raw: string | undefined, decimals: number | undefined): string | undefined => {
    if (raw === undefined || decimals === undefined) return undefined;
    try {
      return formatUnits(BigInt(raw), decimals);
    } catch {
      return undefined;
    }
  };
  const inHuman = render(decoded.executedAmountInRaw, plan.tokenIn?.tokenDecimals);
  const outHuman = render(decoded.executedAmountOutRaw, plan.tokenOut?.tokenDecimals);
  const in2Human = render(decoded.executedAmountIn2Raw, plan.tokenIn2?.tokenDecimals);
  const out2Human = render(decoded.executedAmountOut2Raw, plan.tokenOut2?.tokenDecimals);

  return {
    ...(decoded.executedAmountInRaw !== undefined ? { amountInRaw: decoded.executedAmountInRaw } : {}),
    ...(inHuman !== undefined ? { amountInHuman: inHuman } : {}),
    ...(decoded.executedAmountOutRaw !== undefined ? { amountOutRaw: decoded.executedAmountOutRaw } : {}),
    ...(outHuman !== undefined ? { amountOutHuman: outHuman } : {}),
    ...(decoded.executedAmountIn2Raw !== undefined ? { amountIn2Raw: decoded.executedAmountIn2Raw } : {}),
    ...(in2Human !== undefined ? { amountIn2Human: in2Human } : {}),
    ...(decoded.executedAmountOut2Raw !== undefined ? { amountOut2Raw: decoded.executedAmountOut2Raw } : {}),
    ...(out2Human !== undefined ? { amountOut2Human: out2Human } : {}),
  };
}

/**
 * Run a terminal CAS write without letting a DB failure escape. The receipt is
 * already definitive at every call site: the on-chain outcome is a FACT, and a
 * failure to write it down must never be reported to the agent as that outcome
 * having been different. The row stays `pending` and the repair sweep re-derives
 * the same finalization from the same hash.
 */
async function finalizeFailSoft(toolId: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (err) {
    logger.warn("pendle.activity.finalize_failed", {
      toolId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}
