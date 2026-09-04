/**
 * Capture pipeline - shared logic for recording capture items and populating activity.
 *
 * Used by:
 * - runtime.ts (inline after execution)
 * - replay.ts (one-time historical correction)
 *
 * Pipeline: capture items → recordCaptureItems() → populateActivity() per item
 */

import { sanitizeJsonbValue } from "@vex-agent/db/params.js";
import { MUTATION_MATRIX } from "./mutation-matrix.js";
import logger from "@utils/logger.js";

/**
 * Extract external_refs from handler result data for correlation/lookup.
 * Maps known fields per namespace to canonical keys.
 */
export function extractExternalRefs(data: Record<string, unknown> | undefined): Record<string, string> {
  if (!data) return {};
  const refs: Record<string, string> = {};
  const candidates = ["txHash", "orderId", "positionPubkey", "orderKey", "positionId", "conditionId", "signature", "instrumentKey", "positionKey"];

  for (const key of candidates) {
    let value = data[key];
    // Normalize: Polymarket returns "orderID" instead of "orderId"
    if (value === undefined && key === "orderId") value = data["orderID"];
    // Coerce numbers to strings (KyberSwap orderId can be number)
    if (typeof value === "number") value = String(value);
    if (typeof value === "string" && value) refs[key] = value;
  }

  // Check nested _tradeCapture for refs not in top-level data
  const capture = data._tradeCapture as Record<string, unknown> | undefined;
  if (capture) {
    if (!refs.signature && typeof capture.signature === "string" && capture.signature) {
      refs.signature = capture.signature;
    }
    if (!refs.positionKey && typeof capture.positionKey === "string" && capture.positionKey) {
      refs.positionKey = capture.positionKey;
    }
    if (!refs.instrumentKey && typeof capture.instrumentKey === "string" && capture.instrumentKey) {
      refs.instrumentKey = capture.instrumentKey;
    }
    const meta = capture.meta as Record<string, unknown> | undefined;
    if (!refs.positionPubkey && typeof meta?.positionPubkey === "string" && meta.positionPubkey) {
      refs.positionPubkey = meta.positionPubkey;
    }
    if (!refs.conditionId && typeof meta?.conditionId === "string" && meta.conditionId) {
      refs.conditionId = meta.conditionId;
    }
  }

  return refs;
}

/**
 * Record capture items and populate activity rows.
 *
 * Batch handlers (predict.closeAll) emit _tradeCaptureItems → N items → N activity rows.
 * Single handlers emit _tradeCapture → synthesized 1 item → 1 activity row.
 */
export async function populateCaptureItems(
  executionId: number,
  toolId: string,
  namespace: string,
  tradeCapture: Record<string, unknown> | null,
  tradeCaptureItems: Record<string, unknown>[] | undefined,
  executionExternalRefs: Record<string, string>,
): Promise<void> {
  const hasItems = Array.isArray(tradeCaptureItems) && tradeCaptureItems.length > 0;

  // FAIL-CLOSED GUARD: a `strictItemsRequired` fanOut:"items" tool MUST
  // provide per-item captures. Its summary `_tradeCapture` carries a SINGLE
  // instrumentKey, so falling back to project it would collapse the tool's N
  // distinct legs (e.g. a mint's PT lot AND YT lot) into one mislabeled lot -
  // a portfolio-integrity bug. When such a tool yields no items, skip
  // projection entirely rather than silently project the summary. Other
  // fanOut:"items" tools (e.g. the prediction batch close-all) leave this
  // unset - their zero-item summary fallback is safe.
  const contract = MUTATION_MATRIX.get(toolId);
  if (contract?.fanOut === "items" && contract.strictItemsRequired && !hasItems) {
    logger.warn("protocol.capture.items_fanout_missing_items", {
      toolId,
      hint: "spot fanOut:items tool emitted no _tradeCaptureItems - summary NOT projected (fail-closed)",
    });
    return;
  }

  const items: Record<string, unknown>[] = hasItems
    ? tradeCaptureItems!
    : tradeCapture ? [tradeCapture] : [];

  if (items.length === 0) return;
  const sanitizedItems = items.map(sanitizeCaptureRecord);

  const { recordCaptureItems } = await import("@vex-agent/db/repos/capture-items.js");
  const { populateActivity } = await import("@vex-agent/sync/activity-populator.js");

  const captureItemIds = await recordCaptureItems(
    executionId,
    sanitizedItems.map(item => ({
      tradeCapture: item,
      externalRefs: extractExternalRefs({ _tradeCapture: item }),
    })),
  );

  for (let i = 0; i < sanitizedItems.length; i++) {
    const itemRefs = extractExternalRefs({ _tradeCapture: sanitizedItems[i] });
    const mergedRefs = { ...executionExternalRefs, ...itemRefs };
    await populateActivity(executionId, captureItemIds[i] ?? null, toolId, namespace, sanitizedItems[i], mergedRefs);
  }

  // NOTE: the ledger→memory wake call that used to live here
  // (`memory/ledger-wake.js`'s `enqueueLedgerWake`) is REMOVED - the async
  // reconcile machinery it fed is retired this phase (plan §4.4). Memory
  // teardown (W4) deletes the ledger-wake module itself; this removal lands
  // first so that deletion cannot leave a dangling import here.
}

/**
 * Populate activity rows from existing capture items (for replay).
 * Does NOT record new capture items - reads what's already in the DB.
 * Preserves capture_item_id FK when available.
 */
export async function replayActivityFromCapture(
  executionId: number,
  toolId: string,
  namespace: string,
  captureItems: { id: number | null; data: Record<string, unknown> }[],
  executionExternalRefs: Record<string, string>,
): Promise<void> {
  const { populateActivity } = await import("@vex-agent/sync/activity-populator.js");

  for (const item of captureItems) {
    const itemRefs = extractExternalRefs({ _tradeCapture: item.data });
    const mergedRefs = { ...executionExternalRefs, ...itemRefs };
    await populateActivity(executionId, item.id, toolId, namespace, item.data, mergedRefs);
  }
}

function sanitizeCaptureRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeJsonbValue(value);
  return isRecord(sanitized) ? sanitized : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
