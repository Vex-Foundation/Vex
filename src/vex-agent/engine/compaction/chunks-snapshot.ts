/**
 * Branch B — building the ONE frozen, insert-ready chunk snapshot (contract C5).
 *
 * Pure: redact → validate/fallback the theme → exclusion-drop → materialize the
 * render. No I/O, no embedding, no DB.
 *
 * WHY THE SNAPSHOT IS THE FULLY MATERIALIZED ROW, not just the model's texts.
 * `prepareMemoryRender` mints a fresh `randomUUID()` and `new Date()` per
 * outstanding item and renders `body_md` around them, so re-rendering on a
 * retry produces DIFFERENT bytes than the first attempt embedded. Freezing only
 * the texts would therefore not be deterministic at all — the retry would embed
 * one body and, after a template bump, store another. So the snapshot carries
 * the generated item identity, the rendered body, its hash, the pinned schema
 * version, and the `content_hash` the `(session_id, content_hash)` active-row
 * upsert dedupes on. Re-inserting it is idempotent by construction.
 *
 * EMBEDDING IS DELIBERATELY OUTSIDE THE SNAPSHOT. It is provider-dependent
 * I/O, and the snapshot has to be reproducible and reviewable. The exact-body
 * contract (`session-memories/render.ts` — the bytes embedded are the bytes
 * stored) still holds, because `bodyMd` itself is frozen: re-embedding the same
 * frozen body on a retry embeds exactly what the row will contain.
 */

import { createHash } from "node:crypto";

import {
  FROZEN_CHUNKS_SNAPSHOT_VERSION,
  type FrozenChunk,
  type FrozenChunksOutput,
  type FrozenThemeSource,
} from "../../db/repos/compaction-preparations/index.js";
import {
  BODY_MD_SCHEMA_VERSION,
  prepareMemoryRender,
} from "@vex-agent/db/repos/session-memories/index.js";
import { exceedsEmbeddingDocumentBudget } from "@vex-agent/embeddings/document-size-budget.js";
import { redact } from "@vex-agent/memory/redaction.js";
import { scanLiveState } from "@vex-agent/memory/exclusion-rules.js";
import {
  buildFallbackTheme,
  validateTheme,
} from "@vex-agent/memory/theme-validation.js";
import { MAX_OUTSTANDING_ITEMS_PER_CHUNK } from "@vex-agent/memory/session-memory-policy.js";
import logger from "@utils/logger.js";

import type { PreparationChunk } from "./chunks-call.js";

export interface BuildChunksSnapshotInput {
  readonly preparationId: number;
  readonly chunks: readonly PreparationChunk[];
  /** Fixed target generation — feeds the fallback theme, as the legacy path does. */
  readonly targetGeneration: number;
}

export interface ChunksSnapshotBuild {
  readonly snapshot: FrozenChunksOutput;
  readonly snapshotSha256: string;
  /** Chunks dropped for being mostly live state. */
  readonly rejectedByExclusion: number;
  /**
   * Chunks dropped by output-side redaction.
   *
   * Always 0, and that is a policy statement, not a stub: hard-redact
   * placeholders sanitize a chunk IN PLACE, so redaction never removes one.
   * The counter exists because the column does — a future redaction-threshold
   * drop policy would populate it — and reporting a real 0 is more honest than
   * folding these into the exclusion count, which answers a different question.
   */
  readonly rejectedByRedaction: number;
}

export function buildChunksSnapshot(
  input: BuildChunksSnapshotInput,
): ChunksSnapshotBuild {
  const frozen: FrozenChunk[] = [];
  let rejectedByExclusion = 0;

  for (const raw of input.chunks) {
    // Redact EVERY generated string field. Anything landing in the row's
    // structured columns, in `body_md`, or in the embedding input must be
    // scrubbed before storage — the transcript scrubber runs on the way OUT to
    // the provider, this is the guard on the way IN to the database.
    const themeR = redact(raw.theme);
    const happened = redact(raw.happened_md);
    const did = redact(raw.did_md);
    const tried = redact(raw.tried_md);
    const outstanding = raw.outstanding_items
      .slice(0, MAX_OUTSTANDING_ITEMS_PER_CHUNK)
      .map((text) => redact(text).text);
    const entities = redactAll(raw.entities);
    const protocols = redactAll(raw.protocols);
    const errorClasses = redactAll(raw.error_classes);
    const chains = redactAll(raw.chains);
    const tasks = redactAll(raw.tasks);

    // Validate the REDACTED theme, and build any fallback from REDACTED
    // structured fields, so a leaked identifier cannot survive via the
    // fallback construction path.
    const themeResult = validateTheme(themeR.text);
    const theme = themeResult.ok
      ? themeResult.theme
      : buildFallbackTheme({
          entities,
          protocols,
          errorClasses,
          chains,
          tasks,
          generation: input.targetGeneration,
        });
    // Provenance is only knowable HERE. A fallback theme validates by
    // construction, so re-deriving this at insert time would label every
    // fallback as `chunker`; the snapshot carries the answer instead.
    const themeSource: FrozenThemeSource = themeResult.ok ? "chunker" : "fallback";

    // Outstanding items ARE part of `body_md`, so they belong in the exclusion
    // scan input.
    const bodyForExclusion = [
      happened.text,
      did.text,
      tried.text,
      outstanding.join("\n"),
    ].join("\n");
    if (scanLiveState(bodyForExclusion).rejected) {
      rejectedByExclusion += 1;
      logger.info("compaction-prep.chunk_rejected_exclusion", {
        preparationId: input.preparationId,
        theme,
      });
      continue;
    }

    const prep = prepareMemoryRender({
      theme,
      happenedMd: happened.text,
      didMd: did.text,
      triedMd: tried.text,
      outstandingTexts: outstanding,
    });

    frozen.push({
      theme,
      themeSource,
      entities,
      protocols,
      errorClasses,
      chains,
      tasks,
      happenedMd: happened.text,
      didMd: did.text,
      triedMd: tried.text,
      outstandingItems: prep.outstandingItems.map((item) => ({
        id: item.id,
        text: item.text,
        createdAt: item.createdAt,
        // A chunk that has not been inserted yet cannot have had an item
        // resolved; the frozen schema pins these to null.
        resolvedAt: null,
        resolutionNote: null,
        resolutionSource: null,
      })),
      bodyMd: prep.bodyMd,
      bodyMdHash: prep.bodyMdHash,
      bodyMdSchemaVersion: BODY_MD_SCHEMA_VERSION,
      contentHash: prep.contentHash,
    });
  }

  return {
    ...sealFrozenChunks(frozen),
    rejectedByExclusion,
    rejectedByRedaction: 0,
  };
}

/**
 * Wrap frozen chunks into the persisted snapshot and fingerprint it.
 *
 * Exported because the size guard merges the chunks of two builds (the first
 * model answer plus the re-emitted oversized ones) into ONE snapshot, and the
 * fingerprint must be computed the same way for both paths — a second
 * `createHash` call site is exactly how the two drift.
 */
export function sealFrozenChunks(chunks: readonly FrozenChunk[]): {
  readonly snapshot: FrozenChunksOutput;
  readonly snapshotSha256: string;
} {
  const snapshot: FrozenChunksOutput = {
    snapshotVersion: FROZEN_CHUNKS_SNAPSHOT_VERSION,
    chunks: [...chunks],
  };
  return {
    snapshot,
    snapshotSha256: createHash("sha256")
      .update(JSON.stringify(snapshot), "utf8")
      .digest("hex"),
  };
}

/**
 * Split frozen chunks by whether their embedding input fits the provider's
 * usable batch. Measured on the EXACT bytes `embedDocument` would send, which
 * only exist once the body has been rendered — so this is the first point where
 * the answer is knowable, and it is strictly before the freeze.
 */
export function partitionFrozenChunksByEmbeddingBudget(
  chunks: readonly FrozenChunk[],
): { readonly withinBudget: FrozenChunk[]; readonly oversized: FrozenChunk[] } {
  const withinBudget: FrozenChunk[] = [];
  const oversized: FrozenChunk[] = [];
  for (const chunk of chunks) {
    if (exceedsEmbeddingDocumentBudget(chunk.theme, chunk.bodyMd)) {
      oversized.push(chunk);
    } else {
      withinBudget.push(chunk);
    }
  }
  return { withinBudget, oversized };
}

function redactAll(values: readonly string[]): string[] {
  return values.map((value) => redact(value).text);
}
