/**
 * LIVE STEP 4 - place one resting GTT limit order far from the market on the
 * owner's Robinhood Chain Lighter account and then cancel it, both through the
 * real prepare -> approve -> resume -> reconcile chain.
 *
 * Gated by `VEX_LIGHTER_LIVE_CANCEL=1`. Run AFTER steps 1 and 2, and LAST,
 * because it is the only step that deliberately leaves an order resting on the
 * book between its two legs.
 *
 * The resting price is half the last trade, so the order cannot fill while the
 * cancel is prepared. If it somehow does, the cancel leg refuses rather than
 * cancelling a different order: the resting order is identified by its exact
 * provider order id, read back from Lighter's own authenticated open orders.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness.js")).electronMainStub());

import {
  approveAndResume,
  cardCriticalArgs,
  createLiveSession,
  ensureIntegrationEnabled,
  decideOrderSizing,
  ETH_PERP_MARKET_ID,
  EXPECTED_ACCOUNT_INDEX,
  flagEnabled,
  installLighterProductionSeams,
  isDryRun,
  LIVE_ENVIRONMENT,
  LIGHTER_LIFECYCLE_TERMINAL_STATES,
  LIVE_FLAGS,
  openEvidence,
  orderStatusReport,
  pollUntil,
  prepareAndEnqueueApproval,
  printInspectionSql,
  readApprovalRecord,
  readRawMarketDetail,
  requireLiveTarget,
  runReadTool,
  type EvidenceWriter,
  type LiveSession,
} from "./harness.js";

const describeLive = flagEnabled(LIVE_FLAGS.cancel) ? describe : describe.skip;

/** Half the last trade: far enough below the book that the order rests. */
const RESTING_PRICE_FRACTION = 0.5;

let disposeSeams: (() => void) | null = null;
let session: LiveSession | null = null;
let evidence: EvidenceWriter | null = null;
const approvalIds: string[] = [];

beforeAll(async () => {
  evidence = openEvidence("cancel");
  const target = await requireLiveTarget();
  if (isDryRun()) {
    const { runMigrations } = await import("@vex-agent/db/migrate.js");
    await runMigrations();
  }
  disposeSeams = await installLighterProductionSeams();
  session = await createLiveSession(target, "cancel");
  const integration = await ensureIntegrationEnabled(target);
  evidence.record("target", {
    environment: LIVE_ENVIRONMENT,
    accountIndex: target.accountIndex,
    walletAddress: target.walletAddress,
    sessionId: session.sessionId,
    dryRun: isDryRun(),
    workflowBefore: integration.before,
    workflowAfter: integration.after,
    workflowCreatedByThisRun: integration.created,
    marketId: ETH_PERP_MARKET_ID,
  });
});

afterAll(async () => {
  if (session !== null) printInspectionSql(session.sessionId, approvalIds);
  disposeSeams?.();
  const { closePool } = await import("@vex-agent/db/client.js");
  await closePool();
});

function requireSession(): LiveSession {
  if (session === null) throw new Error("The live session was not created.");
  return session;
}

function requireEvidence(): EvidenceWriter {
  if (evidence === null) throw new Error("The evidence writer was not opened.");
  return evidence;
}

function orderRows(json: unknown): Record<string, unknown>[] {
  const container = json as Record<string, unknown> | null;
  const rows = container?.["orders"];
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}

describeLive("a resting Lighter order placed and cancelled on the owner's account", () => {
  it("places one GTT limit order and cancels it through both approval cards", { timeout: 900_000 }, async () => {
    const live = requireSession();
    const record = requireEvidence();

    // CANCEL-ONLY MODE: an order a previous run left resting (a failed cancel
    // leg, an interrupted run) is cancelled without placing another. It is
    // identified by Lighter's own open-orders read, exactly once, never by
    // trusting the id alone.
    const existingOrderId = process.env["VEX_LIGHTER_LIVE_CANCEL_ORDER_ID"]?.trim() || null;
    let placementApprovalId: string | null = null;
    let placementIntentId: unknown = null;
    let providerOrderId: unknown;

    if (existingOrderId === null) {
      const detail = await readRawMarketDetail(ETH_PERP_MARKET_ID);
      const lastTradePrice = Number(detail["last_trade_price"]);
      const priceDecimals = Number(detail["supported_price_decimals"]);
      const price = (lastTradePrice * RESTING_PRICE_FRACTION).toFixed(priceDecimals);

      const accountRead = await runReadTool({
        sessionId: live.sessionId,
        publicName: "lighter__account_get",
        params: { environment: LIVE_ENVIRONMENT, accountIndex: EXPECTED_ACCOUNT_INDEX },
      });
      expect(accountRead.success, accountRead.output).toBe(true);
      const accounts = (accountRead.json as Record<string, unknown> | null)?.["accounts"];
      const account = Array.isArray(accounts) ? accounts[0] as Record<string, unknown> : null;
      if (account === null) throw new Error("Lighter returned no account row for the owner's account.");

      const sizing = decideOrderSizing({
        marketId: ETH_PERP_MARKET_ID,
        detail,
        initialMarginFractionBps: Number(detail["default_initial_margin_fraction"]),
        availableCollateralUsdg: Number(account["availableBalance"] ?? account["collateral"]),
        price: Number(price),
      });
      record.record("sizing", { price, sizing, rawOrderBookDetail: detail });

      // ── Leg 1: place the resting order ──
      const preview = await runReadTool({
        sessionId: live.sessionId,
        publicName: "lighter__order_preview",
        params: {
          environment: LIVE_ENVIRONMENT,
          accountIndex: EXPECTED_ACCOUNT_INDEX,
          marketId: ETH_PERP_MARKET_ID,
          side: "buy",
          baseAmountIn: sizing.baseAmount,
          price,
          orderType: "limit",
          timeInForce: "good-till-time",
          reduceOnly: false,
          orderExpiry: Date.now() + 60 * 60 * 1000,
        },
      });
      expect(preview.success, preview.output).toBe(true);
      const previewId = (preview.json as Record<string, unknown> | null)?.["previewId"];
      expect(typeof previewId).toBe("string");

      const placement = await prepareAndEnqueueApproval({
        sessionId: live.sessionId,
        publicName: "lighter__order_create_prepare",
        params: { environment: LIVE_ENVIRONMENT, previewId },
      });
      approvalIds.push(placement.approvalId);
      placementApprovalId = placement.approvalId;
      const placementCard = await readApprovalRecord(placement.approvalId);
      expect(placementCard.queueStatus).toBe("pending");
      expect(placementCard.decision).toBeNull();
      expect(placement.followUpToolId).toBe("lighter.order.create");
      placementIntentId = (JSON.parse(placement.prepareOutput) as Record<string, unknown>)["intentId"];
      record.record("placement-prepared", {
        approvalId: placement.approvalId,
        intentId: placementIntentId,
        previewId,
        approvalCard: placementCard,
      });

      if (isDryRun()) return;

      const placed = await approveAndResume(placement.approvalId);
      expect(placed.toolResult.success, placed.toolResult.output).toBe(true);
      record.record("placed", {
        approvalId: placement.approvalId,
        intentId: placementIntentId,
        executionStatus: placed.executionStatus,
        resumeToolOutput: placed.toolResult.output,
      });

      // ── Identify the resting order by Lighter's own open-orders read ──
      const resting = await pollUntil(
        { attempts: 20, intervalMs: 6_000, what: "the order resting on the book" },
        () => runReadTool({
          sessionId: live.sessionId,
          publicName: "lighter__open_orders_list",
          params: { environment: LIVE_ENVIRONMENT, marketId: ETH_PERP_MARKET_ID, limit: 25 },
        }),
        (attempt) => orderRows(attempt.json).some(
          (row) => row["price"] === price && row["initialBaseAmount"] === sizing.baseAmount,
        ),
      );
      expect(resting.settled, resting.attempts.at(-1)?.output ?? "no attempt").toBe(true);
      const matches = orderRows(resting.attempts.at(-1)?.json).filter(
        (row) => row["price"] === price && row["initialBaseAmount"] === sizing.baseAmount,
      );
      // Exactly one, or the cancel leg would be aimed at an order this run did not
      // place. Ambiguity is a hard stop, never a "pick the first" guess.
      expect(matches.length, JSON.stringify(matches)).toBe(1);
      providerOrderId = matches[0]?.["orderId"];
      record.record("resting", { providerOrderId, order: matches[0] });
    } else {
      const open = await runReadTool({
        sessionId: live.sessionId,
        publicName: "lighter__open_orders_list",
        params: { environment: LIVE_ENVIRONMENT, marketId: ETH_PERP_MARKET_ID, limit: 25 },
      });
      expect(open.success, open.output).toBe(true);
      const matches = orderRows(open.json).filter((row) => row["orderId"] === existingOrderId);
      expect(matches.length, `order ${existingOrderId} is not resting exactly once: ${JSON.stringify(matches)}`).toBe(1);
      providerOrderId = existingOrderId;
      record.record("resting", { providerOrderId, order: matches[0], reusedFromEnvironment: true });
    }
    expect(typeof providerOrderId).toBe("string");

    // ── Leg 2: cancel that exact order ──
    const cancellation = await prepareAndEnqueueApproval({
      sessionId: live.sessionId,
      publicName: "lighter__order_cancel_prepare",
      params: {
        environment: LIVE_ENVIRONMENT,
        accountIndex: EXPECTED_ACCOUNT_INDEX,
        marketId: ETH_PERP_MARKET_ID,
        orderId: providerOrderId,
      },
    });
    approvalIds.push(cancellation.approvalId);
    const cancelCard = await readApprovalRecord(cancellation.approvalId);
    expect(cancelCard.queueStatus).toBe("pending");
    expect(cancelCard.decision).toBeNull();
    expect(cancellation.followUpToolId).toBe("lighter.order.cancel");
    const cancelCritical = cardCriticalArgs(cancelCard);
    // The card must name the exact order this run placed.
    expect(cancelCritical["providerOrderId"]).toBe(providerOrderId);
    expect(cancelCritical["marketIndex"]).toBe(ETH_PERP_MARKET_ID);
    const cancelIntentId = (JSON.parse(cancellation.prepareOutput) as Record<string, unknown>)["intentId"];
    record.record("cancel-prepared", {
      approvalId: cancellation.approvalId,
      intentId: cancelIntentId,
      providerOrderId,
      approvalCard: cancelCard,
    });

    const cancelled = await approveAndResume(cancellation.approvalId);
    expect(cancelled.toolResult.success, cancelled.toolResult.output).toBe(true);

    const cancelReconciliation = await pollUntil(
      { attempts: 20, intervalMs: 6_000, what: "the cancel settled" },
      () => runReadTool({
        sessionId: live.sessionId,
        publicName: "lighter__order_status",
        params: { environment: LIVE_ENVIRONMENT, intentId: cancelIntentId },
      }),
      // The lifecycle report's own `stateAfter`, not a substring of the blob:
      // "canceled" also appears inside the order's `cancelOrderIds` field.
      (attempt) => LIGHTER_LIFECYCLE_TERMINAL_STATES.includes(
        String(orderStatusReport(attempt.json, String(cancelIntentId))?.["stateAfter"] ?? ""),
      ),
    );

    // Lighter's own inactive-order read is the world's answer, not ours.
    const inactive = await runReadTool({
      sessionId: live.sessionId,
      publicName: "lighter__order_history_list",
      params: { environment: LIVE_ENVIRONMENT, marketId: ETH_PERP_MARKET_ID, limit: 25 },
    });
    const openAfter = await runReadTool({
      sessionId: live.sessionId,
      publicName: "lighter__open_orders_list",
      params: { environment: LIVE_ENVIRONMENT, marketId: ETH_PERP_MARKET_ID, limit: 25 },
    });

    record.record("cancelled", {
      placementApprovalId,
      cancelApprovalId: cancellation.approvalId,
      placementIntentId,
      cancelIntentId,
      providerOrderId,
      cancelResumeOutput: cancelled.toolResult.output,
      settled: cancelReconciliation.settled,
      statusAttempts: cancelReconciliation.attempts.map((attempt) => attempt.output),
      inactiveOrders: inactive.output,
      openOrdersAfter: openAfter.output,
    });

    expect(cancelReconciliation.settled, cancelReconciliation.attempts.at(-1)?.output ?? "no attempt").toBe(true);
    expect(
      orderRows(openAfter.json).some((row) => row["orderId"] === providerOrderId),
      openAfter.output,
    ).toBe(false);
  });
});
