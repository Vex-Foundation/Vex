/**
 * SWAP / BRIDGE LEG LINE — the "VEX → USDC" summary a friendly tool card shows
 * instead of raw JSON as its primary view.
 *
 * Reads the SANITIZED args/output strings the DTO carries. Both are untrusted.
 * `toolArgs` is capped at 2000 chars by `toolCallDisplaySchema`; the OUTPUT
 * string is a `tool_result` row's `content` and is NOT bounded by the DTO at
 * all, so this module applies its own `MAX_PARSE_CHARS` gate before ever
 * handing text to `JSON.parse` — a multi-megabyte tool result must never cost
 * the renderer a synchronous parse per visible card. Every failure mode —
 * oversized, truncated, malformed, missing token key, non-string token,
 * unrecognised shape — returns `null`, and the card then shows no legs at all.
 *
 * OUTCOME IS PART OF THE TRUTH (rules/90). A leg pair carries the execution
 * outcome the engine persisted (`SessionMessageDto.success`, `null` = UNKNOWN,
 * never success) COMBINED with the act's operation identity from
 * `toolOperation.ts` — because `success` only means the CALL succeeded, not
 * that funds moved: a successful `swap_quote` is a preview, not a trade. Only
 * a proven-successful act may read the untrusted output for its numbers; a
 * requested or failed act is parsed from the ARGS alone. Only a proven MUTATING
 * operation may render without a label, so a preview, a pending, a denied or a
 * failed call can never be dressed up as a completed trade.
 *
 * NEVER GUESS AN AMOUNT (rules/90 money-path discipline). Token identity goes
 * through `lib/token-leg-display.ts`'s `tokenDisplay` (the ONE brand-gating
 * grammar — a brand ticker + logo requires a proven mint), and amounts through
 * its `amountDisplay` with `trustedHuman: false`, so a raw base-unit integer
 * with no decimals to read it by prints NOTHING rather than a thousandfold lie.
 * A leg with no printable amount still names its token — that is honest; an
 * invented number is not.
 */

import {
  amountDisplay,
  tokenDisplay,
  type TokenDisplay,
} from "../../../lib/token-leg-display.js";
import type { ToolDisplayStatus } from "@shared/schemas/messages.js";
import type { ToolOperation } from "./toolOperation.js";

export interface ToolLeg {
  /** Token identity resolved through the shared brand-gating grammar. */
  readonly token: TokenDisplay;
  /** Formatted human amount, or `null` when none could be PROVEN readable. */
  readonly amount: string | null;
}

/**
 * What the ledger is allowed to CLAIM about this leg pair:
 *  - `executed` — a proven MUTATING operation the engine persisted as
 *    `success: true`; the output may be read and the numbers may be presented
 *    as what happened. The ONLY unlabelled outcome.
 *  - `quote` — a proven READ-ONLY preview that succeeded. Its numbers are
 *    real quote numbers, so the output may be read, but nothing moved and the
 *    renderer must say "Quote".
 *  - `completed` — the call succeeded but its operation identity is unproven
 *    (`toolOperation.ts` `unproven`). Numbers may be read; the claim stops at
 *    "the call completed".
 *  - `pending` — persisted `success: false` PLUS the engine's ambiguous-
 *    broadcast display status: the transaction went out, the receipt never
 *    came back. Neither a failure nor a completion, so it is labelled
 *    "Pending" and — exactly like `requested` — reads the ARGS only.
 *  - `failed` — persisted `success: false`; no amount is presented as fact.
 *  - `requested` — UNKNOWN outcome (pending, denied, unpaired, legacy row).
 *    Args-only, and the renderer must mark it visibly as a request.
 */
export type ToolLegOutcome =
  | "executed"
  | "quote"
  | "completed"
  | "failed"
  | "pending"
  | "requested";

export interface ToolLegPair {
  readonly from: ToolLeg;
  readonly to: ToolLeg;
  readonly outcome: ToolLegOutcome;
}

/** Key aliases the swap/bridge tools use for each side of a leg pair. */
const FROM_TOKEN_KEYS = ["tokenIn", "fromToken", "inputMint", "sellToken", "tokenFrom"];
const TO_TOKEN_KEYS = ["tokenOut", "toToken", "outputMint", "buyToken", "tokenTo"];
const FROM_AMOUNT_KEYS = ["amountIn", "sellAmount", "fromAmount", "amount"];
const TO_AMOUNT_KEYS = ["amountOut", "outAmount", "toAmount", "expectedOut"];

/**
 * Hard bound on any payload this module hands to `JSON.parse`. Tool OUTPUT is
 * an unbounded DTO string and every visible swap/bridge card would parse it
 * synchronously on the renderer's main thread — an unbounded parse per card is
 * a CPU/memory denial path. 20k chars is far above any legitimate swap/bridge
 * payload whose leg keys sit at the root (or one level into `params`), so the
 * gate costs no real leg line; an oversized payload simply shows no legs.
 */
const MAX_PARSE_CHARS = 20_000;

/** Parse a sanitized payload into a plain record; fail-closed to `null`. */
function parseRecord(text: string | null): Record<string, unknown> | null {
  if (text === null || text.length === 0) return null;
  if (text.length > MAX_PARSE_CHARS) return null; // never parse unbounded text
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // truncated, or not JSON at all
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * The record to read leg keys from: the payload itself, plus one level into
 * `params` (the `execute_tool` wrapper nests the real call there). Deliberately
 * ONE level — an unbounded deep search over untrusted JSON is how a lookalike
 * key from an unrelated nested object ends up presented as the user's trade.
 */
function candidateRecords(text: string | null): Record<string, unknown>[] {
  const root = parseRecord(text);
  if (root === null) return [];
  const params = root["params"];
  if (params !== null && typeof params === "object" && !Array.isArray(params)) {
    return [root, params as Record<string, unknown>];
  }
  return [root];
}

/** First key that carries a non-empty string, across the candidate records. */
function readString(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | null {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return null;
}

/**
 * A numeric-ish field may legitimately arrive as a string or a number; both are
 * normalized to the string form `amountDisplay` audits. Anything else → null.
 */
function readAmount(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | null {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
      if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
      }
    }
  }
  return null;
}

/**
 * Persisted outcome × operation identity → what this pair may claim.
 * `null`/absent success = UNKNOWN. A successful call is only ever `executed`
 * when the operation was PROVEN mutating (rules/90: label more, claim less).
 */
function legOutcome(
  success: boolean | null | undefined,
  operation: ToolOperation,
  displayStatus: ToolDisplayStatus | null | undefined,
): ToolLegOutcome {
  // The display axis only ever SPLITS a persisted failure; it can never
  // upgrade an unknown or downgrade a success (rules/90: claim less).
  if (success === false) {
    return displayStatus === "pending" ? "pending" : "failed";
  }
  if (success !== true) return "requested";
  if (operation === "mutating") return "executed";
  return operation === "quote" ? "quote" : "completed";
}

/** Outcomes proven successful — the only ones that may read untrusted output. */
function readsOutput(outcome: ToolLegOutcome): boolean {
  return (
    outcome === "executed" || outcome === "quote" || outcome === "completed"
  );
}

/**
 * Resolve the leg pair for a swap/bridge act, or `null` when it cannot be
 * proven. BOTH token sides must be present — a half-read pair would render an
 * arrow pointing at nothing, which reads as a completed leg that never was.
 *
 * Record precedence follows the OUTCOME, not convenience:
 *  - a SUCCEEDED call (`executed`, `quote`, `completed`): the OUTPUT is read
 *    first — what the call returned outranks what was requested — with the
 *    args as the fallback.
 *  - everything else — including `pending`: the ARGS only. An unproven act's
 *    untrusted output must not supply tokens or amounts, because the renderer
 *    would then be presenting an attacker-controllable string as a request the
 *    user made. A pending broadcast is unproven by definition.
 */
export function resolveToolLegs(
  toolArgs: string | null,
  output: string | null,
  success: boolean | null | undefined,
  operation: ToolOperation,
  displayStatus?: ToolDisplayStatus | null,
): ToolLegPair | null {
  const outcome = legOutcome(success, operation, displayStatus);
  const argRecords = candidateRecords(toolArgs);
  const all = readsOutput(outcome)
    ? [...candidateRecords(output), ...argRecords]
    : argRecords;

  const fromToken = readString(all, FROM_TOKEN_KEYS);
  const toToken = readString(all, TO_TOKEN_KEYS);
  if (fromToken === null || toToken === null) return null;

  return {
    from: {
      token: tokenDisplay(fromToken, null, null),
      amount: amountDisplay(readAmount(all, FROM_AMOUNT_KEYS)),
    },
    to: {
      token: tokenDisplay(toToken, null, null),
      amount: amountDisplay(readAmount(all, TO_AMOUNT_KEYS)),
    },
    outcome,
  };
}
