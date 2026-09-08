/**
 * LIVE STEP 2 - authorize Vex trading fees on the owner's Robinhood Chain
 * Lighter account through the real prepare -> approve -> resume -> verify chain.
 *
 * Gated by `VEX_LIGHTER_LIVE_FEE_AUTHORIZATION=1`. Run AFTER step 1: the fee
 * authorization is signed with the registered trading key.
 *
 * The terms asserted below are the ones the owner authorized for this run. They
 * are checked against the durable APPROVAL CARD (`approval_intents.preview_json`),
 * not against the handler's own return value, because the card is the sentence
 * a human would have read before clicking approve.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness.js")).electronMainStub());

import {
  approveAndResume,
  cardCriticalArgs,
  createLiveSession,
  EXPECTED_ACCOUNT_INDEX,
  flagEnabled,
  installLighterProductionSeams,
  isDryRun,
  LIVE_ENVIRONMENT,
  LIVE_FLAGS,
  openEvidence,
  prepareAndEnqueueApproval,
  printInspectionSql,
  readApprovalRecord,
  requireLiveTarget,
  runReadTool,
  type EvidenceWriter,
  type LiveSession,
} from "./harness.js";

const describeLive = flagEnabled(LIVE_FLAGS.feeAuthorization) ? describe : describe.skip;

/** Owner-authorized terms for this run (1000 ticks perps, 2500 ticks spot). */
const EXPECTED_PERPS_FEE_TICKS = 1000;
const EXPECTED_SPOT_FEE_TICKS = 2500;
/** Vex's fee collector account on Robinhood Chain. */
const EXPECTED_COLLECTOR_ACCOUNT_INDEX = 22869;

let disposeSeams: (() => void) | null = null;
let session: LiveSession | null = null;
let evidence: EvidenceWriter | null = null;
const approvalIds: string[] = [];

beforeAll(async () => {
  evidence = openEvidence("fee-authorization");
  const target = await requireLiveTarget();
  if (isDryRun()) {
    const { runMigrations } = await import("@vex-agent/db/migrate.js");
    await runMigrations();
  }
  disposeSeams = await installLighterProductionSeams();
  session = await createLiveSession(target, "fees");
  evidence.record("target", {
    environment: LIVE_ENVIRONMENT,
    accountIndex: target.accountIndex,
    walletAddress: target.walletAddress,
    sessionId: session.sessionId,
    dryRun: isDryRun(),
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

describeLive("Lighter fee authorization on the owner's Robinhood Chain account", () => {
  it("prepares, approves, signs and verifies the integrator authorization", { timeout: 600_000 }, async () => {
    const live = requireSession();
    const record = requireEvidence();

    const tierBefore = await runReadTool({
      sessionId: live.sessionId,
      publicName: "lighter__fees_status",
      params: { environment: LIVE_ENVIRONMENT },
    });
    record.record("tier-before", { feesStatus: tierBefore.output });

    const prepared = await prepareAndEnqueueApproval({
      sessionId: live.sessionId,
      publicName: "lighter__fees_approve_prepare",
      params: { environment: LIVE_ENVIRONMENT },
    });
    approvalIds.push(prepared.approvalId);

    const card = await readApprovalRecord(prepared.approvalId);
    expect(card.queueStatus).toBe("pending");
    expect(card.decision).toBeNull();
    expect(card.executionStatus).toBe("not_started");
    expect(prepared.followUpToolId).toBe("lighter.fees.approve");

    const critical = cardCriticalArgs(card);
    expect(critical["environment"]).toBe(LIVE_ENVIRONMENT);
    expect(critical["accountIndex"]).toBe(EXPECTED_ACCOUNT_INDEX);
    expect(critical["collectorAccountIndex"]).toBe(EXPECTED_COLLECTOR_ACCOUNT_INDEX);
    expect(critical["maxPerpsMakerFee"]).toBe(EXPECTED_PERPS_FEE_TICKS);
    expect(critical["maxPerpsTakerFee"]).toBe(EXPECTED_PERPS_FEE_TICKS);
    expect(critical["maxSpotMakerFee"]).toBe(EXPECTED_SPOT_FEE_TICKS);
    expect(critical["maxSpotTakerFee"]).toBe(EXPECTED_SPOT_FEE_TICKS);
    expect(critical["revoke"]).toBe(false);

    const prepareJson = JSON.parse(prepared.prepareOutput) as Record<string, unknown>;
    const intentId = prepareJson["intentId"];
    expect(typeof intentId).toBe("string");

    record.record("prepared", {
      approvalId: prepared.approvalId,
      intentId,
      // The tier change and both exchange-tick sides, verbatim from the card.
      currentAccountTier: critical["currentAccountTier"],
      accountChange: critical["accountChange"],
      currentExchangeMakerFeeTick: critical["currentExchangeMakerFeeTick"],
      currentExchangeTakerFeeTick: critical["currentExchangeTakerFeeTick"],
      exchangeFees: critical["exchangeFees"],
      exchangeFeeChange: critical["exchangeFeeChange"],
      authorizationValidUntil: critical["authorizationValidUntil"],
      criticalArgs: critical,
      approvalCard: card,
    });

    if (isDryRun()) return;

    const dispatched = await approveAndResume(prepared.approvalId);
    expect(dispatched.executionStatus).toBe("succeeded");
    expect(dispatched.toolResult.success, dispatched.toolResult.output).toBe(true);

    const verified = await runReadTool({
      sessionId: live.sessionId,
      publicName: "lighter__fees_status",
      params: { environment: LIVE_ENVIRONMENT, intentId },
    });
    const tierAfter = await runReadTool({
      sessionId: live.sessionId,
      publicName: "lighter__fees_status",
      params: { environment: LIVE_ENVIRONMENT },
    });

    record.record("authorized", {
      approvalId: prepared.approvalId,
      intentId,
      executionStatus: dispatched.executionStatus,
      resumeToolOutput: dispatched.toolResult.output,
      reconciledIntent: verified.output,
      feesStatusAfter: tierAfter.output,
    });

    expect(verified.success, verified.output).toBe(true);
    expect(tierAfter.success, tierAfter.output).toBe(true);
  });
});
