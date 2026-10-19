/**
 * Embedding parity gate (plan section 11).
 *
 *   tsx native-runtime/parity/parity.ts --reference <url> --candidate <url> [--out report.json]
 *
 * Embeds the parity corpus against a REFERENCE server (today's
 * ghcr.io/ggml-org/llama.cpp:server-b9115 container) and a CANDIDATE server
 * (the bundled native llama-server), both as OpenAI-compatible `/v1` base
 * URLs. The candidate's API key, when it has one, comes from
 * NR_CANDIDATE_API_KEY. Fails (exit 1) unless:
 *
 *   - every response reports model = the bundled alias and 768 finite values,
 *   - the minimum per-input cosine similarity is >= MIN_COSINE,
 *   - mean top-10 retrieval overlap (queries against tools + documents) is
 *     >= MIN_MEAN_OVERLAP, so stored vectors keep ranking the same way.
 *
 * Re-run on every llama.cpp bump and for every shipped target.
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { openAIEmbeddingsResponseSchema } from "@vex-agent/embeddings/schemas.js";
import { EMBEDDING_DIM, EMBEDDING_MODEL_ALIAS } from "../../vex-app/src/shared/embedding-defaults.js";
import { buildCorpus, type ParityItem } from "./corpus.js";

const MIN_COSINE = 0.999;
const MIN_MEAN_OVERLAP = 0.95;
const TOP_K = 10;
const CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 60_000;

interface Endpoint {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string | null;
}

async function embed(endpoint: Endpoint, item: ParityItem): Promise<Float64Array> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (endpoint.apiKey !== null) headers.authorization = `Bearer ${endpoint.apiKey}`;
  const res = await fetch(`${endpoint.baseUrl}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input: item.input, model: EMBEDDING_MODEL_ALIAS }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`${endpoint.name} ${item.id}: HTTP ${res.status} ${await res.text()}`);
  }
  const body = openAIEmbeddingsResponseSchema.parse(await res.json());
  if (body.model !== EMBEDDING_MODEL_ALIAS) {
    throw new Error(`${endpoint.name} ${item.id}: model ${String(body.model)}, expected ${EMBEDDING_MODEL_ALIAS}`);
  }
  const vector = body.data[0]?.embedding;
  if (vector?.length !== EMBEDDING_DIM || !vector.every(Number.isFinite)) {
    throw new Error(`${endpoint.name} ${item.id}: expected ${EMBEDDING_DIM} finite values, got ${vector?.length}`);
  }
  return Float64Array.from(vector);
}

async function embedAll(endpoint: Endpoint, items: readonly ParityItem[]): Promise<Float64Array[]> {
  const out: Float64Array[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      const item = items[i];
      if (item !== undefined) out[i] = await embed(endpoint, item);
    }
  };
  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`${endpoint.name}: embedded ${items.length} inputs in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return out;
}

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / Math.sqrt(na * nb);
}

function topK(query: Float64Array, pool: readonly Float64Array[]): number[] {
  return pool
    .map((v, i) => ({ i, s: cosine(query, v) }))
    .sort((x, y) => y.s - x.s)
    .slice(0, TOP_K)
    .map((x) => x.i);
}

function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      reference: { type: "string" },
      candidate: { type: "string" },
      out: { type: "string" },
    },
  });
  if (values.reference === undefined || values.candidate === undefined) {
    throw new Error("usage: parity.ts --reference <url> --candidate <url> [--out report.json]");
  }
  const reference: Endpoint = { name: "reference", baseUrl: values.reference, apiKey: null };
  const candidate: Endpoint = {
    name: "candidate",
    baseUrl: values.candidate,
    apiKey: process.env.NR_CANDIDATE_API_KEY ?? null,
  };

  const items = buildCorpus();
  const counts = { tool: 0, query: 0, document: 0 };
  for (const item of items) counts[item.kind]++;
  console.log(`corpus: ${items.length} inputs (${JSON.stringify(counts)})`);

  const refVectors = await embedAll(reference, items);
  const candVectors = await embedAll(candidate, items);

  const perItem = items.map((item, i) => ({
    id: item.id,
    kind: item.kind,
    chars: item.input.length,
    cosine: cosine(refVectors[i] as Float64Array, candVectors[i] as Float64Array),
  }));
  const cosines = perItem.map((p) => p.cosine).sort((a, b) => a - b);

  const queryIdx = items.flatMap((item, i) => (item.kind === "query" ? [i] : []));
  const poolIdx = items.flatMap((item, i) => (item.kind === "query" ? [] : [i]));
  const refPool = poolIdx.map((i) => refVectors[i] as Float64Array);
  const candPool = poolIdx.map((i) => candVectors[i] as Float64Array);
  const overlaps = queryIdx.map((qi) => {
    const a = new Set(topK(refVectors[qi] as Float64Array, refPool));
    const b = topK(candVectors[qi] as Float64Array, candPool);
    return b.filter((x) => a.has(x)).length / TOP_K;
  });
  const meanOverlap = overlaps.reduce((s, x) => s + x, 0) / overlaps.length;

  const report = {
    reference: reference.baseUrl,
    candidate: candidate.baseUrl,
    model: EMBEDDING_MODEL_ALIAS,
    dim: EMBEDDING_DIM,
    counts: { total: items.length, ...counts },
    cosine: {
      min: cosines[0],
      p01: quantile(cosines, 0.01),
      p50: quantile(cosines, 0.5),
      mean: cosines.reduce((s, x) => s + x, 0) / cosines.length,
    },
    retrieval: {
      k: TOP_K,
      queries: overlaps.length,
      poolSize: poolIdx.length,
      meanOverlap,
      minOverlap: Math.min(...overlaps),
    },
    worst: [...perItem].sort((a, b) => a.cosine - b.cosine).slice(0, 10),
    thresholds: { minCosine: MIN_COSINE, minMeanOverlap: MIN_MEAN_OVERLAP },
    pass: (cosines[0] ?? 0) >= MIN_COSINE && meanOverlap >= MIN_MEAN_OVERLAP,
  };

  if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ cosine: report.cosine, retrieval: report.retrieval, pass: report.pass }, null, 2));
  if (!report.pass) {
    console.error("PARITY FAILED: worst inputs:", JSON.stringify(report.worst, null, 2));
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
