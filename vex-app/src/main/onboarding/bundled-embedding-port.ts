import { z } from "zod";
import {
  DEFAULT_EMBED_PORT,
  EMBEDDING_DIM,
  EMBEDDING_MODEL_ALIAS,
  buildEmbeddingBaseUrl,
} from "./embedding-defaults.js";

/** Only relocate an unavailable bundled endpoint to a verified local runtime. */
export const BUNDLED_EMBEDDING_PORT_REPAIR = true;

const responseSchema = z.object({
  model: z.literal(EMBEDDING_MODEL_ALIAS),
  data: z.array(z.object({ embedding: z.array(z.number()).length(EMBEDDING_DIM) })).min(1),
});
const refusedSchema = z.object({
  cause: z.object({ code: z.literal("ECONNREFUSED") }),
});

/** Probes use synthetic text only; one shared deadline bounds both requests. */
export async function canRepairBundledEmbeddingPort(
  embedPort: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!Number.isInteger(embedPort) || embedPort < 1 || embedPort > 65535 || embedPort === DEFAULT_EMBED_PORT) {
    return false;
  }
  const signal = AbortSignal.timeout(5_000);
  try {
    await fetchImpl(`http://127.0.0.1:${DEFAULT_EMBED_PORT}/health`, { signal });
    // Any HTTP response proves a listener exists. Never redirect a live endpoint.
    return false;
  } catch (cause) {
    if (!refusedSchema.safeParse(cause).success) return false;
  }
  try {
    const response = await fetchImpl(`${buildEmbeddingBaseUrl(embedPort)}/embeddings`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBEDDING_MODEL_ALIAS, input: "vex runtime availability probe" }),
    });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    return responseSchema.safeParse(payload).success;
  } catch {
    return false;
  }
}
