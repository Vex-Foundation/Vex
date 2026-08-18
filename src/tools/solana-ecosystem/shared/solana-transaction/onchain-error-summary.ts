/**
 * Render a STRUCTURED Solana chain error as bounded, deterministic text.
 *
 * WHY THIS EXISTS. On 2026-07-25 a `solana.swap.execute` mined-reverted with
 * `{"InstructionError":[3,"ProgramFailedToComplete"]}` and the activity sweep
 * wrote `failure_reason = "Solana activity sweep: getSignatureStatuses
 * reported an on-chain error."` — the error itself was DISCARDED. The row said
 * that something failed and nothing about what, so neither the agent nor an
 * operator could tell a compute-starved swap from a slippage refusal without
 * going back to the explorer.
 *
 * WHY IT IS NOT `program-error-reason.ts`. That sibling recovers a PROGRAM-
 * AUTHORED sentence out of `logs: string[]` hanging off a thrown
 * `SendTransactionError`. The input here is a different thing entirely: the
 * STRUCTURED `err` value from `getSignatureStatuses`, `meta.err`, or a
 * simulation's `value.err` — an arbitrary JSON-ish shape, not a log array.
 * Both live in this directory because both answer "render a chain error as
 * text for the agent", and both the activity sweep and the pre-sign
 * compute-budget gate consume this one.
 *
 * THREE PROPERTIES THIS MUST HAVE, all because the output lands in a DB column
 * and then in front of the agent:
 *
 *   - DETERMINISTIC. Object keys are sorted recursively before stringify, so
 *     the same chain error always produces the same row text and two rows are
 *     diffable. Array order is preserved — an `InstructionError`'s leading
 *     instruction INDEX is data, not something to sort away.
 *   - BOUNDED AT THE SOURCE. `err` is chain/provider-controlled input, and the
 *     repo boundary (`agent-activity/validation.ts` `sanitizeFailureReason`)
 *     redacts without truncating, so nothing downstream will cut an oversized
 *     blob for us. 200 chars is generous for every realistic Solana `err` and
 *     leaves the sweep's own explaining prefix intact, which is the point: a
 *     provider blob must not eat the sentence that explains it.
 *   - TOTAL. This runs on failure paths. A serializer that throws would
 *     replace a decoded failure with an undecoded crash, so a circular or
 *     BigInt-bearing value degrades to a descriptor instead of propagating.
 *
 * Redaction is deliberately NOT duplicated here: `sanitizeFailureReason`
 * applies `redact()` unconditionally on every write path, and a second copy
 * would be one more place to drift.
 */

export const MAX_SOLANA_ONCHAIN_ERROR_CHARS = 200;

const TRUNCATION_SUFFIX = "…[truncated]";

/** Sentinel for a value that cannot be rendered — never leaks the reason, which could itself be unbounded. */
const UNSERIALIZABLE = "unserializable error";

/**
 * Thrown out of the key-sorting walk when a cycle is found, so the caller
 * degrades instead of recursing forever. It joins `JSON.stringify`'s own
 * `TypeError` (BigInt, hostile `toJSON`) in the SAME catch on purpose: every
 * one of them means "this value cannot be rendered".
 */
class CircularSolanaErrorValue extends Error {}

/**
 * Compact, deterministic, bounded text for a Solana chain error.
 *
 * `null`/`undefined` yields a stable descriptor rather than an empty string:
 * callers interpolate this into a sentence, and an empty span there reads as a
 * bug in the sweep rather than as a chain error with no detail.
 */
export function summarizeSolanaOnChainError(err: unknown): string {
  if (err === null || err === undefined) return "unspecified error";
  if (typeof err === "string") return bound(err);

  try {
    const serialized = JSON.stringify(withSortedKeys(err, new WeakSet()));
    // `JSON.stringify` returns undefined for a bare function/symbol.
    return serialized === undefined ? UNSERIALIZABLE : bound(serialized);
  } catch {
    // A cycle, a BigInt, or a hostile `toJSON` — all of them mean "we cannot
    // render this value", and none of them may take down the failure path.
    return UNSERIALIZABLE;
  }
}

function bound(text: string): string {
  if (text.length <= MAX_SOLANA_ONCHAIN_ERROR_CHARS) return text;
  return text.slice(0, MAX_SOLANA_ONCHAIN_ERROR_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

/**
 * Rebuild `value` with every plain-object key in sorted order. Arrays keep
 * their order. `seen` makes a cycle a thrown marker rather than a stack
 * overflow, which the caller turns into the safe descriptor.
 */
function withSortedKeys(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new CircularSolanaErrorValue("circular reference");
  seen.add(value);

  if (Array.isArray(value)) {
    const mapped = value.map((entry) => withSortedKeys(entry, seen));
    seen.delete(value);
    return mapped;
  }

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = withSortedKeys(source[key], seen);
  }
  seen.delete(value);
  return sorted;
}
