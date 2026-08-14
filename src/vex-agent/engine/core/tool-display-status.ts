/**
 * Tool DISPLAY status — derive the renderer-facing status of an ambiguous tool
 * result from its structured `data` at transcript-persistence time, BEFORE
 * `result.data` is dropped from the transcript. Sibling of `explorer-refs.ts`
 * and persisted the same way: under the tool-result message metadata payload,
 * surfacing as `metadata -> 'displayStatus'` for the desktop app.
 *
 * WHY THIS EXISTS. A broadcast whose receipt never came back is persisted
 * `success: false` ON PURPOSE — the model must not read ambiguity as success,
 * and the remaining legs of a batch must abort. That is the correct
 * MODEL-facing semantic and this module does not change it. But the chat UI
 * derived its chip from `success` alone, so it printed a red FAILED directly
 * above the handler's own "recorded as pending and will resolve automatically"
 * prose — a contradiction the user can see. This is the second, DISPLAY-only
 * axis that lets the renderer say "Pending" for exactly that case.
 *
 * THE CONTRACT is the ambiguous-broadcast shape the swap handlers already
 * emit: `data.status` is one of a CLOSED allowlist of in-progress literals,
 * alongside the `txHash` that was broadcast. Lighter order creation has a
 * source-scoped variant because its `ambiguous` / `sequencer_pending` statuses
 * are order-specific and too broad to admit globally. Nothing is normalized and
 * nothing is inferred — `data` is untrusted (provider/model-derived), so only
 * an exact string literal on a plain object counts. Every other shape yields
 * `null`, which reads as "no
 * display status" and leaves the row rendering off `success` exactly as
 * before. Legacy rows persisted before this key existed therefore keep their
 * current display; there is no backfill.
 *
 * Pure, no I/O.
 */

/**
 * Renderer-facing display status for a tool-result row. Deliberately a single
 * literal rather than an open string: it is a display CLAIM, and each new
 * variant needs its own renderer treatment and its own decision.
 */
export type ToolDisplayStatus = "pending";

const PENDING_STATUS = "pending";

/**
 * The CLOSED set of `data.status` literals that mean "in progress, outcome not
 * yet known" and therefore display as Pending. Each entry is admitted with its
 * emitting site, because each one is a claim about money in motion:
 *
 *  - `pending`            — the ambiguous-broadcast marker the swap/bridge
 *                           handlers set when a receipt never came back.
 *  - `filled_unverified`  — `protocols/khalani/handlers/bridge-poll.ts:66`: the
 *                           provider reports `filled`, but the destination fill
 *                           is NOT verified, so the handler refuses to claim it.
 *  - `in_flight`          — `protocols/relay/handlers/bridge.ts:415`: the
 *                           deposit is broadcast and the relay leg is running.
 *
 * NOT admitted, deliberately: khalani's terminal `failed` / `refunded` — the
 * destination never received funds, so a red FAILED row is the honest display.
 * Any unknown string fails closed to `null`; a new in-progress literal must be
 * added here on purpose, with its source, rather than inferred.
 */
const PENDING_EQUIVALENT_STATUSES: ReadonlySet<string> = new Set([
  PENDING_STATUS,
  "filled_unverified",
  "in_flight",
]);

const LIGHTER_PENDING_SOURCE = "vex_lighter_live_order_create";
const LIGHTER_PENDING_STATUSES: ReadonlySet<string> = new Set([
  "ambiguous",
  "sequencer_pending",
]);

export function deriveToolDisplayStatus(data: unknown): ToolDisplayStatus | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const source = (data as Record<string, unknown>)["source"];
  const status = (data as Record<string, unknown>)["status"];
  if (
    source === LIGHTER_PENDING_SOURCE
    && typeof status === "string"
    && LIGHTER_PENDING_STATUSES.has(status)
  ) {
    return PENDING_STATUS;
  }
  return typeof status === "string" && PENDING_EQUIVALENT_STATUSES.has(status)
    ? PENDING_STATUS
    : null;
}

/**
 * Spread-ready form for the persistence sites: the key is OMITTED entirely
 * when there is no display status, so an ordinary tool-result row carries no
 * extra JSONB (same shape discipline as `explorerRefs` / `durationMs`).
 */
export function displayStatusPayload(
  data: unknown,
): { readonly displayStatus?: ToolDisplayStatus } {
  const status = deriveToolDisplayStatus(data);
  return status === null ? {} : { displayStatus: status };
}
