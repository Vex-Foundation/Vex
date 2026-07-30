/**
 * Branch A — the summarization inference call.
 *
 * Thin by design: the prompt is a versioned artifact in `summary-prompt.ts`,
 * the call mechanics (env gate, fresh vault provider, deadline, brace
 * extraction, cost/model readers) live in `branch-provider-call.ts`, and the
 * acceptance decision lives in `summary-validation.ts`. What is left here is
 * only the branch's own contract: what it sends and what shape it expects back.
 */

import { z } from "zod";

import {
  callBranchProvider,
  defaultBranchProvider,
  type BranchProviderFactory,
} from "./branch-provider-call.js";
import type { EndpointFailoverDeps } from "@vex-agent/inference/openrouter/endpoint-failover.js";
import { SUMMARY_CALL_TIMEOUT_MS } from "./policy.js";
import {
  buildSummaryInstruction,
  buildSummarySystemPrompt,
} from "./summary-prompt.js";
import type { ProviderMessage } from "@vex-agent/inference/types.js";

const SummaryOutputSchema = z.object({ conversation_summary: z.string() });

export interface SummaryCallInput {
  readonly preparationId: number;
  /** Session whose current effective endpoint this call must use. */
  readonly sessionId: string;
  readonly frozenSummary: string | null;
  /** The frozen conversation prefix, roles intact. */
  readonly prefix: readonly ProviderMessage[];
}

export interface SummaryCallResult {
  /** RAW model text. Untrusted until `validateSummaryOutput` accepts it. */
  readonly rawSummary: string;
  readonly costUsd: number | null;
  readonly model: string | null;
}

export async function callSummaryLLM(
  input: SummaryCallInput,
  makeProvider: BranchProviderFactory = defaultBranchProvider,
  failoverDeps?: EndpointFailoverDeps,
): Promise<SummaryCallResult> {
  const result = await callBranchProvider({
    label: "compaction_summary",
    sessionId: input.sessionId,
    ...(failoverDeps ? { failoverDeps } : {}),
    prefix: input.prefix,
    systemPrompt: buildSummarySystemPrompt(),
    instruction: buildSummaryInstruction({ frozenSummary: input.frozenSummary }),
    timeoutMs: SUMMARY_CALL_TIMEOUT_MS,
    schema: SummaryOutputSchema,
    makeProvider,
    preparationId: input.preparationId,
  });
  return {
    rawSummary: result.output.conversation_summary,
    costUsd: result.costUsd,
    model: result.model,
  };
}
