/**
 * WHERE VEX'S TOKEN HANGS (docs/design/R3-MINIMAL.md section 6): once per
 * turn, on the first row Vex writes after the reader's message; the live row
 * carries it only when nothing in the turn has yet; a prose-less tool row
 * right under another step row continues that list.
 */

import { describe, expect, it } from "vitest";
import {
  continuesStepRun,
  isVexTurnRow,
  liveTurnNeedsMark,
  turnMarkKeys,
} from "../../SessionTranscript/turnMarks.js";
import type {
  TranscriptEntry,
  TranscriptRowModel,
  TranscriptRowVariant,
} from "../../transcriptRowModel.js";

const ISO = "2026-10-17T12:28:00.000Z";

function row(
  id: number,
  variant: TranscriptRowVariant,
  over: Partial<TranscriptRowModel> = {},
): TranscriptRowModel {
  return { id, variant, label: null, content: "", createdAt: ISO, ...over };
}

function group(id: number, reasonings: readonly string[] = []): TranscriptEntry {
  return {
    variant: "tool_group",
    id,
    calls: [],
    distinctToolNames: [],
    createdAt: ISO,
    reasonings,
  };
}

describe("turnMarkKeys", () => {
  it("marks the first Vex row after each user message, and no other", () => {
    const rows: TranscriptEntry[] = [
      row(1, "user", { content: "What is my balance?" }),
      row(2, "assistant", { content: "Checking two things." }),
      row(3, "tool", { toolKind: "call" }),
      row(4, "assistant", { content: "12 USD." }),
      row(5, "user", { content: "And ETH?" }),
      row(6, "tool", { toolKind: "call" }),
      row(7, "assistant", { content: "0.5 ETH." }),
    ];
    expect([...turnMarkKeys(rows)]).toEqual(["2", "t-6"]);
  });

  it("never gives the token to a notice or a marker, so the next Vex row heads the turn", () => {
    const rows: TranscriptEntry[] = [
      row(1, "user", { content: "hi" }),
      row(2, "notice", { content: "Resumed" }),
      row(3, "compaction"),
      group(4),
    ];
    expect([...turnMarkKeys(rows)]).toEqual(["tg-4"]);
  });

  it("marks a turn that opens the loaded page with no user row above it", () => {
    expect([...turnMarkKeys([row(9, "assistant", { content: "Done." })])]).toEqual(["9"]);
  });
});

describe("liveTurnNeedsMark", () => {
  it("is true when the turn in flight has nothing yet", () => {
    expect(liveTurnNeedsMark([row(1, "user", { content: "And ETH?" })])).toBe(true);
    expect(liveTurnNeedsMark([])).toBe(true);
  });

  it("is false once a row of the same turn carried the token", () => {
    expect(
      liveTurnNeedsMark([
        row(1, "user", { content: "And ETH?" }),
        row(2, "assistant", { content: "Checking." }),
        row(3, "notice", { content: "Wake" }),
      ]),
    ).toBe(false);
  });
});

describe("isVexTurnRow", () => {
  it("counts prose, a stopped reply, a step and a fold; never the system's rows", () => {
    expect(isVexTurnRow(row(1, "assistant"))).toBe(true);
    expect(isVexTurnRow(row(1, "assistant_stopped"))).toBe(true);
    expect(isVexTurnRow(row(1, "tool"))).toBe(true);
    expect(isVexTurnRow(group(1))).toBe(true);
    for (const variant of ["user", "notice", "compaction", "recall"] as const) {
      expect(isVexTurnRow(row(1, variant))).toBe(false);
    }
  });
});

describe("continuesStepRun", () => {
  const step = row(1, "tool", { toolKind: "call" });

  it("joins a prose-less step row or a bare fold to the steps right above it", () => {
    expect(continuesStepRun(row(2, "tool", { toolKind: "call" }), step)).toBe(true);
    expect(continuesStepRun(row(2, "tool", { toolKind: "result" }), group(1))).toBe(true);
    expect(continuesStepRun(group(2), step)).toBe(true);
  });

  it("keeps a row apart when it opens on prose or a Reasoned row, or follows anything else", () => {
    expect(continuesStepRun(row(2, "tool", { toolKind: "call", content: "Now the price." }), step)).toBe(false);
    expect(continuesStepRun(row(2, "tool", { toolKind: "call", reasoning: "weigh it" }), step)).toBe(false);
    expect(continuesStepRun(group(2, ["weigh it"]), step)).toBe(false);
    expect(continuesStepRun(row(2, "tool", { toolKind: "call" }), row(1, "assistant", { content: "x" }))).toBe(false);
    expect(continuesStepRun(row(2, "tool", { toolKind: "call" }), undefined)).toBe(false);
  });
});
