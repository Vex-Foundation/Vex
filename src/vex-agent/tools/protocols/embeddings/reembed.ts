/**
 * Tool-embedding reconcile task — the desktop bootstrap's refresh path.
 *
 * Iterates every reembeddable manifest (filter via
 * `lifecycle.ts:isReembeddableNamespace` — `active` only, deprecated and
 * reserved skipped), computes a stable `content_hash` over the dense input
 * + formatter version, and upserts into `tool_embeddings` only when the row is
 * NOT already current for this generation. First boot embeds the full active
 * surface (~120 tools today, ~3-4s wallclock); subsequent boots are a cheap
 * generation diff.
 *
 * GENERATION, not raw config.model, defines "current". The provider is probed
 * once at the start to learn the model name it actually reports
 * (`currentProviderModel`) and the dim it returns (`currentDim`) — providers
 * alias models, and `client.ts` documents `providerModel` as the audit/recall
 * truth (`dense-score.ts` filters on it). A row is up to date only when it
 * matches ALL of `(tool_id, content_hash, embedding_model === currentProviderModel,
 * embedding_dim === currentDim)`. Unchanged text under a drifted model/dim is
 * re-embedded, not skipped.
 *
 * After the upsert loop writes the full current generation, an orphan purge
 * deletes rows for tool ids no longer active (removed/renamed tools) and rows
 * from any prior generation. The purge runs LAST so there is never an
 * empty-table window mid-refresh.
 *
 * A pass is "successful" when it completes against a reachable DB + provider
 * (no thrown infra/config error). Per-tool embed failures are counted in
 * `errors`, not thrown — the caller decides whether to retry.
 *
 * The `ToolSearch` cold path NEVER lazy-embeds in user-facing code — if
 * `tool_embeddings` is incomplete, dense discovery degrades to
 * `dense_failed: true` and falls back to lexical scoring.
 *
 * Module-level `inFlight` promise enforces single-flight shared between
 * `reconcileToolEmbeddings` (desktop boot) and `reembedAllTools` (dev script):
 * parallel callers wait on the same run rather than double-embedding.
 */

import { createHash } from "node:crypto";
import { embedTool, FORMATTER_VERSION } from "@vex-agent/embeddings/client.js";
import { loadEmbeddingConfig } from "@vex-agent/embeddings/config.js";
import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { isReembeddableNamespace } from "@vex-agent/tools/protocols/lifecycle.js";
import {
  deleteOrphanedToolEmbeddings,
  findExistingByHash,
  upsertToolEmbedding,
} from "@vex-agent/db/repos/tool-embeddings.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";
import logger from "@utils/logger.js";

export interface ReembedReport {
  embedded: number;
  skipped: number;
  errors: number;
  durationMs: number;
  formatterVersion: string;
  embeddingModel: string;
  embeddingDim: number;
}

/** Reconcile adds `deleted` — the count of orphaned/stale-generation rows purged. */
export interface ReconcileReport extends ReembedReport {
  deleted: number;
}

let inFlight: Promise<ReconcileReport> | null = null;

/**
 * Reconcile `tool_embeddings` with the current active surface + embedding
 * generation: probe the provider, upsert every active tool whose row is not
 * already current, then purge orphaned/stale-generation rows. Idempotent.
 * Single-flight — concurrent callers share one run.
 */
export function reconcileToolEmbeddings(): Promise<ReconcileReport> {
  if (inFlight !== null) return inFlight;
  inFlight = run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Embed (or refresh) every active protocol tool. Idempotent. Single-flight —
 * shares the reconcile run (so the dev `pnpm tool-reembed` script gets the same
 * generation-aware refresh + orphan purge the desktop boot performs). Returns
 * the reconcile report, a superset of the historic reembed report.
 */
export function reembedAllTools(): Promise<ReembedReport> {
  return reconcileToolEmbeddings();
}

async function run(): Promise<ReconcileReport> {
  const start = Date.now();
  const config = loadEmbeddingConfig();

  // Generation probe: the provider's REPORTED model + the dim it actually
  // returns define the current generation for every predicate below. Throws
  // (propagates) if the provider or config is unavailable — that is an infra
  // failure the caller retries, not a per-tool error.
  const probe = await embedTool("__schema_probe__", "ignore", config);
  const currentProviderModel = probe.providerModel;
  const currentDim = probe.embedding.length;

  let embedded = 0;
  let skipped = 0;
  let errors = 0;

  const eligible = PROTOCOL_TOOLS.filter((m) => isReembeddableNamespace(m.namespace));
  const activeToolIds = eligible.map((m) => m.toolId);

  for (const manifest of eligible) {
    try {
      const sourceText = pickSourceText(manifest);
      if (sourceText.length === 0) {
        skipped++;
        continue;
      }
      const contentHash = computeContentHash(manifest, sourceText);
      const existing = await findExistingByHash(contentHash);
      // Skip ONLY when the stored row is current for THIS generation. Unchanged
      // text whose model/dim drifted (provider alias change, dim swap) has the
      // same content_hash but the wrong generation — it must be re-embedded.
      const upToDate =
        existing !== null &&
        existing.toolId === manifest.toolId &&
        existing.embeddingModel === currentProviderModel &&
        existing.embeddingDim === currentDim;
      if (upToDate) {
        skipped++;
        continue;
      }

      const result = await embedTool(manifest.toolId, sourceText, config);
      await upsertToolEmbedding({
        toolId: manifest.toolId,
        namespace: manifest.namespace,
        contentHash,
        embeddingModel: result.providerModel,
        embeddingDim: result.embedding.length,
        embedding: result.embedding,
      });
      embedded++;
    } catch (err) {
      errors++;
      logger.warn("tool_embeddings.reembed.tool_failed", {
        toolId: manifest.toolId,
        namespace: manifest.namespace,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Orphan purge runs AFTER the upsert loop so the new generation is fully
  // written before any old row disappears (no empty-table window). Keyed on the
  // PROBED generation, never config.model — an aliasing provider must not purge
  // the rows we just stamped.
  const deleted = await deleteOrphanedToolEmbeddings(
    activeToolIds,
    currentProviderModel,
    currentDim,
  );

  const report: ReconcileReport = {
    embedded,
    skipped,
    errors,
    deleted,
    durationMs: Date.now() - start,
    formatterVersion: FORMATTER_VERSION,
    embeddingModel: currentProviderModel,
    embeddingDim: currentDim,
  };

  logger.info("tool_embeddings.reconcile.completed", report);
  return report;
}

/**
 * The exact text that goes through the dense embedding pipeline. Falls back
 * through `embeddingText` → `canonicalSummary` → `description` so a tool
 * with no `discovery` metadata still embeds something coherent (the
 * description authors already wrote).
 */
function pickSourceText(manifest: ProtocolToolManifest): string {
  return (
    manifest.discovery?.embeddingText ??
    manifest.discovery?.canonicalSummary ??
    manifest.description ??
    ""
  );
}

/**
 * Stable content hash. Includes formatter version + tool_id + namespace so
 * - swapping the embedding-input formatter (Gemma `title:|text:` → BGE)
 *   invalidates every row;
 * - the same `sourceText` shared by two tools (rare but possible) hashes
 *   differently.
 */
function computeContentHash(manifest: ProtocolToolManifest, sourceText: string): string {
  const meta = manifest.discovery;
  const aliasesJoined = (meta?.aliases ?? []).join("|");
  const exampleIntentsJoined = (meta?.exampleIntents ?? []).join("|");
  const chainsJoined = (meta?.chains ?? []).join("|");
  const components = [
    FORMATTER_VERSION,
    manifest.toolId,
    manifest.namespace,
    sourceText,
    aliasesJoined,
    exampleIntentsJoined,
    chainsJoined,
  ];
  return createHash("sha256").update(components.join("\x1f")).digest("hex");
}
