/**
 * AgentScan wallet-binding SESSION client v2 — wire shape + outcome mapping.
 *
 * Pinned here:
 *   - exact URLs, headers and bodies for session/start and session/complete;
 *   - session/complete carries `Authorization: Bearer <token>` whenever one is
 *     passed, and omits it when null;
 *   - contract retry rule: only 429/5xx/network are retryable;
 *   - session/complete's 400 splits on the server's error CODE:
 *     `challenge_expired` restarts the flow, anything else is a client-bug
 *     `invalid` (long-hold territory for the caller);
 *   - 401 → auth_lost, 409 → wallet_conflict, both non-retryable;
 *   - nothing throws — a network failure is a named outcome;
 *   - failure details never contain the nonce, token, or a signature.
 */
import { afterEach, describe, it, expect, vi } from "vitest";

import { buildAgentscanSessionClient } from "../../../vex-agent/agentscan/session-client.js";

const AGENT_HASH = "c".repeat(64);
const TOKEN = "T".repeat(43);
const NONCE = "N".repeat(43);
const SIGNATURE = "0x" + "ab".repeat(65);

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function stubFetch(response: Response | Error): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const START_INPUT = {
  agentHash: AGENT_HASH,
  addresses: [
    { chainFamily: "eip155" as const, address: "0x" + "1".repeat(40) },
    { chainFamily: "solana" as const, address: "SoLaNaAddr111111111111111111111111111111" },
  ],
};

const COMPLETE_INPUT = {
  challengeId: "chal-123",
  agentHash: AGENT_HASH,
  consentVersion: 1,
  appVersion: "0.2.4",
  proofs: [
    { chainFamily: "eip155" as const, address: "0x" + "1".repeat(40), signature: SIGNATURE, issuedAt: "2026-08-08T00:00:00.000Z" },
  ],
};

describe("sessionStart — wire shape", () => {
  it("POSTs agentHash + addresses to /v2/agents/session/start with NO auth header", async () => {
    const mock = stubFetch(
      jsonResponse(200, { challengeId: "chal-1", nonce: NONCE, domain: "agentscan.example", expiresAt: "2026-08-08T00:05:00.000Z" }),
    );
    const client = buildAgentscanSessionClient("http://localhost");
    const outcome = await client.sessionStart(START_INPUT);

    expect(outcome).toEqual({
      kind: "started",
      challengeId: "chal-1",
      nonce: NONCE,
      domain: "agentscan.example",
      expiresAt: "2026-08-08T00:05:00.000Z",
    });
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost/v2/agents/session/start");
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual(START_INPUT);
  });

  it("preserves a base-URL subpath", async () => {
    const mock = stubFetch(
      jsonResponse(200, { challengeId: "c", nonce: NONCE, domain: "example.org", expiresAt: "2026-08-08T00:05:00.000Z" }),
    );
    const client = buildAgentscanSessionClient("https://example.org/scan/");
    await client.sessionStart(START_INPUT);
    const [url] = mock.mock.calls[0] as [string];
    expect(url).toBe("https://example.org/scan/v2/agents/session/start");
  });

  it("maps a malformed 200 body to invalid rather than throwing", async () => {
    stubFetch(jsonResponse(200, { nonce: NONCE }));
    const client = buildAgentscanSessionClient("http://localhost");
    const outcome = await client.sessionStart(START_INPUT);
    expect(outcome.kind).toBe("invalid");
  });

  it("maps 429 to retryable carrying Retry-After", async () => {
    stubFetch(jsonResponse(429, { error: { code: "rate_limited" } }, { "retry-after": "60" }));
    const client = buildAgentscanSessionClient("http://localhost");
    const outcome = await client.sessionStart(START_INPUT);
    expect(outcome).toMatchObject({ kind: "retryable", status: 429, retryAfterSeconds: 60 });
  });

  it("maps 500 and network failure to retryable, without leaking the agentHash", async () => {
    stubFetch(jsonResponse(500, { error: { code: "internal" } }));
    const client = buildAgentscanSessionClient("http://localhost");
    const server = await client.sessionStart(START_INPUT);
    expect(server).toMatchObject({ kind: "retryable", status: 500 });

    stubFetch(new Error(`connect ECONNREFUSED near ${AGENT_HASH}`));
    const network = await client.sessionStart(START_INPUT);
    expect(network.kind).toBe("retryable");
    expect(JSON.stringify(network)).not.toContain(AGENT_HASH);
  });

  it("maps a validation 400 to invalid (non-retryable client bug)", async () => {
    stubFetch(jsonResponse(400, { error: { code: "validation_failed" } }));
    const client = buildAgentscanSessionClient("http://localhost");
    const outcome = await client.sessionStart(START_INPUT);
    expect(outcome.kind).toBe("invalid");
  });
});

describe("sessionComplete — wire shape", () => {
  it("POSTs the envelope to /v2/agents/session/complete WITH the Bearer token when one is passed", async () => {
    const mock = stubFetch(
      jsonResponse(200, { status: "bound", ingestToken: TOKEN, agentName: "agent-007", syncState: { lastAcceptedRowId: 42 } }),
    );
    const client = buildAgentscanSessionClient("http://localhost");
    const outcome = await client.sessionComplete(COMPLETE_INPUT, "current-token-xyz");

    expect(outcome).toEqual({ kind: "bound", ingestToken: TOKEN, agentName: "agent-007", lastAcceptedRowId: 42 });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost/v2/agents/session/complete");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer current-token-xyz");
    expect(JSON.parse(init.body as string)).toEqual(COMPLETE_INPUT);
  });

  it("omits the Authorization header when no current token is passed (brand-new agent)", async () => {
    const mock = stubFetch(
      jsonResponse(200, { status: "bound", ingestToken: TOKEN, agentName: "agent-fresh", syncState: { lastAcceptedRowId: null } }),
    );
    const client = buildAgentscanSessionClient("http://localhost");
    const outcome = await client.sessionComplete(COMPLETE_INPUT, null);

    expect(outcome).toEqual({ kind: "bound", ingestToken: TOKEN, agentName: "agent-fresh", lastAcceptedRowId: null });
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("omits appVersion when not provided", async () => {
    const mock = stubFetch(jsonResponse(200, { status: "bound", ingestToken: TOKEN, agentName: "a", syncState: { lastAcceptedRowId: null } }));
    const client = buildAgentscanSessionClient("http://localhost");
    const { appVersion: _omit, ...noVersion } = COMPLETE_INPUT;
    await client.sessionComplete(noVersion, null);
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect("appVersion" in JSON.parse(init.body as string)).toBe(false);
  });

  it("maps 400 challenge_expired to a dedicated outcome (restart the flow)", async () => {
    stubFetch(jsonResponse(400, { error: { code: "challenge_expired" } }));
    const client = buildAgentscanSessionClient("http://localhost");
    const outcome = await client.sessionComplete(COMPLETE_INPUT, null);
    expect(outcome).toEqual({ kind: "challenge_expired" });
  });

  it.each([
    ["invalid_signature"],
    ["validation_failed"],
  ])("maps 400 %s to invalid (client bug)", async (code) => {
    stubFetch(jsonResponse(400, { error: { code } }));
    const client = buildAgentscanSessionClient("http://localhost");
    const outcome = await client.sessionComplete(COMPLETE_INPUT, null);
    expect(outcome.kind).toBe("invalid");
  });

  it("maps 401 to auth_lost", async () => {
    stubFetch(jsonResponse(401, { error: { code: "unauthorized" } }));
    const client = buildAgentscanSessionClient("http://localhost");
    const outcome = await client.sessionComplete(COMPLETE_INPUT, TOKEN);
    expect(outcome).toEqual({ kind: "auth_lost" });
  });

  it("maps 409 to wallet_conflict", async () => {
    stubFetch(jsonResponse(409, { error: { code: "wallet_conflict" } }));
    const client = buildAgentscanSessionClient("http://localhost");
    const outcome = await client.sessionComplete(COMPLETE_INPUT, null);
    expect(outcome).toEqual({ kind: "wallet_conflict" });
  });

  it("maps 429/503 to retryable carrying Retry-After, and network failure to retryable", async () => {
    stubFetch(jsonResponse(429, { error: { code: "rate_limited" } }, { "retry-after": "30" }));
    const client = buildAgentscanSessionClient("http://localhost");
    expect(await client.sessionComplete(COMPLETE_INPUT, null)).toMatchObject({ kind: "retryable", status: 429, retryAfterSeconds: 30 });

    stubFetch(jsonResponse(503, { error: { code: "database_unavailable" } }, { "retry-after": "5" }));
    expect(await client.sessionComplete(COMPLETE_INPUT, null)).toMatchObject({ kind: "retryable", status: 503, retryAfterSeconds: 5 });

    stubFetch(new Error("fetch failed"));
    expect(await client.sessionComplete(COMPLETE_INPUT, null)).toMatchObject({ kind: "retryable", status: null });
  });

  it("never leaks the nonce, token, or signature into a retryable/invalid detail", async () => {
    stubFetch(jsonResponse(500, { error: { code: `internal ${TOKEN} ${SIGNATURE}` } }));
    const client = buildAgentscanSessionClient("http://localhost");
    const outcome = await client.sessionComplete(COMPLETE_INPUT, TOKEN);
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(SIGNATURE);
  });
});
