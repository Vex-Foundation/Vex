import { formatWithOptions } from "node:util";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "undici";
import type { DispatchableRequestInit } from "../../../vex-agent/sync/rpc-egress-policy.js";

import { buildShareTokenClient } from "../../../vex-agent/agentscan/share-token-client.js";
import { generateShareToken } from "../../../vex-agent/agentscan/share-token.js";

const INGEST = "I".repeat(43);
const SHARE = "S".repeat(43);
const CANDIDATE = "N".repeat(43);
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
    expect(line).not.toContain(CANDIDATE);
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
    expect(init.body).toBe(JSON.stringify({ shareToken: SHARE }));
    const { body, ...requestMetadata } = init;
    expect(body).not.toContain(INGEST);
    expect(JSON.stringify({ url, ...requestMetadata })).not.toContain(SHARE);
    expect(init.redirect).toBe("error");
    expect(JSON.stringify(outcome)).not.toContain(SHARE);
  });

  it("sends shareToken and replaces byte-exact with that key order", async () => {
    const mock = stubFetch(jsonResponse(200, { status: "registered" }));
    const client = buildShareTokenClient("https://agentscan.example");
    const outcome = await client.register({ ingestToken: INGEST, shareToken: CANDIDATE, replaces: SHARE });

    expect(outcome).toEqual({ kind: "registered" });
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(`{"shareToken":"${CANDIDATE}","replaces":"${SHARE}"}`);
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

  it("maps 429 to rate_limited with Retry-After", async () => {
    stubFetch(jsonResponse(429, { error: { code: "rate_limited" } }, { "retry-after": "30" }));
    const client = buildShareTokenClient("http://localhost");
    expect(await client.register({ ingestToken: INGEST, shareToken: SHARE })).toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 30,
      detail: "HTTP 429 rate_limited",
    });
  });

  it("maps 429 without Retry-After to rate_limited with a null wait", async () => {
    stubFetch(jsonResponse(429, { error: { code: "rate_limited" } }));
    const client = buildShareTokenClient("http://localhost");
    expect(await client.register({ ingestToken: INGEST, shareToken: SHARE })).toEqual({
      kind: "rate_limited",
      retryAfterSeconds: null,
      detail: "HTTP 429 rate_limited",
    });
  });

  it.each([400, 404, 413, 415])("maps %i to http with the error code", async (status) => {
    stubFetch(jsonResponse(status, { error: { code: "validation_failed" } }));
    const client = buildShareTokenClient("http://localhost");
    expect(await client.register({ ingestToken: INGEST, shareToken: SHARE })).toEqual({
      kind: "http",
      status,
      code: "validation_failed",
      retryAfterSeconds: null,
      detail: `HTTP ${status} validation_failed`,
    });
  });

  it("maps 5xx to http with Retry-After when the header is present", async () => {
    stubFetch(jsonResponse(503, { error: { code: "internal" } }, { "retry-after": "15" }));
    const client = buildShareTokenClient("http://localhost");
    expect(await client.register({ ingestToken: INGEST, shareToken: SHARE })).toEqual({
      kind: "http",
      status: 503,
      code: "internal",
      retryAfterSeconds: 15,
      detail: "HTTP 503 internal",
    });
  });

  it("reads a null http code when the body carries none", async () => {
    stubFetch(jsonResponse(500, { unexpected: true }));
    const client = buildShareTokenClient("http://localhost");
    expect(await client.register({ ingestToken: INGEST, shareToken: SHARE })).toEqual({
      kind: "http",
      status: 500,
      code: null,
      retryAfterSeconds: null,
      detail: "HTTP 500",
    });
  });

  it.each([400, 429, 500])("never leaks credentials from a %i response into details or logs", async (status) => {
    stubFetch(jsonResponse(status, { error: { code: `internal ${SHARE} ${INGEST}`, message: SHARE } }));
    const client = buildShareTokenClient("http://localhost");
    const server = await client.register({ ingestToken: INGEST, shareToken: SHARE });
    expect(server.kind).toBe(status === 400 ? "http" : status === 429 ? "rate_limited" : "http");
    expect(JSON.stringify(server)).not.toContain(SHARE);
    expect(JSON.stringify(server)).not.toContain(INGEST);
  });

  it("never leaks credentials from a network error into details or logs", async () => {
    stubFetch(new Error(`connect ECONNREFUSED near ${SHARE} ${INGEST}`));
    const client = buildShareTokenClient("http://localhost");
    const network = await client.register({ ingestToken: INGEST, shareToken: SHARE });
    expect(JSON.stringify(network)).not.toContain(SHARE);
    expect(JSON.stringify(network)).not.toContain(INGEST);
    expect(network.kind).toBe("transport");
  });

  it("reports an oversized provider detail explicitly without returning a cut-off message", async () => {
    stubFetch(jsonResponse(400, { error: { code: "invalid field ".repeat(30) } }));
    const outcome = await buildShareTokenClient("https://agentscan.example")
      .register({ ingestToken: INGEST, shareToken: SHARE });
    expect(outcome).toEqual({
      kind: "http",
      status: 400,
      code: null,
      retryAfterSeconds: null,
      detail: "HTTP 400; detail omitted (exceeds 120 characters)",
    });
  });

  it("reads a hostile error code as null while the detail still names the status", async () => {
    stubFetch(jsonResponse(400, { error: { code: SHARE } }));
    const outcome = await buildShareTokenClient("http://localhost")
      .register({ ingestToken: INGEST, shareToken: SHARE });
    expect(outcome).toEqual({
      kind: "http",
      status: 400,
      code: null,
      retryAfterSeconds: null,
      detail: "HTTP 400 <blob>",
    });
    expect(JSON.stringify(outcome)).not.toContain(SHARE);
  });

  it("maps a malformed 200 body to malformed_response rather than throwing", async () => {
    stubFetch(jsonResponse(200, { status: "ok" }));
    const client = buildShareTokenClient("http://localhost");
    const outcome = await client.register({ ingestToken: INGEST, shareToken: SHARE });
    expect(outcome).toEqual({ kind: "malformed_response", detail: "malformed share-token response" });
  });
});

describe("buildShareTokenClient.register transport classification (real node:http server)", () => {
  const servers: Server[] = [];

  // The measurement is a DIRECT loopback connection. Ambient proxy env
  // (`NODE_USE_ENV_PROXY=1`, read once at startup) would route these requests
  // through a proxy and mask the transport shape - clearing `process.env`
  // here does NOT help - so every request in this block rides an explicit
  // direct dispatcher. Production intentionally keeps the global dispatcher
  // (proxy-respecting); the pin is test-only, for a loopback server.
  const realFetch = globalThis.fetch;
  let directAgent: Agent | null = null;
  beforeEach(() => {
    directAgent = new Agent();
    const agent = directAgent;
    vi.stubGlobal(
      "fetch",
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const directInit: DispatchableRequestInit = { ...init, dispatcher: agent };
        return realFetch(input, directInit);
      },
    );
  });

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server === undefined) break;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await directAgent?.close();
    directAgent = null;
  });

  /** Listen on 127.0.0.1 with the given handler; closed after the test. */
  async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("server has no address");
    return addr.port;
  }

  /** A port nothing listens on: bind, read the port, close, then connect. */
  async function closedPort(): Promise<number> {
    const tmp = createServer();
    await new Promise<void>((resolve) => tmp.listen(0, "127.0.0.1", resolve));
    const addr = tmp.address();
    if (addr === null || typeof addr === "string") throw new Error("tmp server has no address");
    await new Promise<void>((resolve) => tmp.close(() => resolve()));
    return addr.port;
  }

  it("classifies a refused redirect as redirect (measured: undici cause 'unexpected redirect')", async () => {
    // The client always appends v1/agents/share-token under the base, so the
    // server redirects every request it receives.
    const port = await listen((_req, res) => {
      res.writeHead(302, { Location: "/elsewhere" });
      res.end();
    });
    const outcome = await buildShareTokenClient(`http://127.0.0.1:${port}`)
      .register({ ingestToken: INGEST, shareToken: SHARE });
    expect(outcome).toMatchObject({ kind: "transport", reason: "redirect" });
    expect((outcome as { detail: string }).detail).toContain("(unexpected redirect)");
    expect(JSON.stringify(outcome)).not.toContain(SHARE);
    expect(JSON.stringify(outcome)).not.toContain(INGEST);
  });

  it("classifies a refused connection as network with the errno in the detail", async () => {
    const outcome = await buildShareTokenClient(`http://127.0.0.1:${await closedPort()}`)
      .register({ ingestToken: INGEST, shareToken: SHARE });
    expect(outcome).toMatchObject({ kind: "transport", reason: "network" });
    expect((outcome as { detail: string }).detail).toContain("(ECONNREFUSED)");
    expect(JSON.stringify(outcome)).not.toContain(SHARE);
    expect(JSON.stringify(outcome)).not.toContain(INGEST);
  });

  it("classifies a hung response past the timeout as timeout", async () => {
    const port = await listen(() => undefined); // never answers
    const outcome = await buildShareTokenClient(`http://127.0.0.1:${port}`, { timeoutMs: 200 })
      .register({ ingestToken: INGEST, shareToken: SHARE });
    expect(outcome).toMatchObject({ kind: "transport", reason: "timeout" });
    expect((outcome as { detail: string }).detail).toContain("Request timed out after 200ms");
  });
});
