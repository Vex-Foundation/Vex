/**
 * `SessionMemoryResolve` tool handler — closes a single outstanding
 * item on a session memory chunk. Updates the JSONB element + re-renders
 * `body_md` + re-embeds via the same local EmbeddingGemma service.
 *
 * Orchestrates the two-step pattern from PR1:
 *   1. markOutstandingResolved repo call — updates outstanding_items array
 *      element and body_md.
 *   2. embedDocument(theme, body_md) on the post-update body.
 *   3. updateEmbedding repo call — replaces the vector in place so future
 *      recall sees the resolved state.
 *
 * If embedding fails (local service down), the body_md change is preserved
 * (recoverable) but the embedding stays stale until a future re-embed pass.
 * That's preferable to losing the resolution acknowledgement.
 */

import { z } from "zod";

import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import {
  getById,
  markOutstandingResolved,
  updateEmbedding,
} from "@vex-agent/db/repos/session-memories/index.js";
import { embedDocument } from "@vex-agent/embeddings/client.js";
import { OUTSTANDING_ITEM_TEXT_MAX } from "@vex-agent/memory/session-memory-policy.js";
import { redact } from "@vex-agent/memory/redaction.js";
import logger from "@utils/logger.js";
import { formatZodIssueForModel } from "../arg-validation.js";

const ResolveItemSchema = z.object({
  memory_id: z.number().int().positive(),
  outstanding_item_id: z.string().uuid(),
  resolution_note: z.string().min(1).max(OUTSTANDING_ITEM_TEXT_MAX),
});

export async function handleSessionMemoryResolveItem(
  args: unknown,
  context: InternalToolContext,
): Promise<ToolResult> {
  const parsed = ResolveItemSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: `SessionMemoryResolve: ${formatZodIssueForModel(parsed.error.issues[0], args)}`,
    };
  }
  const { memory_id, outstanding_item_id, resolution_note } = parsed.data;

  // Redact secrets / identifiers from the resolution note BEFORE it lands in
  // the JSONB outstanding_items column, the materialized body_md, or the
  // embedding input. Compact-time writes already pass through redact() in the
  // Track 2 worker; this is the symmetrical guard for the agent-driven
  // resolution path that the cross-PR audit flagged as a leak surface.
  const redactedNote = redact(resolution_note);

  logger.info("session_memory_resolve_item.called", {
    sessionId: context.sessionId,
    memoryId: memory_id,
    redactionHardCount: redactedNote.hardRedactCount,
    redactionMaskCount: redactedNote.maskCount,
  });

  // Verify the chunk belongs to this session (defense-in-depth).
  const existing = await getById(memory_id);
  if (!existing) {
    return { success: false, output: `Memory chunk ${memory_id} not found.` };
  }
  if (existing.sessionId !== context.sessionId) {
    return {
      success: false,
      output: `Memory chunk ${memory_id} does not belong to this session.`,
    };
  }

  const result = await markOutstandingResolved(
    memory_id,
    outstanding_item_id,
    redactedNote.text,
    "agent",
  );
  if (!result.ok) {
    return {
      success: false,
      output: `SessionMemoryResolve: ${result.reason}`,
    };
  }

  // Re-embed the updated body. If embedDocument fails, the resolution still
  // persists in DB — the vector becomes stale until a future re-embed.
  try {
    const embedded = await embedDocument(result.memory.theme, result.memory.bodyMd);
    // Race-safety: pass the body_md_hash of the body we embedded so a
    // concurrent resolution that rewrote body_md (and bumped its hash)
    // rejects this UPDATE. False return = stale embedding, do NOT retry —
    // the winning concurrent path already wrote a fresh vector for the
    // current body. (codex PR3-final race fix.)
    const updated = await updateEmbedding(
      memory_id,
      embedded.embedding,
      embedded.providerModel,
      embedded.embedding.length,
      result.memory.bodyMdHash,
    );
    if (!updated) {
      logger.info("session_memory_resolve_item.embed_stale", {
        memoryId: memory_id,
        sessionId: context.sessionId,
      });
      return {
        success: true,
        output:
          `Outstanding item ${outstanding_item_id} resolved on chunk ${memory_id}. ` +
          "NOTE: a concurrent resolution rewrote the chunk body; this embedding " +
          "was discarded as stale (the concurrent path already wrote a fresh vector). " +
          "Resolution itself is durable.",
        data: { resolved: true, embedding_stale: true },
      };
    }
  } catch (err) {
    logger.warn("session_memory_resolve_item.embed_failed", {
      memoryId: memory_id,
      sessionId: context.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: true,
      output:
        `Outstanding item ${outstanding_item_id} resolved on chunk ${memory_id}. ` +
        "WARNING: re-embedding failed; the vector for this chunk is now stale. " +
        "Recall will continue to find the chunk via the old embedding until the next compact.",
      data: { resolved: true, embedding_stale: true },
    };
  }

  return {
    success: true,
    output: `Outstanding item ${outstanding_item_id} resolved on chunk ${memory_id} (theme: ${result.memory.theme}).`,
    data: {
      resolved: true,
      memory_id,
      outstanding_item_id,
      remaining_unresolved: result.memory.outstandingItems.filter((it) => it.resolvedAt === null).length,
    },
  };
}
