/**
 * Persisted reasoning — `saveAssistantMessage` writes the model's reasoning
 * trace under `metadata.payload.reasoning` so the desktop app can render a
 * collapsible "Reasoned" block on the durable transcript row (contract C1).
 *
 * Pinned here: the cap (REASONING_PAYLOAD_CAP), the TAIL semantics (the
 * newest characters survive a truncation, not the oldest), and the
 * omit-on-empty rule (no `reasoning` key at all rather than "" / null noise
 * in the JSONB column).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const appendMessage = vi.fn().mockResolvedValue({ id: 1 });

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...args: unknown[]) => appendMessage(...args),
  streamDeltaBus: { emit: vi.fn() },
  toStreamDeltaEvent: vi.fn(),
}));

const { REASONING_PAYLOAD_CAP, saveAssistantMessage } = await import(
  "../../../../vex-agent/engine/core/turn.js"
);

const SESSION_ID = "session-1";

function persistedPayload(): Record<string, unknown> | undefined {
  return (appendMessage.mock.calls[0]![2] as { payload?: Record<string, unknown> }).payload;
}

beforeEach(() => {
  appendMessage.mockClear();
});

describe("saveAssistantMessage reasoning payload", () => {
  it("persists reasoning under metadata.payload.reasoning", async () => {
    await saveAssistantMessage(SESSION_ID, "answer", null, {
      reasoning: "first I considered X",
    });

    expect(persistedPayload()).toEqual({ reasoning: "first I considered X" });
  });

  it("omits the key entirely when reasoning is absent, null, or whitespace-only", async () => {
    await saveAssistantMessage(SESSION_ID, "answer", null);
    expect(persistedPayload()).toBeUndefined();

    appendMessage.mockClear();
    await saveAssistantMessage(SESSION_ID, "answer", null, { reasoning: null });
    expect(persistedPayload()).toBeUndefined();

    appendMessage.mockClear();
    await saveAssistantMessage(SESSION_ID, "answer", null, { reasoning: "   \n\t " });
    expect(persistedPayload()).toBeUndefined();
  });

  it("truncates to the cap KEEPING THE TAIL — the newest reasoning survives", async () => {
    const head = "H".repeat(REASONING_PAYLOAD_CAP);
    const tail = "T".repeat(500);
    await saveAssistantMessage(SESSION_ID, "answer", null, { reasoning: head + tail });

    const stored = persistedPayload()!.reasoning as string;
    expect(stored).toHaveLength(REASONING_PAYLOAD_CAP);
    expect(stored.endsWith(tail)).toBe(true);
    expect(stored.startsWith("T")).toBe(false); // head partially retained
    expect(stored).toBe((head + tail).slice(-REASONING_PAYLOAD_CAP));
  });

  it("leaves other metadata stamps untouched", async () => {
    await saveAssistantMessage(SESSION_ID, "partial", null, {
      stopped: true,
      reasoning: "why I stopped",
    });

    const metadata = appendMessage.mock.calls[0]![2] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      source: "assistant",
      messageType: "chat_stopped",
      visibility: "user",
    });
  });
});
