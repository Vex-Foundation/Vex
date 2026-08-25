/**
 * Wallet transfer protocol-execution first-writer contract against real
 * PostgreSQL.
 *
 * The handler owns the exact tool-attempt result, transaction reference, and
 * measured duration. Terminal AA settlement also has a conservative repair
 * completion for crash recovery. The execution row is write-once, so the
 * handler must complete it first and a later coordinator fallback must lose
 * without replacing that audit metadata.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { queryOne } from "@vex-agent/db/client.js";
import {
  completeExecutionIntentWith,
  createExecutionIntent,
} from "@vex-agent/db/repos/executions.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

interface StoredExecutionCompletion {
  readonly execution_status: "succeeded" | "failed";
  readonly success: boolean;
  readonly result: Record<string, unknown>;
  readonly external_refs: Record<string, unknown>;
  readonly duration_ms: number;
}

const CASES = [
  {
    name: "confirmed",
    success: true,
    result: {
      status: "confirmed",
      txHash: "0xconfirmed",
      blockTimeIso: "2026-08-25T12:34:56.000Z",
    },
    externalRefs: { txHash: "0xconfirmed" },
    durationMs: 37,
  },
  {
    name: "reverted",
    success: false,
    result: { status: "reverted", txHash: "0xreverted" },
    externalRefs: { txHash: "0xreverted" },
    durationMs: 41,
  },
  {
    name: "failed before broadcast",
    success: false,
    result: { status: "failed_before_broadcast" },
    externalRefs: {},
    durationMs: 43,
  },
] as const;

describe("wallet transfer protocol-execution first writer", () => {
  let sessionId: string;

  beforeEach(async () => {
    await resetDb();
    sessionId = await makeSession();
  });

  it.each(CASES)(
    "preserves the handler's $name metadata when repair completes the same row later",
    async (testCase) => {
      const executionId = await withSessionControlLock(sessionId, (client) =>
        createExecutionIntent(
          "wallet_send_confirm",
          "wallet",
          sessionId,
          { intentId: "intent-first-writer" },
          client,
        ),
      );

      const handlerApplied = await withSessionControlLock(sessionId, (client) =>
        completeExecutionIntentWith(client, {
          executionId,
          result: testCase.result,
          success: testCase.success,
          tradeCapture: null,
          externalRefs: testCase.externalRefs,
          durationMs: testCase.durationMs,
        }),
      );
      expect(handlerApplied).toBe(true);

      const repairApplied = await withSessionControlLock(sessionId, (client) =>
        completeExecutionIntentWith(client, {
          executionId,
          result: { status: testCase.result.status, settledBy: "repair" },
          success: testCase.success,
          tradeCapture: null,
          externalRefs: {},
          durationMs: 0,
        }),
      );
      expect(repairApplied).toBe(false);

      const stored = await queryOne<StoredExecutionCompletion>(
        `SELECT execution_status, success, result, external_refs, duration_ms
           FROM protocol_executions
          WHERE id = $1`,
        [executionId],
      );
      expect(stored).toEqual({
        execution_status: testCase.success ? "succeeded" : "failed",
        success: testCase.success,
        result: testCase.result,
        external_refs: testCase.externalRefs,
        duration_ms: testCase.durationMs,
      });
    },
  );
});
