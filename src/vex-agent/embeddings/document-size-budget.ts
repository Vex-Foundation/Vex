/**
 * The size budget for ONE document embedding request — the single owner of
 * "how much text may be handed to `embedDocument` in one call".
 *
 * WHY THIS EXISTS. The shipped embeddings runtime is a `llama.cpp:server`
 * started by `vex-app/resources/compose/docker-compose.template.yml` with
 * `--model --embeddings --alias --host --port` and NO `--ubatch-size`, so its
 * physical batch stays at the llama.cpp default of 512 tokens. An input longer
 * than that is not truncated and not split — the server answers HTTP 500
 * (`input (N tokens) is too large to process. increase the physical batch
 * size`). Measured directly against that container on 2026-07-30: a 500-token
 * input succeeds, a 600-token input returns 500, and a real 747-token session
 * memory chunk failed every insert forever, because the branch-B insert tail
 * has no terminal outcome by design and simply retries.
 *
 * WHY CHARACTERS, NOT TOKENS. We do not ship the model's tokenizer, and the
 * only honest bound available at validation time is the character count of the
 * exact string that will be sent. So the budget is a CONSERVATIVE characters →
 * tokens conversion, deliberately pessimistic:
 *
 *   usable tokens = 512 physical batch − 32 reserve (BOS/EOS, the
 *                   `title: … | text: …` prefix, tokenizer variance)  = 480
 *   chars/token   = 3, well below EmbeddingGemma's ~4.2 on English prose and
 *                   still below the ~1.8 that UUID/timestamp scaffolding costs
 *   budget        = 480 × 3 = 1440 characters of formatted input
 *
 * Worst case check with the densest content we actually produce — a session
 * memory body carrying five outstanding items (each ~94 characters of UUID +
 * ISO timestamp scaffolding at ~1.7 chars/token, ≈176 tokens total) plus the
 * remaining ~1140 characters of English prose at ~4 chars/token (≈285 tokens)
 * — lands near 460 tokens, inside 512 with margin.
 *
 * If the compose template ever ships `--ubatch-size`, THIS file is the one
 * place that changes.
 */

import { formatDocumentInput } from "./client.js";

/** llama.cpp's default physical batch, which the shipped compose does not raise. */
export const EMBEDDING_PHYSICAL_BATCH_TOKENS = 512;

/** Held back for BOS/EOS, the formatter prefix, and tokenizer variance. */
export const EMBEDDING_BATCH_RESERVE_TOKENS = 32;

/** Pessimistic characters-per-token conversion — see the module note. */
export const EMBEDDING_CONSERVATIVE_CHARS_PER_TOKEN = 3;

/**
 * Hard bound on the FORMATTED document input (`title: … | text: …`), in
 * characters. Anything longer must never be sent: the provider rejects it and
 * the caller retries forever.
 */
export const EMBEDDING_DOCUMENT_MAX_CHARS =
  (EMBEDDING_PHYSICAL_BATCH_TOKENS - EMBEDDING_BATCH_RESERVE_TOKENS) *
  EMBEDDING_CONSERVATIVE_CHARS_PER_TOKEN;

/**
 * The MODEL-FACING budget stated in the chunker prompts: the maximum combined
 * length of a chunk's theme and narrative fields (`happened_md`, `did_md`,
 * `tried_md`, and the outstanding-item texts).
 *
 * It is smaller than `EMBEDDING_DOCUMENT_MAX_CHARS` because the model's text is
 * not what gets embedded. `renderBodyMd` wraps it in section headers (~80
 * characters) and renders each outstanding item with a server-generated UUID
 * and ISO timestamp (~94 characters of scaffolding each, five items maximum —
 * `MAX_OUTSTANDING_ITEMS_PER_CHUNK`), and `formatDocumentInput` adds ~15 more.
 * 800 + 15 + 80 + 5 × 94 = 1365 ≤ 1440, so a compliant chunk fits by
 * construction. The validator on the formatted input remains authoritative;
 * this number only makes compliance the model's default rather than luck.
 */
export const MEMORY_CHUNK_MODEL_BUDGET_CHARS = 800;

/** Length of the exact string `embedDocument` would send for this pair. */
export function embeddingDocumentInputChars(
  title: string,
  body: string,
): number {
  return formatDocumentInput(title, body).length;
}

/** True when this pair would exceed the provider's usable batch. */
export function exceedsEmbeddingDocumentBudget(
  title: string,
  body: string,
): boolean {
  return embeddingDocumentInputChars(title, body) > EMBEDDING_DOCUMENT_MAX_CHARS;
}
