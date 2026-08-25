/**
 * Indexify trading handlers — the fee preview and the two funds-moving paths.
 *
 * CUSTODIAL COMMIT POINT: `client.swap(...)` and the resolve calls execute
 * server-side the moment the venue accepts them. There is no sign step, so the
 * POST itself is the commit — the Operator-Stop signal is therefore passed to
 * every PREFLIGHT read but deliberately NOT to the mutating call (aborting a
 * mutation mid-flight leaves an unknowable half-state on a venue with no
 * cancel), and the reply after a submit is TRUTHFUL-PENDING: the order id plus
 * the instruction to confirm settlement via indexify__orders_list.
 *
 * Preflights are cheap and all fail CLOSED with the real cause:
 *  - the stack must exist and not be closed/archived,
 *  - a buy must clear the venue minimum and the account's spendable USDC,
 *  - a sell must have a position to sell,
 *  - a resolve must target a PARTIAL order offering that resolution.
 */

import { getIndexifyClient } from "@tools/indexify/client.js";
import type { IndexifyPartialResolution, IndexifyTradeDirection } from "@tools/indexify/constants.js";
import {
  INDEXIFY_PARTIAL_RESOLUTIONS,
  INDEXIFY_TRADE_CUES,
  INDEXIFY_TRADE_DIRECTIONS,
} from "@tools/indexify/constants.js";
import { ok, fail, num, str } from "../../handler-helpers.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { indexifyFailureDetail } from "./failure.js";

// ── indexify.fees ──────────────────────────────────────────────────

export async function indexifyFeesHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const amountRaw = str(p, "amountIn").trim();
  const stackId = num(p, "stackId");
  if ((amountRaw !== "") !== (stackId !== undefined)) {
    return fail("Provide amountIn and stackId TOGETHER for a per-trade estimate, or neither for just the minimum and bounds.");
  }
  let amount: number | undefined;
  if (amountRaw !== "") {
    amount = Number.parseFloat(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      return fail(`"amountIn" must be a positive HUMAN USDC amount as a string, received "${amountRaw}".`);
    }
  }
  try {
    const client = getIndexifyClient();
    const [minBuy, bounds, calculation] = await Promise.all([
      client.minBuy({ signal: context.abortSignal }),
      client.creatorFeeBounds({ signal: context.abortSignal }),
      amount !== undefined && stackId !== undefined
        ? client.feeCalculate(amount, stackId, { signal: context.abortSignal })
        : Promise.resolve(null),
    ]);
    return ok({
      minBuyUsdc: minBuy,
      creatorFeeBoundsPercent: bounds,
      platformFeeNote: "Indexify charges a 1% platform fee plus the stack's creator fee on every buy and sell; Solana gas is sponsored.",
      ...(calculation !== null
        ? {
          estimate: {
            amountUsdc: amount,
            stackId,
            feeDisplay: calculation.total_fee_display ?? calculation.fee_display ?? null,
            estimatedBlockchainFeesSaved: calculation.estimated_blockchain_fees_saved ?? null,
          },
        }
        : {}),
    });
  } catch (err) {
    return fail(`Indexify fee preview unavailable (${indexifyFailureDetail("indexify__fees_get", err)})`);
  }
}

// ── indexify.trade_execute ─────────────────────────────────────────

export async function indexifyTradeExecuteHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const stackId = num(p, "stackId");
  if (stackId === undefined || !Number.isInteger(stackId) || stackId <= 0) {
    return fail("Missing or invalid required: stackId (a positive integer stack id).");
  }
  const directionRaw = str(p, "direction").trim().toLowerCase();
  const direction = INDEXIFY_TRADE_DIRECTIONS.find((candidate) => candidate === directionRaw) as
    | IndexifyTradeDirection
    | undefined;
  if (direction === undefined) {
    return fail(`"direction" must be one of: ${INDEXIFY_TRADE_DIRECTIONS.join(", ")}.`);
  }

  // The boundary enforced exactly one of amountIn|sellPercent; the STATED
  // direction must agree with the amount that arrived (rules/90: a money-path
  // parameter disagreement is refused by name, never resolved silently).
  const amountRaw = str(p, "amountIn").trim();
  const sellPercent = num(p, "sellPercent");
  if (direction === "buy" && amountRaw === "") {
    return fail('direction "buy" sizes with amountIn (HUMAN USDC as a string), but sellPercent arrived. Confirm which trade the user wants.');
  }
  if (direction === "sell" && sellPercent === undefined) {
    return fail('direction "sell" sizes with sellPercent (1-100, a PERCENT of holdings), but amountIn arrived. Confirm which trade the user wants.');
  }

  const client = getIndexifyClient();

  let amount: number;
  if (direction === "buy") {
    amount = Number.parseFloat(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      return fail(`"amountIn" must be a positive HUMAN USDC amount as a string, received "${amountRaw}".`);
    }
  } else {
    if (typeof sellPercent !== "number" || !Number.isFinite(sellPercent) || sellPercent < 1 || sellPercent > 100) {
      return fail(`"sellPercent" must be a percent of holdings between 1 and 100, received ${String(sellPercent)}.`);
    }
    amount = sellPercent;
  }

  // ── Preflights (abortable reads; every refusal names its cause) ──
  let stackName: string;
  try {
    const stack = await client.fetchStack({ stackId }, { signal: context.abortSignal });
    if (stack === null) {
      return fail(`Indexify knows no stack with id ${stackId}. Resolve it via indexify__stacks_search before trading.`);
    }
    if (stack.is_closed === true || stack.archived === true) {
      return fail(`Stack ${stackId} ("${stack.stack_name}") is ${stack.is_closed ? "closed" : "archived"} and cannot be traded.`);
    }
    stackName = stack.stack_name;

    if (direction === "buy") {
      const [minBuy, portfolio] = await Promise.all([
        client.minBuy({ signal: context.abortSignal }).catch(() => null),
        client.portfolio({ signal: context.abortSignal }),
      ]);
      if (minBuy !== null && amount < minBuy) {
        return fail(`Buy of $${amount} is below Indexify's minimum buy of $${minBuy}. Raise amountIn to at least "${minBuy}".`);
      }
      if (portfolio.usdcBalance < amount) {
        return fail(
          `Insufficient Indexify balance: the account holds $${portfolio.usdcBalance} spendable USDC`
          + `${portfolio.usdcReserved > 0 ? ` (plus $${portfolio.usdcReserved} reserved by in-flight orders)` : ""}, `
          + `but the buy needs $${amount}. Deposit USDC on Solana to ${portfolio.walletAddress} or lower the amount.`,
        );
      }
    } else {
      const holdings = await client.stackHoldings(stackId, { signal: context.abortSignal });
      if (holdings.total_usdc <= 0) {
        return fail(`The account holds nothing in stack ${stackId} ("${stackName}") — there is no position to sell.`);
      }
    }
  } catch (err) {
    return fail(`Indexify trade preflight failed — nothing was traded (${indexifyFailureDetail("indexify__stack_trade_execute", err)})`);
  }

  // ── Commit (deliberately NOT abortable — see module doc) ─────────
  let orderId: string;
  try {
    const result = await client.swap({ stackId, amount, cue: INDEXIFY_TRADE_CUES[direction] });
    orderId = result.order_id;
  } catch (err) {
    // The venue answered — a 4xx here means it refused and nothing traded; a
    // transport failure is AMBIGUOUS and must be said so.
    const detail = indexifyFailureDetail("indexify__stack_trade_execute", err);
    const ambiguous = detail.includes("timed out") || detail.includes("Could not reach");
    return fail(
      ambiguous
        ? `Indexify trade result UNKNOWN — the request may or may not have executed (${detail}). `
          + "Check indexify__orders_list for a new order before retrying; a blind retry can double-trade."
        : `Indexify refused the trade — nothing was traded (${detail})`,
    );
  }

  // Best-effort immediate status read; its failure never hides the order id.
  let earlyStatus: string | null = null;
  try {
    const details = await client.orderDetails(orderId);
    earlyStatus = details.order.status;
  } catch {
    earlyStatus = null;
  }

  return ok({
    accepted: true,
    orderId,
    stackId,
    stackName,
    direction,
    ...(direction === "buy" ? { amountUsdcIn: amount } : { sellPercent: amount }),
    status: earlyStatus ?? "PENDING",
    settlement:
      "TRUTHFUL-PENDING: the venue executes this order server-side and it settles asynchronously. "
      + "Confirm the outcome with indexify__orders_list (it can land SUCCESS, FAILED, or PARTIAL — "
      + "resolve a PARTIAL with indexify__order_resolve). Do NOT retry this trade on silence.",
  });
}

// ── indexify.order_resolve ─────────────────────────────────────────

export async function indexifyOrderResolveHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const orderId = str(p, "orderId").trim();
  if (!orderId) return fail("Missing required: orderId (the PARTIAL order to resolve).");
  const actionRaw = str(p, "action").trim().toLowerCase();
  const action = INDEXIFY_PARTIAL_RESOLUTIONS.find((candidate) => candidate === actionRaw) as
    | IndexifyPartialResolution
    | undefined;
  if (action === undefined) {
    return fail(`"action" must be one of: ${INDEXIFY_PARTIAL_RESOLUTIONS.join(", ")}.`);
  }

  const client = getIndexifyClient();

  // Preflight: the order must be PARTIAL and must currently OFFER the chosen
  // resolution — the venue's own `available_actions` is the authority.
  try {
    const breakdown = await client.partialDetails(orderId, { signal: context.abortSignal });
    const offered = breakdown.available_actions?.[action];
    if (offered !== true) {
      const available = Object.entries(breakdown.available_actions ?? {})
        .filter(([, allowed]) => allowed === true)
        .map(([name]) => name);
      return fail(
        `Order ${orderId} does not currently offer "${action}"`
        + `${available.length > 0 ? ` — the venue offers: ${available.join(", ")}` : " — no resolutions are offered (it may already be resolved)"}. `
        + "Read it again with indexify__orders_list.",
      );
    }
  } catch (err) {
    return fail(`Indexify resolve preflight failed — nothing was changed (${indexifyFailureDetail("indexify__order_resolve", err)})`);
  }

  // Commit — deliberately NOT abortable, same contract as the trade.
  try {
    if (action === "retry") {
      const result = await client.retryOrder(orderId);
      return ok({
        accepted: true,
        action,
        parentOrderId: orderId,
        newOrderId: result.order_id,
        retryAttempt: result.retry_attempt ?? null,
        settlement:
          "TRUTHFUL-PENDING: the retry is a NEW order settling asynchronously — confirm it with "
          + "indexify__orders_list using the newOrderId. Do NOT retry on silence.",
      });
    }
    if (action === "sell_all") {
      await client.sellAllPartial(orderId);
      return ok({
        accepted: true,
        action,
        orderId,
        settlement:
          "TRUTHFUL-PENDING: the venue is selling everything this order bought back to USDC. "
          + "Confirm with indexify__orders_list and indexify__portfolio_get.",
      });
    }
    await client.acknowledgeOrder(orderId);
    return ok({
      accepted: true,
      action,
      orderId,
      note: "The partial fill is accepted as final. No funds moved; the bought tokens stay in the position.",
    });
  } catch (err) {
    const detail = indexifyFailureDetail("indexify__order_resolve", err);
    const ambiguous = detail.includes("timed out") || detail.includes("Could not reach");
    return fail(
      ambiguous
        ? `Indexify resolve result UNKNOWN — it may or may not have applied (${detail}). `
          + "Re-read the order with indexify__orders_list before retrying."
        : `Indexify refused the resolution — nothing was changed (${detail})`,
    );
  }
}
