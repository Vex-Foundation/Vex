/**
 * The `board` DTO slot: required-and-nullable, validated by the ONE canonical
 * `BoardSpecV1` schema, and enforced at the IPC boundary through
 * `messagePageSchema` (the read handlers' `outputSchema`).
 *
 * The point of this suite is the SEAM, not the board's own bounds - those are
 * owned and proven by `src/lib/board/`. What must hold here is that a board
 * cannot reach the renderer without passing that schema, and that an oversize
 * or off-contract mapper output is rejected rather than shipped.
 */

import { describe, expect, it } from "vitest";
import { boardSpecV1Schema } from "@vex-lib/board/index.js";
import {
  boardProjectionSchema,
  messagePageSchema,
  sessionMessageDtoSchema,
} from "../messages.js";
import { boardSpecFixture } from "./board-spec-fixture.js";

const DTO_BASE = {
  id: 1,
  sessionId: "00000000-0000-4000-8000-000000000001",
  role: "assistant" as const,
  kind: "text" as const,
  content: "Liquidity is thinner than it looks; see the board.",
  createdAt: "2026-08-25T10:00:00.000Z",
  toolCallId: null,
  toolName: null,
  toolCalls: null,
  explorerRefs: null,
  reasoning: null,
  durationMs: null,
  success: null,
  displayStatus: null,
  interruptDisposition: null,
};

describe("board DTO projection", () => {
  it("IS the canonical engine schema, not a second copy", () => {
    expect(boardProjectionSchema).toBe(boardSpecV1Schema);
  });

  it("accepts a valid spec on the DTO", () => {
    const parsed = sessionMessageDtoSchema.safeParse({
      ...DTO_BASE,
      board: boardSpecFixture(),
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts null - a row with no board is the ordinary case", () => {
    expect(
      sessionMessageDtoSchema.safeParse({ ...DTO_BASE, board: null }).success,
    ).toBe(true);
  });

  it("is REQUIRED and nullable, never optional: an absent field fails", () => {
    expect(sessionMessageDtoSchema.safeParse(DTO_BASE).success).toBe(false);
  });

  it("rejects an off-contract board rather than shipping it", () => {
    for (const board of [
      {},
      "board",
      { version: 1 },
      { ...boardSpecFixture(), extra: "smuggled" },
    ]) {
      expect(
        sessionMessageDtoSchema.safeParse({ ...DTO_BASE, board }).success,
      ).toBe(false);
    }
  });

  it("round-trips a board through messagePageSchema (the IPC output gate)", () => {
    const spec = boardSpecFixture();
    const page = {
      items: [{ ...DTO_BASE, board: spec }],
      nextCursor: null,
      hasMore: false,
    };
    const parsed = messagePageSchema.safeParse(page);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.items[0]?.board).toEqual(spec);
  });

  it("fails the whole page when one row's board is off-contract", () => {
    const page = {
      items: [
        { ...DTO_BASE, board: null },
        { ...DTO_BASE, id: 2, board: { version: 9 } },
      ],
      nextCursor: null,
      hasMore: false,
    };
    expect(messagePageSchema.safeParse(page).success).toBe(false);
  });
});
