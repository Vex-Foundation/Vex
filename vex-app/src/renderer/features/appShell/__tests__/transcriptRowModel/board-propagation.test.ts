/**
 * DTO-FIELD PROPAGATION - the composed board travelling from
 * `SessionMessageDto.board` onto the ASSISTANT row model.
 *
 * The contract under test is the one that keeps the board from becoming a
 * second kind of message: a board is a projection of the assistant row that
 * already carries the turn's prose, so the row's variant, content and
 * reasoning are untouched by its presence, and its absence is the ordinary
 * assistant document.
 */

import { describe, expect, it } from "vitest";
import { boardSpecFixture } from "@shared/schemas/__tests__/board-spec-fixture.js";
import { toTranscriptRow, toTranscriptRows } from "../../transcriptRowModel.js";
import { callDto, dto, resultDto } from "./message-dto-fixture.js";

describe("board propagation onto the assistant row", () => {
  it("carries the spec onto an assistant text row without changing its variant", () => {
    const spec = boardSpecFixture();
    const row = toTranscriptRow(
      dto({ role: "assistant", kind: "text", content: "see the board", board: spec }),
    );
    expect(row.variant).toBe("assistant");
    expect(row.content).toBe("see the board");
    expect(row.board).toEqual(spec);
  });

  it("keeps the prose row standalone: no board is the ordinary assistant row", () => {
    const row = toTranscriptRow(
      dto({ role: "assistant", kind: "text", content: "no board here" }),
    );
    expect(row.variant).toBe("assistant");
    expect(row.board).toBeNull();
  });

  it("carries a board onto a stopped assistant row too", () => {
    const spec = boardSpecFixture();
    const row = toTranscriptRow(
      dto({ role: "assistant", kind: "assistant_stopped", board: spec }),
    );
    expect(row.variant).toBe("assistant_stopped");
    expect(row.board).toEqual(spec);
  });

  it("never puts a board on a tool row", () => {
    expect(toTranscriptRow(resultDto(3, "c1", "{}")).board ?? null).toBeNull();
    expect(toTranscriptRow(callDto(4, ["wallet_balance"])).board ?? null).toBeNull();
  });

  it("survives the whole-page pass alongside a tool run", () => {
    const spec = boardSpecFixture();
    const rows = toTranscriptRows([
      callDto(1, ["dexscreener_pairs"]),
      resultDto(2, "c1-0", "{}"),
      dto({ id: 3, role: "assistant", kind: "text", content: "verdict", board: spec }),
    ]);
    const assistant = rows.filter((r) => r.variant === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.board).toEqual(spec);
  });

  it("does not disturb reasoning on the same row", () => {
    const row = toTranscriptRow(
      dto({
        role: "assistant",
        kind: "text",
        reasoning: "checked both pools",
        board: boardSpecFixture(),
      }),
    );
    expect(row.reasoning).toBe("checked both pools");
    expect(row.board).not.toBeNull();
  });
});
