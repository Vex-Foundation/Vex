/**
 * Archive chunking worker's LLM call. Extracted from `executor.ts`
 * for scaling — `callChunkerLLM` is a pure async function that owns
 * its OpenRouter invocation + JSON parse + Zod validate. No
 * dependency on the worker lifecycle or `claimLost` flag.
 *
 * The schema validation MUST happen here — returning `[]` on schema
 * failure would let `markCompleted(0 chunks)` silently lose the job
 * (codex flagged that as a permanent-loss bug). Throw instead so
 * `processJob`'s catch leaves the outbox row in `pending` with a
 * backoff for retry.
 *
 * The provider is INJECTABLE (`JudgeProvider`, the same structural interface
 * its three background siblings already use — judge, entity extraction,
 * regime worker) so tests drive it with a deterministic stub instead of a
 * live OpenRouter call.
 */

import { z } from "zod";
import type { CompactJob } from "../../db/repos/compact-jobs/index.js";
import type { JudgeProvider } from "@vex-agent/memory/manager/judge.js";
import { CHUNKER_CALL_TIMEOUT_MS } from "./policy.js";
import { MEMORY_CHUNK_MODEL_BUDGET_CHARS } from "@vex-agent/embeddings/document-size-budget.js";
import logger from "@utils/logger.js";
import {
  renderRedactedArchivedTranscript,
  type ArchivedPrefixRow,
} from "./archived-prefix.js";

export const ChunkerOutputSchema = z.object({
  chunks: z.array(
    z.object({
      theme: z.string(),
      entities: z.array(z.string()).optional().default([]),
      protocols: z.array(z.string()).optional().default([]),
      error_classes: z.array(z.string()).optional().default([]),
      chains: z.array(z.string()).optional().default([]),
      tasks: z.array(z.string()).optional().default([]),
      happened_md: z.string().optional().default(""),
      did_md: z.string().optional().default(""),
      tried_md: z.string().optional().default(""),
      outstanding_items: z.array(z.string()).optional().default([]),
    }),
  ),
});

export type ChunkerChunk = z.infer<typeof ChunkerOutputSchema>["chunks"][number];

export interface ChunkerCallResult {
  chunks: ChunkerChunk[];
  transcriptRedactionCounts: { hard: number; mask: number };
  /** Provider-reported USD cost for this call, or null when unreported. */
  costUsd: number | null;
  /** Model the loaded config actually resolved to, or null when unreadable. */
  model: string | null;
}

/**
 * Default provider factory — constructs the env-driven OpenRouter provider,
 * fresh PER CALL.
 *
 * The per-call construction is deliberate, not an oversight: the constructor
 * reads `OPENROUTER_API_KEY` / `AGENT_MODEL` out of `process.env`, which the
 * secret vault populates on unlock and scrubs on lock. Reusing a cached
 * provider (or the registry singleton) would pin the worker to whatever
 * credentials and model existed at first use, so a vault unlock or a model
 * change would not take effect until the app restarted.
 */
async function defaultProvider(): Promise<JudgeProvider> {
  const { OpenRouterProvider } = await import("@vex-agent/inference/openrouter.js");
  return new OpenRouterProvider();
}

/** The `model` field we need off the otherwise-opaque provider config. */
const configModelShape = z.object({ model: z.string().min(1) });

/** Provider-reported cost, shaped like the judge's own reader. */
const costShape = z.object({
  usage: z.object({ cost: z.number().nullable().optional() }).optional(),
});

export async function callChunkerLLM(
  job: CompactJob,
  archivedPrefix: ReadonlyArray<ArchivedPrefixRow>,
  makeProvider: () => Promise<JudgeProvider> = defaultProvider,
): Promise<ChunkerCallResult> {
  // If env is missing or the loader can't produce a config, we THROW (not
  // silently return []) so `processJob`'s catch leaves the outbox row in
  // `pending` with a backoff for retry. Returning an empty array here would
  // let `markCompleted(0 chunks)` silently lose the job — codex flagged this
  // as a permanent-loss bug.
  if (!process.env.OPENROUTER_API_KEY || !process.env.AGENT_MODEL) {
    logger.warn("compact-worker.provider_config_missing", { jobId: job.id });
    throw new Error("compact_worker_provider_config_missing");
  }
  const provider = await makeProvider();
  const config = await provider.loadConfig();
  if (!config) {
    logger.warn("compact-worker.provider_config_load_failed", { jobId: job.id });
    throw new Error("compact_worker_provider_config_load_failed");
  }

  // Transcript-side scrubber: archived live messages may contain
  // wallet identifiers, tx hashes, API tokens, or key material that
  // pre-date the memory layer's output-side redaction. Re-scrub
  // before the remote chunker provider sees the prompt; output-side
  // redaction in `executor.ts` remains the DB + embedding guard.
  const { transcript, redactionCounts } =
    renderRedactedArchivedTranscript(archivedPrefix);

  const systemPrompt = [
    "You are a chunker for per-session agent memory. You receive a conversation prefix that was just archived.",
    "Produce as many narrative chunks as the prefix warrants — typically 1-3, but emit more when distinct themes are present. There is no enforced upper cap; quality beats quantity, so do NOT pad.",
    "Write all narrative fields (theme, happened_md, did_md, tried_md, outstanding_items, entities, protocols, error_classes, chains, tasks) in ENGLISH regardless of the conversation's language. Memory recall queries against this content are English-by-contract.",
    "EXCLUDE live state: balances, prices, gas, intent IDs, transaction hashes, position values. These are queryable live and would just become stale.",
    "INCLUDE: decisions and rationale, observed patterns, lessons learned, user signals, mission state.",
    "Output strict JSON: { chunks: [ { theme, entities[], protocols[], error_classes[], chains[], tasks[], happened_md, did_md, tried_md, outstanding_items[] } ] }",
    "Theme: 3-8 lowercase underscore-separated tokens, specific (e.g. 'kyber_quote_timeout_pattern' NOT 'debug').",
    // Same size budget the preparation chunker states, from the same owner
    // (`embeddings/document-size-budget.ts`): a chunk that does not fit the
    // embeddings server's physical batch cannot be stored at all, and this path
    // fails the job rather than inserting it.
    `SIZE BUDGET, per chunk: the theme plus all narrative text (happened_md + did_md + tried_md + every outstanding_items entry) must total at most ${MEMORY_CHUNK_MODEL_BUDGET_CHARS} characters. If a theme needs more, SPLIT it into several smaller chunks instead of exceeding the budget. Never truncate mid-sentence.`,
    "If nothing worth chunking, return { chunks: [] }.",
  ].join(" ");
  const userPrompt = [
    `Agent's own summary of the conversation:\n${job.agentSummary}`,
    job.preserveMd ? `Preserve hints:\n${job.preserveMd}` : "",
    job.threadThemesHints.length > 0
      ? `Theme hints (advisory, validate before using):\n${job.threadThemesHints.join("\n")}`
      : "",
    `Archived conversation prefix (session=${job.sessionId}, generation=${job.checkpointGeneration}):\n${transcript}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // A real deadline, not a race the loser ignores. The previous
  // `Promise.race([call, setTimeout])` rejected on time but ABANDONED the HTTP
  // request, which kept streaming and billing tokens for an answer already
  // discarded. `AbortSignal.timeout` cancels the fetch itself.
  const timeoutSignal = AbortSignal.timeout(CHUNKER_CALL_TIMEOUT_MS);
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
    // Preserve the named failure the retry/backoff logging keys on. The
    // cancelled request surfaces as the SDK's abort error, which says nothing
    // about WHY we cancelled; no `cause` is attached, matching the deliberate
    // no-`.cause` discipline of the OpenRouter error normalizer.
    if (timeoutSignal.aborted) throw new Error("chunker_timeout");
    throw err;
  }

  const text = response.content?.trim() ?? "";
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error(
      `chunker_malformed_json: missing braces in response (len=${text.length})`,
    );
  }
  const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  const validated = ChunkerOutputSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`chunker_schema_invalid: ${validated.error.message}`);
  }
  // Cost + model are best-effort audit data (persisted on `compact_jobs`, NOT
  // on `usage_log` — that table means "this conversation" and feeds the user's
  // session totals in the sidebar; background work must not inflate it).
  const costParse = costShape.safeParse(response);
  const costUsd = costParse.success ? costParse.data.usage?.cost ?? null : null;
  const modelParse = configModelShape.safeParse(config);

  return {
    chunks: validated.data.chunks,
    transcriptRedactionCounts: redactionCounts,
    costUsd,
    model: modelParse.success ? modelParse.data.model : null,
  };
}
