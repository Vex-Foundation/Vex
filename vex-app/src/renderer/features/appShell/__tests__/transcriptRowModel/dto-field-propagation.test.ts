/**
 * DTO-FIELD PROPAGATION — explorerRefs (Stage 2) and the contract C1 pair
 * (persisted `reasoning`, measured `durationMs`) travelling from
 * `SessionMessageDto` into row models and merged acts.
 *
 * Split out of `transcriptRowModel.test.ts` when it crossed the 550-line hard
 * limit. Grouping mechanics live in `act-ledger-grouping.test.ts`; variant
 * mapping stays in the main file.
 */

import { describe, expect, it } from "vitest";
import type { SessionMessageDto } from "@shared/schemas/messages.js";
import {
  groupTranscriptRows,
  toTranscriptRow,
  toTranscriptRows,
} from "../../transcriptRowModel.js";
import { callDto, dto, group, resultDto } from "./message-dto-fixture.js";

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

  it("puts reasoning on the PROSE row only when a tool_call splits - never both", () => {
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

  it("a measured ZERO still merges - 0 ms is a measurement, unlike null", () => {
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
