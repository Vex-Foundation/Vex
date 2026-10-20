/**
 * The Vex Cloud D16 disclosure: when the gateway sends fewer `max_tokens`
 * upstream than the request asked for, it says so in a response header on
 * JSON and SSE responses alike (the SDK strips unknown BODY fields, so a
 * header is the only channel that survives it):
 *
 *     x-vex-max-tokens: requested=<n>; effective=<m>; reason=balance
 *
 * Two reasons exist (phase 1a, `VexVirtualsCompute/src/metering/estimate.ts`
 * `maxTokensHeader`): `balance` (the VEX balance covers no more, D16) and
 * `model_limit` (the request asked above the model's per-effort ceiling).
 *
 * Parsed strictly: exactly the three fields, positive integers, a known
 * reason. Anything else is `null`, and the caller logs that it saw an
 * unreadable disclosure rather than inventing numbers.
 */

export const MAX_TOKENS_CLAMP_HEADER = "x-vex-max-tokens";

export const MAX_TOKENS_CLAMP_REASONS = ["balance", "model_limit"] as const;
export type MaxTokensClampReason = (typeof MAX_TOKENS_CLAMP_REASONS)[number];

export interface MaxTokensClamp {
  /** What the request asked for (the model default when it asked nothing). */
  readonly requested: number;
  /** What the gateway actually sent upstream. */
  readonly effective: number;
  readonly reason: MaxTokensClampReason;
}

/** A token count no model comes near; bounds what a hostile header may claim. */
const MAX_PLAUSIBLE_TOKENS = 10_000_000;

function parseCount(raw: string | undefined): number | null {
  if (raw === undefined || !/^[0-9]{1,8}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= MAX_PLAUSIBLE_TOKENS ? value : null;
}

function isReason(value: string | undefined): value is MaxTokensClampReason {
  return value !== undefined && (MAX_TOKENS_CLAMP_REASONS as readonly string[]).includes(value);
}

/**
 * Parse the header value, or `null` when it is absent or not the documented
 * shape. Field order is the gateway's but not required; duplicates and
 * unknown fields are refused.
 */
export function parseMaxTokensClampHeader(value: string | null | undefined): MaxTokensClamp | null {
  if (value === null || value === undefined) return null;
  const fields = new Map<string, string>();
  for (const part of value.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) return null;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return null;
    const key = trimmed.slice(0, eq).trim();
    const fieldValue = trimmed.slice(eq + 1).trim();
    if (fields.has(key)) return null;
    fields.set(key, fieldValue);
  }
  if (fields.size !== 3) return null;
  const requested = parseCount(fields.get("requested"));
  const effective = parseCount(fields.get("effective"));
  const reason = fields.get("reason");
  if (requested === null || effective === null || !isReason(reason)) return null;
  return { requested, effective, reason };
}
