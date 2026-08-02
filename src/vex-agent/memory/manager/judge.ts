/**
 * LLM-judge call (S4 §7). Mirrors `engine/compact-jobs/chunker-call.ts`: the
 * SAME env-driven OpenRouter provider the in-turn agent uses, on-demand so a
 * settings change after restart picks up the new model.
 *
 * Sequence: `new OpenRouterProvider()` → `loadConfig()` → resolve the session's
 * current endpoint → `chatCompletionSimple` under a real deadline →
 * `indexOf('{')…lastIndexOf('}')` → `JSON.parse` → `judgeVerdictSchema.safeParse`.
 * On ANY malformed step it THROWS (never returns an empty/promoting verdict) so
 * `consolidate.ts`'s catch fails the item -> the job retries. There is NO
 * promoting fallback on LLM failure (§949).
 *
 * NO API-level `response_format`. The judge used to send a strict `json_schema`
 * format, which `OpenRouterProvider` pairs with `provider.requireParameters:true`
 * — and an endpoint that does not advertise `structured_outputs` is then refused
 * BEFORE inference. On 2026-07-31 that rejected every consolidate item in ~50 ms
 * on the user's own model. The output contract now lives where every other
 * JSON-returning call in this tree puts it: the prompt, brace extraction, and
 * the authoritative Zod parse.
 *
 * The provider is INJECTABLE (`JudgeProvider`) so tests use a deterministic stub
 * — the real OpenRouter is never called in tests.
 */

import { z } from "zod";

import { JUDGE_TIMEOUT_MS } from "@vex-agent/engine/memory-manager/policy.js";
import { memLog } from "@vex-agent/memory/observability/logger.js";
import {
  endpointFailoverDepsFrom,
  resolveSessionInferenceConfig,
} from "@vex-agent/inference/openrouter/endpoint-failover.js";
import type { InferenceConfig } from "@vex-agent/inference/types.js";
import { buildJudgeSystemPrompt, buildJudgeUserPrompt } from "./judge-prompt.js";
import { judgeVerdictSchema, type JudgeVerdict } from "./judge-schema.js";
import type { JudgeContext } from "./context-builder.js";

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
    // Optional API-level response format. The judge always passes `undefined`
    // (see the module header); the parameter stays declared because the
    // concrete `OpenRouterProvider.chatCompletionSimple` has it and this
    // interface must remain a structural supertype.
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
 * `loadConfig()` is typed `unknown` on the structural provider interface, so the
 * config is untrusted here (rules/03). Narrow it before handing it to a typed
 * domain function; a stub config that is not an inference config (every test
 * double) simply skips the endpoint resolution instead of being cast into one.
 * Mirrors the same guard in `compaction/branch-provider-call.ts`.
 */
function isInferenceConfig(value: unknown): value is InferenceConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<InferenceConfig>;
  return (
    typeof candidate.model === "string" &&
    typeof candidate.provider === "string" &&
    typeof candidate.contextLimit === "number"
  );
}

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
  const loaded = await provider.loadConfig();
  if (!loaded) {
    memLog.warn("judge", "config_load_failed");
    throw new Error("memory_judge_provider_config_load_failed");
  }

  // Run against the candidate's session CURRENT effective endpoint, not the
  // operator's pin. A no-op until that session has actually switched.
  const config = isInferenceConfig(loaded)
    ? await resolveSessionInferenceConfig(
        loaded,
        ctx.sessionId,
        endpointFailoverDepsFrom(provider),
      )
    : loaded;

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
      undefined,
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
