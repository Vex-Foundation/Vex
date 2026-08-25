/**
 * THE DURABLE APPROVAL CARD for a bound proposal - built in ONE place, compared
 * in ONE place.
 *
 * ## Why this module exists
 *
 * `approval_intents.preview_json` is the row the approval UI renders, and the
 * renderer shows `toolName` as the card's TITLE (`approvals-db.ts` ->
 * `ApprovalCard.tsx`). The confirm handler used to re-derive only
 * `criticalArgs` from the intent and compare that, deliberately excluding the
 * title - which left an edit to `preview_json.toolName` invisible: the human
 * reads a harmless title, approves, and the envelope dispatches the transaction
 * it always described.
 *
 * The fix is not another comparison beside the first one. It is ONE builder,
 * used by the enqueue path that WRITES the row and by the confirm path that
 * CHECKS it, so the two copies cannot drift apart by construction and every
 * field the builder emits is a field the check covers.
 *
 * ## What is compared
 *
 * The COMPLETE card: `toolName`, the presence or absence of `namespace`, the
 * label (which rides `criticalArgs.effect`, because `IntentPreview` has no label
 * field and the renderer shows the whole map), and every `criticalArgs` key. No
 * key may appear or vanish on either side - an ADDED key is exactly the shape a
 * misleading card takes, with the true facts still present and one more line the
 * user reads as authoritative.
 *
 * ## The tool name is CANONICALIZED
 *
 * The card stores `resolveToolName(toolName)`, the same canonical identity
 * `buildApprovalToolCall` writes into the envelope. That is what makes the
 * confirm side able to state an expected title at all: it has no copy of the
 * name the enqueue path was called with, but it holds the stored envelope, and
 * the envelope names the tool that will actually be dispatched. A retired
 * spelling and its canonical name are the same tool, so normalizing both sides
 * compares tool IDENTITY rather than spelling.
 */

import { resolveToolName } from "@vex-agent/tools/registry/name-resolution.js";

import type { IntentPreview } from "../approval-intent-preview.js";

/** The scalar map both the card and the binding preview carry. */
type CriticalArgs = Record<string, string | number | boolean | null>;

/**
 * What the card is built FROM: the confirm handler's own
 * `ToolResult.preparedApprovalBinding`, narrowed to the fields the card shows.
 */
export interface DurableApprovalCardSource {
  readonly preview: { readonly label: string; readonly criticalArgs: CriticalArgs };
  readonly intentExpiresAt: string;
  readonly resource: { readonly intentId: string };
}

/**
 * The ONE canonical card for a bound proposal.
 *
 * No `namespace`: this lane's tools are internal handlers with no protocol
 * namespace, and the comparison below treats an APPEARING namespace as a
 * difference, so the absence is part of the contract rather than an omission.
 */
export function buildDurableApprovalCard(
  toolName: string,
  binding: DurableApprovalCardSource,
): IntentPreview {
  return {
    toolName: resolveToolName(toolName),
    criticalArgs: {
      ...binding.preview.criticalArgs,
      effect: binding.preview.label,
      intentId: binding.resource.intentId,
      expiresAt: binding.intentExpiresAt,
    },
  };
}

/**
 * The canonical tool identity recorded on a stored approval envelope, or `null`
 * when the envelope carries none.
 *
 * The canonicalized `execute_tool` arm keeps the name the model emitted in
 * `vex.originalToolName`, so that is the one resolved there; every other lane
 * stores the canonical name in `command` directly. `null` means the envelope
 * cannot state which tool it is, and a caller on the money path treats that as a
 * refusal.
 */
export function readEnvelopeToolName(rawToolCall: Record<string, unknown>): string | null {
  const vex = rawToolCall.vex;
  if (typeof vex === "object" && vex !== null) {
    const original = (vex as { originalToolName?: unknown }).originalToolName;
    if (typeof original === "string" && original.length > 0) return resolveToolName(original);
  }
  const command = rawToolCall.command;
  if (typeof command === "string" && command.length > 0) return resolveToolName(command);
  return null;
}

/**
 * WHOLE-CARD equality against a raw stored `preview_json`.
 *
 * `stored` is untrusted durable JSONB, so it is validated structurally here
 * rather than cast: anything that is not an object with an object
 * `criticalArgs` of scalars is not the card this builder produces, and reports
 * unequal.
 */
export function durableApprovalCardMatches(expected: IntentPreview, stored: unknown): boolean {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return false;
  const card = stored as Record<string, unknown>;

  // The TITLE. Compared as canonical identity on both sides, because the stored
  // value is written by `buildDurableApprovalCard` and the expected value comes
  // from the envelope's own canonical name.
  if (typeof card.toolName !== "string") return false;
  if (resolveToolName(card.toolName) !== expected.toolName) return false;

  // PRESENCE as well as value: a namespace that appears on the stored card is a
  // renderer-visible field this build never wrote.
  const expectedHasNamespace = expected.namespace !== undefined;
  const storedHasNamespace = Object.prototype.hasOwnProperty.call(card, "namespace");
  if (expectedHasNamespace !== storedHasNamespace) return false;
  if (expectedHasNamespace && card.namespace !== expected.namespace) return false;

  // No OTHER top-level key may exist: the card is what the renderer reads whole.
  const allowed = new Set(["toolName", "criticalArgs", ...(storedHasNamespace ? ["namespace"] : [])]);
  if (Object.keys(card).some((key) => !allowed.has(key))) return false;

  const storedArgs = card.criticalArgs;
  if (typeof storedArgs !== "object" || storedArgs === null || Array.isArray(storedArgs)) {
    return false;
  }
  const actual = storedArgs as Record<string, unknown>;
  const expectedKeys = Object.keys(expected.criticalArgs).sort();
  const actualKeys = Object.keys(actual).sort();
  if (expectedKeys.length !== actualKeys.length) return false;
  return expectedKeys.every(
    (key, index) => key === actualKeys[index] && actual[key] === expected.criticalArgs[key],
  );
}
