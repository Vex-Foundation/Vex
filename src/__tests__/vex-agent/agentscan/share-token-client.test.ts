import { formatWithOptions } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const logSpies = () => [
  vi.spyOn(console, "log").mockImplementation(() => undefined),
  vi.spyOn(console, "info").mockImplementation(() => undefined),
  vi.spyOn(console, "warn").mockImplementation(() => undefined),
  vi.spyOn(console, "error").mockImplementation(() => undefined),
  vi.spyOn(console, "debug").mockImplementation(() => undefined),
  vi.spyOn(process.stdout, "write").mockImplementation(() => true),
  vi.spyOn(process.stderr, "write").mockImplementation(() => true),
];
let logs: ReturnType<typeof logSpies>;

beforeEach(() => {
  logs = logSpies();
});

afterEach(() => {
  const lines = logs.flatMap((spy) => spy.mock.calls.map((args) => formatWithOptions(
    { depth: null, maxArrayLength: null, maxStringLength: null }, ...args,
  )));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const line of lines) {
    expect(line).not.toContain(SHARE);
    expect(line).not.toContain(INGEST);
  }
});

describe("generateShareToken", () => {
  it("mints 43-char base64url", () => {
    const token = generateShareToken();
    expect(token).toMatch(SHARE_PATTERN);
    expect(generateShareToken()).not.toBe(token);
  });
});

describe("buildShareTokenClient.register", () => {
  it("POSTs the plaintext shareToken only in the body to the configured URL with Bearer ingest token", async () => {
    const mock = stubFetch(jsonResponse(200, { status: "registered" }));
    const client = buildShareTokenClient("https://agentscan.example");
    const outcome = await client.register({ ingestToken: INGEST, shareToken: SHARE });

    expect(outcome).toEqual({ kind: "registered" });
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://agentscan.example/v1/agents/share-token");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${INGEST}`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      shareToken: SHARE,
    });
    const { body, ...requestMetadata } = init;
    expect(body).not.toContain(INGEST);
    expect(JSON.stringify({ url, ...requestMetadata })).not.toContain(SHARE);
    expect(init.redirect).toBe("error");
    expect(JSON.stringify(outcome)).not.toContain(SHARE);
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
    expect(outcome).toEqual({ kind: "invalid", detail: "HTTP 400 validation_failed" });
  });

  it("maps 429/500 and network failure to retryable", async () => {
    stubFetch(jsonResponse(429, { error: { code: "rate_limited" } }, { "retry-after": "30" }));
    const client = buildShareTokenClient("http://localhost");
    expect(await client.register({ ingestToken: INGEST, shareToken: SHARE })).toMatchObject({
      kind: "retryable",
      status: 429,
      retryAfterSeconds: 30,
    });

    stubFetch(jsonResponse(500, { error: { code: "internal" } }, { "retry-after": "15" }));
    expect(await client.register({ ingestToken: INGEST, shareToken: SHARE })).toMatchObject({
      kind: "retryable",
      status: 500,
      retryAfterSeconds: 15,
    });

    stubFetch(new Error("fetch failed"));
    expect(await client.register({ ingestToken: INGEST, shareToken: SHARE })).toMatchObject({
      kind: "retryable",
      status: null,
    });
  });

  it.each([400, 429, 500])("never leaks credentials from a %i response into details or logs", async (status) => {
    stubFetch(jsonResponse(status, { error: { code: `internal ${SHARE} ${INGEST}`, message: SHARE } }));
    const client = buildShareTokenClient("http://localhost");
    const server = await client.register({ ingestToken: INGEST, shareToken: SHARE });
    expect(server.kind).toBe(status === 400 ? "invalid" : "retryable");
    expect(JSON.stringify(server)).not.toContain(SHARE);
    expect(JSON.stringify(server)).not.toContain(INGEST);
  });

  it("never leaks credentials from a network error into details or logs", async () => {
    stubFetch(new Error(`connect ECONNREFUSED near ${SHARE} ${INGEST}`));
    const client = buildShareTokenClient("http://localhost");
    const network = await client.register({ ingestToken: INGEST, shareToken: SHARE });
    expect(JSON.stringify(network)).not.toContain(SHARE);
    expect(JSON.stringify(network)).not.toContain(INGEST);
    expect(network.kind).toBe("retryable");
  });

  it("reports an oversized provider detail explicitly without returning a cut-off message", async () => {
    stubFetch(jsonResponse(400, { error: { code: "invalid field ".repeat(30) } }));
    const outcome = await buildShareTokenClient("https://agentscan.example")
      .register({ ingestToken: INGEST, shareToken: SHARE });
    expect(outcome).toEqual({
      kind: "invalid",
      detail: "HTTP 400; detail omitted (exceeds 120 characters)",
    });
  });

  it("maps a malformed 200 body to invalid rather than throwing", async () => {
    stubFetch(jsonResponse(200, { status: "ok" }));
    const client = buildShareTokenClient("http://localhost");
    const outcome = await client.register({ ingestToken: INGEST, shareToken: SHARE });
    expect(outcome.kind).toBe("invalid");
  });
});
