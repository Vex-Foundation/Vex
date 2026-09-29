/**
 * Embedding call policies and the timeout error they produce.
 *
 * Kept apart from `config.ts` on purpose: this module has no dependency on the
 * env-backed config, so the interactive discovery path can import its budget
 * without pulling in (or being broken by a stub of) the config loader. The
 * background default, built from the long-standing constants, lives in
 * `config.ts` as `BACKGROUND_EMBEDDING_POLICY`.
 */

/**
 * How long one embedding call may take and how often it retries.
 *
 * `totalBudgetMs`, when set, is a hard deadline across every attempt AND the
 * backoff between them: an attempt's timeout is clipped to what is left, and
 * no retry starts once it is spent.
 */
export interface EmbeddingCallPolicy {
  attemptTimeoutMs: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  totalBudgetMs?: number;
}

/** Hard ceiling on the query embedding for interactive `ToolSearch` discovery. */
export const DISCOVERY_EMBEDDING_BUDGET_MS = 5_000;

/**
 * Interactive discovery: one retry inside a 5 s budget, then the caller falls
 * back to lexical ranking (flagged low confidence). Two 2.4 s attempts plus a
 * 200 ms pause fit the budget, so a hung first attempt still leaves a real
 * second one instead of a retry with no time left.
 */
export const INTERACTIVE_DISCOVERY_EMBEDDING_POLICY: EmbeddingCallPolicy = {
  attemptTimeoutMs: 2_400,
  maxRetries: 1,
  baseDelayMs: 200,
  maxDelayMs: 200,
  jitter: false,
  totalBudgetMs: DISCOVERY_EMBEDDING_BUDGET_MS,
};

/**
 * An embedding call gave up on time: one attempt hit its timeout, or the
 * policy's total budget ran out. Distinct from a provider error so a caller
 * (and its telemetry) can tell "slow" from "broken".
 */
export class EmbeddingTimeoutError extends Error {
  override name = "EmbeddingTimeoutError";
}
