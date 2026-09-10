/**
 * THE CLEANUP STEP - the one executable owner of "leave the account flat".
 *
 * Gated by `VEX_LIGHTER_LIVE_CLEANUP=1`. It exists because a marker file is a
 * reminder, not a cleanup: `registerCleanupRequired` writes instructions, and
 * instructions do not close a position. This step reads those markers and
 * EXECUTES the close, through the production chain and a separately authorized
 * approval:
 *
 *   lighter__order_status (reconcile this run's intents)
 *     -> lighter__position_close_prepare
 *     -> the approval card the human decides
 *     -> lighter__position_close
 *     -> the account, polled until it is flat
 *
 * It never calls `runTool`, never forges an approval and never sends a second
 * order to chase a residual. The close is sized by the PRODUCTION prepare from
 * the account's own live position, never from the marker, so a partial fill, a
 * short, or a position an earlier step never recorded is closed at its real
 * size. That also means it closes a SHORT: the prepare closes the entire
 * position whichever side it is on.
 *
 * WHAT IT REPORTS, per market, and never softens:
 *   - `flat`       - a live account read proved zero exposure;
 *   - `residual`   - exposure remains; its size, its value and the provider's
 *                    verbatim refusal are named. A residual is reported as a
 *                    residual, never as cleanup;
 *   - `unresolved` - something was submitted without proof; the intent id is
 *                    named and nothing is resubmitted.
 * The test FAILS unless EVERY market is `flat`, and the failure lists the rest.
 *
 * ONE MARKET'S FAILURE DOES NOT STOP THE OTHERS. Every market is attempted,
 * its failure is collected, and the summary carries all of them - the same
 * shape as VS Code's `_disposePtyHost`, which runs on every path and lets no
 * single failed resource strand the ones behind it.
 *
 * RE-RUNNING IT IS SAFE. Markers are durable evidence and are never deleted, so
 * a second run finds the same markers, reconciles the same (now terminal)
 * intents, reads a flat account and reports `flat` without preparing anything.
 *
 * The pure marker contract at the bottom of this file is NOT gated: the
 * discovery, the refusals and the verdict are decisions over values, so they
 * stay provable on any machine and in CI, exactly like
 * `deposit-amount-gate.test.ts` does for the deposit amounts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness.js")).electronMainStub());

import {
  approveAndResume,
  cardCriticalArgs,
  CLEANUP_MARKER_FILE,
  CLEANUP_MARKET_IDS_ENV,
  createLiveSession,
  decideCleanupOutcome,
  ensureIntegrationEnabled,
  EXPECTED_ACCOUNT_INDEX,
  flagEnabled,
  installLighterProductionSeams,
  isDryRun,
  LIGHTER_CLOSE_PROVEN_STATUSES,
  LIVE_ENVIRONMENT,
  LIVE_FLAGS,
  LiveHarnessRefusal,
  marketSymbol,
  mergeCleanupTargets,
  openEvidence,
  orderStatusUnresolvedCount,
  parseCleanupMarker,
  parseCleanupMarketIds,
  pollUntil,
  positionExposure,
  prepareAndEnqueueApproval,
  printInspectionSql,
  readAccountRow,
  readApprovalRecord,
  readCleanupMarkers,
  readRawMarketDetail,
  requireLiveEvidenceDirectory,
  requireLiveTarget,
  runReadTool,
  type CleanupOutcome,
  type CleanupTarget,
  type EvidenceWriter,
  type LiveSession,
} from "./harness.js";

const describeLive = flagEnabled(LIVE_FLAGS.cleanup) ? describe : describe.skip;

/**
 * The slippage ceiling the close is prepared with, in basis points.
 *
 * A close that cannot be filled inside 1% is a market this step must NOT force
 * its way out of: the prepare refuses on insufficient depth, the refusal is
 * recorded verbatim, and the exposure is reported as a residual for a human to
 * decide on. It is a bound on what the account can lose to the close itself.
 */
const CLEANUP_SLIPPAGE_BPS = 100;

/**
 * How long the account is polled for a flat position after a close is
 * submitted, bounded: 15 attempts, 4 s apart, so at most one minute of waiting
 * per market. Running out of attempts is an honest `residual`, never a pass.
 */
const FLAT_POLL = { attempts: 15, intervalMs: 4_000, what: "the position is flat" } as const;

let disposeSeams: (() => void) | null = null;
let session: LiveSession | null = null;
let evidence: EvidenceWriter | null = null;
const approvalIds: string[] = [];

function requireSession(): LiveSession {
  if (session === null) throw new Error("The live session was not created.");
  return session;
}

function requireEvidence(): EvidenceWriter {
  if (evidence === null) throw new Error("The evidence writer was not opened.");
  return evidence;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reconcile this run's intents FIRST, through the production repair path
 * `lighter__order_status` drives, and take the tool's OWN verdict on each one.
 *
 * `stillUnresolved` is the repair path's count, not a re-derivation here: an
 * intent it could not resolve is exposure that has not finished landing, and
 * reading a position while one is in flight measures a number that can still
 * move. An unreadable answer counts as unresolved for the same reason.
 */
async function reconcileIntents(
  sessionId: string,
  target: CleanupTarget,
): Promise<{ readonly unresolved: readonly string[]; readonly reports: readonly Record<string, unknown>[] }> {
  const unresolved: string[] = [];
  const reports: Record<string, unknown>[] = [];
  for (const intentId of target.intentIds) {
    const status = await runReadTool({
      sessionId,
      publicName: "lighter__order_status",
      params: { environment: LIVE_ENVIRONMENT, intentId },
    });
    const stillUnresolved = orderStatusUnresolvedCount(status.json);
    const isUnresolved = !status.success || stillUnresolved === null || stillUnresolved > 0;
    if (isUnresolved) unresolved.push(intentId);
    reports.push({ intentId, success: status.success, stillUnresolved, output: status.output });
  }
  return { unresolved, reports };
}

/** The account's exposure on one market, and the tool output that proved it. */
async function readExposure(
  sessionId: string,
  marketId: number,
): Promise<{ readonly size: number; readonly signedSize: number; readonly output: string }> {
  const read = await readAccountRow({ sessionId, accountIndex: EXPECTED_ACCOUNT_INDEX });
  const exposure = positionExposure(read.account["positions"], marketId);
  return { size: exposure.size, signedSize: exposure.signedSize, output: read.output };
}

describeLive("close every position this run's live steps left open", () => {
  // The setup hooks live INSIDE the gated suite, not at file scope: this file
  // also carries an ungated suite, and a file-scoped `beforeAll` would run for
  // it too - demanding an evidence directory, a vault and a database on a
  // machine that has none.
  beforeAll(async () => {
    requireLiveEvidenceDirectory();
    evidence = openEvidence("cleanup");
    const target = await requireLiveTarget();
    if (isDryRun()) {
      const { runMigrations } = await import("@vex-agent/db/migrate.js");
      await runMigrations();
    }
    disposeSeams = await installLighterProductionSeams();
    session = await createLiveSession(target, "cleanup");
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
      slippageBps: CLEANUP_SLIPPAGE_BPS,
      flatPoll: FLAT_POLL,
    });
  });

  afterAll(async () => {
    if (session !== null) printInspectionSql(session.sessionId, approvalIds);
    disposeSeams?.();
    const { closePool } = await import("@vex-agent/db/client.js");
    await closePool();
  });

  it("reconciles, closes and proves the account flat on every registered market", { timeout: 1_800_000 }, async () => {
    const live = requireSession();
    const record = requireEvidence();

    const markers = readCleanupMarkers(requireLiveEvidenceDirectory());
    const explicitMarketIds = parseCleanupMarketIds(process.env[CLEANUP_MARKET_IDS_ENV]);
    const targets = mergeCleanupTargets({ markers, explicitMarketIds });
    record.record("markers", {
      evidenceRoot: requireLiveEvidenceDirectory(),
      markerFiles: markers.map((found) => found.file),
      markers: markers.map((found) => found.marker),
      explicitMarketIds,
      explicitMarketIdsVariable: CLEANUP_MARKET_IDS_ENV,
      targets,
    });

    const outcomes: CleanupOutcome[] = [];

    for (const target of targets) {
      const unresolvedIntentIds: string[] = [];
      let providerRefusal: string | null = null;
      let symbol = `market ${target.marketId}`;
      let price: number | null = null;
      let residualBaseAmount: number | null = null;

      try {
        const reconciliation = await reconcileIntents(live.sessionId, target);
        unresolvedIntentIds.push(...reconciliation.unresolved);

        const detail = await readRawMarketDetail(target.marketId);
        symbol = marketSymbol(detail);
        const lastTradePrice = Number(detail["last_trade_price"]);
        price = Number.isFinite(lastTradePrice) && lastTradePrice > 0 ? lastTradePrice : null;

        const before = await readExposure(live.sessionId, target.marketId);
        residualBaseAmount = before.size;
        record.record(`position-${symbol}`, {
          marketId: target.marketId,
          symbol,
          sources: target.sources,
          intentIds: target.intentIds,
          reconciliation: reconciliation.reports,
          unresolvedIntentIds: reconciliation.unresolved,
          exposure: { size: before.size, signedSize: before.signedSize },
          lastTradePrice: price,
          accountRead: before.output,
        });

        if (before.size > 0) {
          // The FULL close, through the production chain. The size comes from
          // the prepare's own read of the live position; nothing here types a
          // number, and nothing here approves itself.
          const prepared = await prepareAndEnqueueApproval({
            sessionId: live.sessionId,
            publicName: "lighter__position_close_prepare",
            params: {
              environment: LIVE_ENVIRONMENT,
              accountIndex: EXPECTED_ACCOUNT_INDEX,
              marketId: target.marketId,
              slippageBps: CLEANUP_SLIPPAGE_BPS,
            },
          });
          approvalIds.push(prepared.approvalId);
          expect(prepared.followUpToolId).toBe("lighter.position.close");

          const card = await readApprovalRecord(prepared.approvalId);
          const critical = cardCriticalArgs(card);
          const closeIntentId = String(critical["intentId"]);
          record.record(`close-${symbol}`, {
            marketId: target.marketId,
            symbol,
            approvalId: prepared.approvalId,
            closeIntentId,
            criticalArgs: critical,
            prepareOutput: prepared.prepareOutput,
            approvalCard: card,
          });

          // THE CARD IS THE SENTENCE THAT GETS APPROVED, so the binding is
          // checked against the durable card, before the decision, not against
          // the handler's return value.
          expect(card.queueStatus).toBe("pending");
          expect(card.decision).toBeNull();
          expect(critical["toolId"]).toBe("lighter.position.close");
          expect(critical["environment"]).toBe(LIVE_ENVIRONMENT);
          expect(critical["accountIndex"]).toBe(EXPECTED_ACCOUNT_INDEX);
          expect(critical["marketIndex"]).toBe(target.marketId);
          expect(critical["reduceOnly"]).toBe(true);
          expect(critical["maxSlippageBps"]).toBe(CLEANUP_SLIPPAGE_BPS);
          expect(Number(critical["positionAmount"])).toBeCloseTo(before.size, 8);

          // The dry run stops HERE, one step before the decision, exactly as
          // every other step does: `approveAndResume` decides and dispatches in
          // one production call, so there is no honest way to stop inside it.
          if (isDryRun()) continue;

          let closeStatus: string | null = null;
          let closeOutput = "";
          try {
            const dispatched = await approveAndResume(prepared.approvalId);
            closeOutput = dispatched.toolResult.output;
            if (dispatched.toolResult.success) {
              let parsed: unknown = null;
              try {
                parsed = JSON.parse(closeOutput);
              } catch {
                parsed = null;
              }
              const status = (parsed as Record<string, unknown> | null)?.["status"];
              closeStatus = typeof status === "string" ? status : null;
            }
            // A submission the provider has not confirmed is UNRESOLVED, and
            // it is named by intent id. It is never retried here.
            if (closeStatus === null || !LIGHTER_CLOSE_PROVEN_STATUSES.includes(closeStatus)) {
              unresolvedIntentIds.push(closeIntentId);
            }
          } catch (error) {
            // The approve-and-resume call can fail on either side of the one
            // submission it makes, so the outcome of this intent is unknown.
            unresolvedIntentIds.push(closeIntentId);
            closeOutput = errorText(error);
          }

          const flat = await pollUntil(
            FLAT_POLL,
            () => readExposure(live.sessionId, target.marketId),
            (attempt) => attempt.size === 0,
          );
          const last = flat.attempts.at(-1);
          residualBaseAmount = last?.size ?? before.size;
          record.record(`after-${symbol}`, {
            marketId: target.marketId,
            symbol,
            closeIntentId,
            closeStatus,
            closeOutput,
            reachedFlat: flat.settled,
            attempts: flat.attempts.map((attempt) => ({ size: attempt.size, signedSize: attempt.signedSize })),
            lastAccountRead: last?.output ?? null,
          });
        }
      } catch (error) {
        // One market's failure must not strand the markets behind it. The
        // failure text is kept verbatim and reported with this market's
        // outcome; the loop continues.
        providerRefusal = errorText(error);
        try {
          residualBaseAmount = (await readExposure(live.sessionId, target.marketId)).size;
        } catch (readError) {
          residualBaseAmount = null;
          providerRefusal = `${providerRefusal} The follow-up account read also failed: ${errorText(readError)}`;
        }
      }

      if (residualBaseAmount === null) {
        // Nothing about this market could be measured, so nothing about it is
        // claimed beyond the failure itself.
        outcomes.push({
          marketId: target.marketId,
          symbol,
          kind: "unresolved",
          detail:
            `The exposure on market ${target.marketId} (${symbol}) could not be read, so this run cannot `
            + `say whether it is flat. ${providerRefusal ?? ""}`.trim(),
        });
        continue;
      }
      outcomes.push(decideCleanupOutcome({
        marketId: target.marketId,
        symbol,
        residualBaseAmount,
        residualValueUsdg: price === null ? null : residualBaseAmount * price,
        unresolvedIntentIds,
        providerRefusal,
      }));
    }

    const notFlat = outcomes.filter((outcome) => outcome.kind !== "flat");
    record.record("summary", {
      dryRun: isDryRun(),
      marketsRegistered: targets.length,
      marketsClassified: outcomes.length,
      outcomes,
      allFlat: notFlat.length === 0,
    });

    // A dry run prepared cards and decided nothing, so it has no verdict on
    // whether the account is flat and does not pretend to one.
    if (isDryRun()) return;

    if (targets.length === 0) {
      // Nothing was registered and nothing was named: an honest no-op, and the
      // evidence says so rather than implying a close happened.
      process.stdout.write(`${JSON.stringify({
        event: "lighter.live.cleanup_no_targets",
        evidenceRoot: requireLiveEvidenceDirectory(),
      })}\n`);
      return;
    }

    expect(
      notFlat.map((outcome) => `market ${outcome.marketId} (${outcome.symbol}) is ${outcome.kind}: ${outcome.detail}`)
        .join("\n"),
      "the account is not flat on every market this run opened",
    ).toBe("");
  });
});

describe("the cleanup marker contract", () => {
  const marker = {
    environment: LIVE_ENVIRONMENT,
    accountIndex: EXPECTED_ACCOUNT_INDEX,
    marketId: 1,
    symbol: "BTC",
    side: "buy" as const,
    baseAmount: "0.0002",
    intentIds: ["lighter-order-1"],
    sessionId: "session-1",
    registeredAt: "2026-09-10T12:00:00.000Z",
    howToClose: "Run the cleanup step.",
  };

  it("accepts a marker the harness itself wrote", () => {
    expect(parseCleanupMarker(marker, "marker.json")).toEqual(marker);
  });

  it("refuses a marker that names another account, another environment or another kind of market id", () => {
    for (const broken of [
      { ...marker, accountIndex: 999 },
      { ...marker, environment: "mainnet" },
      { ...marker, marketId: 255 },
      { ...marker, marketId: "1" },
      { ...marker, intentIds: "lighter-order-1" },
      { ...marker, sessionId: "" },
      { ...marker, registeredAt: "yesterday" },
      "not an object",
    ]) {
      expect(() => parseCleanupMarker(broken, "marker.json"), JSON.stringify(broken)).toThrow(LiveHarnessRefusal);
    }
  });

  it("refuses rather than skips, because a skipped marker is a forgotten position", () => {
    expect(() => parseCleanupMarker({ ...marker, symbol: "" }, "/evidence/marker.json"))
      .toThrow(/records an OPEN POSITION/);
  });

  it("finds every marker under the evidence root, at any depth", () => {
    const root = mkdtempSync(path.join(tmpdir(), "vex-cleanup-markers-"));
    try {
      const nested = path.join(root, "ioc-order-BTC-2026-09-10");
      mkdirSync(nested, { recursive: true });
      writeFileSync(path.join(nested, CLEANUP_MARKER_FILE), JSON.stringify(marker), "utf8");
      writeFileSync(path.join(nested, "01-sizing.json"), "{}", "utf8");
      const found = readCleanupMarkers(root);
      expect(found).toHaveLength(1);
      expect(found[0]?.marker.marketId).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an evidence root that does not exist", () => {
    expect(() => readCleanupMarkers(path.join(tmpdir(), "vex-cleanup-absent-directory")))
      .toThrow(LiveHarnessRefusal);
  });

  it("merges markers and the operator's explicit list into one target per market", () => {
    const targets = mergeCleanupTargets({
      markers: [
        { file: "/a/cleanup-required.json", marker },
        { file: "/b/cleanup-required.json", marker: { ...marker, intentIds: ["lighter-order-2", "lighter-order-1"] } },
        { file: "/c/cleanup-required.json", marker: { ...marker, marketId: 0, symbol: "ETH", intentIds: [] } },
      ],
      explicitMarketIds: [1, 5],
    });
    expect(targets.map((target) => target.marketId)).toEqual([0, 1, 5]);
    expect(targets[1]?.intentIds).toEqual(["lighter-order-1", "lighter-order-2"]);
    expect(targets[1]?.sources).toEqual([
      "/a/cleanup-required.json",
      "/b/cleanup-required.json",
      CLEANUP_MARKET_IDS_ENV,
    ]);
    expect(targets[2]?.intentIds).toEqual([]);
  });

  it("reads the explicit market list, and refuses anything that is not a market index", () => {
    expect(parseCleanupMarketIds(" 1, 0 ,1")).toEqual([1, 0]);
    expect(parseCleanupMarketIds(undefined)).toEqual([]);
    for (const raw of ["255", "-1", "1.5", "BTC"]) {
      expect(() => parseCleanupMarketIds(raw), raw).toThrow(LiveHarnessRefusal);
    }
  });

  it("calls proven zero exposure flat, and nothing else", () => {
    const outcome = decideCleanupOutcome({
      marketId: 1,
      symbol: "BTC",
      residualBaseAmount: 0,
      residualValueUsdg: 0,
      unresolvedIntentIds: [],
      providerRefusal: null,
    });
    expect(outcome.kind).toBe("flat");
  });

  it("still carries a failure that happened on the way to a flat account", () => {
    const outcome = decideCleanupOutcome({
      marketId: 1,
      symbol: "BTC",
      residualBaseAmount: 0,
      residualValueUsdg: 0,
      unresolvedIntentIds: [],
      providerRefusal: "the close prepare refused: no position",
    });
    expect(outcome.kind).toBe("flat");
    expect(outcome.detail).toContain("the close prepare refused: no position");
  });

  it("names a residual as a residual, with its size, its value and the provider's own words", () => {
    const outcome = decideCleanupOutcome({
      marketId: 1,
      symbol: "BTC",
      residualBaseAmount: 0.0001,
      residualValueUsdg: 11.5,
      unresolvedIntentIds: [],
      providerRefusal: "below the exchange minimum",
    });
    expect(outcome.kind).toBe("residual");
    expect(outcome.detail).toContain("0.0001");
    expect(outcome.detail).toContain("11.500000 USDG");
    expect(outcome.detail).toContain("below the exchange minimum");
  });

  it("calls a submission without proof unresolved, names the intent, and keeps the measured exposure", () => {
    const outcome = decideCleanupOutcome({
      marketId: 1,
      symbol: "BTC",
      residualBaseAmount: 0.0002,
      residualValueUsdg: 23,
      unresolvedIntentIds: ["lighter-lifecycle-9"],
      providerRefusal: null,
    });
    expect(outcome.kind).toBe("unresolved");
    expect(outcome.detail).toContain("lighter-lifecycle-9");
    expect(outcome.detail).toContain("0.0002");
    expect(outcome.detail).not.toContain("RESIDUAL, not cleanup");
  });
});
