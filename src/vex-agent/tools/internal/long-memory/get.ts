/**
 * MemoryGet handler (S3) — direct fetch of a long-term memory entry by id.
 *
 * Explicit fetch ⇒ returns the entry. Concise by default (metadata + lineage
 * only); pass response_format='detailed' to also inline the full metadata bag.
 * Either way content_md injects into the engine's loadedDocuments under
 * `long_memory:{id}` so it surfaces in the system prompt's loaded-content
 * section — so concise avoids double-emitting the body in the tool output.
 *
 * Steering on miss: not-found → re-search hint; a non-active entry steers the
 * agent toward the live successor (`supersededBy`) when one exists, otherwise
 * explains the terminal status (invalidated / archived).
 *
 * Read-only. Does NOT require the embeddings service.
 */

import * as knowledgeRepo from "@vex-agent/db/repos/knowledge.js";

import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { num, enumField, ok, fail, missingOrWrongTypeMessage } from "../types.js";

const RESPONSE_FORMATS = ["concise", "detailed"] as const;
type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

export async function handleLongMemoryGet(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const id = num(params, "id");
  if (id === undefined) {
    return fail(missingOrWrongTypeMessage(params, "id", "a number (the entry id from MemorySearch)"));
  }

  const responseFormat: ResponseFormat =
    enumField<ResponseFormat>(params, "response_format", RESPONSE_FORMATS) ?? "concise";

  const entry = await knowledgeRepo.getById(id);
  if (!entry) {
    return fail(
      `long-term memory entry ${id} not found. Re-run MemorySearch to find the current version.`,
    );
  }

  // Non-active steering: point at the live successor when superseded.
  if (entry.status !== "active") {
    if (entry.supersededBy !== null) {
      return fail(
        `long-term memory entry ${id} is ${entry.status} — it was replaced. The current version is entry ${entry.supersededBy}; fetch that with MemoryGet instead.`,
      );
    }
    return fail(
      `long-term memory entry ${id} is ${entry.status} and no longer current. Re-run MemorySearch for the active lesson on this topic.`,
    );
  }

  // Inject content_md so it surfaces in the system prompt loaded-content section.
  context.loadedDocuments.set(`long_memory:${entry.id}`, entry.contentMd);

  const base = {
    source: "long_memory" as const,
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    status: entry.status,
    // Lifecycle lineage — both directions so the agent can navigate the chain.
    supersedesId: entry.supersedesId,
    supersededBy: entry.supersededBy,
  };

  if (responseFormat === "concise") {
    return ok(base);
  }

  return ok({
    ...base,
    contentMd: entry.contentMd,
    tags: entry.tags,
    sourceRefs: entry.sourceRefs,
    confidence: entry.confidence,
    pinned: entry.pinned,
    validUntil: entry.validUntil,
    sourceTier: entry.source,
    maturityState: entry.maturityState,
    statusReason: entry.statusReason,
    changeSummary: entry.changeSummary,
    whatFailed: entry.whatFailed,
  });
}
