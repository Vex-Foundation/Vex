/**
 * LIVE STEP 3 - one immediate-or-cancel perpetual order on the owner's
 * Robinhood Chain Lighter account, through the real preview -> prepare ->
 * approve -> resume -> reconcile chain.
 *
 * Gated by `VEX_LIGHTER_LIVE_IOC_ORDER=1`. Run AFTER steps 1 and 2. The market
 * is `VEX_LIGHTER_LIVE_MARKET_ID` (default 0, ETH); its symbol is in the
 * evidence directory name, so a BTC run and an ETH run never write into the
 * same place.
 *
 * THIS IS THE ROUND-2 UNIT MEASUREMENT. The fill's account-relative fields are
 * recorded VERBATIM from the authenticated provider response, because
 * `projectTrade` drops all of them (see the note in `harness.ts`); the projected
 * `lighter__trades_list` output is recorded alongside so the gap is visible in
 * the evidence rather than only in a report.
 *
 * WHAT THIS STEP NOW PROVES, and did not before:
 *
 *   - the size is TWICE the exchange minimum, so a partial fill still leaves a
 *     closable residual rather than an unclosable dust position;
 *   - the best opposite level holds at least three times that size before
 *     anything is prepared, so the IOC does not walk the book past the price it
 *     was sized for;
 *   - the initial margin fraction comes from THIS market's own position row
 *     (read with `activeOnly: false`, converted from its percent string by the
 *     repository's converter) or from THIS market's default, never from another
 *     market's row and never from a percent string on the 10000 scale;
 *   - the open leg leaves a POSITIVE fill whose trades carry this run's own
 *     client order index, and the account then holds the intended exposure;
 *   - the close leg leaves ZERO residual exposure on the market, and a residual
 *     below the exchange minimum is reported through
 *     `lighter__position_close_prepare` and named in the failure, never chased
 *     with a second unapproved order.
 *
 * CLEANUP IS REGISTERED THE MOMENT THE FIRST FILL LANDS: `cleanup-required.json`
 * lands in the evidence directory before any later assertion can end the run,
 * because a refusal that kills the process must not take the knowledge of an
 * open position with it.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness.js")).electronMainStub());

import {
  approveAndResume,
  assertTopOfBookDepth,
  createLiveSession,
  ensureIntegrationEnabled,
  decideOrderSizing,
  EXPECTED_ACCOUNT_INDEX,
  findLighterPositionRow,
  flagEnabled,
  installLighterProductionSeams,
  isDryRun,
  LIVE_ENVIRONMENT,
  LIVE_FLAGS,
  LIVE_IOC_CROSSING_BUFFER,
  LIVE_ORDER_SIZE_MULTIPLE,
  LIVE_TOP_OF_BOOK_DEPTH_MULTIPLE,
  LiveHarnessRefusal,
  positionMarginFractionConverter,
  marketSymbol,
  matchFillsForClientOrderIndex,
  MIN_NOTIONAL_USDG,
  openEvidence,
  isTerminalOrderState,
  orderStatusReport,
  pollUntil,
  positionExposure,
  prepareAndEnqueueApproval,
  printInspectionSql,
  readAccountRow,
  readApprovalRecord,
  readIntentClientOrderIndex,
  readRawAccountTrades,
  readRawMarketDetail,
  registerCleanupRequired,
  requireLiveEvidenceDirectory,
  requireLiveTarget,
  resolveInitialMarginFraction,
  resolveLiveMarketId,
  runReadTool,
  type EvidenceWriter,
  type LiveSession,
} from "./harness.js";

const describeLive = flagEnabled(LIVE_FLAGS.iocOrder) ? describe : describe.skip;

/** Bounded protection buffer: over the best ask for a buy, under the best bid for a sell, so the IOC can cross. */
const CROSSING_BUFFER = LIVE_IOC_CROSSING_BUFFER;

/**
 * `VEX_LIGHTER_LIVE_IOC_SIDE=sell` turns this step into the reduce-only CLOSE
 * of the position the buy opened: the size is the open position read from the
 * account, never a number typed by hand, and no new margin is required.
 */
const IOC_SIDE: "buy" | "sell" = process.env["VEX_LIGHTER_LIVE_IOC_SIDE"] === "sell" ? "sell" : "buy";
const REDUCE_ONLY = IOC_SIDE === "sell";

let disposeSeams: (() => void) | null = null;
let session: LiveSession | null = null;
let evidence: EvidenceWriter | null = null;
let marketId = 0;
let symbol = "";
const approvalIds: string[] = [];

/**
 * THE CLOSE SIZING: the account's own long on this market, whole.
 *
 * A position below the exchange's own minimums cannot be closed by an ordinary
 * IOC, so this refuses and names the residual rather than sending an order the
 * exchange would reject. The documented residual path (running
 * `lighter__position_close_prepare` and recording the provider's verbatim
 * answer) runs in the caller, which has the session and the evidence writer.
 */
function decideCloseSizing(input: {
  readonly detail: Record<string, unknown>;
  readonly positions: unknown;
  readonly price: number;
}): { readonly baseAmount: string; readonly notionalUsdg: number; readonly positionBefore: string } {
  const sizeDecimals = Number(input.detail["supported_size_decimals"]);
  const minBaseAmount = Number(input.detail["min_base_amount"]);
  const minQuoteAmount = Number(input.detail["min_quote_amount"]);
  const long = findLighterPositionRow(input.positions, marketId);
  const position = long === null || Number(long["sign"]) !== 1 ? Number.NaN : Number(long["position"]);
  if (long === null || !Number.isFinite(position) || position <= 0) {
    throw new LiveHarnessRefusal(
      `Refusing to prepare the close: the account holds no long on market ${marketId} (${symbol}). `
      + "Nothing was prepared, signed or submitted.",
    );
  }
  const baseAmount = position.toFixed(sizeDecimals);
  const notionalUsdg = Number(baseAmount) * input.price;
  if (Number(baseAmount) < minBaseAmount || notionalUsdg < minQuoteAmount) {
    throw new LiveHarnessRefusal(
      `Refusing to prepare the close: the long of ${baseAmount} (${notionalUsdg.toFixed(6)} USDG at `
      + `${input.price}) is below the exchange minimums (min_base_amount ${minBaseAmount}, min_quote_amount `
      + `${minQuoteAmount}). This is the RESIDUAL case: it is reported through `
      + "lighter__position_close_prepare and named in the run, never chased with a second order. Nothing "
      + "was prepared, signed or submitted.",
    );
  }
  return { baseAmount, notionalUsdg, positionBefore: String(long["position"]) };
}

beforeAll(async () => {
  // The evidence-directory gate fires FIRST, exactly as it always did; the
  // writer itself is opened after the public market read, so the directory can
  // carry the traded market's symbol.
  requireLiveEvidenceDirectory();
  marketId = resolveLiveMarketId();
  const detail = await readRawMarketDetail(marketId);
  symbol = marketSymbol(detail);
  evidence = openEvidence(`${REDUCE_ONLY ? "ioc-close" : "ioc-order"}-${symbol}`);
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
    marketId,
    symbol,
    sizeMultiple: LIVE_ORDER_SIZE_MULTIPLE,
    depthMultiple: LIVE_TOP_OF_BOOK_DEPTH_MULTIPLE,
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

describeLive("one live IOC perpetual order on the owner's Robinhood Chain account", () => {
  it(`previews, prepares, approves, signs and reconciles one IOC ${IOC_SIDE}${REDUCE_ONLY ? " (reduce-only close)" : ""}`, { timeout: 900_000 }, async () => {
    const live = requireSession();
    const record = requireEvidence();

    // ── Sizing, from live provider state only ──
    const detail = await readRawMarketDetail(marketId);
    const book = await runReadTool({
      sessionId: live.sessionId,
      publicName: "lighter__orderbook_get",
      params: { environment: LIVE_ENVIRONMENT, marketId, limit: 5 },
    });
    expect(book.success, book.output).toBe(true);
    const bookJson = book.json as Record<string, unknown> | null;
    // A buy crosses the ask; the close (a sell) crosses the bid.
    const crossedSide = REDUCE_ONLY ? "bids" : "asks";
    const bestOpposite = firstNumber(bookJson?.[crossedSide], "price")
      ?? Number(detail["last_trade_price"]);
    expect(Number.isFinite(bestOpposite) && bestOpposite > 0).toBe(true);

    // `activeOnly: false`: a market with a leverage setting but no open
    // position still has to produce its row, and that row is where this
    // market's own initial margin fraction lives.
    const { account, output: accountOutput } = await readAccountRow({
      sessionId: live.sessionId,
      accountIndex: EXPECTED_ACCOUNT_INDEX,
    });
    const availableCollateralUsdg = Number(account["availableBalance"] ?? account["collateral"]);
    const margin = resolveInitialMarginFraction({
      marketId,
      detail,
      positions: account["positions"],
      convertPositionPercent: positionMarginFractionConverter,
    });

    const priceDecimals = Number(detail["supported_price_decimals"]);
    const sizeDecimals = Number(detail["supported_size_decimals"]);
    const price = (REDUCE_ONLY ? bestOpposite / CROSSING_BUFFER : bestOpposite * CROSSING_BUFFER).toFixed(priceDecimals);
    const sizing = REDUCE_ONLY
      ? decideCloseSizing({ detail, positions: account["positions"], price: Number(price) })
      : decideOrderSizing({
          marketId,
          detail,
          margin,
          availableCollateralUsdg,
          price: Number(price),
        });

    // The depth gate, immediately before anything is prepared. It runs on the
    // close too: a reduce-only IOC that walks a thin book realises the position
    // at prices this run never priced.
    const depth = assertTopOfBookDepth({
      book: bookJson,
      side: crossedSide,
      baseAmount: sizing.baseAmount,
      marketId,
    });

    const exposureBefore = positionExposure(account["positions"], marketId);
    record.record("sizing", {
      mode: REDUCE_ONLY ? "close_reduce_only" : "open",
      side: IOC_SIDE,
      marketId,
      symbol,
      bestOpposite,
      price,
      depth,
      availableCollateralUsdg,
      initialMarginFraction: margin.initialMarginFraction,
      initialMarginFractionScale: 10_000,
      initialMarginFractionSource: margin.source,
      initialMarginFractionProviderValue: margin.providerValue,
      sizing,
      exposureBefore,
      accountRead: accountOutput,
      // Verbatim, because the projected market read is a projection and the
      // provider's own row is the specification.
      rawOrderBookDetail: detail,
    });

    // ── Preview, the durable input the prepare tool binds to ──
    const preview = await runReadTool({
      sessionId: live.sessionId,
      publicName: "lighter__order_preview",
      params: {
        environment: LIVE_ENVIRONMENT,
        accountIndex: EXPECTED_ACCOUNT_INDEX,
        marketId,
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
    const intentId = String(prepareJson["intentId"]);
    expect(typeof prepareJson["intentId"]).toBe("string");
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
      // An IOC either fills or is cancelled by the exchange; both are terminal
      // for the INTENT. Whether it filled is a separate question, asserted
      // below against the account's own trades.
      async (attempt) => isTerminalOrderState(
        orderStatusReport(attempt.json, intentId)?.["stateAfter"],
      ),
    );

    // The account-relative fill fields, verbatim from the authenticated
    // response. This is the measurement round 2 needs.
    const rawTrades = await readRawAccountTrades(EXPECTED_ACCOUNT_INDEX, 25);
    const clientOrderIndex = await readIntentClientOrderIndex(intentId);
    const fill = matchFillsForClientOrderIndex({
      trades: rawTrades,
      marketId,
      side: IOC_SIDE,
      clientOrderIndex,
    });

    // CLEANUP REGISTRATION, before any assertion below can end this run.
    //
    // The marker carries THIS RUN'S INTENT ID, not only the size: the cleanup
    // step reconciles every id it finds through `lighter__order_status` before
    // it reads the position, so a submission whose outcome is still unproven
    // cannot be mistaken for a flat account.
    if (!REDUCE_ONLY && fill.filledBase > 0) {
      registerCleanupRequired(record, {
        environment: LIVE_ENVIRONMENT,
        accountIndex: EXPECTED_ACCOUNT_INDEX,
        marketId,
        symbol,
        side: IOC_SIDE,
        baseAmount: fill.filledBase.toFixed(sizeDecimals),
        intentIds: [intentId],
        sessionId: live.sessionId,
      });
    }

    const projectedTrades = await runReadTool({
      sessionId: live.sessionId,
      publicName: "lighter__trades_list",
      params: { environment: LIVE_ENVIRONMENT, accountIndex: EXPECTED_ACCOUNT_INDEX, limit: 25 },
    });
    const accountAfter = await readAccountRow({
      sessionId: live.sessionId,
      accountIndex: EXPECTED_ACCOUNT_INDEX,
    });
    const exposureAfter = positionExposure(accountAfter.account["positions"], marketId);

    // THE RESIDUAL PATH, documented and taken BEFORE the assertion fails: when
    // the close leg leaves exposure the exchange minimums will not let an
    // ordinary IOC touch, the provider's own answer to a full-position close is
    // recorded verbatim, and the run stops with the residual named. Never a
    // second unapproved order.
    let residualCloseAnswer: string | null = null;
    if (REDUCE_ONLY && exposureAfter.size > 0) {
      const residualClose = await runReadTool({
        sessionId: live.sessionId,
        publicName: "lighter__position_close_prepare",
        params: {
          environment: LIVE_ENVIRONMENT,
          accountIndex: EXPECTED_ACCOUNT_INDEX,
          marketId,
          slippageBps: 100,
        },
      });
      residualCloseAnswer = residualClose.output;
    }

    record.record("settled", {
      approvalId: prepared.approvalId,
      intentId,
      clientOrderIndex,
      settled: reconciliation.settled,
      statusAttempts: reconciliation.attempts.map((attempt) => attempt.output),
      filledBase: fill.filledBase,
      matchedTrades: fill.trades,
      rawAccountTrades: rawTrades,
      projectedTradesTool: projectedTrades.output,
      exposureBefore,
      exposureAfter,
      accountAfter: accountAfter.output,
      residualCloseAnswer,
    });
    process.stdout.write(`${JSON.stringify({
      event: "lighter.live.ioc_raw_trades",
      trades: rawTrades,
    })}\n`);

    expect(reconciliation.settled, reconciliation.attempts.at(-1)?.output ?? "no attempt").toBe(true);

    // A POSITIVE fill, matched to THIS run's client order index. "The account
    // has some trades" and "the exchange cancelled it" are not this step's
    // claim: an IOC that filled nothing proves nothing about the money path.
    expect(
      fill.filledBase,
      `no trade on market ${marketId} carries this run's client order index ${clientOrderIndex}; `
      + `raw trades: ${JSON.stringify(rawTrades)}`,
    ).toBeGreaterThan(0);

    if (REDUCE_ONLY) {
      // ZERO residual exposure is the target of the close. A residual is
      // reported as a residual, with its size and its value, and the provider's
      // own answer to a full-position close beside it.
      expect(
        exposureAfter.size,
        `market ${marketId} (${symbol}) still carries ${exposureAfter.size} base units after the close `
        + `(about ${(exposureAfter.size * Number(price)).toFixed(6)} USDG at ${price}). `
        + `lighter__position_close_prepare answered: ${residualCloseAnswer ?? "not run"}`,
      ).toBe(0);
    } else {
      // The account holds the exposure the fill created, on THIS market and on
      // the intended side.
      expect(exposureAfter.signedSize, accountAfter.output).toBeGreaterThan(exposureBefore.signedSize);
    }
  });
});
