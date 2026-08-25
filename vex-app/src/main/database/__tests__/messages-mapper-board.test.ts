/**
 * `toDto` board projection. The `metadata -> 'board'` JSONB projection is
 * untrusted at this boundary: ONLY assistant rows expose a board, a valid spec
 * passes through unchanged, and anything malformed / oversize / wrong-typed /
 * written by a future writer collapses to `null` WITHOUT throwing (one bad row
 * must not poison a page).
 *
 * The board deliberately does NOT copy `explorerRefs`' empty-value collapse:
 * there is no arithmetic here that can turn a real board into "there was none".
 */

import { describe, expect, it } from "vitest";
import { boardSpecFixture } from "@shared/schemas/__tests__/board-spec-fixture.js";
import {
  MESSAGE_ROW_COLUMNS,
  toDto,
  type MessageRow,
} from "../messages/mappers.js";

const BASE: Omit<MessageRow, "role" | "board"> = {
  id: 12,
  session_id: "00000000-0000-4000-8000-00000000abcd",
  content: "Liquidity is thinner than it looks; see the board.",
  tool_call_id: null,
  tool_calls: null,
  created_at: "2026-08-25T10:00:00.000Z",
  source: "agent",
  message_type: "chat",
  explorer_refs: null,
  reasoning: null,
  duration_ms: null,
  success: null,
  display_status: null,
};

function row(role: string, board: unknown): MessageRow {
  return { ...BASE, role, board };
}

describe("toDto - board projection (metadata -> 'board')", () => {
  it("selects ONLY the metadata sub-key, never raw metadata", () => {
    expect(MESSAGE_ROW_COLUMNS).toContain("metadata -> 'board' AS board");
    expect(MESSAGE_ROW_COLUMNS).not.toMatch(/(^|,\s*)metadata(\s*,|\s*$)/);
  });

  it("projects a valid spec on an assistant row, unchanged", () => {
    const spec = boardSpecFixture();
    const dto = toDto(row("assistant", spec));
    expect(dto.board).toEqual(spec);
  });

  it("keeps the row an ordinary assistant row - the board is not a new kind", () => {
    const dto = toDto(row("assistant", boardSpecFixture()));
    expect(dto.kind).toBe("text");
    expect(dto.role).toBe("assistant");
    expect(dto.content).toBe(BASE.content);
  });

  it("returns null on every non-assistant row, even with a valid spec", () => {
    const spec = boardSpecFixture();
    for (const role of ["tool", "user", "system"]) {
      expect(toDto(row(role, spec)).board).toBeNull();
    }
  });

  it("returns null for a legacy row that predates the projection", () => {
    expect(toDto(row("assistant", null)).board).toBeNull();
    expect(toDto(row("assistant", undefined)).board).toBeNull();
  });

  it("returns null (never throws) for malformed / wrong-typed JSONB", () => {
    const bad = (board: unknown) => () => toDto(row("assistant", board));
    for (const board of [
      "not-an-object",
      42,
      [],
      {},
      { version: 1 },
      { ...boardSpecFixture(), version: 2 },
    ]) {
      expect(bad(board)).not.toThrow();
      expect(toDto(row("assistant", board)).board).toBeNull();
    }
  });

  it("rejects an unknown extra key rather than shipping it to the renderer", () => {
    const smuggled = { ...boardSpecFixture(), imageUrl: "https://evil.example" };
    expect(toDto(row("assistant", smuggled)).board).toBeNull();
  });

  it("rejects a spec whose hydration rows do not pair with its pools", () => {
    const spec = boardSpecFixture();
    const twoPools = {
      ...spec,
      pools: [...spec.pools, { chain: "base", pairAddress: "0xdeadBEEF01" }],
    };
    expect(toDto(row("assistant", twoPools)).board).toBeNull();
  });

  it("rejects text carrying a forbidden code-point class", () => {
    // Built with `fromCodePoint`, never authored as a raw literal: a bidi
    // override pasted into a source file is invisible to every reviewer and
    // makes the file read as binary to grep.
    const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
    const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
    for (const forbidden of [RIGHT_TO_LEFT_OVERRIDE, ZERO_WIDTH_SPACE]) {
      const spec = boardSpecFixture({ title: `SOL${forbidden}check` });
      expect(toDto(row("assistant", spec)).board).toBeNull();
    }
  });

  it("does not disturb the sibling projections", () => {
    const dto = toDto(row("assistant", boardSpecFixture()));
    expect(dto.explorerRefs).toBeNull();
    expect(dto.reasoning).toBeNull();
    expect(dto.durationMs).toBeNull();
    expect(dto.success).toBeNull();
    expect(dto.displayStatus).toBeNull();
  });
});
