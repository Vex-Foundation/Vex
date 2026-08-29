/**
 * `toDto` displayStatus projection — the FIFTH narrow `messages.metadata`
 * sub-key.
 *
 * Same posture as the other four: the SELECT reaches only the sub-key (raw
 * metadata is never selected), only tool-result rows expose it, the literal
 * `"pending"` is the only accepted value, and anything malformed / wrong-typed
 * collapses to `null` WITHOUT throwing so one bad row cannot poison a page.
 */

import { describe, expect, it } from "vitest";
import {
  MESSAGE_ROW_COLUMNS,
  toDto,
  type MessageRow,
} from "../messages/mappers.js";

const BASE: Omit<MessageRow, "role" | "success" | "display_status"> = {
  id: 1,
  session_id: "00000000-0000-4000-8000-00000000abcd",
  content: "recorded as pending and will resolve automatically",
  tool_call_id: "call_1",
  tool_calls: null,
  created_at: "2026-07-30T10:00:00.000Z",
  source: "tool",
  message_type: "tool_result",
  explorer_refs: null,
  reasoning: null,
  duration_ms: null,
  board: null,
  interrupt_disposition: null,
};

function row(p: {
  readonly role: string;
  readonly success?: unknown;
  readonly display_status?: unknown;
}): MessageRow {
  return {
    ...BASE,
    role: p.role,
    success: p.success ?? null,
    display_status: p.display_status ?? null,
  };
}

describe("toDto - displayStatus projection", () => {
  it("selects ONLY the metadata sub-key (never raw metadata) in the column tuple", () => {
    expect(MESSAGE_ROW_COLUMNS).toContain(
      "metadata -> 'displayStatus' AS display_status",
    );
    expect(MESSAGE_ROW_COLUMNS).not.toMatch(/(^|,\s*)metadata(\s*,|\s*$)/);
  });

  it("projects 'pending' on a tool-result row alongside success:false", () => {
    const dto = toDto(row({ role: "tool", success: false, display_status: "pending" }));
    expect(dto.displayStatus).toBe("pending");
    // Model-facing outcome is untouched — this is display fidelity only.
    expect(dto.success).toBe(false);
  });

  it("is null on a legacy tool row that persisted no displayStatus", () => {
    const dto = toDto(row({ role: "tool", success: false }));
    expect(dto.displayStatus).toBeNull();
    expect(dto.success).toBe(false);
  });

  it("is null on every non-tool row even when the JSONB carries a value", () => {
    for (const role of ["assistant", "user", "system"]) {
      expect(toDto(row({ role, display_status: "pending" })).displayStatus).toBeNull();
    }
  });

  it.each([
    ["a non-contract string", "confirmed"],
    ["the wrong case", "PENDING"],
    ["a number", 1],
    ["a boolean", true],
    ["an object", { status: "pending" }],
    ["an array", ["pending"]],
  ])("collapses %s to null without throwing", (_label, value) => {
    expect(() =>
      toDto(row({ role: "tool", success: false, display_status: value })),
    ).not.toThrow();
    expect(
      toDto(row({ role: "tool", success: false, display_status: value })).displayStatus,
    ).toBeNull();
  });
});
