/**
 * LIVE STEP 3 - one immediate-or-cancel ETH-perp order on the owner's Robinhood
 * Chain Lighter account, through the real preview -> prepare -> approve ->
 * resume -> reconcile chain.
 *
 * Gated by `VEX_LIGHTER_LIVE_IOC_ORDER=1`. Run AFTER steps 1 and 2.
 *
 * THIS IS THE ROUND-2 UNIT MEASUREMENT. The fill's account-relative fields are
 * recorded VERBATIM from the authenticated provider response, because
 * `projectTrade` drops all of them (see the note in `harness.ts`); the projected
 * `lighter__trades_list` output is recorded alongside so the gap is visible in
 * the evidence rather than only in a report.
 *
 * The harness REFUSES before preparing anything when the account's collateral
 * cannot carry the smallest accepted order at the account's initial margin
 * fraction. That refusal is a real outcome, not a harness defect: measured live
 * on 2026-09-08, RHC market 0 has min_base_amount 0.0050 and a default initial
 * margin fraction of 5000/10000, so the smallest ETH order is well above the
 * nominal 10 USDG minimum notional and needs about half of it as margin.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness.js")).electronMainStub());

import {
  approveAndResume,
  createLiveSession,
  ensureIntegrationEnabled,
  decideOrderSizing,
  ETH_PERP_MARKET_ID,
  EXPECTED_ACCOUNT_INDEX,
  flagEnabled,
  installLighterProductionSeams,
  isDryRun,
  LIVE_ENVIRONMENT,
  LIVE_FLAGS,
  LiveHarnessRefusal,
  MIN_NOTIONAL_USDG,
  openEvidence,
  isTerminalOrderState,
  orderStatusReport,
  pollUntil,
  prepareAndEnqueueApproval,
  printInspectionSql,
  readApprovalRecord,
  readRawAccountTrades,
  readRawMarketDetail,
  requireLiveTarget,
  runReadTool,
  type EvidenceWriter,
  type LiveSession,
} from "./harness.js";

const describeLive = flagEnabled(LIVE_FLAGS.iocOrder) ? describe : describe.skip;

/** Bounded protection buffer: over the best ask for a buy, under the best bid for a sell, so the IOC can cross. */
const CROSSING_BUFFER = 1.005;

/**
 * `VEX_LIGHTER_LIVE_IOC_SIDE=sell` turns this step into the reduce-only CLOSE
 * of the long the buy opened: the size is the open position read from the
 * account, never a number typed by hand, and no new margin is required.
 */
const IOC_SIDE: "buy" | "sell" = process.env["VEX_LIGHTER_LIVE_IOC_SIDE"] === "sell" ? "sell" : "buy";
const REDUCE_ONLY = IOC_SIDE === "sell";

let disposeSeams: (() => void) | null = null;
let session: LiveSession | null = null;
let evidence: EvidenceWriter | null = null;
const approvalIds: string[] = [];

/**
 * THE CLOSE SIZING: the account's own long on this market, whole. Refuses when
 * there is no long to close, or when the position is below the exchange's own
 * minimums (an IOC below them would be rejected rather than partially closed).
 */
function decideCloseSizing(input: {
  readonly detail: Record<string, unknown>;
  readonly positions: unknown;
  readonly price: number;
}): { readonly baseAmount: string; readonly notionalUsdg: number; readonly positionBefore: string } {
  const sizeDecimals = Number(input.detail["supported_size_decimals"]);
  const minBaseAmount = Number(input.detail["min_base_amount"]);
  const minQuoteAmount = Number(input.detail["min_quote_amount"]);
  const rows = Array.isArray(input.positions) ? (input.positions as Record<string, unknown>[]) : [];
  const long = rows.find((row) => Number(row["market_id"]) === ETH_PERP_MARKET_ID && Number(row["sign"]) === 1);
  const position = long === undefined ? Number.NaN : Number(long["position"]);
  if (!Number.isFinite(position) || position <= 0) {
    throw new LiveHarnessRefusal(
      `Refusing to prepare the close: the account holds no long on market ${ETH_PERP_MARKET_ID}. Nothing was prepared, signed or submitted.`,
    );
  }
  const baseAmount = position.toFixed(sizeDecimals);
  const notionalUsdg = Number(baseAmount) * input.price;
  if (Number(baseAmount) < minBaseAmount || notionalUsdg < minQuoteAmount) {
    throw new LiveHarnessRefusal(
      `Refusing to prepare the close: the long of ${baseAmount} (${notionalUsdg.toFixed(6)} USDG at ${input.price}) is below `
      + `the exchange minimums (min_base_amount ${minBaseAmount}, min_quote_amount ${minQuoteAmount}). Nothing was prepared, signed or submitted.`,
    );
  }
  return { baseAmount, notionalUsdg, positionBefore: String(long?.["position"]) };
}

beforeAll(async () => {
  evidence = openEvidence(REDUCE_ONLY ? "ioc-close" : "ioc-order");
  const target = await requireLiveTarget();
  if (isDryRun()) {
    const { runMigrations } = await import("@vex-agent/db/migrate.js");
    await runMigrations();
  }
  disposeSeams = await installLighterProductionSeams();
  session = await createLiveSession(target, "ioc");
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
    nominalMinNotionalUsdg: MIN_NOTIONAL_USDG,
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

function firstNumber(rows: unknown, key: string): number | null {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (row !== null && typeof row === "object") {
      const value = Number((row as Record<string, unknown>)[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

describeLive("one live IOC ETH-perp order on the owner's Robinhood Chain account", () => {
  it(`previews, prepares, approves, signs and reconciles one IOC ${IOC_SIDE}${REDUCE_ONLY ? " (reduce-only close)" : ""}`, { timeout: 900_000 }, async () => {
    const live = requireSession();
    const record = requireEvidence();

    // ── Sizing, from live provider state only ──
    const detail = await readRawMarketDetail(ETH_PERP_MARKET_ID);
    const book = await runReadTool({
      sessionId: live.sessionId,
      publicName: "lighter__orderbook_get",
      params: { environment: LIVE_ENVIRONMENT, marketId: ETH_PERP_MARKET_ID, limit: 5 },
    });
    expect(book.success, book.output).toBe(true);
    const bookJson = book.json as Record<string, unknown> | null;
    // A buy crosses the ask; the close (a sell) crosses the bid.
    const bestOpposite = firstNumber(bookJson?.[REDUCE_ONLY ? "bids" : "asks"], "price")
      ?? Number(detail["last_trade_price"]);
    expect(Number.isFinite(bestOpposite) && bestOpposite > 0).toBe(true);

    const accountRead = await runReadTool({
      sessionId: live.sessionId,
      publicName: "lighter__account_get",
      params: { environment: LIVE_ENVIRONMENT, accountIndex: EXPECTED_ACCOUNT_INDEX },
    });
    expect(accountRead.success, accountRead.output).toBe(true);
    const accountJson = accountRead.json as Record<string, unknown> | null;
    const account = Array.isArray(accountJson?.["accounts"])
      ? (accountJson["accounts"] as Record<string, unknown>[])[0] ?? null
      : null;
    if (account === null) throw new Error("Lighter returned no account row for the owner's account.");
    const availableCollateralUsdg = Number(account["availableBalance"] ?? account["collateral"]);
    // A position already open on this market carries its own initial margin
    // fraction; with no position the market default applies.
    const positionImf = firstNumber(account["positions"], "initial_margin_fraction");
    const initialMarginFractionBps = positionImf
      ?? Number(detail["default_initial_margin_fraction"]);

    const priceDecimals = Number(detail["supported_price_decimals"]);
    const price = (REDUCE_ONLY ? bestOpposite / CROSSING_BUFFER : bestOpposite * CROSSING_BUFFER).toFixed(priceDecimals);
    const sizing = REDUCE_ONLY
      ? decideCloseSizing({ detail, positions: account["positions"], price: Number(price) })
      : decideOrderSizing({
          marketId: ETH_PERP_MARKET_ID,
          detail,
          initialMarginFractionBps,
          availableCollateralUsdg,
          price: Number(price),
        });
    record.record("sizing", {
      mode: REDUCE_ONLY ? "close_reduce_only" : "open",
      side: IOC_SIDE,
      bestOpposite,
      price,
      availableCollateralUsdg,
      initialMarginFractionBps,
      initialMarginFractionSource: positionImf === null ? "market_default" : "open_position",
      sizing,
      positionsBefore: account["positions"],
      // Verbatim, because the projected market read omits every margin field.
      rawOrderBookDetail: detail,
    });

    // ── Preview, the durable input the prepare tool binds to ──
    const preview = await runReadTool({
      sessionId: live.sessionId,
      publicName: "lighter__order_preview",
      params: {
        environment: LIVE_ENVIRONMENT,
        accountIndex: EXPECTED_ACCOUNT_INDEX,
        marketId: ETH_PERP_MARKET_ID,
        side: IOC_SIDE,
        baseAmountIn: sizing.baseAmount,
        price,
        orderType: "market",
        timeInForce: "immediate-or-cancel",
        reduceOnly: REDUCE_ONLY,
        orderExpiry: Date.now() + 10 * 60 * 1000,
      },
    });
    expect(preview.success, preview.output).toBe(true);
    const previewJson = preview.json as Record<string, unknown> | null;
    const previewId = previewJson?.["previewId"];
    expect(typeof previewId).toBe("string");
    record.record("previewed", { previewId, preview: preview.output });

    const prepared = await prepareAndEnqueueApproval({
      sessionId: live.sessionId,
      publicName: "lighter__order_create_prepare",
      params: { environment: LIVE_ENVIRONMENT, previewId },
    });
    approvalIds.push(prepared.approvalId);

    const card = await readApprovalRecord(prepared.approvalId);
    expect(card.queueStatus).toBe("pending");
    expect(card.decision).toBeNull();
    expect(card.executionStatus).toBe("not_started");
    expect(prepared.followUpToolId).toBe("lighter.order.create");

    const prepareJson = JSON.parse(prepared.prepareOutput) as Record<string, unknown>;
    const intentId = prepareJson["intentId"];
    expect(typeof intentId).toBe("string");
    record.record("prepared", {
      approvalId: prepared.approvalId,
      intentId,
      previewId,
      prepareOutput: prepared.prepareOutput,
      approvalCard: card,
    });

    if (isDryRun()) return;

    const dispatched = await approveAndResume(prepared.approvalId);
    expect(dispatched.toolResult.success, dispatched.toolResult.output).toBe(true);
    record.record("approved-and-submitted", {
      approvalId: prepared.approvalId,
      intentId,
      executionStatus: dispatched.executionStatus,
      resumeToolOutput: dispatched.toolResult.output,
    });

    const reconciliation = await pollUntil(
      { attempts: 20, intervalMs: 6_000, what: "IOC order settled" },
      () => runReadTool({
        sessionId: live.sessionId,
        publicName: "lighter__order_status",
        params: { environment: LIVE_ENVIRONMENT, intentId },
      }),
      // An IOC either fills or is cancelled by the exchange; both are terminal.
      // Asserted on the report's `stateAfter` against the protocol's own
      // exported terminal list, never on a substring of the serialized blob.
      async (attempt) => isTerminalOrderState(
        orderStatusReport(attempt.json, String(intentId))?.["stateAfter"],
      ),
    );

    // The account-relative fill fields, verbatim from the authenticated
    // response. This is the measurement round 2 needs.
    const rawTrades = await readRawAccountTrades(EXPECTED_ACCOUNT_INDEX, 25);
    const projectedTrades = await runReadTool({
      sessionId: live.sessionId,
      publicName: "lighter__trades_list",
      params: { environment: LIVE_ENVIRONMENT, accountIndex: EXPECTED_ACCOUNT_INDEX, limit: 25 },
    });
    const positions = await runReadTool({
      sessionId: live.sessionId,
      publicName: "lighter__positions_list",
      params: { environment: LIVE_ENVIRONMENT, accountIndex: EXPECTED_ACCOUNT_INDEX },
    });

    record.record("settled", {
      approvalId: prepared.approvalId,
      intentId,
      settled: reconciliation.settled,
      statusAttempts: reconciliation.attempts.map((attempt) => attempt.output),
      rawAccountTrades: rawTrades,
      projectedTradesTool: projectedTrades.output,
      positionsAfter: positions.output,
    });
    process.stdout.write(`${JSON.stringify({
      event: "lighter.live.ioc_raw_trades",
      trades: rawTrades,
    })}\n`);

    expect(reconciliation.settled, reconciliation.attempts.at(-1)?.output ?? "no attempt").toBe(true);
    expect(rawTrades.length).toBeGreaterThan(0);
    expect(positions.success, positions.output).toBe(true);
  });
});
