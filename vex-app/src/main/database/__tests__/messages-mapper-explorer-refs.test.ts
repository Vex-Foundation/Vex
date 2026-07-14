/**
 * Stage 2 — `toDto` explorerRefs projection. The `metadata -> 'explorerRefs'`
 * JSONB projection is untrusted at this boundary: only tool-result rows expose
 * refs, valid arrays pass through, and anything malformed / oversize / wrong-
 * typed collapses to `null` WITHOUT throwing (one bad row must not poison a
 * page).
 */

import { describe, expect, it } from "vitest";
import {
  MESSAGE_ROW_COLUMNS,
  toDto,
  type MessageRow,
} from "../messages/mappers.js";

const BASE: Omit<MessageRow, "role" | "explorer_refs"> = {
  id: 1,
  session_id: "00000000-0000-4000-8000-00000000abcd",
  content: "{}",
  tool_call_id: "call_1",
  tool_calls: null,
  created_at: "2026-07-13T10:00:00.000Z",
  source: "tool",
  message_type: "tool_result",
};

function row(p: {
  readonly role: string;
  readonly explorer_refs: unknown;
}): MessageRow {
  return { ...BASE, role: p.role, explorer_refs: p.explorer_refs };
}

describe("toDto — explorerRefs projection", () => {
  it("selects ONLY the metadata sub-key (never raw metadata) in the column tuple", () => {
    expect(MESSAGE_ROW_COLUMNS).toContain(
      "metadata -> 'explorerRefs' AS explorer_refs",
    );
    // Guard: raw `metadata` is not exposed as its own selected column.
    expect(MESSAGE_ROW_COLUMNS).not.toMatch(/(^|,\s*)metadata(\s*,|\s*$)/);
  });

  it("projects a valid refs array on a tool row", () => {
    const dto = toDto(
      row({
        role: "tool",
        explorer_refs: [
          { chain: "hyperliquid", txRef: "0xabc" },
          { chain: "solana", txRef: "5sig" },
        ],
      }),
    );
    expect(dto.explorerRefs).toEqual([
      { chain: "hyperliquid", txRef: "0xabc" },
      { chain: "solana", txRef: "5sig" },
    ]);
  });

  it("returns null for a non-tool row even with a valid refs array", () => {
    const dto = toDto(
      row({ role: "assistant", explorer_refs: [{ chain: "base", txRef: "0xabc" }] }),
    );
    expect(dto.explorerRefs).toBeNull();
  });

  it("returns null for absent / empty refs", () => {
    expect(toDto(row({ role: "tool", explorer_refs: null })).explorerRefs).toBeNull();
    expect(toDto(row({ role: "tool", explorer_refs: undefined })).explorerRefs).toBeNull();
    expect(toDto(row({ role: "tool", explorer_refs: [] })).explorerRefs).toBeNull();
  });

  it("returns null (never throws) for malformed / wrong-typed JSONB", () => {
    expect(toDto(row({ role: "tool", explorer_refs: "not-an-array" })).explorerRefs).toBeNull();
    expect(toDto(row({ role: "tool", explorer_refs: { chain: "base" } })).explorerRefs).toBeNull();
    expect(
      toDto(row({ role: "tool", explorer_refs: [{ chain: "base" }] })).explorerRefs,
    ).toBeNull();
    expect(
      toDto(row({ role: "tool", explorer_refs: [{ chain: 1, txRef: 2 }] })).explorerRefs,
    ).toBeNull();
  });

  it("returns null for oversize refs (over-length txRef or over the 8-entry cap)", () => {
    expect(
      toDto(
        row({ role: "tool", explorer_refs: [{ chain: "base", txRef: "a".repeat(129) }] }),
      ).explorerRefs,
    ).toBeNull();
    const nine = Array.from({ length: 9 }, (_, i) => ({ chain: "base", txRef: `0x${i}` }));
    expect(toDto(row({ role: "tool", explorer_refs: nine })).explorerRefs).toBeNull();
  });
});
