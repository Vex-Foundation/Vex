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
import {
  MAXIMAL_ASTRAL_ANALYSIS_PRETTY_CHARS,
  MAXIMAL_DOCUMENT_PRETTY_CHARS,
  maximalBoardSpec,
} from "../../../../../src/__tests__/lib/board/maximal-board-spec.js";

const ISO = "2026-05-21T10:00:00.000Z";
const SESSION = "00000000-0000-4000-8000-000000000001";

/** One `tool_call` DTO row carrying `toolArgs`. Shared by the ceiling tests. */
const toolArgsRow = (toolArgs: string) => ({
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
    expect(
      sessionMessageDtoSchema.safeParse(toolArgsRow("a".repeat(2001))).success,
    ).toBe(true);
    expect(
      sessionMessageDtoSchema.safeParse(toolArgsRow("a".repeat(TOOL_ARGS_DISPLAY_CEILING))).success,
    ).toBe(true);
    expect(
      sessionMessageDtoSchema.safeParse(toolArgsRow("a".repeat(TOOL_ARGS_DISPLAY_CEILING + 1))).success,
    ).toBe(false);
  });

  /**
   * THE INVARIANT, restated for the 2026-08-29 budget rise, and the reason it
   * could not stay `TOOL_ARGS_DISPLAY_CEILING > BOARD_SPEC_MAX_BYTES`.
   *
   * CONTRACT CHANGE, stated: this test used to assert exactly that, plus half
   * the budget as headroom. Both constants now read 524,288, so the old
   * assertions would fail while the property they were PROXYING for holds with
   * enormous margin. They were a byte-vs-character comparison standing in for
   * the real question, which is what the transcript mapper can actually
   * produce.
   *
   * The two numbers are not comparable by arithmetic in either direction: this
   * ceiling counts UTF-16 units of a PRETTY-PRINTED string, the board budget
   * counts UTF-8 bytes of a COMPACT one, and pretty-printing ADDS indentation
   * characters that the byte figure never carried. What actually bounds the
   * mapper is the board schema's own CHARACTER bounds - which is why raising
   * the byte budget by 192 KiB did not move the character figures below by a
   * single unit.
   */
  it("clears the mapper's output for every board the budget admits, measured", () => {
    // The mapper serializes tool args with `JSON.stringify(value, null, 2)`
    // (`vex-app/src/main/database/messages/redaction.ts`), so that string's
    // LENGTH is the figure this ceiling must clear - indentation, key names
    // and escaping included.
    const pretty = (spec: unknown): number => JSON.stringify(spec, null, 2).length;

    // EVERY single-script fill produces the SAME character count while
    // spanning 161,945 to 383,449 bytes. That identity is the invariant: the
    // schema bounds characters, so the script cannot move this number.
    for (const script of ["latin", "twoByte", "threeByte"] as const) {
      expect(pretty(maximalBoardSpec({ script }))).toBe(MAXIMAL_DOCUMENT_PRETTY_CHARS);
    }

    // The heaviest ADMISSIBLE document: astral assessments are the one way to
    // spend TWO UTF-16 units on one code point of a code-point-bounded field.
    expect(pretty(maximalBoardSpec({ script: "threeByte", analysisScript: "fourByte" }))).toBe(
      MAXIMAL_ASTRAL_ANALYSIS_PRETTY_CHARS,
    );

    // The real invariant, and real headroom rather than a squeeze: the ceiling
    // is a corruption guard, so no legitimate producer sits anywhere near it.
    expect(TOOL_ARGS_DISPLAY_CEILING).toBeGreaterThan(MAXIMAL_ASTRAL_ANALYSIS_PRETTY_CHARS);
    expect(TOOL_ARGS_DISPLAY_CEILING - MAXIMAL_ASTRAL_ANALYSIS_PRETTY_CHARS).toBeGreaterThan(
      MAXIMAL_ASTRAL_ANALYSIS_PRETTY_CHARS,
    );
  });

  /**
   * THE PER-CHARACTER FACT the conservative reasoning rests on, pinned rather
   * than asserted in prose: for any string, UTF-16 units <= UTF-8 bytes. A
   * multi-byte character is one or two units but two to four bytes, and an
   * escape costs the same on both sides. It does NOT alone make the ceiling
   * safe - pretty-printing adds characters the compact byte figure never
   * carried - which is why the measured test above is the binding one.
   */
  it("never lets a stringified spec's characters exceed its bytes", () => {
    const encoder = new TextEncoder();
    for (const script of ["latin", "twoByte", "threeByte", "fourByte"] as const) {
      const serialized = JSON.stringify(maximalBoardSpec({ script }));
      expect(serialized.length).toBeLessThanOrEqual(encoder.encode(serialized).length);
    }
    // Including the shapes JSON escapes: a control character and a lone
    // surrogate both serialize to six ASCII characters and six bytes.
    for (const raw of ["\u0001", "\ud800", '"', "\\"]) {
      const serialized = JSON.stringify({ v: raw });
      expect(serialized.length).toBeLessThanOrEqual(encoder.encode(serialized).length);
    }
  });

  /**
   * THE INCLUSIVE EDGE, both sides of it.
   *
   * The mapper nulls args only STRICTLY above the ceiling, and the board
   * budget admits a document of exactly its own size, so the two agree at the
   * boundary. A silent flip to `>=` on either side would open a one-unit band
   * where a board is stored but its arguments vanish from the transcript.
   */
  it("ships args of EXACTLY the ceiling whole, and nulls only one character more", () => {
    const atCeiling = "a".repeat(TOOL_ARGS_DISPLAY_CEILING);
    expect(atCeiling.length > TOOL_ARGS_DISPLAY_CEILING).toBe(false);
    expect(`${atCeiling}a`.length > TOOL_ARGS_DISPLAY_CEILING).toBe(true);
    // The schema agrees with the mapper at the same edge.
    expect(sessionMessageDtoSchema.safeParse(toolArgsRow(atCeiling)).success).toBe(true);
    expect(sessionMessageDtoSchema.safeParse(toolArgsRow(`${atCeiling}a`)).success).toBe(false);
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
