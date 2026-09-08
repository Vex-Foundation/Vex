/**
 * `GET /capabilities` and `POST /v1/lighter/positions` - the two client calls
 * the Lighter reporting lane needs, and the outcome each server answer maps to.
 *
 * Pinned here, because each one is a decision the gate acts on:
 *   - 200 is the LIST, empty included: a server that answers and advertises
 *     nothing has given a real, negative answer;
 *   - 404 is `absent`, and it is the ONLY status that is: the route does not
 *     exist, which is exactly what an old server says;
 *   - 401, 403 and a transport failure are `unreachable`, never `absent` - a
 *     rejected token is not the deployment telling us what it carries, and
 *     recording it as absent would turn an auth problem into a capability
 *     rollback that holds every Lighter row;
 *   - an install with no token asks nothing at all;
 *   - the token travels only in the Authorization header.
 */
import { afterEach, describe, it, expect, vi } from "vitest";

import { buildAgentscanClient } from "../../../vex-agent/agentscan/client.js";

const HASH = "c".repeat(64);
const TOKEN = "T".repeat(43);

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

describe("fetchCapabilities", () => {
  it("reads the advertised list from a 200 and sends the token only as a Bearer header", async () => {
    const mock = stubFetch(jsonResponse(200, { capabilities: ["lighter_v1", "other"] }));
    const client = buildAgentscanClient("http://localhost");

    const answer = await client.fetchCapabilities({ ingestToken: TOKEN });

    expect(answer).toEqual({ kind: "list", capabilities: ["lighter_v1", "other"] });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost/capabilities");
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("reads an EMPTY advertised list as a real answer, not as absence", async () => {
    stubFetch(jsonResponse(200, { capabilities: [] }));
    const client = buildAgentscanClient("http://localhost");

    expect(await client.fetchCapabilities({ ingestToken: TOKEN }))
      .toEqual({ kind: "list", capabilities: [] });
  });

  it("treats a 404 as capability absent - the old-server answer", async () => {
    stubFetch(jsonResponse(404, { error: { code: "not_found" } }));
    const client = buildAgentscanClient("http://localhost");

    expect(await client.fetchCapabilities({ ingestToken: TOKEN })).toEqual({ kind: "absent" });
  });

  it("treats a 401 as unreachable, NEVER as absent", async () => {
    stubFetch(jsonResponse(401, { error: { code: "unauthorized" } }));
    const client = buildAgentscanClient("http://localhost");

    expect(await client.fetchCapabilities({ ingestToken: TOKEN })).toEqual({ kind: "unreachable", reason: "refused" });
  });

  it("treats a transport failure as unreachable", async () => {
    stubFetch(new Error("ECONNREFUSED"));
    const client = buildAgentscanClient("http://localhost");

    expect(await client.fetchCapabilities({ ingestToken: TOKEN })).toEqual({ kind: "unreachable", reason: "transport" });
  });

  it("asks nothing at all when this install holds no ingest token", async () => {
    const mock = stubFetch(jsonResponse(200, { capabilities: ["lighter_v1"] }));
    const client = buildAgentscanClient("http://localhost");

    expect(await client.fetchCapabilities({ ingestToken: null })).toEqual({ kind: "unreachable", reason: "no_ingest_token" });
    expect(mock).not.toHaveBeenCalled();
  });
});

const OBSERVATION = {
  environment: "core",
  accountIndex: "24226",
  observationId: "obs-1",
  observedAt: "2026-09-08T10:00:00.000Z",
  source: "account_endpoint",
  coverage: { markets: "all", complete: true },
  positions: [],
} as const;

describe("postLighterPositionObservations", () => {
  it("POSTs the batch to /v1/lighter/positions with the Bearer token", async () => {
    const mock = stubFetch(jsonResponse(200, { accepted: 1, ignoredStale: 0, rejected: [] }));
    const client = buildAgentscanClient("http://localhost");

    const outcome = await client.postLighterPositionObservations({
      agentHash: HASH,
      ingestToken: TOKEN,
      observations: [OBSERVATION],
    });

    expect(outcome).toEqual({ kind: "ok", accepted: 1, ignoredStale: 0, rejectedIndexes: [] });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost/v1/lighter/positions");
    expect(url).not.toContain(TOKEN);
    expect(JSON.parse(String(init.body))).toEqual({
      schemaVersion: 1,
      agentHash: HASH,
      observations: [OBSERVATION],
    });
  });

  it("surfaces a per-item refusal by index and counts an ignored-stale arrival separately", async () => {
    stubFetch(jsonResponse(200, { accepted: 1, ignoredStale: 2, rejected: [{ index: 0 }] }));
    const client = buildAgentscanClient("http://localhost");

    expect(await client.postLighterPositionObservations({
      agentHash: HASH,
      ingestToken: TOKEN,
      observations: [OBSERVATION],
    })).toEqual({ kind: "ok", accepted: 1, ignoredStale: 2, rejectedIndexes: [0] });
  });

  it("maps 401 to auth_lost, 410 to a permanent stop and 503 to a retryable outcome", async () => {
    const client = buildAgentscanClient("http://localhost");

    stubFetch(jsonResponse(401, { error: { code: "unauthorized" } }));
    expect(await client.postLighterPositionObservations({
      agentHash: HASH, ingestToken: TOKEN, observations: [OBSERVATION],
    })).toEqual({ kind: "auth_lost" });

    stubFetch(jsonResponse(410, { error: { code: "consent_revoked" } }));
    expect(await client.postLighterPositionObservations({
      agentHash: HASH, ingestToken: TOKEN, observations: [OBSERVATION],
    })).toEqual({ kind: "stopped", reason: "consent_revoked" });

    stubFetch(jsonResponse(503, { error: { code: "unavailable" } }, { "retry-after": "7" }));
    const retryable = await client.postLighterPositionObservations({
      agentHash: HASH, ingestToken: TOKEN, observations: [OBSERVATION],
    });
    expect(retryable.kind).toBe("retryable");
    if (retryable.kind === "retryable") expect(retryable.retryAfterSeconds).toBe(7);
  });

  it("never throws on a transport failure", async () => {
    stubFetch(new Error("ECONNRESET"));
    const client = buildAgentscanClient("http://localhost");

    const outcome = await client.postLighterPositionObservations({
      agentHash: HASH, ingestToken: TOKEN, observations: [OBSERVATION],
    });
    expect(outcome.kind).toBe("retryable");
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });
});
