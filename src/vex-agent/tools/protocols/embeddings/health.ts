/**
 * Tool-embeddings health check.
 *
 * Used by the eval runner before dense baseline capture and by latency/smoke
 * tests. NOT called from `discoverProtocolCapabilities` - the dense leg already
 * degrades gracefully via `denseFailed: true` on empty or mismatched rows. This
 * is a pre-flight gate for test/eval paths where a misconfigured table should
 * fail loudly rather than silently produce zero dense hits.
 *
 * Three conditions checked, in order:
 *   1. Config is loadable (throws from `loadEmbeddingConfig()` if env vars
 *      are missing).
 *   2. `tool_embeddings` has at least one row for the CURRENT generation -
 *      the (provider-reported model, dim) pair, not raw config - no rows
 *      means the table was never populated or was populated under a different
 *      generation. Operator fix: `pnpm tool-reembed`.
 *   3. Row count for that generation is not fewer than the expected active
 *      tool count - stale table means some manifests changed without a
 *      reembed. Operator fix: `pnpm tool-reembed`.
 *
 * GENERATION, not raw config.model, defines "current". Rows are stamped by
 * `reembed.ts` with the model name the PROVIDER reports (providers alias model
 * names) and the dim it actually returns - see `reembed.ts`'s generation probe
 * and `client.ts`'s `providerModel` doctrine. This preflight probes the
 * provider once the same way (`embedTool` schema probe) so its count predicate
 * matches exactly what the reconcile wrote. Counting by raw `config.model`
 * would report a false "empty" whenever the provider aliases the model name.
 */

import { loadEmbeddingConfig } from "@vex-agent/embeddings/config.js";
import { embedTool } from "@vex-agent/embeddings/client.js";
import { countByModelDim } from "@vex-agent/db/repos/tool-embeddings.js";
import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { isReembeddableNamespace } from "@vex-agent/tools/protocols/lifecycle.js";

/**
 * Assert that `tool_embeddings` is populated and consistent with the current
 * embedding generation.
 *
 * Probes the provider once to learn the generation it stamps - the reported
 * model name (`providerModel`) plus the dim it actually returns - then counts
 * by that pair, exactly as `reembed.ts` writes and `dense-score.ts` filters.
 *
 * Throws a descriptive error when:
 * - No rows exist for the current generation - needs `pnpm tool-reembed`.
 * - Row count < expected active tool count - stale table, needs `pnpm tool-reembed`.
 *
 * Returns void on success. Callers should await this before running dense
 * baseline capture or latency tests.
 */
export async function assertToolEmbeddingsReady(): Promise<void> {
  const config = loadEmbeddingConfig();

  // Generation probe: the provider's REPORTED model + the dim it actually
  // returns define the generation every row is stamped with. Same cheap probe
  // reembed.ts uses. Propagates on provider/config failure - an infra error the
  // caller surfaces, not a false "table empty".
  const probe = await embedTool("__schema_probe__", "ignore", config);
  const generationModel = probe.providerModel;
  const generationDim = probe.embedding.length;

  const expectedCount = PROTOCOL_TOOLS.filter((m) =>
    isReembeddableNamespace(m.namespace),
  ).length;
  const actual = await countByModelDim(generationModel, generationDim);

  if (actual === 0) {
    throw new Error(
      `tool_embeddings is empty for model "${generationModel}" dim ${generationDim}. ` +
        `Run \`pnpm tool-reembed\` to populate it.`,
    );
  }

  if (actual < expectedCount) {
    const missing = expectedCount - actual;
    throw new Error(
      `tool_embeddings is stale for model "${generationModel}" dim ${generationDim}: ` +
        `found ${actual} rows but expected at least ${expectedCount} ` +
        `(${missing} tool${missing === 1 ? "" : "s"} missing). ` +
        `Run \`pnpm tool-reembed\` to refresh.`,
    );
  }
}
