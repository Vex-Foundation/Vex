/**
 * Direct unit tests for `buildTurnEnvelope`.
 *
 * The envelope's CONTENT contract (segment order, cache hints, tool-call
 * round-trip, orphan repair placement) is proven by
 * `turn-envelope-characterization.test.ts`, which observed the identical bytes
 * through `executeTurn` before and after the extraction. This file covers only
 * what that path cannot see: the returned `insertedPlaceholders` count, and
 * the fact that the function is callable standalone — which is what lets the
 * C8 byte ceiling measure the very object the request will carry instead of
 * re-building one that could drift.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@vex-agent/db/repos/messages.js", () => ({
  addMessage: vi.fn(),
  addEngineMessage: vi.fn(),
  getLiveMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  updateTokenCount: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
}));

vi.mock("@vex-agent/tools/protocols/catalog.js", () => ({
  PROTOCOL_TOOLS: [],
  PROTOCOL_NAMESPACE_ALLOWLIST: [],
}));

const { buildTurnEnvelope } = await import(
  "../../../../vex-agent/engine/core/turn-envelope.js"
);

function makeContext() {
  return {
    sessionId: "session-1",
    sessionKind: "agent" as const,
    sessionPermission: "restricted" as const,
    missionId: null,
    missionRunId: null,
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" as const },
    loadedDocuments: new Map<string, string>(),
  };
}

describe("buildTurnEnvelope", () => {
  it("reports zero inserted placeholders for a clean tape", () => {
    const envelope = buildTurnEnvelope(
      makeContext() as never,
      [{ role: "user", content: "hi", timestamp: "t1" }] as never,
      null,
    );

    expect(envelope.insertedPlaceholders).toBe(0);
  });

  it("reports one placeholder per unanswered tool call", () => {
    const envelope = buildTurnEnvelope(
      makeContext() as never,
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call-1", command: "a", args: {} },
            { id: "call-2", command: "b", args: {} },
          ],
          timestamp: "t1",
        },
      ] as never,
      null,
    );

    expect(envelope.insertedPlaceholders).toBe(2);
    expect(envelope.providerMessages.filter((m) => m.role === "tool")).toHaveLength(2);
  });

  it("is NOT reproducible across calls — the turn-state segment embeds a live clock", () => {
    // This is the reason the C8 ceiling must measure the envelope object that
    // is then HANDED to the request, never a second build of the same inputs.
    // The turn-state segment carries "Current time UTC: <now>", so two builds
    // of identical inputs differ. The drift is small, but a ceiling computed
    // over bytes that are not the bytes sent is a ceiling that can be wrong in
    // either direction — and only one of those directions is safe.
    const args = [
      makeContext() as never,
      [{ role: "user", content: "swap", timestamp: "t1" }] as never,
      "summary",
    ] as const;

    const first = buildTurnEnvelope(...args);
    const second = buildTurnEnvelope(...args);

    // Structure is stable…
    expect(first.providerMessages.map((m) => m.cacheHint ?? null)).toEqual(
      second.providerMessages.map((m) => m.cacheHint ?? null),
    );
    // …but the turn-state content is time-dependent, so byte equality of the
    // whole envelope is NOT a property callers may assume.
    const turnState = (e: typeof first): string =>
      e.providerMessages[e.providerMessages.length - 1]!.content;
    expect(turnState(first)).toContain("Current time UTC:");
    expect(turnState(second)).toContain("Current time UTC:");
  });
});
