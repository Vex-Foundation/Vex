import { describe, expect, it } from "vitest";
import {
  messageCursorSchema,
  messageKindSchema,
  messagePageSchema,
  messageRoleSchema,
  messagesGetAroundInputSchema,
  messagesGetTailInputSchema,
  messagesListInputSchema,
  sessionMessageDtoSchema,
  TOOL_ARGS_DISPLAY_CEILING,
  transcriptAppendEventSchema,
  TRANSCRIPT_APPEND_EVENT_TYPE,
} from "../messages.js";
import { BOARD_SPEC_MAX_BYTES } from "@vex-lib/board/index.js";
import { maximalBoardSpec } from "../../../../../src/__tests__/lib/board/maximal-board-spec.js";

const ISO = "2026-05-21T10:00:00.000Z";
const SESSION = "00000000-0000-4000-8000-000000000001";

describe("messages schemas", () => {
  it("role + kind enums accept canonical values", () => {
    for (const r of ["system", "user", "assistant", "tool"]) {
      expect(messageRoleSchema.safeParse(r).success).toBe(true);
    }
    for (const k of [
      "text",
      // Pre-existing gap: this list was not total. `steering` (A33) and
      // `operator_ack` (M6) are named here so the enumeration matches the
      // schema and a kind added without a wire pin becomes visible.
      "steering",
      "tool_call",
      "tool_result",
      "runtime_notice",
      "operator_ack",
      "error",
      "compaction",
      "recall",
      "assistant_stopped",
    ]) {
      expect(messageKindSchema.safeParse(k).success).toBe(true);
    }
  });

  it("rejects exotic role / kind", () => {
    expect(messageRoleSchema.safeParse("hacker").success).toBe(false);
    // `compaction`/`recall` are valid kinds as of stage 8-4; a bogus value
    // still fails.
    expect(messageKindSchema.safeParse("compaction_started").success).toBe(
      false,
    );
  });

  it("sessionMessageDtoSchema parses a typical text row", () => {
    const parsed = sessionMessageDtoSchema.safeParse({
      id: 12,
      sessionId: SESSION,
      role: "assistant",
      kind: "text",
      content: "hello",
      createdAt: ISO,
      toolCallId: null,
      toolName: null,
      toolCalls: null,
      explorerRefs: null,
      reasoning: null,
      durationMs: null,
      success: null,
      displayStatus: null,
      board: null,
      interruptDisposition: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("sessionMessageDtoSchema accepts a bounded toolCalls display array", () => {
    const parsed = sessionMessageDtoSchema.safeParse({
      id: 13,
      sessionId: SESSION,
      role: "assistant",
      kind: "tool_call",
      content: "",
      createdAt: ISO,
      toolCallId: null,
      toolName: "wallet:read",
      toolCalls: [
        { toolCallId: "call_1", toolName: "wallet:read", toolArgs: '{\n  "chain": "base"\n}' },
        { toolCallId: "call_2", toolName: "dexscreener:search", toolArgs: null },
      ],
      explorerRefs: null,
      reasoning: null,
      durationMs: null,
      success: null,
      displayStatus: null,
      board: null,
      interruptDisposition: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("sessionMessageDtoSchema accepts a bounded explorerRefs array on a tool row", () => {
    const parsed = sessionMessageDtoSchema.safeParse({
      id: 20,
      sessionId: SESSION,
      role: "tool",
      kind: "tool_result",
      content: "{}",
      createdAt: ISO,
      toolCallId: "call_1",
      toolName: null,
      toolCalls: null,
      explorerRefs: [
        { chain: "hyperliquid", txRef: "0xabc" },
        { chain: "solana", txRef: "5sig" },
      ],
      reasoning: null,
      durationMs: 2314,
      success: true,
      displayStatus: null,
      board: null,
      interruptDisposition: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an explorerRefs array over the 8-entry cap", () => {
    const refs = Array.from({ length: 9 }, (_, i) => ({
      chain: "solana",
      txRef: `sig${i}`,
    }));
    const parsed = sessionMessageDtoSchema.safeParse({
      id: 21,
      sessionId: SESSION,
      role: "tool",
      kind: "tool_result",
      content: "{}",
      createdAt: ISO,
      toolCallId: "call_1",
      toolName: null,
      toolCalls: null,
      explorerRefs: refs,
      reasoning: null,
      durationMs: null,
      success: null,
      displayStatus: null,
      board: null,
      interruptDisposition: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an explorerRef with an oversize txRef (>128 chars)", () => {
    const parsed = sessionMessageDtoSchema.safeParse({
      id: 22,
      sessionId: SESSION,
      role: "tool",
      kind: "tool_result",
      content: "{}",
      createdAt: ISO,
      toolCallId: "call_1",
      toolName: null,
      toolCalls: null,
      explorerRefs: [{ chain: "solana", txRef: "a".repeat(129) }],
      reasoning: null,
      durationMs: null,
      success: null,
      displayStatus: null,
      board: null,
      interruptDisposition: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts persisted reasoning on an assistant row and bounds it at 20k", () => {
    const base = {
      id: 30,
      sessionId: SESSION,
      role: "assistant",
      kind: "text",
      content: "answer",
      createdAt: ISO,
      toolCallId: null,
      toolName: null,
      toolCalls: null,
      explorerRefs: null,
      durationMs: null,
      success: null,
      displayStatus: null,
      board: null,
      interruptDisposition: null,
    };
    expect(
      sessionMessageDtoSchema.safeParse({ ...base, reasoning: "thought…" })
        .success,
    ).toBe(true);
    expect(
      sessionMessageDtoSchema.safeParse({
        ...base,
        reasoning: "a".repeat(20_001),
      }).success,
    ).toBe(false);
    // Empty string is not a reasoning trace — the mapper collapses it to null.
    expect(
      sessionMessageDtoSchema.safeParse({ ...base, reasoning: "" }).success,
    ).toBe(false);
  });

  it("accepts ONLY the 'pending' literal (or null) for displayStatus", () => {
    const base = {
      id: 32,
      sessionId: SESSION,
      role: "tool",
      kind: "tool_result",
      content: "{}",
      createdAt: ISO,
      toolCallId: "call_1",
      toolName: null,
      toolCalls: null,
      explorerRefs: null,
      reasoning: null,
      durationMs: null,
      success: false,
      board: null,
      interruptDisposition: null,
    };
    expect(
      sessionMessageDtoSchema.safeParse({ ...base, displayStatus: "pending" })
        .success,
    ).toBe(true);
    expect(
      sessionMessageDtoSchema.safeParse({ ...base, displayStatus: null }).success,
    ).toBe(true);
    for (const bad of ["confirmed", "PENDING", "", 1, true, {}]) {
      expect(
        sessionMessageDtoSchema.safeParse({ ...base, displayStatus: bad })
          .success,
      ).toBe(false);
    }
    // Required, not optional — an omitted key is a contract violation.
    expect(sessionMessageDtoSchema.safeParse(base).success).toBe(false);
  });

  it("rejects a malformed durationMs (negative, fractional, over 24h)", () => {
    const base = {
      id: 31,
      sessionId: SESSION,
      role: "tool",
      kind: "tool_result",
      content: "{}",
      createdAt: ISO,
      toolCallId: "call_1",
      toolName: null,
      toolCalls: null,
      explorerRefs: null,
      reasoning: null,
      success: null,
      displayStatus: null,
      board: null,
      interruptDisposition: null,
    };
    expect(
      sessionMessageDtoSchema.safeParse({ ...base, durationMs: -1 }).success,
    ).toBe(false);
    expect(
      sessionMessageDtoSchema.safeParse({ ...base, durationMs: 12.5 }).success,
    ).toBe(false);
    expect(
      sessionMessageDtoSchema.safeParse({ ...base, durationMs: 86_400_001 })
        .success,
    ).toBe(false);
    expect(
      sessionMessageDtoSchema.safeParse({ ...base, durationMs: 0 }).success,
    ).toBe(true);
  });

  it("admits whole large toolArgs and rejects only past the corruption ceiling", () => {
    // Contract change (owner decree, 2026-08-26): toolArgs is the WHOLE
    // sanitized serialization, never a cut string. The first BoardCompose call
    // in production serialized past the old 2,000-char cap and the mapper's
    // truncation suffix pushed it past this schema, failing the entire page.
    // The bound is now TOOL_ARGS_DISPLAY_CEILING, a corruption guard above
    // every legitimate producer, shared with the mapper's own null guard.
    const row = (toolArgs: string) => ({
      id: 14,
      sessionId: SESSION,
      role: "assistant",
      kind: "tool_call",
      content: "",
      createdAt: ISO,
      toolCallId: null,
      toolName: "x:y",
      toolCalls: [{ toolCallId: "c", toolName: "x:y", toolArgs }],
      explorerRefs: null,
      reasoning: null,
      durationMs: null,
      success: null,
      displayStatus: null,
      board: null,
      interruptDisposition: null,
    });
    expect(
      sessionMessageDtoSchema.safeParse(row("a".repeat(2001))).success,
    ).toBe(true);
    expect(
      sessionMessageDtoSchema.safeParse(row("a".repeat(TOOL_ARGS_DISPLAY_CEILING))).success,
    ).toBe(true);
    expect(
      sessionMessageDtoSchema.safeParse(row("a".repeat(TOOL_ARGS_DISPLAY_CEILING + 1))).success,
    ).toBe(false);
  });

  it("keeps the display ceiling ABOVE the board budget plus its args envelope", () => {
    // THE invariant that makes the ceiling a corruption guard rather than a
    // content cut. BoardCompose is the largest legitimate producer: it accepts
    // a spec up to BOARD_SPEC_MAX_BYTES, and the mapper serializes that
    // payload PLUS the call envelope. If this ever inverted, a board the
    // compose tool accepted would have its args shipped as `null` and the user
    // would see a tool call with no arguments - a silent loss dressed as an
    // empty field. This test is what fails when someone raises the board
    // budget without re-checking this constant.
    expect(TOOL_ARGS_DISPLAY_CEILING).toBeGreaterThan(BOARD_SPEC_MAX_BYTES);
    // Not merely greater: the envelope, key names and JSON escaping all ride
    // along, so the guard keeps real headroom rather than a single byte of it.
    expect(TOOL_ARGS_DISPLAY_CEILING - BOARD_SPEC_MAX_BYTES).toBeGreaterThan(
      BOARD_SPEC_MAX_BYTES / 2,
    );
  });

  it("clears the envelope MEASURED from the largest board the contract admits", () => {
    // The comparison above is the conservative form: it holds a UTF-16 length
    // against a UTF-8 byte budget, which is safe but is not the real envelope.
    // This is the real one. `maximalBoardSpec()` is the schema-valid
    // all-fields-max document that `BOARD_SPEC_MAX_BYTES` itself is derived
    // from, and the mapper serializes a tool call's args with
    // `JSON.stringify(value, null, 2)` (see
    // `vex-app/src/main/database/messages/redaction.ts`), so the figure the
    // ceiling must clear is that pretty-printed string's length - indentation,
    // key names and escaping included.
    //
    // Deriving it from the SAME generator is what keeps the two constants
    // honest together: raising a board bound moves this number, and this test
    // is where a ceiling that no longer covers it fails.
    const spec = maximalBoardSpec();
    const envelope = JSON.stringify(spec, null, 2).length;
    expect(envelope).toBeGreaterThan(0);
    expect(TOOL_ARGS_DISPLAY_CEILING).toBeGreaterThan(envelope);
    // Real headroom, not a squeeze: the ceiling is a corruption guard, so no
    // legitimate producer should sit anywhere near it.
    expect(TOOL_ARGS_DISPLAY_CEILING - envelope).toBeGreaterThan(envelope);
  });

  it("rejects a toolCalls array over the 32-entry cap", () => {
    const calls = Array.from({ length: 33 }, (_, i) => ({
      toolCallId: `c${i}`,
      toolName: "x:y",
      toolArgs: null,
    }));
    const parsed = sessionMessageDtoSchema.safeParse({
      id: 15,
      sessionId: SESSION,
      role: "assistant",
      kind: "tool_call",
      content: "",
      createdAt: ISO,
      toolCallId: null,
      toolName: "x:y",
      toolCalls: calls,
      explorerRefs: null,
      reasoning: null,
      durationMs: null,
      success: null,
      displayStatus: null,
      board: null,
      interruptDisposition: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects DTO with extra fields (.strict)", () => {
    const parsed = sessionMessageDtoSchema.safeParse({
      id: 1,
      sessionId: SESSION,
      role: "user",
      kind: "text",
      content: "x",
      createdAt: ISO,
      toolCallId: null,
      toolName: null,
      metadata: { leaky: "value" },
    });
    expect(parsed.success).toBe(false);
  });

  it("messageCursorSchema requires datetime + positive int id", () => {
    expect(
      messageCursorSchema.safeParse({ createdAt: ISO, id: 7 }).success,
    ).toBe(true);
    expect(
      messageCursorSchema.safeParse({ createdAt: ISO, id: 0 }).success,
    ).toBe(false);
    expect(
      messageCursorSchema.safeParse({ createdAt: "yesterday", id: 1 }).success,
    ).toBe(false);
  });

  it("messagesGetTailInputSchema clamps limit to [1, 100] with default 50", () => {
    const parsed = messagesGetTailInputSchema.safeParse({ sessionId: SESSION });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.limit).toBe(50);

    expect(
      messagesGetTailInputSchema.safeParse({ sessionId: SESSION, limit: 0 })
        .success,
    ).toBe(false);
    expect(
      messagesGetTailInputSchema.safeParse({ sessionId: SESSION, limit: 101 })
        .success,
    ).toBe(false);
  });

  it("messagesListInputSchema defaults cursor to null", () => {
    const parsed = messagesListInputSchema.safeParse({ sessionId: SESSION });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cursor).toBeNull();
      expect(parsed.data.limit).toBe(50);
    }
  });

  it("messagesGetAroundInputSchema requires positive messageId + clamps windows", () => {
    expect(
      messagesGetAroundInputSchema.safeParse({
        sessionId: SESSION,
        messageId: 0,
      }).success,
    ).toBe(false);
    expect(
      messagesGetAroundInputSchema.safeParse({
        sessionId: SESSION,
        messageId: 5,
        before: 60,
      }).success,
    ).toBe(false);
  });

  it("messagePageSchema validates wrapper shape", () => {
    const parsed = messagePageSchema.safeParse({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("transcriptAppendEventSchema", () => {
  const VALID = {
    type: TRANSCRIPT_APPEND_EVENT_TYPE,
    sessionId: SESSION,
    messageId: 7,
    role: "assistant" as const,
    createdAt: ISO,
    messageType: "chat",
    correlationId: null,
  };

  it("accepts a canonical engine.transcript.append payload", () => {
    expect(transcriptAppendEventSchema.safeParse(VALID).success).toBe(true);
  });

  it("rejects payloads with the wrong literal type", () => {
    expect(
      transcriptAppendEventSchema.safeParse({
        ...VALID,
        type: "engine.transcript.update",
      }).success,
    ).toBe(false);
  });

  it("rejects non-positive messageId", () => {
    expect(
      transcriptAppendEventSchema.safeParse({ ...VALID, messageId: 0 }).success,
    ).toBe(false);
    expect(
      transcriptAppendEventSchema.safeParse({ ...VALID, messageId: -1 }).success,
    ).toBe(false);
  });

  it("rejects non-UUID sessionId", () => {
    expect(
      transcriptAppendEventSchema.safeParse({
        ...VALID,
        sessionId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("rejects role outside the canonical enum", () => {
    expect(
      transcriptAppendEventSchema.safeParse({ ...VALID, role: "hacker" }).success,
    ).toBe(false);
  });

  it("rejects extra fields (.strict)", () => {
    expect(
      transcriptAppendEventSchema.safeParse({
        ...VALID,
        extra: "smuggle",
      }).success,
    ).toBe(false);
  });

  it("accepts null messageType and null correlationId", () => {
    expect(
      transcriptAppendEventSchema.safeParse({
        ...VALID,
        messageType: null,
        correlationId: null,
      }).success,
    ).toBe(true);
  });
});
