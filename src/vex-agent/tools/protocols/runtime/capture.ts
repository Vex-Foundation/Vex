/**
 * Execution capture - capture validation / projection / audit recording.
 *
 * Extracted verbatim from `../runtime.ts` as part of a façade-preserving
 * structural split. `executeProtocolTool` (in the runtime façade) calls
 * `captureExecution` after a mutating handler runs; this module owns the
 * audit-record + projection-population pipeline.
 */

import type { ToolResult } from "../../types.js";
import { validateCaptureContract } from "../capture-validator.js";
import { extractExternalRefs, populateCaptureItems } from "../capture-pipeline.js";
import { MUTATION_MATRIX } from "../mutation-matrix.js";
import { sanitizeJsonbValue } from "@vex-agent/db/params.js";
import logger from "@utils/logger.js";

// ── Execution capture ───────────────────────────────────────────

// extractExternalRefs moved to capture-pipeline.ts (shared with replay.ts)

export async function captureExecution(
  toolId: string,
  namespace: string,
  sessionId: string | null,
  params: Record<string, unknown>,
  result: ToolResult,
  durationMs: number,
  existingExecutionId?: number,
): Promise<void> {
  // Defense-in-depth: preview results are NOT mutations - skip entire capture pipeline
  if (result.data?.dryRun === true) return;

  const { completeExecutionIntentWith, recordExecution, getById } = await import("@vex-agent/db/repos/executions.js");
  const paramsForStorage = sanitizeRecord(params);
  const resultData = sanitizeRecord(result.data ?? {});
  const tradeCapture = isRecord(resultData._tradeCapture) ? resultData._tradeCapture : null;
  const tradeCaptureItems = sanitizeRecordArray(resultData._tradeCaptureItems);
  const externalRefs = extractExternalRefs(resultData);

  // Agent Scan (plan §11.1 step 4): a handler that already created its OWN
  // `protocol_executions` intent row BEFORE broadcasting (the Kyber/Uniswap
  // execute handlers) embeds that id as `_executionId` on the returned
  // ToolResult.data - the SAME underscore-prefixed internal-metadata
  // convention as `_tradeCapture`. Reusing it here (exactly like the explicit
  // `existingExecutionId` param) keeps post-handler capture from creating a
  // SECOND audit row for the same attempt.
  //
  // PROVENANCE CHECK (FIX-SPINE round 1, finding 13/C10): unlike
  // `existingExecutionId` (a trusted internal call parameter the runtime
  // itself computes before invoking a handler), `_executionId` arrives on an
  // adopted ONLY when the referenced `protocol_executions` row's own
  // `tool_id`/`namespace` match the tool CURRENTLY executing - a mismatch
  // (or a missing row) is logged and this capture falls through to creating
  // a FRESH execution row instead, exactly as if no id had been supplied.
  // This can never adopt a foreign/forged intent.
  const resultExecutionId = typeof resultData._executionId === "number" ? resultData._executionId : undefined;
  let priorExecutionId = existingExecutionId;
  if (priorExecutionId === undefined && resultExecutionId !== undefined) {
    const candidate = await getById(resultExecutionId);
    if (candidate && candidate.toolId === toolId && candidate.namespace === namespace) {
      priorExecutionId = resultExecutionId;
    } else {
      logger.warn("protocol.execute.execution_id_provenance_mismatch", {
        toolId, namespace, claimedExecutionId: resultExecutionId,
        foundToolId: candidate?.toolId ?? null, foundNamespace: candidate?.namespace ?? null,
      });
    }
  }

  const executionId = priorExecutionId ?? await recordExecution(
    toolId, namespace, sessionId, paramsForStorage,
    resultData, result.success,
    tradeCapture, externalRefs, durationMs,
  );
  if (priorExecutionId !== undefined) {
    // Short, DB-only, under the session control lock - the handler's broadcast
    // is already finished by the time capture runs, so nothing external happens
    // inside it. An `intent` row is unresolved money state for the compaction
    // safe-moment gate; settling it must be strictly ordered against that gate
    // rather than able to interleave with it.
    //
    // A NULL session is deliberately completed WITHOUT the lock: the gate is
    // session-scoped, so such a row is outside it by construction and there is
    // no key to serialize on. (Widening the gate to a global scan would block
    // unrelated sessions - see the KNOWN GAP in
    // `db/repos/approval-intents/money-state.ts`.)
    const completion = {
      executionId: priorExecutionId,
      result: resultData,
      success: result.success,
      tradeCapture,
      externalRefs,
      durationMs,
    };
    if (sessionId === null) {
      const { withTransaction } = await import("@vex-agent/db/client.js");
      await withTransaction((client) =>
        completeExecutionIntentWith(client, completion),
      );
    } else {
      const { withSessionControlLock } = await import(
        "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js"
      );
      await withSessionControlLock(sessionId, (client) =>
        completeExecutionIntentWith(client, completion),
      );
    }
  }

  // Enqueue sync runs for this namespace (only on success - failed mutations don't need projection refresh)
  if (result.success && executionId > 0) {
    try {
      const { getJobsForNamespace, enqueueRun } = await import("@vex-agent/db/repos/sync.js");
      const jobs = await getJobsForNamespace(namespace);
      for (const job of jobs) {
        await enqueueRun(job.id, executionId);
      }
    } catch (err) {
      logger.warn("protocol.execute.sync_enqueue_failed", {
        toolId, namespace, executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Populate proj_activity ONLY for successful executions (projections = business truth)
  // Failed mutations go to protocol_executions audit log but NOT to activity/positions/lots
  if (executionId > 0 && result.success) {
    // Validate capture contract before sending to projection pipeline
    // For fanOut:"items" tools, validate items (not summary) - summary intentionally lacks per-item identity
    const contract = MUTATION_MATRIX.get(toolId);
    const itemsToValidate = contract?.fanOut === "items" && Array.isArray(tradeCaptureItems) && tradeCaptureItems.length > 0
      ? tradeCaptureItems
      : tradeCapture ? [tradeCapture] : [];
    const allValid = itemsToValidate.every(item => validateCaptureContract(toolId, item));
    if (!allValid) {
      logger.warn("protocol.execute.capture_validation_failed", {
        toolId, namespace, executionId,
        hint: "Capture blocked by validator - not sent to projection pipeline",
      });
      return;
    }
    try {
      await populateCaptureItems(executionId, toolId, namespace, tradeCapture, tradeCaptureItems, externalRefs);
    } catch (err) {
      logger.warn("protocol.execute.activity_populate_failed", {
        toolId, namespace, executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// populateCaptureItems moved to capture-pipeline.ts (shared with replay.ts)

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeJsonbValue(value);
  return isRecord(sanitized) ? sanitized : {};
}

function sanitizeRecordArray(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const sanitized = sanitizeJsonbValue(value);
  if (!Array.isArray(sanitized)) return undefined;

  const records = sanitized.filter(isRecord);
  return records.length > 0 ? records : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
