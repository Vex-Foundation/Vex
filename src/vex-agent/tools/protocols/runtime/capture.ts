/**
 * Execution capture — capture validation / projection / audit recording.
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
  // Defense-in-depth: preview results are NOT mutations — skip entire capture pipeline
  if (result.data?.dryRun === true) return;

  const { completeExecutionIntent, recordExecution } = await import("@vex-agent/db/repos/executions.js");
  const paramsForStorage = sanitizeRecord(params);
  const resultData = sanitizeRecord(result.data ?? {});
  const tradeCapture = isRecord(resultData._tradeCapture) ? resultData._tradeCapture : null;
  const tradeCaptureItems = sanitizeRecordArray(resultData._tradeCaptureItems);
  const externalRefs = extractExternalRefs(resultData);

  const executionId = existingExecutionId ?? await recordExecution(
    toolId, namespace, sessionId, paramsForStorage,
    resultData, result.success,
    tradeCapture, externalRefs, durationMs,
  );
  if (existingExecutionId !== undefined) {
    await completeExecutionIntent(
      existingExecutionId, resultData, result.success, tradeCapture, externalRefs, durationMs,
    );
  }

  // Enqueue sync runs for this namespace (only on success — failed mutations don't need projection refresh)
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
    // For fanOut:"items" tools, validate items (not summary) — summary intentionally lacks per-item identity
    const contract = MUTATION_MATRIX.get(toolId);
    const itemsToValidate = contract?.fanOut === "items" && Array.isArray(tradeCaptureItems) && tradeCaptureItems.length > 0
      ? tradeCaptureItems
      : tradeCapture ? [tradeCapture] : [];
    const allValid = itemsToValidate.every(item => validateCaptureContract(toolId, item));
    if (!allValid) {
      logger.warn("protocol.execute.capture_validation_failed", {
        toolId, namespace, executionId,
        hint: "Capture blocked by validator — not sent to projection pipeline",
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

/** Insert the Hyperliquid audit record before the handler can reach signing. */
export async function createHyperliquidExecutionIntent(
  toolId: string,
  namespace: string,
  sessionId: string | null,
  params: Record<string, unknown>,
): Promise<number> {
  const { createExecutionIntent } = await import("@vex-agent/db/repos/executions.js");
  const executionId = await createExecutionIntent(toolId, namespace, sessionId, sanitizeRecord(params));
  if (executionId <= 0) throw new Error("durable intent insert returned no execution id");
  return executionId;
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
