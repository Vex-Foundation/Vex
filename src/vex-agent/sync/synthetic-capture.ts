/**
 * Synthetic capture — records settlement/reconciliation events through the
 * standard capture pipeline without going through runtime.ts.
 *
 * Used by prediction-settlement-sync.ts for auto-settled positions.
 *
 * Pipeline: validate → recordExecution() → populateCaptureItems()
 * → activity-populator → position-projector
 *
 * NOT in MUTATION_MATRIX (no phantom entries). Synthetic captures therefore
 * bypass the matrix-driven `capture-validator`, so this module owns the
 * boundary contract: SYNTHETIC_CONTRACTS is the allowlist of known synthetic
 * tool-ids and their required fields. Unknown synthetic tool-ids reject. See
 * B-006.
 */

import { extractExternalRefs, populateCaptureItems } from "@vex-agent/tools/protocols/capture-pipeline.js";
import logger from "@utils/logger.js";

export interface SyntheticCaptureOpts {
  /** Synthetic toolId — NOT in MUTATION_MATRIX (e.g. "settlement_sync.jupiter"). */
  toolId: string;
  /** Protocol namespace ("solana", "polymarket"). */
  namespace: string;
  /** Session ID (null for background sync). */
  sessionId?: string | null;
  /** Trade capture with standard fields (type, status, walletAddress, positionKey, etc.). */
  tradeCapture: Record<string, unknown>;
  /** Source identifier for audit trail. */
  source: string;
}

/**
 * Contract for a known synthetic tool-id.
 *
 * Synthetic captures skip MUTATION_MATRIX, so this is the matrix-equivalent
 * minimum each synthetic source must satisfy. `requiredFields` always covers
 * the wallet / position / valuation triple plus the type/status discriminators
 * the projection pipeline reads.
 */
interface SyntheticCaptureContract {
  /** Expected `type` discriminator for this synthetic source. */
  readonly expectedType: string;
  /** Capture fields that must be present, non-null, non-empty strings. */
  readonly requiredFields: readonly string[];
}

/**
 * Allowlist of synthetic tool-ids. A tool-id NOT in this map is rejected — a
 * new synthetic source must register an explicit contract here, it cannot
 * silently inherit the fail-open behaviour the runtime grants non-synthetic
 * unknown tools.
 *
 * The wallet/position/valuation triple is required for every entry:
 * - `walletAddress` — account scoping for projections.
 * - `positionKey`   — position the settlement closes/claims.
 * - `valuationSource` — provenance of USD economics ("none" is valid, "" / absent is not).
 */
const SYNTHETIC_CONTRACTS: ReadonlyMap<string, SyntheticCaptureContract> = new Map([
  ["settlement_sync.jupiter", {
    expectedType: "prediction",
    requiredFields: ["type", "status", "walletAddress", "positionKey", "valuationSource"],
  }],
  ["settlement_sync.polymarket", {
    expectedType: "prediction",
    requiredFields: ["type", "status", "walletAddress", "positionKey", "valuationSource"],
  }],
  ["hyperliquid_reconcile.position", {
    expectedType: "perps",
    requiredFields: ["type", "status", "walletAddress", "positionKey", "valuationSource"],
  }],
]);

/**
 * Namespace prefix that marks the synthetic-capture family. Membership is by
 * prefix (not allowlist) so an unregistered `settlement_sync.*` id is still
 * routed into the synthetic validator and REJECTED there — it must never fall
 * back to the fail-open non-synthetic path. See B-006.
 */
const SYNTHETIC_TOOL_PREFIXES = ["settlement_sync.", "hyperliquid_reconcile."] as const;

/** Whether a tool-id belongs to the synthetic-capture family (by prefix). */
export function isSyntheticToolId(toolId: string): boolean {
  return SYNTHETIC_TOOL_PREFIXES.some((prefix) => toolId.startsWith(prefix));
}

/**
 * Validate a synthetic capture against its per-tool-id contract.
 *
 * Throws on: unknown synthetic tool-id, wrong `type`, or any missing required
 * field (wallet/position/valuation included). This is the boundary guard that
 * replaces MUTATION_MATRIX enforcement for synthetic sources.
 */
export function validateSyntheticCapture(
  toolId: string,
  capture: Record<string, unknown>,
): void {
  const contract = SYNTHETIC_CONTRACTS.get(toolId);
  if (!contract) {
    // Reject unknown synthetic tool-ids — no fail-open for the synthetic family.
    throw new Error(`synthetic capture: unknown synthetic tool-id "${toolId}"`);
  }

  const missing: string[] = [];
  for (const field of contract.requiredFields) {
    const value = capture[field];
    if (typeof value !== "string" || value === "") {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `synthetic capture: missing required field(s) for "${toolId}": ${missing.join(", ")}`,
    );
  }

  const type = capture.type as string;
  if (type !== contract.expectedType) {
    throw new Error(
      `synthetic capture: unexpected type "${type}" for "${toolId}" (expected "${contract.expectedType}")`,
    );
  }

  // instrumentKey optional (claim has exception), but warn for a lifecycle
  // source that normally carries one. A legacy close remains auditable.
  if ((type === "prediction" || type === "perps") && !capture.instrumentKey) {
    logger.warn("synthetic_capture.no_instrument_key", { positionKey: capture.positionKey, type });
  }
}

/**
 * Record a synthetic execution and push it through the capture pipeline.
 *
 * Returns the execution ID (> 0 on success, 0 on failure).
 */
export async function recordSyntheticCapture(opts: SyntheticCaptureOpts): Promise<number> {
  const { toolId, namespace, sessionId, tradeCapture, source } = opts;

  // Local validation boundary — synthetic contract (allowlist + required fields).
  validateSyntheticCapture(toolId, tradeCapture);

  const externalRefs = extractExternalRefs({ _tradeCapture: tradeCapture });

  // Write audit row to protocol_executions
  const { recordExecution } = await import("@vex-agent/db/repos/executions.js");
  const executionId = await recordExecution(
    toolId,
    namespace,
    sessionId ?? null,
    { source, detectedAt: new Date().toISOString() },
    { _tradeCapture: tradeCapture },
    true, // success
    tradeCapture,
    externalRefs,
    0, // durationMs — not applicable for sync-originated captures
  );

  if (executionId <= 0) {
    logger.warn("synthetic_capture.execution_failed", { toolId, namespace });
    return 0;
  }

  // Push through capture pipeline → activity → position projector
  // Let errors propagate — caller must know if projection failed so closed count is truthful.
  // Audit row in protocol_executions remains (committed above) as evidence of attempt.
  await populateCaptureItems(executionId, toolId, namespace, tradeCapture, undefined, externalRefs);

  logger.info("synthetic_capture.recorded", {
    toolId, namespace, executionId, source,
    positionKey: tradeCapture.positionKey,
    status: tradeCapture.status,
  });

  return executionId;
}
