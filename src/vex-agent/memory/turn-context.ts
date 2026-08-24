/**
 * Memory turn-context façade — the SINGLE pre-inference memory read for a
 * turn (D-FACADE). Replaces the Active-Knowledge prefetch that used to live
 * in `executeTurn` plus the session-memory stats read in
 * `buildTurnPromptStack`; the sole caller is `buildTurnPromptStack`, which
 * derives BOTH the `# Memory` prompt section AND the `hasSessionMemory`
 * tool-visibility signal from this one object.
 *
 * Branch-nullability is the contract: `null` means the FETCH FAILED, which
 * is NOT the same as an empty database. The memory section OMITS the lines
 * fed by a failed branch; empty-state guidance ("Use MemorySuggest…",
 * "Skip SessionMemorySearch…") renders ONLY on a successful fetch with true zero
 * counts. Two independent try/catch blocks preserve today's failure
 * granularity (one for the three knowledge queries, one for session stats)
 * and today's warn keys.
 *
 * Import specifiers are pinned (`@vex-agent/db/repos/knowledge.js`,
 * `@vex-agent/db/repos/session-memories/index.js`) so existing `vi.mock`
 * paths keep intercepting.
 */

import * as knowledgeRepo from "@vex-agent/db/repos/knowledge.js";
import type {
  ActiveKnowledgeListItem,
  KnownKind,
} from "@vex-agent/db/repos/knowledge.js";
import {
  getSessionMemoryStats,
  type SessionMemoryStats,
} from "@vex-agent/db/repos/session-memories/index.js";
import {
  ACTIVE_KNOWLEDGE_ENTRY_LIMIT,
  KNOWN_KINDS_LIMIT,
} from "@vex-agent/knowledge/policy.js";
import { MEMORY_BANNER_RECENT_THEMES_LIMIT } from "./session-memory-policy.js";
import logger from "@utils/logger.js";

export interface MemoryTurnContext {
  /** `null` = knowledge fetch FAILED (≠ empty DB). Success with zeros = truly empty. */
  readonly knowledge: {
    readonly hotEntries: readonly ActiveKnowledgeListItem[];
    /** FULL list (KNOWN_KINDS_LIMIT = 30) — the banner slices its own top-5. */
    readonly knownKinds: readonly KnownKind[];
    readonly activeCount: number;
  } | null;
  /** `null` = stats fetch FAILED (≠ zero chunks). */
  readonly sessionStats: SessionMemoryStats | null;
}

export async function getTurnContext(input: {
  readonly sessionId: string;
}): Promise<MemoryTurnContext> {
  let knowledge: MemoryTurnContext["knowledge"] = null;
  try {
    const [hotEntries, knownKinds, activeCount] = await Promise.all([
      knowledgeRepo.listActiveForHotContext({ limit: ACTIVE_KNOWLEDGE_ENTRY_LIMIT }),
      knowledgeRepo.listKnownKinds({ limit: KNOWN_KINDS_LIMIT }),
      knowledgeRepo.countActiveHotContextEntries(),
    ]);
    knowledge = { hotEntries, knownKinds, activeCount };
  } catch (err) {
    logger.warn("turn.active_knowledge.fetch_failed", {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let sessionStats: SessionMemoryStats | null = null;
  try {
    sessionStats = await getSessionMemoryStats(
      input.sessionId,
      MEMORY_BANNER_RECENT_THEMES_LIMIT,
    );
  } catch (err) {
    logger.warn("turn.memory_state.fetch_failed", {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { knowledge, sessionStats };
}
