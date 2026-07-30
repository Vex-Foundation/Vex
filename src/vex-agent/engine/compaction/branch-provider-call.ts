/**
 * One JSON-returning inference call for a preparation branch.
 *
 * Owns the mechanics both branches share and neither should re-implement: the
 * pre-call env gate, the freshly-constructed vault provider, the real deadline,
 * brace extraction, Zod validation, and the best-effort cost/model readers.
 * The branches supply their prompts and their schema; everything else about
 * "how this repo talks to the summarizer model" is decided here, once.
 *
 * Modelled on `compact-jobs/chunker-call.ts` and deliberately NOT importing
 * from it: contract C5 keeps the legacy chunker isolated and free of new
 * importers so it can be retired on its own schedule.
 */

import { z } from "zod";

import type {
  InferenceConfig,
  ProviderMessage,
} from "@vex-agent/inference/types.js";
import {
  endpointFailoverDepsFrom,
  resolveSessionInferenceConfig,
  type EndpointFailoverDeps,
} from "@vex-agent/inference/openrouter/endpoint-failover.js";
import logger from "@utils/logger.js";

/**
 * The provider surface a branch needs.
 *
 * NOT `JudgeProvider`. That interface narrows messages to `{role, content}`,
 * which cannot express a tool call or a tool result — and the branches replay a
 * role-bearing prefix that contains both. Relying on `JudgeProvider` while
 * passing richer objects through it would work only because the concrete
 * implementation happens to read fields the type does not declare; the pairing
 * would then be invisible to the type checker and one refactor away from being
 * silently dropped. This is a structural supertype of `OpenRouterProvider`, so
 * `new OpenRouterProvider()` is assignable with no cast, and test stubs
 * implement it directly.
 */
export interface BranchInferenceProvider {
  loadConfig(): Promise<unknown | null>;
  chatCompletionSimple(
    messages: ProviderMessage[],
    config: unknown,
    responseFormat?: unknown,
    signal?: AbortSignal,
  ): Promise<{ content: string; usage?: { cost?: number | null } }>;
}

/**
 * Default provider factory — the env-driven OpenRouter provider, constructed
 * fresh PER CALL.
 *
 * The per-call construction is deliberate, not an oversight: the constructor
 * reads `OPENROUTER_API_KEY` / `AGENT_MODEL` out of `process.env`, which the
 * secret vault populates on unlock and scrubs on lock. Reusing a cached
 * provider (or the registry singleton) would pin the worker to whatever
 * credentials and model existed at first use, so a vault unlock or a model
 * change would not take effect until the app restarted.
 *
 * "Vault memory provider/model" IS exactly these two environment variables —
 * there is no separate memory-model configuration anywhere in the tree.
 */
export async function defaultBranchProvider(): Promise<BranchInferenceProvider> {
  const { OpenRouterProvider } = await import(
    "@vex-agent/inference/openrouter.js"
  );
  return new OpenRouterProvider();
}

export type BranchProviderFactory = () => Promise<BranchInferenceProvider>;

/** True when the vault has populated the provider credentials. */
export function hasBranchProviderConfig(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY && process.env.AGENT_MODEL);
}

/** The `model` field we need off the otherwise-opaque provider config. */
const configModelShape = z.object({ model: z.string().min(1) });

/** Provider-reported cost, shaped like the judge's own reader. */
const costShape = z.object({
  usage: z.object({ cost: z.number().nullable().optional() }).optional(),
});

export interface BranchCallResult<T> {
  readonly output: T;
  /** Provider-reported USD cost for this call, or null when unreported. */
  readonly costUsd: number | null;
  /** Model the loaded config actually resolved to, or null when unreadable. */
  readonly model: string | null;
}

/**
 * `loadConfig()` is typed `unknown` on the structural provider interface, so
 * the config is untrusted here (rules/03). Narrow it before handing it to a
 * typed domain function; a stub config that is not an inference config (every
 * test double) simply skips the resolution instead of being cast into one.
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

export interface BranchCallInput<T> {
  /** Short label used in error codes and logs, e.g. `compaction_summary`. */
  readonly label: string;
  /**
   * The FROZEN conversation prefix, roles intact. Sent verbatim ahead of the
   * branch instruction so the branch forks from the tape the session was
   * actually cached on.
   */
  readonly prefix: readonly ProviderMessage[];
  /**
   * Session whose CURRENT effective endpoint this call must run against.
   * Compaction reads the switched endpoint, never the stale pin (owner
   * decision 4) — a background branch talking to the endpoint that already ran
   * out of capacity would fail for a reason the session had already solved.
   */
  readonly sessionId: string;
  readonly systemPrompt: string;
  /** Appended as the LAST user message, after the prefix. */
  readonly instruction: string;
  readonly timeoutMs: number;
  readonly schema: z.ZodType<T>;
  readonly makeProvider: BranchProviderFactory;
  /**
   * Test seam for the endpoint re-resolution. Omitted in production: the deps
   * are derived from the provider itself via `endpointFailoverDepsFrom`, so a
   * real `OpenRouterProvider` supplies real candidates and the switched
   * endpoint's price and context window resolve in full.
   */
  readonly failoverDeps?: EndpointFailoverDeps;
  /** Correlation only — never interpolated into a prompt. */
  readonly preparationId: number;
}

/**
 * Run the call. THROWS on every failure, never returns an empty result.
 *
 * That is not stylistic. The legacy chunker learned it the expensive way: a
 * silent empty return let the caller record a successful zero-output run and
 * permanently lose the work. Here a throw is what makes the attempt a FAILED
 * ATTEMPT — the branch backs off and retries, and only an exhausted budget is
 * terminal.
 */
export async function callBranchProvider<T>(
  input: BranchCallInput<T>,
): Promise<BranchCallResult<T>> {
  if (!hasBranchProviderConfig()) {
    logger.warn("compaction-prep.provider_config_missing", {
      label: input.label,
      preparationId: input.preparationId,
    });
    throw new Error(`${input.label}_provider_config_missing`);
  }

  const provider = await input.makeProvider();
  const loaded = await provider.loadConfig();
  if (!loaded) {
    logger.warn("compaction-prep.provider_config_load_failed", {
      label: input.label,
      preparationId: input.preparationId,
    });
    throw new Error(`${input.label}_provider_config_load_failed`);
  }

  // Run against the session's CURRENT effective endpoint, not the operator's
  // pin. A no-op until the session has actually switched.
  const config = isInferenceConfig(loaded)
    ? await resolveSessionInferenceConfig(
        loaded,
        input.sessionId,
        input.failoverDeps ?? endpointFailoverDepsFrom(provider),
      )
    : loaded;

  // A real deadline, not a race the loser ignores: `AbortSignal.timeout`
  // cancels the fetch itself, so an overdue call stops streaming and stops
  // billing instead of being abandoned mid-flight.
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
  // The branch's own system prompt, then the frozen prefix verbatim, then the
  // branch instruction as the final user turn. No tool definitions are sent:
  // `chatCompletionSimple` passes an empty tool list, and a branch never
  // executes anything — it only reads a conversation that already happened.
  const messages: ProviderMessage[] = [
    { role: "system", content: input.systemPrompt },
    ...input.prefix,
    { role: "user", content: input.instruction },
  ];

  let response: Awaited<
    ReturnType<BranchInferenceProvider["chatCompletionSimple"]>
  >;
  try {
    response = await provider.chatCompletionSimple(
      messages,
      config,
      undefined,
      timeoutSignal,
    );
  } catch (err) {
    // Preserve the named failure the retry/backoff logging keys on. The
    // cancelled request surfaces as the SDK's abort error, which says nothing
    // about WHY we cancelled.
    if (timeoutSignal.aborted) throw new Error(`${input.label}_timeout`);
    throw err;
  }

  const text = response.content?.trim() ?? "";
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error(
      `${input.label}_malformed_json: missing braces in response (len=${text.length})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch (cause) {
    throw new Error(`${input.label}_malformed_json: unparseable object`, {
      cause,
    });
  }
  const validated = input.schema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`${input.label}_schema_invalid: ${validated.error.message}`);
  }

  // Cost + model are best-effort audit data, persisted on
  // `compaction_preparations` and deliberately NOT on `usage_log`: that table
  // feeds the user's per-session totals in the sidebar and must keep meaning
  // "this conversation", not "this conversation plus background maintenance".
  const costParse = costShape.safeParse(response);
  const modelParse = configModelShape.safeParse(config);
  return {
    output: validated.data,
    costUsd: costParse.success ? costParse.data.usage?.cost ?? null : null,
    model: modelParse.success ? modelParse.data.model : null,
  };
}
