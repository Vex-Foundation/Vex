/**
 * Capture validator — runtime boundary check for _tradeCapture contracts.
 *
 * Called by runtime.ts after handler return, before projection pipeline.
 * Blocks capture:"full" results that lack required fields — fail-loud
 * instead of silent null-fill in downstream.
 */

import { MUTATION_MATRIX, isExpectedType } from "./mutation-matrix.js";
import { isSyntheticToolId, validateSyntheticCapture } from "@vex-agent/sync/synthetic-capture.js";
import logger from "@utils/logger.js";

/**
 * Validate a capture against its mutation contract.
 * Returns true if capture is valid and should proceed to projection pipeline.
 * Returns false if capture is invalid — caller should skip projection.
 */
export function validateCaptureContract(
  toolId: string,
  tradeCapture: Record<string, unknown> | null,
): boolean {
  // Synthetic captures (settlement_sync.*) are NOT in MUTATION_MATRIX — route
  // them to their own allowlist+required-field contract instead of the
  // fail-open unknown-tool path below. Unknown synthetic tool-ids and
  // missing wallet/position/valuation fields reject (fail-closed). See B-006.
  if (isSyntheticToolId(toolId)) {
    if (!tradeCapture) {
      logger.error("capture.validator.synthetic_missing_capture", { toolId });
      return false;
    }
    try {
      validateSyntheticCapture(toolId, tradeCapture);
      return true;
    } catch (err) {
      logger.error("capture.validator.synthetic_rejected", {
        toolId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  const contract = MUTATION_MATRIX.get(toolId);
  if (!contract) {
    // Tool not in matrix — non-mutating or unknown. Let it through (no contract to validate against).
    return true;
  }

  if (contract.capture === "none") {
    // No capture expected — nothing to validate.
    return true;
  }

  // capture === "full" — handler must provide _tradeCapture
  if (!tradeCapture) {
    logger.error("capture.validator.missing_capture", {
      toolId,
      kind: contract.kind,
      hint: `Handler returned success without _tradeCapture but matrix requires capture:"full"`,
    });
    return false;
  }

  // Validate expectedType (type is now a required field — always present after field check)
  const actualType = typeof tradeCapture.type === "string" ? tradeCapture.type : "";
  if (actualType && !isExpectedType(contract, actualType)) {
    logger.error("capture.validator.unexpected_type", {
      toolId,
      expected: contract.expectedType,
      actual: actualType,
    });
    return false;
  }

  // Check required fields (with exception support)
  const missingFields: string[] = [];
  for (const field of contract.requiredFields) {
    const value = tradeCapture[field];
    if (value === undefined || value === null || value === "") {
      // Check if this field has an exception
      const hasException = hasRequiredFieldException(field, tradeCapture, contract.exceptions);
      if (!hasException) {
        missingFields.push(field);
      }
    }
  }

  if (missingFields.length > 0) {
    logger.error("capture.validator.missing_fields", {
      toolId,
      kind: contract.kind,
      missingFields,
      hint: `Required fields for ${contract.kind}: [${contract.requiredFields.join(", ")}]`,
    });
    return false;
  }

  // Validate required meta fields (e.g. Hyperliquid protection-gate inputs)
  if (contract.requiredMetaFields && contract.requiredMetaFields.length > 0) {
    const meta = tradeCapture.meta as Record<string, unknown> | undefined;
    const missingMeta: string[] = [];
    for (const field of contract.requiredMetaFields) {
      const value = meta?.[field];
      if (value === undefined || value === null || value === "") {
        missingMeta.push(field);
      }
    }
    if (missingMeta.length > 0) {
      logger.error("capture.validator.missing_meta_fields", {
        toolId,
        missingMetaFields: missingMeta,
        hint: `Required meta fields: [${contract.requiredMetaFields.join(", ")}]`,
      });
      return false;
    }
  }

  return true;
}

function hasRequiredFieldException(
  field: string,
  tradeCapture: Record<string, unknown>,
  exceptions: readonly string[] | undefined,
): boolean {
  if (!exceptions?.some(e => e.toLowerCase().includes(`no ${field.toLowerCase()}`))) {
    return false;
  }

  if (field !== "tradeSide") return true;

  const meta = tradeCapture.meta as Record<string, unknown> | undefined;
  return meta?.stableSwap === true || meta?.ambiguousSwap === true;
}

/**
 * Check if a tool execution is a preview (dryRun) based on mutation contract.
 * Returns true if the tool supports preview AND the params indicate dryRun.
 */
export function isPreviewExecution(
  toolId: string,
  params: Record<string, unknown>,
): boolean {
  const contract = MUTATION_MATRIX.get(toolId);
  return contract?.previewSupport === true && params.dryRun === true;
}
