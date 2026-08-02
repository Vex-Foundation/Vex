/**
 * THE ACT LEDGER — `groupTranscriptRows` post-pass (S5).
 *
 * Split out of `transcriptRowModel.test.ts` when it crossed the 550-line hard
 * limit: this file owns run detection, the ≥6-call collapse threshold, act
 * pairing, prose splitting, and what a fold may never discard. Variant mapping
 * stays in the main file; DTO-field propagation lives in its sibling.
 */

import { describe, expect, it } from "vitest";
import {
  groupTranscriptRows,
  TOOL_GROUP_MIN_CALLS,
  toTranscriptRows,
} from "../../transcriptRowModel.js";
import { callDto, dto, group, resultDto } from "./message-dto-fixture.js";

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

// The fold may drop the call/result INTERLEAVING; it may never drop the
// turn's persisted thinking. Grouping and reasoning were each covered alone —
// their interaction is where the trace used to disappear.
describe("grouping × persisted reasoning (contract C1)", () => {
  it("carries a prose-less call row's reasoning onto the group entry", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([
        callDto(1, ["a"], "", "why I opened the ledger"),
        callDto(2, ["b"]),
        callDto(3, ["c"]),
        callDto(4, ["d"]),
        callDto(5, ["e"]),
        callDto(6, ["f"]),
      ]),
    );
    expect(group(entries)?.reasonings).toEqual(["why I opened the ledger"]);
  });

  it("keeps EVERY contributing trace, in turn order", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([
        callDto(1, ["a"]),
        callDto(2, ["b"], "", "first trace"),
        callDto(3, ["c"], "", "second trace"),
        callDto(4, ["d"]),
        callDto(5, ["e"]),
        callDto(6, ["f"]),
      ]),
    );
    // Keeping only the first silently discarded the rest of the turn's
    // thinking — the group is the ONLY carrier a prose-less row has.
    expect(group(entries)?.reasonings).toEqual(["first trace", "second trace"]);
  });

  it("leaves the group traces empty when no folded row carried one", () => {
    const entries = groupTranscriptRows(
      toTranscriptRows([callDto(1, ["a", "b", "c", "d", "e", "f"])]),
    );
    expect(group(entries)?.reasonings).toEqual([]);
  });

  it("never double-carries a PROSE row's trace — the split prose row keeps it", () => {
    // The prose splits into its own assistant row (which renders the trace),
    // so harvesting it onto the group too would print one turn's thinking
    // twice.
    const entries = groupTranscriptRows(
      toTranscriptRows([
        callDto(1, ["a", "b", "c", "d", "e", "f"], "Doing six.", "the trace"),
      ]),
    );
    const prose = entries[0]!;
    expect(prose.variant === "tool_group" ? null : prose.reasoning).toBe(
      "the trace",
    );
    expect(group(entries)?.reasonings).toEqual([]);
  });
});
