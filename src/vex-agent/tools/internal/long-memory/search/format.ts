/**
 * `MemorySearch` inline cap and output formatting (steps 6 and 8 of the
 * handler, split out in 0R.15, refactor-only): the inline-only cap with
 * truncate-with-steering (no silent drop - R1-#3) and the concise/detailed
 * projections, including the `via_graph(<entity>)` marker that keeps
 * expansion results distinguishable from direct hits.
 */

import {
  LONG_MEMORY_INLINE_CAP,
  LONG_MEMORY_INLINE_CHARS_CAP,
  type LongMemoryResult,
} from "@vex-agent/memory/long-memory-retrieval-policy.js";

export interface InlineSplit {
  readonly inline: LongMemoryResult[];
  readonly dropped: number;
}

/**
 * Cap the ranked set to LONG_MEMORY_INLINE_CAP entries (ALWAYS) and - ONLY when
 * the response actually carries `contentMd` (detailed format) - to
 * LONG_MEMORY_INLINE_CHARS_CAP total chars. concise responses do NOT return
 * `contentMd`, so the chars cap must never truncate them (final-gate fix). The
 * first result is always kept even if it alone busts the chars cap (otherwise the
 * top hit would be lost). NO overflow cache (R1-#3) - the dropped count drives the
 * steering hint + `search.truncated`.
 */
export function capInline(ranked: readonly LongMemoryResult[], applyCharsCap: boolean): InlineSplit {
  if (ranked.length === 0) return { inline: [], dropped: 0 };

  const inline: LongMemoryResult[] = [];
  let totalChars = 0;

  for (const entry of ranked) {
    if (inline.length >= LONG_MEMORY_INLINE_CAP) break;
    // Chars cap (detailed only); the first result is always kept.
    if (
      applyCharsCap &&
      inline.length > 0 &&
      totalChars + entry.contentMd.length > LONG_MEMORY_INLINE_CHARS_CAP
    ) {
      break;
    }
    inline.push(entry);
    totalChars += entry.contentMd.length;
  }

  return { inline, dropped: ranked.length - inline.length };
}

interface ConciseItem {
  source: LongMemoryResult["source"];
  id: number | string;
  kind: string;
  title: string;
  similarity: number;
  score: number;
  notConsolidated?: true;
  /** S8 - `via_graph(<entity>)` marker on graph-expansion results (concise AND detailed). */
  via?: string;
}

export function toConcise(r: LongMemoryResult): ConciseItem {
  const base: ConciseItem = {
    source: r.source,
    id: r.id,
    kind: r.kind,
    title: r.title,
    similarity: round(r.similarity),
    score: round(r.score),
  };
  if (r.source === "memory_candidate") base.notConsolidated = true;
  // S8: expansion results are MARKED, never silently mixed with direct hits.
  if (r.source === "long_memory" && r.via === "graph") {
    base.via = `via_graph(${r.viaEntity ?? ""})`;
  }
  return base;
}

export function toDetailed(r: LongMemoryResult): Record<string, unknown> {
  const base = toConcise(r);
  if (r.source === "long_memory") {
    return {
      ...base,
      summary: r.summary,
      contentMd: r.contentMd,
      tags: r.tags,
      validUntil: r.validUntil,
      maturityState: r.maturityState,
      sourceTier: r.sourceTier,
      evidenceRefs: r.evidenceRefs,
    };
  }
  return {
    ...base,
    summary: r.summary,
    contentMd: r.contentMd,
    tags: r.tags,
    validUntil: r.retrievalUntil,
    sourceTier: r.sourceTier,
    evidenceRefs: r.evidenceRefs,
  };
}

/** Round a unit-interval number to 4 dp for stable, compact output. */
function round(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}
