/**
 * VARIANT MAPPING — `toTranscriptRow` / `toTranscriptRows` (stage 8-1). Locks
 * the role+kind → variant rules, the tool-name label fallback, and the
 * tool call ↔ result correlation pass.
 *
 * This suite crossed the 550-line hard limit and was split by responsibility;
 * the file KEEPS its name (and stays the entry point for the mapping rules)
 * while the rest moved into the sibling `transcriptRowModel/` folder:
 *   - `act-ledger-grouping.test.ts` — the `groupTranscriptRows` post-pass.
 *   - `dto-field-propagation.test.ts` — explorerRefs / reasoning / durationMs.
 *   - `message-dto-fixture.ts` — the shared DTO builders all three use.
 */

import { describe, expect, it } from "vitest";
import { toTranscriptRow, toTranscriptRows } from "../transcriptRowModel.js";
import { dto } from "./transcriptRowModel/message-dto-fixture.js";

describe("toTranscriptRow", () => {
  it("maps a user text message to the user variant (no label)", () => {
    const row = toTranscriptRow(dto({ role: "user", kind: "text", content: "hi" }));
    expect(row.variant).toBe("user");
    expect(row.label).toBeNull();
    expect(row.content).toBe("hi");
  });

  it("maps assistant text → assistant, system text → notice", () => {
    expect(toTranscriptRow(dto({ role: "assistant", kind: "text" })).variant).toBe(
      "assistant",
    );
    expect(toTranscriptRow(dto({ role: "system", kind: "text" })).variant).toBe(
      "notice",
    );
  });

  it("maps tool-role text to the tool variant with the tool-name label", () => {
    const row = toTranscriptRow(
      dto({ role: "tool", kind: "text", toolName: "polymarket:order" }),
    );
    expect(row.variant).toBe("tool");
    expect(row.label).toBe("polymarket:order");
  });

  it("maps tool_call / tool_result kinds to the tool variant regardless of role", () => {
    expect(
      toTranscriptRow(dto({ role: "assistant", kind: "tool_call", toolName: "swap" }))
        .variant,
    ).toBe("tool");
    expect(
      toTranscriptRow(dto({ role: "tool", kind: "tool_result" })).variant,
    ).toBe("tool");
  });

  it("a tool_call row carries the tool name as label (null when none) and toolKind 'call'", () => {
    const r = toTranscriptRow(
      dto({ role: "assistant", kind: "tool_call", toolName: "swap" }),
    );
    expect(r.toolKind).toBe("call");
    expect(r.label).toBe("swap");
    expect(
      toTranscriptRow(
        dto({ role: "assistant", kind: "tool_call", toolName: null }),
      ).label,
    ).toBeNull();
  });

  it("maps runtime_notice and error kinds to the notice variant", () => {
    expect(
      toTranscriptRow(dto({ role: "assistant", kind: "runtime_notice" })).variant,
    ).toBe("notice");
    expect(toTranscriptRow(dto({ role: "system", kind: "error" })).variant).toBe(
      "notice",
    );
  });

  // M6: the operator-instruction acknowledgement is a notice like any other to
  // look at, but it carries the `ack` tone so the renderer can announce it.
  // The tone is what separates it from a wake banner - WITHOUT it the row is
  // indistinguishable from every other runtime notice, and then either nothing
  // is announced or everything is.
  it("maps the operator_ack kind to an announced notice (M6)", () => {
    const row = toTranscriptRow(
      dto({ role: "system", kind: "operator_ack", content: "Saved." }),
    );
    expect(row.variant).toBe("notice");
    expect(row.noticeTone).toBe("ack");
    // Every other runtime notice stays silent.
    expect(
      toTranscriptRow(dto({ role: "system", kind: "runtime_notice" })).noticeTone,
    ).toBe("runtime");
  });

  it("maps the compaction kind to the compaction variant (no label) (8-4)", () => {
    const row = toTranscriptRow(
      dto({
        role: "system",
        kind: "compaction",
        content: "compacted · checkpoint 2",
      }),
    );
    expect(row.variant).toBe("compaction");
    expect(row.label).toBeNull();
    expect(row.content).toBe("compacted · checkpoint 2");
  });

  it("maps the recall kind to the recall variant carrying the tool name as label (8-4)", () => {
    expect(
      toTranscriptRow(
        dto({ role: "assistant", kind: "recall", toolName: "session_memory_search" }),
      ).variant,
    ).toBe("recall");
    expect(
      toTranscriptRow(
        dto({ role: "assistant", kind: "recall", toolName: "long_memory_search" }),
      ).label,
    ).toBe("long_memory_search");
    // A recall row with no tool name keeps a null label (neutral marker copy).
    expect(
      toTranscriptRow(dto({ role: "assistant", kind: "recall", toolName: null }))
        .label,
    ).toBeNull();
  });

  it("maps the assistant_stopped kind to the assistant_stopped variant (no label) (9-5b)", () => {
    const row = toTranscriptRow(
      dto({ role: "assistant", kind: "assistant_stopped", content: "partial…" }),
    );
    expect(row.variant).toBe("assistant_stopped");
    expect(row.label).toBeNull();
    expect(row.content).toBe("partial…");
  });
});

describe("toTranscriptRows - tool call/result correlation (batch 3)", () => {
  it("labels a tool_result `<toolName>_output` by correlating toolCallId to its call", () => {
    const call = dto({
      id: 1,
      role: "assistant",
      kind: "tool_call",
      content: "",
      toolCalls: [
        { toolCallId: "abc", toolName: "wallet:read", toolArgs: '{"chain":"base"}' },
      ],
    });
    const result = dto({
      id: 2,
      role: "tool",
      kind: "tool_result",
      content: "0.5 ETH",
      toolCallId: "abc",
    });
    const rows = toTranscriptRows([call, result]);
    const resRow = rows.find((r) => r.id === 2)!;
    expect(resRow.toolKind).toBe("result");
    expect(resRow.label).toBe("wallet:read_output");
    expect(resRow.content).toBe("0.5 ETH"); // output preserved as the disclosure body
  });

  it("falls back to `tool_output` when a result cannot be correlated", () => {
    const orphan = dto({
      id: 9,
      role: "tool",
      kind: "tool_result",
      content: "x",
      toolCallId: "missing",
    });
    expect(toTranscriptRows([orphan])[0]!.label).toBe("tool_output");
  });

  it("splits assistant prose off a multi-tool row: standalone prose row + the disclosures", () => {
    const call = dto({
      id: 5,
      role: "assistant",
      kind: "tool_call",
      content: "Checking two things.",
      toolCalls: [
        { toolCallId: "a", toolName: "wallet:read", toolArgs: '{"chain":"base"}' },
        { toolCallId: "b", toolName: "dexscreener:search", toolArgs: null },
      ],
    });
    const result = dto({
      id: 6,
      role: "tool",
      kind: "tool_result",
      content: "",
      toolCallId: "b",
    });
    const rows = toTranscriptRows([call, result]);
    // The step's prose splits into a standalone assistant row (visible + in order)…
    const proseRow = rows.find((r) => r.id === 5 && r.variant === "assistant")!;
    expect(proseRow.content).toBe("Checking two things.");
    // …and the tool row keeps every disclosure but no prose.
    const callRow = rows.find((r) => r.id === 5 && r.variant === "tool")!;
    expect(callRow.toolKind).toBe("call");
    expect(callRow.content).toBe("");
    expect(callRow.toolCalls?.map((c) => c.toolName)).toEqual([
      "wallet:read",
      "dexscreener:search",
    ]);
    // Prose row renders BEFORE its tool row (chronological order).
    expect(
      rows.findIndex((r) => r.variant === "assistant" && r.id === 5),
    ).toBeLessThan(rows.findIndex((r) => r.variant === "tool" && r.id === 5));
    // The second tool's result correlates to the second tool's name.
    expect(rows.find((r) => r.id === 6)!.label).toBe("dexscreener:search_output");
  });
});
