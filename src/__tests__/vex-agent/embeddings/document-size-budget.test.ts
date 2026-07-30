/**
 * The embedding document size budget.
 *
 * The reproduction case is the one the live acceptance run hit on 2026-07-30: a
 * ~747-token session memory chunk was handed to `embedDocument`, the shipped
 * llama.cpp server (512-token physical batch, no `--ubatch-size`) answered HTTP
 * 500, and the preparation row sat in `chunks_status = 'frozen'` retrying
 * forever. The budget has to reject that body BEFORE it is frozen.
 */

import { describe, it, expect } from "vitest";

import {
  EMBEDDING_DOCUMENT_MAX_CHARS,
  EMBEDDING_PHYSICAL_BATCH_TOKENS,
  EMBEDDING_CONSERVATIVE_CHARS_PER_TOKEN,
  MEMORY_CHUNK_MODEL_BUDGET_CHARS,
  embeddingDocumentInputChars,
  exceedsEmbeddingDocumentBudget,
} from "@vex-agent/embeddings/document-size-budget.js";
import { MAX_OUTSTANDING_ITEMS_PER_CHUNK } from "@vex-agent/memory/session-memory-policy.js";

/** ~3000 characters of prose — the size class of the 747-token live chunk. */
const LIVE_OVERSIZED_BODY = "the kyberswap quote timed out again. ".repeat(81);

describe("embedding document size budget", () => {
  it("rejects the live 747-token chunk that froze branch B forever", () => {
    expect(LIVE_OVERSIZED_BODY.length).toBeGreaterThan(2500);
    expect(
      exceedsEmbeddingDocumentBudget("kyber_quote_timeout_pattern", LIVE_OVERSIZED_BODY),
    ).toBe(true);
  });

  it("accepts a body inside the budget", () => {
    const body = "a".repeat(EMBEDDING_DOCUMENT_MAX_CHARS - 100);
    expect(exceedsEmbeddingDocumentBudget("kyber_quote_timeout_pattern", body)).toBe(
      false,
    );
  });

  it("measures the formatted input, not the raw body", () => {
    // `title: <t> | text: <b>` — the prefix is real bytes the provider tokenizes.
    expect(embeddingDocumentInputChars("t", "b")).toBeGreaterThan(2);
    const body = "a".repeat(EMBEDDING_DOCUMENT_MAX_CHARS);
    expect(exceedsEmbeddingDocumentBudget("t", body)).toBe(true);
  });

  it("stays inside the provider's physical batch under the conservative ratio", () => {
    expect(
      EMBEDDING_DOCUMENT_MAX_CHARS / EMBEDDING_CONSERVATIVE_CHARS_PER_TOKEN,
    ).toBeLessThan(EMBEDDING_PHYSICAL_BATCH_TOKENS);
  });

  it("leaves room for the worst-case rendered body a compliant chunk produces", () => {
    // Section headers + per-item UUID/ISO scaffolding + formatter prefix. A
    // model that obeys the stated budget must not be able to overflow the
    // authoritative bound through render overhead alone.
    const renderOverhead = 80 + MAX_OUTSTANDING_ITEMS_PER_CHUNK * 94 + 15;
    expect(MEMORY_CHUNK_MODEL_BUDGET_CHARS + renderOverhead).toBeLessThanOrEqual(
      EMBEDDING_DOCUMENT_MAX_CHARS,
    );
  });
});
