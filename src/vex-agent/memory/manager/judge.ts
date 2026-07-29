/**
 * LLM-judge call (S4 §7). Mirrors `engine/compact-jobs/chunker-call.ts`: the
 * SAME env-driven OpenRouter provider the in-turn agent uses, on-demand so a
 * settings change after restart picks up the new model.
 *
 * Sequence: `new OpenRouterProvider()` → `loadConfig()` → race(chatCompletion-
 * Simple, timeout) → `indexOf('{')…lastIndexOf('}')` → `JSON.parse` →
 * `judgeVerdictSchema.safeParse`. On ANY malformed step it THROWS (never returns
 * an empty/promoting verdict) so `consolidate.ts`'s catch fails the item ->
 * the job retries. There is NO promoting fallback on LLM failure (§949).
 *
 * The provider is INJECTABLE (`JudgeProvider`) so tests use a deterministic stub
 * — the real OpenRouter is never called in tests.
 */

import { z } from "zod";

import { JUDGE_TIMEOUT_MS } from "@vex-agent/engine/memory-manager/policy.js";
import { memLog } from "@vex-agent/memory/observability/logger.js";
import { buildJudgeResponseFormat } from "@vex-agent/inference/openrouter/judge-format.js";
import { buildJudgeSystemPrompt, buildJudgeUserPrompt } from "./judge-prompt.js";
import { judgeVerdictJsonSchema, judgeVerdictSchema, type JudgeVerdict } from "./judge-schema.js";
import type { JudgeContext } from "./context-builder.js";

/**
 * API-level output-format enforcement (F31, Layer B), built ONCE. Threaded into
 * `chatCompletionSimple` so OpenRouter constrains the judge to the verdict shape
 * AND (via `provider.requireParameters`) routes only to honoring endpoints. The
 * authoritative semantic gate is still the Zod `judgeVerdictSchema` parse below
 * (Layer A) — `.refine()` cross-field rules do not survive `toJSONSchema`.
 */
const judgeResponseFormat = buildJudgeResponseFormat(judgeVerdictJsonSchema);

/**
 * The provider surface the judge needs — a structural supertype of
 * OpenRouterProvider (`usage.cost` is the provider's authoritative per-request
 * USD cost from `InferenceUsage`), so `new OpenRouterProvider()` is assignable
 * with no cast.
 */
export interface JudgeProvider {
  loadConfig(): Promise<unknown | null>;
  chatCompletionSimple(
    messages: ReadonlyArray<{ role: string; content: string }>,
    config: unknown,
    // Optional API-level response format (F31 Layer B). Typed `unknown` to keep
    // this structural interface provider-agnostic — the judge passes a concrete
    // OpenRouter format object; test stubs ignore it. The concrete
    // `OpenRouterProvider.chatCompletionSimple` accepts a typed optional 3rd arg
    // and remains assignable.
    responseFormat?: unknown,
    /**
     * Per-call deadline. Every background caller passes an
     * `AbortSignal.timeout(...)` so an overdue request is CANCELLED rather
     * than abandoned mid-flight (an abandoned one keeps streaming and billing
     * tokens for a result already discarded). Optional so test stubs that
     * ignore it stay assignable.
     */
    signal?: AbortSignal,
  ): Promise<{ content: string; usage?: { cost?: number | null } }>;
}

export interface JudgeCallResult {
  verdict: JudgeVerdict;
  /** LLM calls made (always 1 on success) — drives bumpJobInference. */
  llmCalls: number;
  /** Cost in USD if the provider reported it, else null. */
  costUsd: number | null;
}

/**
 * Default provider factory — constructs the env-driven OpenRouter provider. The
 * constructor THROWS when OPENROUTER_API_KEY / AGENT_MODEL are absent (the
 * executor's pre-claim gate prevents reaching here without them).
 */
async function defaultProvider(): Promise<JudgeProvider> {
  const { OpenRouterProvider } = await import("@vex-agent/inference/openrouter.js");
  return new OpenRouterProvider();
}

const costShape = z.object({ usage: z.object({ cost: z.number().nullable().optional() }).optional() });

/**
 * Call the judge for ONE escalated candidate. THROWS on missing config, timeout,
 * malformed JSON, or schema failure — the caller fails the item and the job
 * retries. Never returns a promoting verdict on failure.
 */
export async function callJudge(
  ctx: JudgeContext,
  makeProvider: () => Promise<JudgeProvider> = defaultProvider,
): Promise<JudgeCallResult> {
  const provider = await makeProvider();
  const config = await provider.loadConfig();
  if (!config) {
    memLog.warn("judge", "config_load_failed");
    throw new Error("memory_judge_provider_config_load_failed");
  }

  const systemPrompt = buildJudgeSystemPrompt();
  const userPrompt = buildJudgeUserPrompt(ctx);

  // Real cancellation, not an abandoned race: the old
  // `Promise.race([call, setTimeout])` rejected on time but left the HTTP
  // request running, burning tokens for a verdict already thrown away.
  const timeoutSignal = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
  let response: Awaited<ReturnType<JudgeProvider["chatCompletionSimple"]>>;
  try {
    response = await provider.chatCompletionSimple(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      config,
      judgeResponseFormat,
      timeoutSignal,
    );
  } catch (err) {
    // Keep the named timeout error the callers/logs already recognize; the
    // raw abort error would only say "aborted", not why.
    if (timeoutSignal.aborted) throw new Error("memory_judge_timeout");
    throw err;
  }

  const text = response.content?.trim() ?? "";
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    memLog.warn("judge", "malformed");
    throw new Error(`memory_judge_malformed_json: missing braces (len=${text.length})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch {
    memLog.warn("judge", "malformed");
    throw new Error("memory_judge_malformed_json: JSON.parse failed");
  }

  const validated = judgeVerdictSchema.safeParse(parsed);
  if (!validated.success) {
    memLog.warn("judge", "malformed");
    throw new Error(`memory_judge_schema_invalid: ${validated.error.message}`);
  }

  // Cost is best-effort — a provider that does not report it yields null.
  const costParse = costShape.safeParse(response);
  const costUsd = costParse.success ? costParse.data.usage?.cost ?? null : null;

  memLog("judge", "called", {
    decisionType: validated.data.verdict,
    llmCalls: 1,
    ...(costUsd !== null ? { costUsd } : {}),
  });

  return { verdict: validated.data, llmCalls: 1, costUsd };
}
