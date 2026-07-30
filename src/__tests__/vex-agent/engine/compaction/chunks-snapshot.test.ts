/**
 * Branch-B frozen snapshot construction.
 *
 * The snapshot is the ONE artifact every retry re-inserts, so what matters is
 * that it is complete (nothing has to be regenerated at insert time), redacted
 * (nothing secret reaches the DB or the embedding), and schema-valid (the repo
 * parses it back on read and refuses anything it does not understand).
 */

import { describe, it, expect } from "vitest";

import { validateTheme } from "@vex-agent/memory/theme-validation.js";

import { FrozenChunksOutputSchema } from "@vex-agent/db/repos/compaction-preparations/index.js";
import { BODY_MD_SCHEMA_VERSION } from "@vex-agent/db/repos/session-memories/index.js";
import { buildChunksSnapshot } from "@vex-agent/engine/compaction/chunks-snapshot.js";
import type { PreparationChunk } from "@vex-agent/engine/compaction/chunks-call.js";

function chunk(overrides: Partial<PreparationChunk> = {}): PreparationChunk {
  return {
    theme: "kyber_quote_timeout_pattern",
    entities: [],
    protocols: ["kyberswap"],
    error_classes: [],
    chains: ["solana"],
    tasks: [],
    happened_md: "the quote timed out twice",
    did_md: "retried with a longer deadline",
    tried_md: "",
    outstanding_items: ["confirm the retry policy with the user"],
    ...overrides,
  };
}

function build(chunks: PreparationChunk[]) {
  return buildChunksSnapshot({
    preparationId: 3,
    chunks,
    targetGeneration: 4,
  });
}

describe("buildChunksSnapshot", () => {
  it("labels a model-supplied valid theme as `chunker`", () => {
    const { snapshot } = build([chunk()]);
    expect(snapshot.chunks[0]?.themeSource).toBe("chunker");
  });

  it("emits a snapshot the repo's own schema accepts", () => {
    const { snapshot } = build([chunk()]);
    // The repo parses this JSONB back on every read; a snapshot it rejects is
    // a permanently unlandable one.
    expect(FrozenChunksOutputSchema.safeParse(snapshot).success).toBe(true);
  });

  it("freezes everything the insert needs, so nothing is regenerated on retry", () => {
    const { snapshot } = build([chunk()]);
    const frozen = snapshot.chunks[0];

    expect(frozen).toBeDefined();
    if (!frozen) return;
    // Server-generated identity is part of the snapshot: `prepareMemoryRender`
    // would mint a NEW uuid and timestamp on a retry, and `body_md` embeds
    // both, so re-rendering would not reproduce the embedded bytes.
    expect(frozen.outstandingItems[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(frozen.outstandingItems[0]?.createdAt).toBeTruthy();
    expect(frozen.bodyMd).toContain(frozen.outstandingItems[0]?.id ?? "");
    expect(frozen.bodyMdHash).toHaveLength(64);
    expect(frozen.contentHash).toHaveLength(64);
    expect(frozen.bodyMdSchemaVersion).toBe(BODY_MD_SCHEMA_VERSION);
  });

  it("redacts every emitted string field before it can reach storage", () => {
    const { snapshot } = build([
      chunk({
        happened_md:
          "the user's wallet 0x1234567890abcdef1234567890abcdef12345678 was funded",
        entities: ["0x1234567890abcdef1234567890abcdef12345678"],
        outstanding_items: [
          "revisit 0x1234567890abcdef1234567890abcdef12345678 allowance",
        ],
      }),
    ]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(
      "0x1234567890abcdef1234567890abcdef12345678",
    );
  });

  it("falls back to a generated theme built from REDACTED structured fields", () => {
    const { snapshot } = build([
      chunk({
        theme: "debug",
        protocols: ["kyberswap"],
        error_classes: ["timeout"],
      }),
    ]);
    const theme = snapshot.chunks[0]?.theme ?? "";
    expect(theme).not.toBe("debug");
    expect(theme.split("_").length).toBeGreaterThanOrEqual(3);
    // ...and it is LABELLED as a fallback, at the only point where that is
    // knowable. The assertion below is the reason the snapshot carries the
    // label at all: the generated theme VALIDATES, so a downstream
    // "did this validate?" check would have recorded `chunker` and quietly
    // falsified the row's provenance.
    expect(validateTheme(theme).ok).toBe(true);
    expect(snapshot.chunks[0]?.themeSource).toBe("fallback");
  });

  it("drops live-state chunks and counts them at freeze time", () => {
    const live = chunk({
      happened_md:
        "balance 12.5 SOL price $143.22 gas 0.00021 balance 3.1 ETH price $2411.10",
      did_md: "",
      outstanding_items: [],
    });
    const result = build([chunk(), live]);

    expect(result.snapshot.chunks).toHaveLength(1);
    expect(result.rejectedByExclusion).toBe(1);
    // Redaction sanitizes in place and never drops a chunk — a real 0, not a
    // placeholder, so the two counters keep answering different questions.
    expect(result.rejectedByRedaction).toBe(0);
  });

  it("hashes the snapshot it actually emits", () => {
    const a = build([chunk()]);
    expect(a.snapshotSha256).toHaveLength(64);
    // Different content ⇒ different digest, so the stored sha256 is a usable
    // integrity check on the JSONB column.
    const b = build([chunk({ happened_md: "something else entirely" })]);
    expect(b.snapshotSha256).not.toBe(a.snapshotSha256);
  });

  it("caps outstanding items at the memory policy limit", () => {
    const { snapshot } = build([
      chunk({
        outstanding_items: Array.from({ length: 12 }, (_, i) => `item ${i}`),
      }),
    ]);
    expect(snapshot.chunks[0]?.outstandingItems.length).toBeLessThanOrEqual(5);
  });
});
