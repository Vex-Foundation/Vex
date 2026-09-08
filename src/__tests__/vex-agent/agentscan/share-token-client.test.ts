import { afterEach, describe, expect, it, vi } from "vitest";

import { buildShareTokenClient } from "../../../vex-agent/agentscan/share-token-client.js";
import { generateShareToken } from "../../../vex-agent/agentscan/share-token.js";

const INGEST = "I".repeat(43);
const SHARE = "S".repeat(43);
const SHARE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

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

describe("generateShareToken", () => {
  it("mints 43-char base64url", () => {
    const token = generateShareToken();
    expect(token).toMatch(SHARE_PATTERN);
    expect(generateShareToken()).not.toBe(token);
  });
});

describe("buildShareTokenClient.register", () => {
  it("POSTs only the lowercase SHA-256 shareTokenHash with Bearer ingest token", async () => {
    const mock = stubFetch(jsonResponse(200, { status: "registered" }));
    const client = buildShareTokenClient("http://localhost");
    const outcome = await client.register({ ingestToken: INGEST, shareToken: SHARE });

    expect(outcome).toEqual({ kind: "registered" });
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost/v1/agents/share-token");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${INGEST}`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      shareTokenHash: "b0679324228c35931acdfa8a487f94873c05094138a477994a5bdba6d6c24a56",
    });
    expect(init.body).not.toContain(SHARE);
    expect(JSON.stringify(init.headers)).not.toContain(SHARE);
  });

  it("preserves a base-URL subpath", async () => {
    const mock = stubFetch(jsonResponse(200, { status: "registered" }));
    const client = buildShareTokenClient("https://example.org/scan/");
    await client.register({ ingestToken: INGEST, shareToken: SHARE });
    const [url] = mock.mock.calls[0] as [string];
    expect(url).toBe("https://example.org/scan/v1/agents/share-token");
  });

  it("maps 401 to auth_lost", async () => {
    stubFetch(jsonResponse(401, { error: { code: "unauthorized" } }));
    const client = buildShareTokenClient("http://localhost");
    expect(await client.register({ ingestToken: INGEST, shareToken: SHARE })).toEqual({ kind: "auth_lost" });
  });

  it("maps 403 to stopped quarantined", async () => {
    stubFetch(jsonResponse(403, { error: { code: "quarantined" } }));
    const client = buildShareTokenClient("http://localhost");
    expect(await client.register({ ingestToken: INGEST, shareToken: SHARE })).toEqual({
      kind: "stopped",
      reason: "quarantined",
    });
  });

  it("maps 410 to stopped consent_revoked", async () => {
    stubFetch(jsonResponse(410, { error: { code: "consent_revoked" } }));
    const client = buildShareTokenClient("http://localhost");
    expect(await client.register({ ingestToken: INGEST, shareToken: SHARE })).toEqual({
      kind: "stopped",
      reason: "consent_revoked",
    });
  });

  it("maps 409 to conflict", async () => {
    stubFetch(jsonResponse(409, { error: { code: "share_token_conflict" } }));
    const client = buildShareTokenClient("http://localhost");
    expect(await client.register({ ingestToken: INGEST, shareToken: SHARE })).toEqual({ kind: "conflict" });
  });

  it("maps 400 to invalid", async () => {
    stubFetch(jsonResponse(400, { error: { code: "validation_failed" } }));
    const client = buildShareTokenClient("http://localhost");
    const outcome = await client.register({ ingestToken: INGEST, shareToken: SHARE });
    expect(outcome.kind).toBe("invalid");
  });

  it("maps 429/500 and network failure to retryable", async () => {
    stubFetch(jsonResponse(429, { error: { code: "rate_limited" } }, { "retry-after": "30" }));
    const client = buildShareTokenClient("http://localhost");
    expect(await client.register({ ingestToken: INGEST, shareToken: SHARE })).toMatchObject({
      kind: "retryable",
      status: 429,
      retryAfterSeconds: 30,
    });

    stubFetch(jsonResponse(500, { error: { code: "internal" } }));
    expect(await client.register({ ingestToken: INGEST, shareToken: SHARE })).toMatchObject({
      kind: "retryable",
      status: 500,
    });

    stubFetch(new Error("fetch failed"));
    expect(await client.register({ ingestToken: INGEST, shareToken: SHARE })).toMatchObject({
      kind: "retryable",
      status: null,
    });
  });

  it("never leaks the share token into a retryable or invalid detail", async () => {
    stubFetch(jsonResponse(500, { error: { code: `internal ${SHARE}` } }));
    const client = buildShareTokenClient("http://localhost");
    const server = await client.register({ ingestToken: INGEST, shareToken: SHARE });
    expect(JSON.stringify(server)).not.toContain(SHARE);

    stubFetch(new Error(`connect ECONNREFUSED near ${SHARE}`));
    const network = await client.register({ ingestToken: INGEST, shareToken: SHARE });
    expect(JSON.stringify(network)).not.toContain(SHARE);
    expect(network.kind).toBe("retryable");
  });

  it("maps a malformed 200 body to invalid rather than throwing", async () => {
    stubFetch(jsonResponse(200, { status: "ok" }));
    const client = buildShareTokenClient("http://localhost");
    const outcome = await client.register({ ingestToken: INGEST, shareToken: SHARE });
    expect(outcome.kind).toBe("invalid");
  });
});
