import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

import {
  CORPUS_FORMAT_VERSION,
  buildPreparationCorpus,
  serializePreparationCorpus,
  fingerprintPreparationCorpus,
  parsePreparationCorpus,
} from "@vex-agent/engine/compaction-prep/corpus.js";
import { TOOL_RESULT_PLACEHOLDER_CONTENT } from "@vex-agent/engine/core/transcript-integrity.js";
import type { MessageWithId } from "@vex-agent/db/repos/messages/types.js";

function message(
  id: number,
  role: MessageWithId["role"],
  content: string,
  extra: Partial<MessageWithId> = {},
): MessageWithId {
  return {
    id,
    role,
    content,
    timestamp: new Date(0).toISOString(),
    ...extra,
  };
}

describe("buildPreparationCorpus — determinism", () => {
  it("produces byte-identical serialization across repeated builds over equal inputs", () => {
    // Two independently constructed input sets, equal in value. Nothing is
    // shared between them, so identical bytes can only come from the build +
    // serialization being deterministic, not from object reuse.
    const makeRows = (): MessageWithId[] => [
      message(1, "user", "buy some SOL"),
      message(2, "assistant", "calling a tool", {
        toolCalls: [
          { id: "call_1", command: "swap", args: { amount: 3, chain: "sol" } },
        ],
      }),
      message(3, "tool", "done", { toolCallId: "call_1" }),
    ];

    const first = buildPreparationCorpus({
      frozenSummary: "earlier history",
      rows: makeRows(),
      watermarkMessageId: 3,
    });
    const second = buildPreparationCorpus({
      frozenSummary: "earlier history",
      rows: makeRows(),
      watermarkMessageId: 3,
    });

    const a = serializePreparationCorpus(first);
    const b = serializePreparationCorpus(second);
    expect(a).toBe(b);
    expect(fingerprintPreparationCorpus(a)).toBe(
      fingerprintPreparationCorpus(b),
    );
  });

  it("is insensitive to tool-argument key insertion order", () => {
    // The JSONB driver may hand back the same arguments with any key order.
    const forward: Record<string, unknown> = {};
    forward.alpha = 1;
    forward.beta = { inner: true, also: [3, 2, 1] };
    forward.gamma = "x";

    const reverse: Record<string, unknown> = {};
    reverse.gamma = "x";
    reverse.beta = { also: [3, 2, 1], inner: true };
    reverse.alpha = 1;

    const rowsWith = (args: Record<string, unknown>): MessageWithId[] => [
      message(1, "assistant", "call", {
        toolCalls: [{ id: "c1", command: "swap", args }],
      }),
      message(2, "tool", "ok", { toolCallId: "c1" }),
    ];

    const one = serializePreparationCorpus(
      buildPreparationCorpus({
        frozenSummary: null,
        rows: rowsWith(forward),
        watermarkMessageId: 2,
      }),
    );
    const two = serializePreparationCorpus(
      buildPreparationCorpus({
        frozenSummary: null,
        rows: rowsWith(reverse),
        watermarkMessageId: 2,
      }),
    );

    expect(one).toBe(two);
    // Array order is content, not noise — it must survive verbatim.
    expect(one).toContain("[3,2,1]");
  });

  it("fingerprints the exact serialized bytes", () => {
    const corpus = buildPreparationCorpus({
      frozenSummary: null,
      rows: [message(1, "user", "hi")],
      watermarkMessageId: 1,
    });
    const serialized = serializePreparationCorpus(corpus);
    expect(fingerprintPreparationCorpus(serialized)).toBe(
      createHash("sha256").update(serialized, "utf8").digest("hex"),
    );
  });

  it("does not mutate the input rows", () => {
    const rows: MessageWithId[] = [
      message(1, "assistant", "call", {
        toolCalls: [{ id: "c1", command: "swap", args: { a: 1 } }],
      }),
    ];
    const snapshot = JSON.stringify(rows);
    buildPreparationCorpus({
      frozenSummary: null,
      rows,
      watermarkMessageId: 1,
    });
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});

describe("buildPreparationCorpus — membership and identity", () => {
  it("keeps source message ids and excludes rows past the watermark", () => {
    const corpus = buildPreparationCorpus({
      frozenSummary: null,
      rows: [
        message(1, "user", "a"),
        message(2, "assistant", "b"),
        message(7, "user", "past the watermark"),
      ],
      watermarkMessageId: 2,
    });

    expect(corpus.entries.map((e) => e.sourceMessageId)).toEqual([1, 2]);
    expect(corpus.watermarkMessageId).toBe(2);
    expect(corpus.version).toBe(CORPUS_FORMAT_VERSION);
  });

  it("preserves the caller's row order rather than re-sorting by id", () => {
    // `created_at` is caller-supplied, so a lower id can legitimately sort
    // after a higher one. The corpus must reflect the transcript order.
    const corpus = buildPreparationCorpus({
      frozenSummary: null,
      rows: [message(9, "user", "first"), message(4, "assistant", "second")],
      watermarkMessageId: 9,
    });
    expect(corpus.entries.map((e) => e.content)).toEqual(["first", "second"]);
  });

  it("gives synthetic repair placeholders a null source id, deterministically", () => {
    const rows: MessageWithId[] = [
      message(1, "assistant", "two calls, one answer", {
        toolCalls: [
          { id: "c1", command: "swap", args: {} },
          { id: "c2", command: "quote", args: {} },
        ],
      }),
      message(2, "tool", "answer for c1", { toolCallId: "c1" }),
    ];

    const corpus = buildPreparationCorpus({
      frozenSummary: null,
      rows,
      watermarkMessageId: 2,
    });

    expect(corpus.repairedPlaceholders).toBe(1);
    const placeholders = corpus.entries.filter(
      (e) => e.sourceMessageId === null,
    );
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]).toMatchObject({
      role: "tool",
      content: TOOL_RESULT_PLACEHOLDER_CONTENT,
      toolCallId: "c2",
    });
    // Every non-synthetic entry keeps its DB identity.
    expect(
      corpus.entries
        .filter((e) => e.sourceMessageId !== null)
        .map((e) => e.sourceMessageId),
    ).toEqual([1, 2]);

    // Repair is part of the frozen bytes, so it must be stable across runs.
    const again = buildPreparationCorpus({
      frozenSummary: null,
      rows,
      watermarkMessageId: 2,
    });
    expect(serializePreparationCorpus(again)).toBe(
      serializePreparationCorpus(corpus),
    );
  });

  it("is a no-op on an already-paired transcript", () => {
    const corpus = buildPreparationCorpus({
      frozenSummary: null,
      rows: [
        message(1, "assistant", "call", {
          toolCalls: [{ id: "c1", command: "swap", args: {} }],
        }),
        message(2, "tool", "ok", { toolCallId: "c1" }),
      ],
      watermarkMessageId: 2,
    });
    expect(corpus.repairedPlaceholders).toBe(0);
    expect(corpus.entries).toHaveLength(2);
  });
});

describe("buildPreparationCorpus — redaction", () => {
  it("redacts content and tool-argument values, and reports counts", () => {
    const corpus = buildPreparationCorpus({
      frozenSummary: null,
      rows: [
        message(
          1,
          "user",
          "send to 0x1234567890abcdef1234567890abcdef12345678 please",
        ),
        message(2, "assistant", "ok", {
          toolCalls: [
            {
              id: "c1",
              command: "send",
              args: { to: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" },
            },
          ],
        }),
        message(3, "tool", "sent", { toolCallId: "c1" }),
      ],
      watermarkMessageId: 3,
    });

    const serialized = serializePreparationCorpus(corpus);
    expect(serialized).not.toContain("0x1234567890abcdef");
    expect(serialized).not.toContain("0xabcdefabcdefabcd");
    expect(corpus.redactionCounts.mask).toBeGreaterThanOrEqual(2);
    // Tool names and provider call ids are not secrets and must survive, or
    // the assistant→tool pairing the provider validates would break.
    expect(serialized).toContain("send");
    expect(serialized).toContain("c1");
  });

  it("is stable under a second redaction pass (idempotence of the frozen bytes)", () => {
    const once = buildPreparationCorpus({
      frozenSummary: null,
      rows: [
        message(1, "user", "0x1234567890abcdef1234567890abcdef12345678"),
      ],
      watermarkMessageId: 1,
    });
    const twice = buildPreparationCorpus({
      frozenSummary: null,
      rows: [message(1, "user", once.entries[0].content)],
      watermarkMessageId: 1,
    });
    expect(twice.entries[0].content).toBe(once.entries[0].content);
  });
});

describe("preparation corpus round-trip", () => {
  it("parses back to an equal corpus for null and present frozen summaries", () => {
    for (const frozenSummary of [null, "previous compacted history"]) {
      const corpus = buildPreparationCorpus({
        frozenSummary,
        rows: [message(1, "user", "a"), message(2, "assistant", "b")],
        watermarkMessageId: 2,
      });
      const serialized = serializePreparationCorpus(corpus);
      const parsed = parsePreparationCorpus(serialized);
      expect(parsed).toEqual(corpus);
      // Re-serializing a parsed corpus reproduces the stored bytes exactly.
      expect(serializePreparationCorpus(parsed)).toBe(serialized);
    }
  });

  it("rejects malformed, invalid, and unreadable-version corpora", () => {
    expect(() => parsePreparationCorpus("{not json")).toThrow(/valid JSON/);
    expect(() => parsePreparationCorpus('{"version":1}')).toThrow(
      /failed validation/,
    );

    const corpus = buildPreparationCorpus({
      frozenSummary: null,
      rows: [message(1, "user", "a")],
      watermarkMessageId: 1,
    });
    const bumped = JSON.stringify({
      ...corpus,
      version: CORPUS_FORMAT_VERSION + 1,
    });
    expect(() => parsePreparationCorpus(bumped)).toThrow(
      /not readable by this build/,
    );
  });
});
