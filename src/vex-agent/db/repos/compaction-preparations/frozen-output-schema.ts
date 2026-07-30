/**
 * Branch-B frozen-output schema — the COMPLETE insert-ready chunk snapshot
 * persisted on `compaction_preparations.chunks_frozen_output` BEFORE any
 * `session_memories` insert (contract C5).
 *
 * WHY THIS IS NOT `ChunkerOutputSchema`. The chunker's own schema
 * (`engine/compact-jobs/chunker-call.ts`) describes what the MODEL emits. That
 * is not enough to make a retry deterministic: `prepareMemoryRender`
 * (`db/repos/session-memories/render.ts`) turns those texts into a row by
 * generating a fresh `randomUUID()` and `new Date().toISOString()` per
 * outstanding item and by rendering `body_md` through a versioned template. A
 * snapshot of only the texts would therefore produce DIFFERENT rows on every
 * retry — different item ids, different timestamps, and, after a template bump,
 * a different `body_md` than the one the first attempt embedded.
 *
 * So the frozen snapshot is the fully materialized insert payload: the
 * narrative fields, the server-generated outstanding items verbatim, the
 * rendered `body_md` with its hash, the pinned `body_md_schema_version`, and
 * the `content_hash` that the existing `(session_id, content_hash)` active-row
 * upsert dedupes on. Re-inserting it is idempotent by construction.
 *
 * OWNERSHIP. This schema is declared HERE, in the repo module, so that
 * `engine/compact-jobs/chunker-call.ts` stays untouched (C5 isolation) and the
 * `db → engine` import direction is never created.
 *
 * The snapshot is UNTRUSTED on read: it is a JSONB column, and a row written by
 * an older build (or hand-edited) must not be cast into the domain type. Every
 * read parses through `FrozenChunksOutputSchema`.
 */

import { z } from "zod";

/**
 * Bumped only when the snapshot SHAPE changes. A row carrying an older version
 * fails validation loudly rather than being partially reinterpreted — the
 * branch then reports a permanent failure instead of inserting a half-understood
 * payload into memory.
 */
export const FROZEN_CHUNKS_SNAPSHOT_VERSION = 1;

/**
 * An outstanding item exactly as `newOutstandingItem` produced it. Frozen at
 * snapshot time and never regenerated. Resolution fields are always null here:
 * a chunk that has not been inserted yet cannot have had an item resolved.
 */
const FrozenOutstandingItemSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  createdAt: z.string().min(1),
  resolvedAt: z.null(),
  resolutionNote: z.null(),
  resolutionSource: z.null(),
});

/**
 * Where the theme came from, decided at snapshot-build time and CARRIED, not
 * re-derived.
 *
 * Re-deriving it at insert is silently wrong: `buildFallbackTheme` produces a
 * theme that satisfies `validateTheme` by construction, so a "did this validate?"
 * check at insert time answers `chunker` for every fallback theme ever built.
 * The only moment the answer is knowable is the moment the choice is made, so
 * the snapshot records it there.
 *
 * `handoff` — the third value `session_memories.theme_source` accepts — is
 * deliberately absent: it belongs to the handoff path, and Branch B cannot
 * produce it. Narrowing here makes that unrepresentable rather than merely
 * unused.
 */
const FrozenThemeSourceSchema = z.enum(["chunker", "fallback"]);

export type FrozenThemeSource = z.infer<typeof FrozenThemeSourceSchema>;

const FrozenChunkSchema = z.object({
  theme: z.string().min(1),
  themeSource: FrozenThemeSourceSchema,
  entities: z.array(z.string()),
  protocols: z.array(z.string()),
  errorClasses: z.array(z.string()),
  chains: z.array(z.string()),
  tasks: z.array(z.string()),
  happenedMd: z.string(),
  didMd: z.string(),
  triedMd: z.string(),
  outstandingItems: z.array(FrozenOutstandingItemSchema),
  /** Rendered body — the exact bytes that get embedded and stored. */
  bodyMd: z.string(),
  bodyMdHash: z.string().length(64),
  /** Pinned `BODY_MD_SCHEMA_VERSION` at freeze time. */
  bodyMdSchemaVersion: z.string().min(1),
  /** Dedup key of the existing `(session_id, content_hash)` active upsert. */
  contentHash: z.string().length(64),
});

export const FrozenChunksOutputSchema = z.object({
  snapshotVersion: z.literal(FROZEN_CHUNKS_SNAPSHOT_VERSION),
  chunks: z.array(FrozenChunkSchema),
});

export type FrozenChunk = z.infer<typeof FrozenChunkSchema>;
export type FrozenChunksOutput = z.infer<typeof FrozenChunksOutputSchema>;
