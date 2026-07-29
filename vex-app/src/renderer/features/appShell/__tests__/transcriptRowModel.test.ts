/**
 * Pure mapping tests for `toTranscriptRow` (stage 8-1). Locks the role+kind →
 * variant rules and the tool-name label fallback.
 */

import { describe, expect, it } from "vitest";
import type {
  MessageKind,
  MessageRole,
  SessionMessageDto,
} from "@shared/schemas/messages.js";
import {
  groupTranscriptRows,
  TOOL_GROUP_MIN_CALLS,
  toTranscriptRow,
  toTranscriptRows,
  type ToolGroupRowModel,
  type TranscriptEntry,
} from "../transcriptRowModel.js";

function dto(p: {
  readonly role: MessageRole;
  readonly kind: MessageKind;
  readonly content?: string;
  readonly toolName?: string | null;
  readonly toolCallId?: string | null;
  readonly toolCalls?: SessionMessageDto["toolCalls"];
  readonly explorerRefs?: SessionMessageDto["explorerRefs"];
  readonly reasoning?: SessionMessageDto["reasoning"];
  readonly durationMs?: SessionMessageDto["durationMs"];
  readonly id?: number;
}): SessionMessageDto {
  return {
    id: p.id ?? 1,
    sessionId: "00000000-0000-4000-8000-000000000001",
    role: p.role,
    kind: p.kind,
    content: p.content ?? "x",
    createdAt: "2026-05-26T10:00:00.000Z",
    toolCallId: p.toolCallId ?? null,
    toolName: p.toolName ?? null,
    toolCalls: p.toolCalls ?? null,
    explorerRefs: p.explorerRefs ?? null,
    reasoning: p.reasoning ?? null,
    durationMs: p.durationMs ?? null,
  };
}

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

describe("toTranscriptRows — tool call/result correlation (batch 3)", () => {
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

// ── S5: act-ledger grouping post-pass ───────────────────────────────────────

/** Tool CALL dto with one act per name (call ids default to `c<id>-<i>`). */
function callDto(id: number, names: readonly string[], content = ""): SessionMessageDto {
  return dto({
    id,
    role: "assistant",
    kind: "tool_call",
    content,
    toolCalls: names.map((toolName, i) => ({
      toolCallId: `c${id}-${i}`,
      toolName,
      toolArgs: `{"n":${i}}`,
    })),
  });
}

function resultDto(id: number, toolCallId: string, content: string): SessionMessageDto {
  return dto({ id, role: "tool", kind: "tool_result", content, toolCallId });
}

function group(entries: readonly TranscriptEntry[]): ToolGroupRowModel | undefined {
  return entries.find(
    (e): e is ToolGroupRowModel => e.variant === "tool_group",
  );
}

describe("groupTranscriptRows (S5 act ledger)", () => {
  it("a 1-call run stays individual and merges its adjacent output (result row dropped)", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([callDto(1, ["wallet:read"]), resultDto(2, "c1-0", "0.5 ETH")]),
    );
    expect(entries).toHaveLength(1);
    const row = entries[0]!;
    expect(row.variant).toBe("tool");
    if (row.variant === "tool_group") throw new Error("unexpected group");
    expect(row.toolActs).toEqual([
      { toolCallId: "c1-0", toolName: "wallet:read", toolArgs: '{"n":0}', output: "0.5 ETH" },
    ]);
  });

  // Owner decree: collapse only ABOVE five calls (TOOL_GROUP_MIN_CALLS 3 → 6),
  // so an ordinary multi-step turn stays readable without a disclosure click.
  it("the collapse threshold is 6 — five calls is still ordinary work", () => {
    expect(TOOL_GROUP_MIN_CALLS).toBe(6);
  });

  it("a 5-call run stays individual (below the ≥6 threshold)", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([
        callDto(1, ["a"]),
        callDto(2, ["b"]),
        callDto(3, ["c"]),
        callDto(4, ["d"]),
        callDto(5, ["e"]),
      ]),
    );
    expect(group(entries)).toBeUndefined();
    expect(entries).toHaveLength(5);
  });

  it("6 consecutive single-call rows collapse into ONE group with merged outputs", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([
        callDto(1, ["search:web"]),
        resultDto(2, "c1-0", "r1"),
        callDto(3, ["file:read"]),
        resultDto(4, "c3-0", "r2"),
        callDto(5, ["wallet:read"]),
        callDto(6, ["a"]),
        callDto(7, ["b"]),
        callDto(8, ["c"]),
      ]),
    );
    expect(entries).toHaveLength(1);
    const g = group(entries)!;
    expect(g.id).toBe(1); // first contributing call row
    expect(g.createdAt).toBe("2026-05-26T10:00:00.000Z");
    expect(g.calls.map((c) => c.output)).toEqual([
      "r1",
      "r2",
      null,
      null,
      null,
      null,
    ]);
    expect(g.distinctToolNames).toEqual([
      "search:web",
      "file:read",
      "wallet:read",
      "a",
      "b",
      "c",
    ]);
  });

  it("a multi-call batch row counts every call toward the threshold", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([callDto(1, ["a", "b", "c", "d", "e", "f"])]),
    );
    expect(group(entries)?.calls).toHaveLength(6);
  });

  it("a 5-call batch plus a 1-call row in the same run reach the threshold together", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([callDto(1, ["a", "b", "c", "d", "e"]), callDto(2, ["f"])]),
    );
    const g = group(entries)!;
    expect(g.calls.map((c) => c.toolName)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("any non-tool row interrupts the run — split runs below the threshold stay individual", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([
        callDto(1, ["a", "b", "c", "d"]),
        dto({ id: 3, role: "assistant", kind: "text", content: "thinking aloud" }),
        callDto(4, ["c"]),
        callDto(5, ["d"]),
      ]),
    );
    expect(group(entries)).toBeUndefined();
    expect(entries.map((e) => e.id)).toEqual([1, 3, 4, 5]);
  });

  it("an orphan result (unknown call id) stays a standalone row exactly as today", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([callDto(1, ["a"]), resultDto(2, "missing", "lost output")]),
    );
    expect(entries).toHaveLength(2);
    const orphan = entries[1]!;
    if (orphan.variant === "tool_group") throw new Error("unexpected group");
    expect(orphan.toolKind).toBe("result");
    expect(orphan.content).toBe("lost output");
    // The unpaired call carries no output.
    const call = entries[0]!;
    if (call.variant === "tool_group") throw new Error("unexpected group");
    expect(call.toolActs?.[0]?.output).toBeNull();
  });

  it("a result separated from its call by a non-tool row does NOT merge (different run)", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([
        callDto(1, ["a"]),
        dto({ id: 2, role: "user", kind: "text", content: "interrupt" }),
        resultDto(3, "c1-0", "late output"),
      ]),
    );
    expect(entries.map((e) => e.id)).toEqual([1, 2, 3]);
    const call = entries[0]!;
    if (call.variant === "tool_group") throw new Error("unexpected group");
    expect(call.toolActs?.[0]?.output).toBeNull();
    const late = entries[2]!;
    if (late.variant === "tool_group") throw new Error("unexpected group");
    expect(late.toolKind).toBe("result");
  });

  it("splits per-step prose into standalone rows interleaved with each step's tools", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([
        callDto(1, ["a"], "Let me check three things."),
        callDto(2, ["b"]),
        callDto(3, ["c"], "And one more."),
      ]),
    );
    // The split prose rows break the run, so the turn stays chronological and the
    // (now sub-threshold) tools do NOT collapse into one cross-step group:
    // prose1 → tool a → tool b → prose3 → tool c.
    expect(group(entries)).toBeUndefined();
    expect(entries.map((e) => e.variant)).toEqual([
      "assistant",
      "tool",
      "tool",
      "assistant",
      "tool",
    ]);
    const [prose1, , , prose3] = entries;
    expect(prose1!.variant === "tool_group" ? null : prose1!.content).toBe(
      "Let me check three things.",
    );
    expect(prose3!.variant === "tool_group" ? null : prose3!.content).toBe(
      "And one more.",
    );
  });

  it("a prose-bearing batch with ≥6 parallel calls splits the prose off and still groups the calls", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([
        callDto(1, ["a", "b", "c", "d", "e", "f"], "Doing six at once."),
      ]),
    );
    // prose row + ONE group (within-batch parallel calls still aggregate).
    expect(entries).toHaveLength(2);
    const prose = entries[0]!;
    expect(prose.variant === "tool_group" ? null : prose.content).toBe(
      "Doing six at once.",
    );
    expect(group(entries)?.calls).toHaveLength(6);
  });

  it("deduplicates distinctToolNames in first-appearance order", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([callDto(1, ["a", "b", "a", "c", "b", "c"])]),
    );
    expect(group(entries)?.distinctToolNames).toEqual(["a", "b", "c"]);
  });

  it("passes every non-tool variant through untouched", () => {
    const rows = toTranscriptRows([
      dto({ id: 1, role: "user", kind: "text", content: "hi" }),
      dto({ id: 2, role: "assistant", kind: "text", content: "yo" }),
      dto({ id: 3, role: "system", kind: "runtime_notice", content: "n" }),
      dto({ id: 4, role: "system", kind: "compaction", content: "c" }),
    ]);
    expect(groupTranscriptRows(rows)).toEqual(rows);
  });
});

// ── Stage 2: explorerRefs propagation ───────────────────────────────────────

const HL_REFS = [{ chain: "hyperliquid", txRef: "0xabc" }] as const;

function resultDtoWithRefs(
  id: number,
  toolCallId: string,
  content: string,
  explorerRefs: SessionMessageDto["explorerRefs"],
): SessionMessageDto {
  return dto({ id, role: "tool", kind: "tool_result", content, toolCallId, explorerRefs });
}

describe("explorerRefs propagation (Stage 2)", () => {
  it("carries explorerRefs onto a tool_result row model", () => {
    const row = toTranscriptRow(
      resultDtoWithRefs(2, "abc", "{}", [...HL_REFS]),
    );
    expect(row.toolKind).toBe("result");
    expect(row.explorerRefs).toEqual(HL_REFS);
  });

  it("merges the paired result's refs onto its act (individual run)", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([
        callDto(1, ["kyberswap:swap"]),
        resultDtoWithRefs(2, "c1-0", "{}", [...HL_REFS]),
      ]),
    );
    expect(entries).toHaveLength(1);
    const row = entries[0]!;
    if (row.variant === "tool_group") throw new Error("unexpected group");
    expect(row.toolActs?.[0]?.explorerRefs).toEqual(HL_REFS);
  });

  it("merges refs onto the matching act inside a collapsed group", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([
        callDto(1, ["search:web"]),
        resultDto(2, "c1-0", "r1"),
        callDto(3, ["kyberswap:swap"]),
        resultDtoWithRefs(4, "c3-0", "{}", [...HL_REFS]),
        callDto(5, ["wallet:read", "a", "b", "c"]),
      ]),
    );
    const g = group(entries)!;
    const swapAct = g.calls.find((c) => c.toolCallId === "c3-0")!;
    expect(swapAct.explorerRefs).toEqual(HL_REFS);
    // Acts without a ref-bearing result carry none.
    expect(g.calls.find((c) => c.toolCallId === "c1-0")!.explorerRefs).toBeUndefined();
  });

  it("keeps refs on an ORPHAN result row (call scrolled out of the run)", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([resultDtoWithRefs(9, "missing", "lost", [...HL_REFS])]),
    );
    expect(entries).toHaveLength(1);
    const orphan = entries[0]!;
    if (orphan.variant === "tool_group") throw new Error("unexpected group");
    expect(orphan.toolKind).toBe("result");
    expect(orphan.explorerRefs).toEqual(HL_REFS);
  });
});

// ── Contract C1: persisted reasoning + measured durationMs ──────────────────

describe("reasoning propagation (contract C1)", () => {
  it("carries an assistant row's persisted reasoning into the row model", () => {
    const row = toTranscriptRow(
      dto({ role: "assistant", kind: "text", reasoning: "weighed the ledger" }),
    );
    expect(row.reasoning).toBe("weighed the ledger");
  });

  it("keeps reasoning null on a legacy/provider-silent row (renders nothing)", () => {
    expect(toTranscriptRow(dto({ role: "assistant", kind: "text" })).reasoning).toBeNull();
  });

  it("puts reasoning on the PROSE row only when a tool_call splits — never both", () => {
    const rows = toTranscriptRows([
      dto({
        id: 5,
        role: "assistant",
        kind: "tool_call",
        content: "Checking.",
        reasoning: "the trace",
        toolCalls: [{ toolCallId: "c1", toolName: "wallet_balances", toolArgs: null }],
      }),
    ]);
    expect(rows).toHaveLength(2);
    // Both rows share dto.id — exactly one may hold the reasoning.
    expect(rows.every((r) => r.id === 5)).toBe(true);
    expect(rows.filter((r) => r.reasoning !== null && r.reasoning !== undefined))
      .toHaveLength(1);
    expect(rows.find((r) => r.variant === "assistant")!.reasoning).toBe("the trace");
    expect(rows.find((r) => r.variant === "tool")!.reasoning).toBeNull();
  });

  it("keeps reasoning on the TOOL row when the tool_call carries no prose", () => {
    const rows = toTranscriptRows([
      dto({
        id: 7,
        role: "assistant",
        kind: "tool_call",
        content: "",
        reasoning: "silent step",
        toolCalls: [{ toolCallId: "c1", toolName: "wallet_balances", toolArgs: null }],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reasoning).toBe("silent step");
  });
});

describe("durationMs propagation (contract C1)", () => {
  it("carries a measured duration onto the tool_result row and its merged act", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([
        callDto(1, ["wallet_balances"]),
        dto({
          id: 2,
          role: "tool",
          kind: "tool_result",
          content: "ok",
          toolCallId: "c1-0",
          durationMs: 2340,
        }),
      ]),
    );
    const row = entries[0]!;
    if (row.variant === "tool_group") throw new Error("unexpected group");
    expect(row.toolActs?.[0]?.durationMs).toBe(2340);
  });

  it("a measured ZERO still merges — 0 ms is a measurement, unlike null", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([
        callDto(1, ["wallet_balances"]),
        dto({
          id: 2,
          role: "tool",
          kind: "tool_result",
          content: "ok",
          toolCallId: "c1-0",
          durationMs: 0,
        }),
      ]),
    );
    const row = entries[0]!;
    if (row.variant === "tool_group") throw new Error("unexpected group");
    expect(row.toolActs?.[0]?.durationMs).toBe(0);
  });

  it("a null duration (never executed) leaves the act with NO duration at all", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([callDto(1, ["wallet_balances"]), resultDto(2, "c1-0", "ok")]),
    );
    const row = entries[0]!;
    if (row.variant === "tool_group") throw new Error("unexpected group");
    expect(row.toolActs?.[0]?.durationMs).toBeUndefined();
  });
});
