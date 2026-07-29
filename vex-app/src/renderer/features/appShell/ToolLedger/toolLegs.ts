/**
 * SWAP / BRIDGE LEG LINE — the "VEX → USDC" summary a friendly tool card shows
 * instead of raw JSON as its primary view.
 *
 * Reads the SANITIZED args/output strings the DTO carries. Those are
 * untrusted, 2000-char-capped text: a large payload is TRUNCATED and
 * `JSON.parse` throws. Every failure mode — truncated, malformed, missing
 * token key, non-string token, unrecognised shape — returns `null`, and the
 * card then shows no legs at all.
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

export interface ToolLeg {
  /** Token identity resolved through the shared brand-gating grammar. */
  readonly token: TokenDisplay;
  /** Formatted human amount, or `null` when none could be PROVEN readable. */
  readonly amount: string | null;
}

export interface ToolLegPair {
  readonly from: ToolLeg;
  readonly to: ToolLeg;
}

/** Key aliases the swap/bridge tools use for each side of a leg pair. */
const FROM_TOKEN_KEYS = ["tokenIn", "fromToken", "inputMint", "sellToken", "tokenFrom"];
const TO_TOKEN_KEYS = ["tokenOut", "toToken", "outputMint", "buyToken", "tokenTo"];
const FROM_AMOUNT_KEYS = ["amountIn", "sellAmount", "fromAmount", "amount"];
const TO_AMOUNT_KEYS = ["amountOut", "outAmount", "toAmount", "expectedOut"];

/** Parse a sanitized payload into a plain record; fail-closed to `null`. */
function parseRecord(text: string | null): Record<string, unknown> | null {
  if (text === null || text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // truncated at the 2000-char cap, or not JSON at all
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
 * Resolve the leg pair for a swap/bridge act, or `null` when it cannot be
 * proven. BOTH token sides must be present — a half-read pair would render an
 * arrow pointing at nothing, which reads as a completed leg that never was.
 * The out-amount is looked for in the OUTPUT first (what actually happened),
 * falling back to the args (what was requested).
 */
export function resolveToolLegs(
  toolArgs: string | null,
  output: string | null,
): ToolLegPair | null {
  const argRecords = candidateRecords(toolArgs);
  const outputRecords = candidateRecords(output);
  const all = [...outputRecords, ...argRecords];

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
  };
}
