/**
 * Legacy chunking worker — the pre-insert size guard.
 *
 * The legacy path shares the defect and the rule, but not the repair round: its
 * job machinery already retries with backoff and terminalizes at
 * `WORKER_MAX_ATTEMPTS`, so the smallest safe change is to refuse the oversized
 * chunk BEFORE `embedDocument`. What must hold is the same invariant as branch
 * B's: nothing oversized is ever embedded or inserted, and the failure is a
 * named failed attempt rather than an endless retry against an HTTP 500.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const embedDocument = vi.fn();
const insertPreparedMemory = vi.fn();

vi.mock("@vex-agent/embeddings/client.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, embedDocument };
});

vi.mock("@vex-agent/db/repos/session-memories/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, insertPreparedMemory };
});

const { processChunkerOutput } = await import(
  "@vex-agent/engine/compact-jobs/chunk-processing.js"
);

import type { CompactJob } from "@vex-agent/db/repos/compact-jobs/index.js";
import type { ChunkerChunk } from "@vex-agent/engine/compact-jobs/chunker-call.js";

const OVERSIZED_TEXT = "the kyberswap quote timed out again. ".repeat(81);

function job(): CompactJob {
  return {
    id: 1,
    sessionId: "session-1",
    checkpointGeneration: 3,
    sourceStartMessageId: 1,
    sourceEndMessageId: 2,
  } as unknown as CompactJob;
}

function chunk(happened: string): ChunkerChunk {
  return {
    theme: "kyber_quote_timeout_pattern",
    entities: [],
    protocols: ["kyberswap"],
    error_classes: [],
    chains: ["solana"],
    tasks: [],
    happened_md: happened,
    did_md: "",
    tried_md: "",
    outstanding_items: [],
  };
}

describe("processChunkerOutput embedding size budget", () => {
  beforeEach(() => {
    embedDocument.mockReset();
    insertPreparedMemory.mockReset();
    embedDocument.mockResolvedValue({
      embedding: [0.1],
      providerModel: "test/embed",
    });
    insertPreparedMemory.mockResolvedValue({ inserted: true });
  });

  it("refuses an oversized chunk before it reaches the embeddings provider", async () => {
    await expect(
      processChunkerOutput({
        job: job(),
        chunkerOutput: [chunk(OVERSIZED_TEXT)],
        claimGuard: { isLost: () => false },
      }),
    ).rejects.toThrow(/chunker_chunk_exceeds_embedding_budget/);

    expect(embedDocument).not.toHaveBeenCalled();
    expect(insertPreparedMemory).not.toHaveBeenCalled();
  });

  it("still processes a chunk inside the budget", async () => {
    const outcome = await processChunkerOutput({
      job: job(),
      chunkerOutput: [chunk("the quote timed out twice")],
      claimGuard: { isLost: () => false },
    });

    expect(outcome).toEqual({ kind: "completed", inserted: 1, rejectedExclusion: 0 });
    expect(embedDocument).toHaveBeenCalledTimes(1);
  });
});
