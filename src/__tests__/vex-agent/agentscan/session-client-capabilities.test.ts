/**
 * The handshake's additive `capabilities` field.
 *
 * The distinction this suite exists for: an ABSENT field and an EMPTY list are
 * not the same answer. Absent is an old server that has no capabilities to
 * declare - the gate has learned nothing about `lighter_v1` from it beyond
 * "this deployment does not carry it". An empty array is a server that does
 * declare capabilities and declares none. Collapsing the two would let a
 * future server's silence read as a positive statement, or an explicit "none"
 * read as "never asked".
 */
import { afterEach, describe, it, expect, vi } from "vitest";

import { buildAgentscanSessionClient } from "../../../vex-agent/agentscan/session-client.js";

const HASH = "d".repeat(64);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(response: Response): void {
  vi.stubGlobal("fetch", vi.fn(async () => response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const COMPLETE_INPUT = {
  challengeId: "challenge-1",
  agentHash: HASH,
  consentVersion: 1,
  proofs: [],
};

const BOUND_BODY = {
  ingestToken: "T".repeat(43),
  agentName: "agent",
  syncState: { lastAcceptedRowId: 12 },
};

describe("sessionComplete capabilities", () => {
  it("carries the advertised list off the handshake response", async () => {
    stubFetch(jsonResponse(200, { ...BOUND_BODY, capabilities: ["lighter_v1"] }));
    const client = buildAgentscanSessionClient("http://localhost");

    const outcome = await client.sessionComplete(COMPLETE_INPUT, null);

    expect(outcome).toEqual({
      kind: "bound",
      ingestToken: BOUND_BODY.ingestToken,
      agentName: "agent",
      lastAcceptedRowId: 12,
      capabilities: ["lighter_v1"],
    });
  });

  it("reads an ABSENT field as null - an old server, not an empty declaration", async () => {
    stubFetch(jsonResponse(200, BOUND_BODY));
    const client = buildAgentscanSessionClient("http://localhost");

    const outcome = await client.sessionComplete(COMPLETE_INPUT, null);

    expect(outcome.kind).toBe("bound");
    if (outcome.kind === "bound") expect(outcome.capabilities).toBeNull();
  });

  it("reads an EMPTY list as a real, negative answer", async () => {
    stubFetch(jsonResponse(200, { ...BOUND_BODY, capabilities: [] }));
    const client = buildAgentscanSessionClient("http://localhost");

    const outcome = await client.sessionComplete(COMPLETE_INPUT, null);

    expect(outcome.kind).toBe("bound");
    if (outcome.kind === "bound") expect(outcome.capabilities).toEqual([]);
  });

  it("drops entries that are not non-empty strings rather than failing the whole parse", async () => {
    stubFetch(jsonResponse(200, { ...BOUND_BODY, capabilities: ["lighter_v1", "", 7, null] }));
    const client = buildAgentscanSessionClient("http://localhost");

    const outcome = await client.sessionComplete(COMPLETE_INPUT, null);

    expect(outcome.kind).toBe("bound");
    if (outcome.kind === "bound") expect(outcome.capabilities).toEqual(["lighter_v1"]);
  });

  it("reads a malformed (non-array) field as absent rather than as a declaration", async () => {
    stubFetch(jsonResponse(200, { ...BOUND_BODY, capabilities: "lighter_v1" }));
    const client = buildAgentscanSessionClient("http://localhost");

    const outcome = await client.sessionComplete(COMPLETE_INPUT, null);

    expect(outcome.kind).toBe("bound");
    if (outcome.kind === "bound") expect(outcome.capabilities).toBeNull();
  });
});
