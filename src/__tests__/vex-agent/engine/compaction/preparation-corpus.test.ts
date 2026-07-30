/**
 * Corpus reading + deterministic render for the preparation branch workers.
 *
 * The property under test is the one contract C2 exists to guarantee: every
 * branch and every retry reads the SAME bytes and renders them to the SAME
 * string. If that quietly stops being true, nothing fails — the two branches
 * just describe slightly different conversations, forever.
 */

import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";

import {
  buildPreparationCorpus,
  serializePreparationCorpus,
} from "@vex-agent/engine/compaction-prep/index.js";
import {
  buildCorpusProviderMessages,
  readPreparationCorpus,
  verifyToolPairClosure,
} from "@vex-agent/engine/compaction/preparation-corpus.js";
import type { CompactionPreparation } from "@vex-agent/db/repos/compaction-preparations/index.js";
import type { MessageWithId } from "@vex-agent/db/repos/messages/types.js";

function messages(): MessageWithId[] {
  return [
    {
      id: 1,
      role: "user",
      content: "swap some tokens please",
      toolCallId: null,
      toolCalls: null,
    },
    {
      id: 2,
      role: "assistant",
      content: "quoting",
      toolCallId: null,
      toolCalls: [
        { id: "call-1", command: "kyber_quote", args: { to: "USDC", from: "SOL" } },
      ],
    },
    {
      id: 3,
      role: "tool",
      content: "quote returned",
      toolCallId: "call-1",
      toolCalls: null,
    },
  ] as unknown as MessageWithId[];
}

function preparationWith(
  corpusText: string | null,
  overrides: Partial<CompactionPreparation> = {},
): CompactionPreparation {
  const sha =
    corpusText === null
      ? "0".repeat(64)
      : createHash("sha256").update(corpusText, "utf8").digest("hex");
  return {
    id: 7,
    corpusText,
    corpusSha256: sha,
    corpusPrunedAt: null,
    ...overrides,
  } as CompactionPreparation;
}

function storedCorpusText(): string {
  return serializePreparationCorpus(
    buildPreparationCorpus({
      frozenSummary: "previous history",
      rows: messages(),
      watermarkMessageId: 3,
    }),
  );
}

describe("readPreparationCorpus", () => {
  it("round-trips the stored canonical bytes", () => {
    const text = storedCorpusText();
    const corpus = readPreparationCorpus(preparationWith(text));

    expect(corpus.watermarkMessageId).toBe(3);
    expect(corpus.frozenSummary).toBe("previous history");
    expect(corpus.entries).toHaveLength(3);
  });

  it("rejects a corpus whose fingerprint does not match the stored sha256", () => {
    const text = storedCorpusText();
    const tampered = preparationWith(text, { corpusSha256: "b".repeat(64) });

    // Loud, not best-effort: a summary produced from the wrong corpus REPLACES
    // the session's rolling summary and is unrecoverable after the cutover.
    expect(() => readPreparationCorpus(tampered)).toThrow(/corpus mismatch/);
  });

  it("rejects a pruned corpus rather than summarising nothing", () => {
    expect(() => readPreparationCorpus(preparationWith(null))).toThrow(
      /compaction_corpus_unavailable/,
    );
  });

  it("rejects malformed stored bytes at the boundary instead of coercing them", () => {
    const malformed = '{"version":1,"entries":"not-an-array"}';
    expect(() => readPreparationCorpus(preparationWith(malformed))).toThrow(
      /failed validation/,
    );
  });
});

describe("buildCorpusProviderMessages", () => {
  it("preserves the ORIGINAL roles instead of flattening to text", () => {
    const corpus = readPreparationCorpus(preparationWith(storedCorpusText()));
    const messages = buildCorpusProviderMessages(corpus);

    // The branches fork from the tape: the model receives the conversation, not
    // a `[role] text` blob inside one user message.
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(messages[0]?.content).toBe("swap some tokens please");
  });

  it("keeps the assistant→tool pairing intact and canonical arguments parsed", () => {
    const corpus = readPreparationCorpus(preparationWith(storedCorpusText()));
    const messages = buildCorpusProviderMessages(corpus);

    expect(messages[1]?.toolCalls).toEqual([
      { id: "call-1", command: "kyber_quote", args: { from: "SOL", to: "USDC" } },
    ]);
    expect(messages[2]?.toolCallId).toBe("call-1");
    expect(verifyToolPairClosure(messages)).toEqual({ ok: true });
  });

  it("is deterministic across repeated builds", () => {
    const corpus = readPreparationCorpus(preparationWith(storedCorpusText()));
    const builds = Array.from({ length: 5 }, () =>
      JSON.stringify(buildCorpusProviderMessages(corpus)),
    );
    expect(new Set(builds).size).toBe(1);
  });

  it("carries the orphan-repair placeholder through as a real tool message", () => {
    const orphan = [
      {
        id: 1,
        role: "assistant",
        content: "calling",
        toolCallId: null,
        toolCalls: [{ id: "call-9", command: "kyber_quote", args: {} }],
      },
    ] as unknown as MessageWithId[];
    const text = serializePreparationCorpus(
      buildPreparationCorpus({
        frozenSummary: null,
        rows: orphan,
        watermarkMessageId: 1,
      }),
    );
    const corpus = readPreparationCorpus(preparationWith(text));
    const messages = buildCorpusProviderMessages(corpus);

    expect(corpus.repairedPlaceholders).toBe(1);
    // Capture repaired the orphan, so what reaches the provider is pair-closed.
    expect(messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-9" });
    expect(verifyToolPairClosure(messages)).toEqual({ ok: true });
  });
});

describe("verifyToolPairClosure", () => {
  it("names an unanswered tool call rather than shipping it to the provider", () => {
    const broken = [
      { role: "user" as const, content: "hi" },
      {
        role: "assistant" as const,
        content: "calling",
        toolCalls: [{ id: "call-7", command: "kyber_quote", args: {} }],
      },
      { role: "user" as const, content: "still there?" },
    ];
    expect(verifyToolPairClosure(broken)).toEqual({
      ok: false,
      reason: "unanswered tool call(s): call-7",
    });
  });

  it("rejects a tool result that answers nothing", () => {
    const orphanResult = [
      { role: "user" as const, content: "hi" },
      { role: "tool" as const, content: "result", toolCallId: "call-3" },
    ];
    const outcome = verifyToolPairClosure(orphanResult);
    expect(outcome.ok).toBe(false);
  });
});
