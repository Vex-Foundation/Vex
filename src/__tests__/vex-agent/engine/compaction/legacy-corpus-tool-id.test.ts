/**
 * A v1 corpus frozen BEFORE tool-call id normalization existed can carry
 * duplicate or blank ids. Those artefacts are still readable (the schema did
 * not change), and both branch workers run `verifyToolPairClosure` on the
 * rendered prefix BEFORE any provider call — and that check is `Set`-based, so
 * two same-block calls sharing one id collapse to a single expected occurrence
 * and the second result is rejected locally. Compaction would then fail
 * forever on that session, with the mapper's own guard never reached.
 *
 * So the repair has to land in `buildCorpusProviderMessages`, which is the one
 * place both workers go through.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

import {
  buildCorpusProviderMessages,
  readPreparationCorpus,
  verifyToolPairClosure,
} from "@vex-agent/engine/compaction/preparation-corpus.js";
import { mapMessages } from "@vex-agent/inference/openrouter/mappers.js";
import type { PreparationCorpus } from "@vex-agent/engine/compaction-prep/index.js";
import type { CompactionPreparation } from "@vex-agent/db/repos/compaction-preparations/index.js";

function frozenPreparation(corpus: PreparationCorpus): CompactionPreparation {
  const corpusText = JSON.stringify(corpus);
  return {
    id: 11,
    corpusText,
    corpusSha256: createHash("sha256").update(corpusText, "utf8").digest("hex"),
    corpusPrunedAt: null,
  } as CompactionPreparation;
}

function legacyCorpus(callId: string): PreparationCorpus {
  return {
    version: 1,
    watermarkMessageId: 3,
    frozenSummary: null,
    entries: [
      {
        sourceMessageId: 1,
        role: "assistant",
        content: "quoting both legs",
        toolCallId: null,
        toolCalls: [
          { id: callId, command: "kyber_quote", argsJson: '{"leg":1}' },
          { id: callId, command: "kyber_quote", argsJson: '{"leg":2}' },
        ],
      },
      {
        sourceMessageId: 2,
        role: "tool",
        content: "leg 1 quote",
        toolCallId: callId,
        toolCalls: null,
      },
      {
        sourceMessageId: 3,
        role: "tool",
        content: "leg 2 quote",
        toolCallId: callId,
        toolCalls: null,
      },
    ],
    redactionCounts: { hard: 0, mask: 0 },
    repairedPlaceholders: 0,
  };
}

describe("legacy v1 corpus with poisoned tool-call ids", () => {
  it("renders SAME-BLOCK duplicates into a pair-closed, mappable prefix", () => {
    const corpus = readPreparationCorpus(frozenPreparation(legacyCorpus("fc_2")));
    const messages = buildCorpusProviderMessages(corpus);

    const ids = (messages[0]?.toolCalls ?? []).map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(messages[1]?.toolCallId).toBe(ids[0]);
    expect(messages[2]?.toolCallId).toBe(ids[1]);

    // The gate both branch workers run before spending an inference call.
    expect(verifyToolPairClosure(messages)).toEqual({ ok: true });

    // …and the request the worker then builds carries unique declared ids.
    const mapped = mapMessages(messages);
    expect(mapped).toHaveLength(3);
    expect(mapped[1]).toMatchObject({ role: "tool", toolCallId: ids[0] });
    expect(mapped[2]).toMatchObject({ role: "tool", toolCallId: ids[1] });

    // The frozen arguments survive the repair — only ids move.
    expect((messages[0]?.toolCalls ?? []).map((c) => c.args)).toEqual([
      { leg: 1 },
      { leg: 2 },
    ]);
  });

  it("renders BLANK ids into a pair-closed prefix", () => {
    const corpus = readPreparationCorpus(frozenPreparation(legacyCorpus("")));
    const messages = buildCorpusProviderMessages(corpus);

    const ids = (messages[0]?.toolCalls ?? []).map((c) => c.id);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(verifyToolPairClosure(messages)).toEqual({ ok: true });
    expect(messages[1]?.role).toBe("tool");
  });

  it("is deterministic across repeated renders of the same frozen corpus", () => {
    const corpus = readPreparationCorpus(frozenPreparation(legacyCorpus("fc_2")));
    const renders = Array.from({ length: 5 }, () =>
      JSON.stringify(buildCorpusProviderMessages(corpus)),
    );
    expect(new Set(renders).size).toBe(1);
  });
});
