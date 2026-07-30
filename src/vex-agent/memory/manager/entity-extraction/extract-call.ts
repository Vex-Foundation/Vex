/**
 * The extraction LLM call: provider acquisition, deadline, brace-JSON recovery
 * and strict schema validation.
 *
 * Model output is untrusted data (`rules/07`) — nothing here returns a
 * partially-validated extraction. Every failure THROWS with a bounded, code-like
 * message; the caller (`buildGraphPlan`) catches and FAILS OPEN, so a broken
 * extraction costs the lesson its graph, never its promotion.
 */

import { JUDGE_TIMEOUT_MS } from "@vex-agent/engine/memory-manager/policy.js";

import type { JudgeProvider } from "../judge.js";
import {
  entityExtractionSchema,
  type EntityExtraction,
} from "../entity-extraction-schema.js";
import { buildExtractionSystemPrompt, buildExtractionUserPrompt } from "./prompt.js";
import type { ExtractionLesson } from "./types.js";

/**
 * Default provider factory — the SAME env-driven OpenRouter provider the judge
 * uses (constructor THROWS when OPENROUTER_API_KEY / AGENT_MODEL are absent;
 * `buildGraphPlan`'s fail-open catch absorbs it).
 */
async function defaultProvider(): Promise<JudgeProvider> {
  const { OpenRouterProvider } = await import("@vex-agent/inference/openrouter.js");
  return new OpenRouterProvider();
}

/**
 * Call the extractor for ONE promoted lesson. THROWS on missing config,
 * timeout, malformed JSON, or schema failure — the caller (`buildGraphPlan`)
 * catches and FAILS OPEN (null plan; promotion proceeds without a graph).
 * Never returns a partially-validated extraction.
 */
export async function extractEntities(
  lesson: ExtractionLesson,
  makeProvider: () => Promise<JudgeProvider> = defaultProvider,
): Promise<EntityExtraction> {
  const provider = await makeProvider();
  const config = await provider.loadConfig();
  if (!config) {
    throw new Error("memory_extraction_provider_config_load_failed");
  }

  // Real cancellation (see `judge.ts`): an abandoned race left the request
  // running and billing after we stopped caring about the answer.
  const timeoutSignal = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
  let response: Awaited<ReturnType<JudgeProvider["chatCompletionSimple"]>>;
  try {
    response = await provider.chatCompletionSimple(
      [
        { role: "system", content: buildExtractionSystemPrompt() },
        { role: "user", content: buildExtractionUserPrompt(lesson) },
      ],
      config,
      undefined,
      timeoutSignal,
    );
  } catch (err) {
    if (timeoutSignal.aborted) throw new Error("memory_extraction_timeout");
    throw err;
  }

  const text = response.content?.trim() ?? "";
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error(`memory_extraction_malformed_json: missing braces (len=${text.length})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch {
    throw new Error("memory_extraction_malformed_json: JSON.parse failed");
  }

  const validated = entityExtractionSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`memory_extraction_schema_invalid: ${validated.error.message}`);
  }
  return validated.data;
}
