/**
 * messages-db tests — JSONB allowlist + redaction.
 *
 * Codex review hard requirement: every mapper that reduces DB JSONB to
 * a renderer-visible DTO must be allowlisted and validated. These tests
 * exercise `tool_calls` extraction + `metadata` redaction without ever
 * touching a live Postgres — we mock `pg.Client.query` and verify the
 * mapper output shape directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionMessageDto } from "@shared/schemas/messages.js";

/**
 * `pg.Client.query`'s call signature, handed to `vi.fn` as its type argument.
 *
 * Two earlier shapes were wrong in opposite directions. Casting to the bare
 * function type erased `mockResolvedValueOnce`, so every arrangement in this
 * file was an unchecked type error carried in the ratchet baseline. Casting
 * through `unknown` to `MockedFunction` restored the mock surface but threw
 * away the checking again - a double assertion tells the compiler nothing was
 * verified. Passing the signature to `vi.fn` gives both halves with NO cast:
 * the arrangements are checked, and so are the call sites.
 */
type QuerySignature = (
  text: string,
  params?: readonly unknown[],
) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;

const mocks = vi.hoisted(() => ({
  query: vi.fn<QuerySignature>(),
  connect: vi.fn(),
  end: vi.fn(),
  buildPoolConfig: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("pg", () => {
  function MockClient() {
    return {
      connect: mocks.connect,
      end: mocks.end,
      query: mocks.query,
    };
  }
  return { Client: MockClient };
});

vi.mock("../db-config.js", () => ({
  buildPoolConfig: mocks.buildPoolConfig,
}));

vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { getMessageTail, listMessages } = await import("../messages-db.js");

/**
 * The one row a single-row tail must have produced, or a failure that says so.
 *
 * A non-null assertion here asserts nothing: when the projection returns no
 * rows the test dies on "cannot read properties of undefined" with no clue
 * which expectation was being made. This names the missing thing instead, and
 * narrows honestly.
 */
function onlyItem(items: readonly SessionMessageDto[]): SessionMessageDto {
  const first = items[0];
  if (first === undefined) {
    throw new Error("expected the tail to project exactly one row, got none");
  }
  return first;
}

const SESSION = "00000000-0000-4000-8000-00000000abcd";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildPoolConfig.mockResolvedValue({
    host: "127.0.0.1",
    port: 5777,
    database: "vex",
    user: "vex",
    password: "secret",
  });
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("messages-db mapper", () => {
  it("exposes sanitized tool args (drop secret keys, redact secret values, keep public)", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          session_id: SESSION,
          role: "assistant",
          content: "calling tool",
          tool_call_id: null,
          tool_calls: [
            {
              id: "call_1",
              namespace: "wallet",
              command: "send",
              args: {
                to: "0x1111111111111111111111111111111111111111", // public 40-hex addr
                amount: "1.5",
                privateKey: `0x${"a".repeat(64)}`, // secret KEY → dropped entirely
                note: `0x${"b".repeat(64)}`, // benign key, secret-shaped VALUE → redacted
              },
              extraField: "private", // sibling of args - never crosses
            },
          ],
          created_at: "2026-05-21T10:00:00.000Z",
          source: "agent",
          message_type: "chat",
          metadata: { secretKey: "leak-me" },
        },
      ],
    });

    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const msg = result.data.items[0]!;
    expect(msg.toolName).toBe("wallet:send");

    const calls = msg.toolCalls!;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolCallId).toBe("call_1");
    expect(calls[0]!.toolName).toBe("wallet:send");
    const args = calls[0]!.toolArgs!;
    expect(args).toContain("0x1111111111111111111111111111111111111111"); // public addr kept
    expect(args).toContain("amount");
    expect(args).not.toContain("privateKey"); // secret key dropped
    expect(args).not.toContain("aaaaaaaa"); // private-key value never present
    expect(args).toContain("[redacted:key]"); // 0x{64} value redacted (the `note`)

    // Raw JSONB siblings + metadata still never cross the boundary.
    expect(args).not.toContain("extraField");
    expect(args).not.toContain("secretKey");
    expect(msg).not.toHaveProperty("metadata");
    expect(msg).not.toHaveProperty("tool_calls");
  });

  it("redacts secret-SHAPED values (jwt, mnemonic, long base58) while keeping addresses + amounts", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 11,
          session_id: SESSION,
          role: "assistant",
          content: "",
          tool_call_id: null,
          tool_calls: [
            {
              id: "c",
              command: "do",
              args: {
                payload: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123", // JWT value
                words:
                  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", // 12-word mnemonic
                blob: "z".repeat(60), // long base58/base64
                mint: "So11111111111111111111111111111111111111112", // 44-char Solana mint (public)
                amount: "10",
              },
            },
          ],
          created_at: "2026-05-21T10:00:00.000Z",
          source: "agent",
          message_type: "chat",
          metadata: null,
        },
      ],
    });
    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const args = result.data.items[0]!.toolCalls![0]!.toolArgs!;
    expect(args).toContain("[redacted:jwt]");
    expect(args).toContain("[redacted:mnemonic]");
    expect(args).toContain("[redacted:secret]");
    expect(args).not.toContain("eyJhbGci"); // raw jwt never present
    expect(args).toContain("So11111111111111111111111111111111111111112"); // public mint kept
    expect(args).toContain("amount");
  });

  it("maps every tool call in a multi-tool batch, skipping malformed entries (no coercion)", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 12,
          session_id: SESSION,
          role: "assistant",
          content: "two calls",
          tool_call_id: null,
          tool_calls: [
            { id: "c1", namespace: "wallet", command: "read", args: { chain: "base" } },
            { command: "no_id", args: {} }, // no string id → skipped
            { id: 42, command: "numeric_id" }, // numeric id → skipped (no coercion)
            { id: "", command: "empty_id" }, // empty id → skipped (schema min-length)
            { id: "c9", command: "" }, // empty name → skipped (schema min-length)
            { id: "c2", command: "dexscreener_search", args: {} }, // empty args → toolArgs null
          ],
          created_at: "2026-05-21T10:00:00.000Z",
          source: "agent",
          message_type: "chat",
          metadata: null,
        },
      ],
    });
    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const calls = result.data.items[0]!.toolCalls!;
    expect(calls.map((c) => c.toolCallId)).toEqual(["c1", "c2"]);
    expect(calls[0]!.toolName).toBe("wallet:read");
    expect(calls[1]!.toolName).toBe("dexscreener_search");
    expect(calls[1]!.toolArgs).toBeNull(); // empty args → null
  });

  it("leaves toolCalls null on a tool_result row (output lives in content)", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 13,
          session_id: SESSION,
          role: "tool",
          content: "0.5 ETH",
          tool_call_id: "call_1",
          tool_calls: null,
          created_at: "2026-05-21T10:00:00.000Z",
          source: "agent",
          message_type: "chat",
          metadata: null,
        },
      ],
    });
    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const msg = result.data.items[0]!;
    expect(msg.kind).toBe("tool_result");
    expect(msg.toolCalls).toBeNull();
    expect(msg.content).toBe("0.5 ETH");
  });

  it("falls back to command, then name, then null when namespace is absent", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 2,
          session_id: SESSION,
          role: "assistant",
          content: "",
          tool_call_id: null,
          tool_calls: [{ command: "ping" }],
          created_at: "2026-05-21T10:00:00.000Z",
          source: null,
          message_type: null,
          metadata: null,
        },
        {
          id: 3,
          session_id: SESSION,
          role: "assistant",
          content: "",
          tool_call_id: null,
          tool_calls: [{ name: "fallback" }],
          created_at: "2026-05-21T10:01:00.000Z",
          source: null,
          message_type: null,
          metadata: null,
        },
        {
          id: 4,
          session_id: SESSION,
          role: "assistant",
          content: "",
          tool_call_id: null,
          tool_calls: [{ junk: 1 }],
          created_at: "2026-05-21T10:02:00.000Z",
          source: null,
          message_type: null,
          metadata: null,
        },
      ],
    });

    const result = await getMessageTail(SESSION, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // tail returns chronological order (oldest first); items[0] corresponds
    // to row #4 because DESC query gives 4,3,2 then we reverse for render.
    const byId = new Map(result.data.items.map((m) => [m.id, m.toolName]));
    expect(byId.get(2)).toBe("ping");
    expect(byId.get(3)).toBe("fallback");
    expect(byId.get(4)).toBe(null);
  });

  it("rejects non-string namespace/command values (no type coercion)", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 5,
          session_id: SESSION,
          role: "assistant",
          content: "",
          tool_call_id: null,
          tool_calls: [{ namespace: 42, command: { nested: "x" } }],
          created_at: "2026-05-21T10:00:00.000Z",
          source: null,
          message_type: null,
          metadata: null,
        },
      ],
    });

    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]!.toolName).toBeNull();
  });

  it("derives runtime_notice kind from message_type without forwarding JSONB", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 6,
          session_id: SESSION,
          role: "system",
          content: "Run resumed",
          tool_call_id: null,
          tool_calls: null,
          created_at: "2026-05-21T10:00:00.000Z",
          source: "engine",
          message_type: "wake_banner",
          metadata: { kind: "wake", privateData: "leak" },
        },
      ],
    });

    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]!.kind).toBe("runtime_notice");
    expect(result.data.items[0]).not.toHaveProperty("metadata");
  });

  /**
   * M6. The disposition is the engine's own typed record of what it did, and
   * the renderer's delivery words are read from it. Flattened away, the row
   * rendered "Steered - read at the agent's next step" for every interrupt,
   * including one queued against a run parked on an error whose own
   * acknowledgement row said the opposite.
   */
  it("projects the operator instruction's disposition onto the steering row", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 12,
          session_id: SESSION,
          role: "user",
          content: "check the fees first",
          tool_call_id: null,
          tool_calls: null,
          created_at: "2026-08-28T10:00:00.000Z",
          source: "user",
          message_type: "operator_interrupt",
          interrupt_disposition: "queued_interrupt",
        },
      ],
    });

    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = onlyItem(result.data.items);
    expect(row.kind).toBe("steering");
    expect(row.interruptDisposition).toBe("queued_interrupt");
  });

  it("projects null for an unrecognised disposition rather than a loose string", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 13,
          session_id: SESSION,
          role: "user",
          content: "hi",
          tool_call_id: null,
          tool_calls: null,
          created_at: "2026-08-28T10:00:00.000Z",
          source: "user",
          message_type: "operator_interrupt",
          interrupt_disposition: "teleported",
        },
      ],
    });

    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(onlyItem(result.data.items).interruptDisposition).toBeNull();
  });

  /**
   * The ACK row carries the same disposition in its own payload, and its whole
   * text already states it. Projecting it onto both rows would give the
   * renderer two places to say one thing and a chance to say them differently.
   */
  it("does NOT project a disposition onto the acknowledgement row", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 14,
          session_id: SESSION,
          role: "system",
          content: "Saved.",
          tool_call_id: null,
          tool_calls: null,
          created_at: "2026-08-28T10:00:00.000Z",
          source: "engine",
          message_type: "operator_interrupt_ack",
          interrupt_disposition: "queued_interrupt",
        },
      ],
    });

    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ackRow = onlyItem(result.data.items);
    expect(ackRow.kind).toBe("operator_ack");
    expect(ackRow.interruptDisposition).toBeNull();
  });

  // M6: the engine's durable acknowledgement of an operator instruction gets
  // its OWN kind, ahead of the catch-all. Flattened into `runtime_notice` it is
  // indistinguishable from a wake banner, and the renderer cannot announce the
  // one notice that answers something the operator just did.
  it("derives operator_ack from the ack message_type, not the notice catch-all", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 11,
          session_id: SESSION,
          role: "system",
          content:
            "Saved. The agent is not running a turn right now, so it will read this the next time it runs.",
          tool_call_id: null,
          tool_calls: null,
          created_at: "2026-08-28T10:00:00.000Z",
          source: "engine",
          message_type: "operator_interrupt_ack",
          // The typed disposition rides the row's JSONB, which is NEVER
          // forwarded: the renderer derives everything from `kind` plus the
          // engine-authored content, and compares no prose.
          metadata: { payload: { disposition: "queued_interrupt" } },
        },
      ],
    });

    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(onlyItem(result.data.items).kind).toBe("operator_ack");
    expect(result.data.items[0]).not.toHaveProperty("metadata");
  });

  it("maps a user mission-setup row to text kind (a user turn, not a notice)", async () => {
    // A user's mission-setup input is their own message — it must render as a
    // normal user bubble, not the centered-uppercase runtime-notice styling.
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 8,
          session_id: SESSION,
          role: "user",
          content: "Hunt Solana meme tokens with $9",
          tool_call_id: null,
          tool_calls: null,
          created_at: "2026-05-21T10:00:00.000Z",
          source: "user",
          message_type: "mission_setup",
          metadata: null,
        },
      ],
    });

    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]!.kind).toBe("text");
    expect(result.data.items[0]!.role).toBe("user");
  });

  it("maps a user operator_interrupt row to the steering kind - a steered user turn, not a notice (A33)", async () => {
    vi.mocked(mocks.query).mockResolvedValueOnce({
      rows: [
        {
          id: 9,
          session_id: SESSION,
          role: "user",
          content: "actually, check the fees first",
          tool_call_id: null,
          tool_calls: null,
          created_at: "2026-08-20T10:00:00.000Z",
          source: "user",
          message_type: "operator_interrupt",
          metadata: null,
        },
      ],
    });

    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]!.kind).toBe("steering");
    expect(result.data.items[0]!.role).toBe("user");
  });

  it("the ENGINE operator cue row stays a runtime notice - only the USER steered text wears the steering kind", async () => {
    vi.mocked(mocks.query).mockResolvedValueOnce({
      rows: [
        {
          id: 10,
          session_id: SESSION,
          role: "system",
          content: "[Engine: operator_interrupt]",
          tool_call_id: null,
          tool_calls: null,
          created_at: "2026-08-20T10:00:01.000Z",
          source: "engine",
          message_type: "operator_interrupt",
          metadata: null,
        },
      ],
    });

    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]!.kind).toBe("runtime_notice");
  });

  it("maps a compaction_committed marker row to the compaction kind (8-4)", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 7,
          session_id: SESSION,
          role: "system",
          content: "Conversation compacted into memory · checkpoint 2",
          tool_call_id: null,
          tool_calls: null,
          created_at: "2026-05-21T10:00:00.000Z",
          source: "engine",
          message_type: "compaction_committed",
          metadata: null,
        },
      ],
    });
    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]!.kind).toBe("compaction");
  });

  it("maps an assistant chat_stopped row to the assistant_stopped kind (9-5b)", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 70,
          session_id: SESSION,
          role: "assistant",
          content: "The balance is",
          tool_call_id: null,
          tool_calls: null,
          created_at: "2026-05-21T10:00:00.000Z",
          source: "agent",
          message_type: "chat_stopped",
          metadata: null,
        },
      ],
    });
    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]!.kind).toBe("assistant_stopped");
    expect(result.data.items[0]!.content).toBe("The balance is");
  });

  it("keeps a non-assistant chat_stopped row as runtime_notice (role-guarded) (9-5b)", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 71,
          session_id: SESSION,
          role: "system",
          content: "stray",
          tool_call_id: null,
          tool_calls: null,
          created_at: "2026-05-21T10:00:00.000Z",
          source: "engine",
          message_type: "chat_stopped",
          metadata: null,
        },
      ],
    });
    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]!.kind).toBe("runtime_notice");
  });

  it("maps session_memory_search / long_memory_search tool-call rows to the recall kind and keeps assistant prose (8-4)", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 8,
          session_id: SESSION,
          role: "assistant",
          content: "Let me check what I remember.",
          tool_call_id: null,
          tool_calls: [{ command: "session_memory_search", args: { query: "x" } }],
          created_at: "2026-05-21T10:00:00.000Z",
          source: "agent",
          message_type: "chat",
          metadata: null,
        },
        {
          id: 9,
          session_id: SESSION,
          role: "assistant",
          content: "",
          tool_call_id: null,
          tool_calls: [{ command: "long_memory_search", args: {} }],
          created_at: "2026-05-21T10:01:00.000Z",
          source: "agent",
          message_type: "chat",
          metadata: null,
        },
      ],
    });
    const result = await getMessageTail(SESSION, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.data.items.map((m) => [m.id, m]));
    expect(byId.get(8)!.kind).toBe("recall");
    expect(byId.get(8)!.toolName).toBe("session_memory_search");
    // Codex constraint: non-empty assistant prose on a recall row is preserved.
    expect(byId.get(8)!.content).toBe("Let me check what I remember.");
    expect(byId.get(9)!.kind).toBe("recall");
    expect(byId.get(9)!.toolName).toBe("long_memory_search");
  });

  it("keeps a normal tool-call row as tool_call (recall detection is narrow) (8-4)", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 10,
          session_id: SESSION,
          role: "assistant",
          content: "",
          tool_call_id: null,
          tool_calls: [{ namespace: "polymarket", command: "order" }],
          created_at: "2026-05-21T10:00:00.000Z",
          source: "agent",
          message_type: "chat",
          metadata: null,
        },
      ],
    });
    const result = await getMessageTail(SESSION, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]!.kind).toBe("tool_call");
    expect(result.data.items[0]!.toolName).toBe("polymarket:order");
  });

  it("uses cursor-based DESC ordering with overflow page for hasMore=true", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: Array.from({ length: 6 }, (_, idx) => ({
        id: 100 - idx,
        session_id: SESSION,
        role: "user",
        content: `m${idx}`,
        tool_call_id: null,
        tool_calls: null,
        created_at: `2026-05-21T10:0${idx}:00.000Z`,
        source: null,
        message_type: "chat",
        metadata: null,
      })),
    });

    const result = await listMessages(SESSION, null, 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toHaveLength(5);
    expect(result.data.hasMore).toBe(true);
    expect(result.data.nextCursor).not.toBeNull();
  });

  it("returns ok({}) shape (no error) when DB has zero messages for session", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const result = await getMessageTail(SESSION, 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toEqual([]);
    expect(result.data.hasMore).toBe(false);
    expect(result.data.nextCursor).toBeNull();
  });

  it("dbUnavailable when buildPoolConfig returns null", async () => {
    mocks.buildPoolConfig.mockReset();
    mocks.buildPoolConfig.mockResolvedValueOnce(null);
    const result = await getMessageTail(SESSION, 5);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("internal.unexpected");
    expect(result.error.domain).toBe("messages");
  });
});
