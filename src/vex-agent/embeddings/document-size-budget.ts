/**
 * The size budget for ONE document embedding request — the single owner of
 * "how much text may be handed to `embedDocument` in one call".
 *
 * WHY THIS EXISTS. The embeddings runtime is a `llama.cpp` server, and an
 * input longer than its physical batch is not truncated and not split — the
 * server answers HTTP 500 (`input (N tokens) is too large to process.
 * increase the physical batch size`). The branch-B insert tail has no
 * terminal outcome by design and retries, so an over-long chunk would fail
 * every insert forever.
 *
 * Until 2026-10 the shipped server ran llama.cpp's default 512-token batch and
 * this budget assumed 3 characters per token. Session memories disproved that:
 * UUID and ISO-timestamp scaffolding tokenizes at ~1.5 characters per token,
 * and a compliant 1330-character chunk was 544 tokens (HTTP 500). Both
 * runtimes (the compose template and the native launch) now run the server
 * at the model's 2048-token context for context, batch and physical batch
 * (`EMBEDDING_CONTEXT_TOKENS` in vex-app's `shared/embedding-defaults.ts`).
 *
 * WHY CHARACTERS, NOT TOKENS. We do not ship the model's tokenizer, and the
 * only honest bound available at validation time is the character count of the
 * exact string that will be sent. The budget no longer depends on a guessed
 * density: at one token per character (denser than anything we produce)
 *
 *   usable tokens = 2048 physical batch − 32 reserve (BOS/EOS, the
 *                   `title: … | text: …` prefix, tokenizer variance)  = 2016
 *   budget        = 1440 characters of formatted input ≤ 2016
 *
 * The 1440-character budget itself is unchanged, so chunk sizes are too.
 */

import { formatDocumentInput } from "./client.js";

/** The embeddings server's physical batch (the model's context) in both runtimes. */
export const EMBEDDING_PHYSICAL_BATCH_TOKENS = 2048;

/** Held back for BOS/EOS, the formatter prefix, and tokenizer variance. */
export const EMBEDDING_BATCH_RESERVE_TOKENS = 32;

/**
 * Hard bound on the FORMATTED document input (`title: … | text: …`), in
 * characters. Anything longer must never be sent: the provider rejects it and
 * the caller retries forever. Fits the usable batch even at one token per
 * character.
 */
export const EMBEDDING_DOCUMENT_MAX_CHARS = 1440;

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
