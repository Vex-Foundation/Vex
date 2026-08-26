/**
 * `toDto` — a protocol tool's WIRE name is canonicalized to its dotted toolId.
 *
 * The model calls a discovered manifest as `kyberswap__swap_quote`, and the row
 * persists that name. Everything downstream of this mapper — the tool card, the
 * ledger's protocol logo, the Markdown export — reads the DTO, so the dotted id
 * has to be produced HERE. `toolName` and `toolCalls[].toolName` are separate
 * code paths and are pinned separately; an unresolvable `__` name must keep its
 * raw form so it can never borrow a curated venue's identity.
 */

import { describe, expect, it } from "vitest";
import { toDto, type MessageRow } from "../messages/mappers.js";

const BASE: Omit<MessageRow, "tool_calls"> = {
  id: 7,
  session_id: "00000000-0000-4000-8000-00000000abcd",
  role: "assistant",
  content: "",
  tool_call_id: null,
  created_at: "2026-08-04T10:00:00.000Z",
  source: "agent",
  message_type: "chat",
  explorer_refs: null,
  reasoning: null,
  duration_ms: null,
  success: null,
  display_status: null,
  board: null,
};

function callRow(name: string, id = "call_1"): MessageRow {
  return { ...BASE, tool_calls: [{ id, command: name, args: { a: 1 } }] };
}

describe("toDto - injected protocol names become dotted toolIds", () => {
  // Wire names are the manifests' publicNames (Batch 2: `namespace__resource_action`).
  it("canonicalizes BOTH toolName and every toolCalls[].toolName", () => {
    const dto = toDto(callRow("kyberswap__swap_quote"));
    expect(dto.toolName).toBe("kyberswap.swap.quote");
    expect(dto.toolCalls?.[0]?.toolName).toBe("kyberswap.swap.quote");
  });

  it("canonicalizes a `name`-only entry as well as a `command` one", () => {
    const dto = toDto({
      ...BASE,
      tool_calls: [{ id: "call_1", name: "trench__launch_execute" }],
    });
    expect(dto.toolName).toBe("trench.launch_execute");
    expect(dto.toolCalls?.[0]?.toolName).toBe("trench.launch_execute");
  });

  it("preserves camelCase - lower-casing would lose 14 real toolIds", () => {
    const dto = toDto(callRow("dexscreener__token_pairs_list"));
    expect(dto.toolName).toBe("dexscreener.tokenPairs");
  });

  it("leaves an INTERNAL tool name untouched", () => {
    const dto = toDto(callRow("agent_scan"));
    expect(dto.toolName).toBe("agent_scan");
    expect(dto.toolCalls?.[0]?.toolName).toBe("agent_scan");
  });

  it("leaves an UNRESOLVABLE `__` name verbatim - no venue may be borrowed", () => {
    const dto = toDto(callRow("kyberswapp__swap__quote"));
    expect(dto.toolName).toBe("kyberswapp__swap__quote");
    expect(dto.toolCalls?.[0]?.toolName).toBe("kyberswapp__swap__quote");
  });

  it("keeps the recall kind working off internal names", () => {
    const dto = toDto(callRow("long_memory_search"));
    expect(dto.kind).toBe("recall");
  });

  it("still prefers `namespace:command` when both are present", () => {
    const dto = toDto({
      ...BASE,
      tool_calls: [{ id: "call_1", namespace: "trench", command: "tokens" }],
    });
    expect(dto.toolName).toBe("trench:tokens");
  });
});
