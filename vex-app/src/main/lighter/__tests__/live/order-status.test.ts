/**
 * LIVE STEP 5 - reconcile ONE existing order intent through
 * `lighter__order_status`, in the session that owns it, and prove that the
 * fill ledger self-heals.
 *
 * An order that settled from ORDER evidence (an order frame, an inactive-order
 * read) has a terminal durable outcome and, until the follow-up read existed,
 * no `lighter_fills` row at all. The repair arm behind `lighter__order_status`
 * asks the ledger once and, when the fill is missing, reads the account's
 * trades once and records it. This step runs that arm against a real intent
 * and then reads the ledger back from the database: the row, not the tool's
 * word, is the evidence.
 *
 * Gated by `VEX_LIGHTER_LIVE_ORDER_STATUS=1`. Needs
 * `VEX_LIGHTER_LIVE_STATUS_INTENT_ID` (the order execution intent) and
 * `VEX_LIGHTER_LIVE_RESUME_SESSION_ID` (the session that created it; the
 * status tool scopes the intent lookup to its session). Signs nothing,
 * submits nothing.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness.js")).electronMainStub());

import {
  flagEnabled,
  installLighterProductionSeams,
  LIVE_ENVIRONMENT,
  LIVE_FLAGS,
  LiveHarnessRefusal,
  openEvidence,
  orderStatusReport,
  printInspectionSql,
  requireLiveTarget,
  runReadTool,
  type EvidenceWriter,
} from "./harness.js";

const describeLive = flagEnabled(LIVE_FLAGS.orderStatus) ? describe : describe.skip;

let disposeSeams: (() => void) | null = null;
let evidence: EvidenceWriter | null = null;
let sessionId: string | null = null;
let intentId: string | null = null;

function requiredSetting(name: string, why: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new LiveHarnessRefusal(`${name} is not set. ${why}`);
  }
  return value;
}

beforeAll(async () => {
  evidence = openEvidence("order-status");
  intentId = requiredSetting("VEX_LIGHTER_LIVE_STATUS_INTENT_ID", "It names the order intent to reconcile.");
  sessionId = requiredSetting(
    "VEX_LIGHTER_LIVE_RESUME_SESSION_ID",
    "The status tool scopes the intent lookup to the session that created it.",
  );
  const target = await requireLiveTarget();
  disposeSeams = await installLighterProductionSeams();
  evidence.record("target", {
    environment: LIVE_ENVIRONMENT,
    accountIndex: target.accountIndex,
    walletAddress: target.walletAddress,
    sessionId,
    intentId,
  });
});

afterAll(async () => {
  if (sessionId !== null) printInspectionSql(sessionId, []);
  disposeSeams?.();
  const { closePool } = await import("@vex-agent/db/client.js");
  await closePool();
});

describeLive("reconcile one settled order intent and let the fill ledger catch up", () => {
  it("runs lighter__order_status in the owning session and finds the fill in lighter_fills", { timeout: 300_000 }, async () => {
    if (sessionId === null || intentId === null || evidence === null) throw new Error("The live step was not set up.");
    const { query } = await import("@vex-agent/db/client.js");
    const ledgerRowsFor = (id: string) => query<{ id: string | number; canonical_identity: string; trade_type: string; usd_amount: string; position_effect: string | null }>(
      "SELECT id, canonical_identity, trade_type, usd_amount, position_effect FROM lighter_fills WHERE execution_intent_id = $1 ORDER BY id",
      [id],
    );

    const before = await ledgerRowsFor(intentId);
    const status = await runReadTool({
      sessionId,
      publicName: "lighter__order_status",
      params: { environment: LIVE_ENVIRONMENT, intentId },
    });
    const report = orderStatusReport(status.json, intentId);
    const after = await ledgerRowsFor(intentId);
    evidence.record("status", {
      intentId,
      ledgerRowsBefore: before,
      statusOutput: status.output,
      report,
      ledgerRowsAfter: after,
    });

    expect(status.success, status.output).toBe(true);
    expect(report).not.toBeNull();
    expect(after.length, "the fill ledger holds no row for this intent after the repair").toBeGreaterThan(0);
  });
});
