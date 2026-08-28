/**
 * AgentScan ingest client — wire shape + outcome mapping.
 *
 * Registration is dead client-side (see `client.ts`'s header) — this suite
 * covers what remains, `sendEvents`, the outbox drain endpoint.
 *
 * Pinned here:
 *   - exact URL, headers and body for events (the token travels ONLY in the
 *     Authorization header — never in a URL);
 *   - every server answer maps to the outcome the reporter keys off:
 *     contract retry rule (only 429/5xx/network are retryable), 401 and
 *     403-not_registered as recoverable auth loss, 410 as a permanent stop,
 *     403-quarantined as a named `stopped` outcome the lane treats as a
 *     pause, 400/413 as non-retryable client bugs;
 *   - `Retry-After` is surfaced on 429/503;
 *   - nothing throws — a network failure is a named outcome;
 *   - failure details never contain the token.
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

const SEND_INPUT = {
  agentHash: HASH,
  ingestToken: TOKEN,
  backfill: false,
  events: [] as never[],
};

describe("sendEvents — wire shape", () => {
  it("POSTs the envelope to /v1/events with the Bearer token, never in the URL", async () => {
    const mock = stubFetch(jsonResponse(200, { accepted: 2, duplicates: 1, rejected: [] }));
    const client = buildAgentscanClient("http://localhost");
    const outcome = await client.sendEvents({ ...SEND_INPUT, backfill: true });

    expect(outcome).toEqual({ kind: "ok", accepted: 2, duplicates: 1, rejectedIndexes: [], agentHealth: null });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost/v1/events");
    expect(url).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({
      // 2 declares that this build's confirmedAt is the settling block time
      // (or null), never local observation time - the server side's request
      // so it can later relax the time rule for version-1 clients only.
      schemaVersion: 2,
      agentHash: HASH,
      backfill: true,
      events: [],
    });
  });

  it("surfaces per-item rejections as indexes", async () => {
    stubFetch(jsonResponse(200, { accepted: 1, duplicates: 0, rejected: [{ index: 3, code: "validation_failed" }] }));
    const client = buildAgentscanClient("http://localhost");
    const outcome = await client.sendEvents(SEND_INPUT);
    expect(outcome).toEqual({ kind: "ok", accepted: 1, duplicates: 0, rejectedIndexes: [3], agentHealth: null });
  });

  it("reads the additive agent-health field, tolerantly", async () => {
    stubFetch(jsonResponse(200, {
      accepted: 1, duplicates: 0, rejected: [],
      agent: { strikeCount: 2, status: "active" },
    }));
    const client = buildAgentscanClient("http://localhost");
    const outcome = await client.sendEvents(SEND_INPUT);
    expect(outcome).toMatchObject({ kind: "ok", agentHealth: { strikeCount: 2, status: "active" } });
  });

  it.each([
    ["missing entirely", {}],
    ["not a record", { agent: "quarantined" }],
    ["negative strikes", { agent: { strikeCount: -1, status: "active" } }],
    ["missing status", { agent: { strikeCount: 1 } }],
    ["null strikes (Number(null) is 0)", { agent: { strikeCount: null, status: "active" } }],
    ["boolean strikes (Number(true) is 1)", { agent: { strikeCount: true, status: "active" } }],
    ["stringly strikes", { agent: { strikeCount: "2", status: "active" } }],
    ["whitespace-only status", { agent: { strikeCount: 1, status: "   " } }],
  ])("agent-health reads as null when %s", async (_label, extra) => {
    stubFetch(jsonResponse(200, { accepted: 1, duplicates: 0, rejected: [], ...extra }));
    const client = buildAgentscanClient("http://localhost");
    const outcome = await client.sendEvents(SEND_INPUT);
    expect(outcome).toMatchObject({ kind: "ok", agentHealth: null });
  });

  it.each([
    [401, { error: { code: "unauthorized", message: "unknown token" } }, { kind: "auth_lost" }],
    [403, { error: { code: "not_registered", message: "hash mismatch" } }, { kind: "auth_lost" }],
    [403, { error: { code: "quarantined", message: "strikes" } }, { kind: "stopped", reason: "quarantined" }],
    [410, { error: { code: "consent_revoked", message: "revoked" } }, { kind: "stopped", reason: "consent_revoked" }],
  ])("maps %s %o", async (status, body, expected) => {
    stubFetch(jsonResponse(status as number, body));
    const client = buildAgentscanClient("http://localhost");
    const outcome = await client.sendEvents(SEND_INPUT);
    expect(outcome).toMatchObject(expected as Record<string, unknown>);
  });

  it("maps 400 and 413 to invalid (non-retryable client bugs)", async () => {
    stubFetch(jsonResponse(400, { error: { code: "validation_failed", message: "events batch failed validation" } }));
    const client = buildAgentscanClient("http://localhost");
    expect((await client.sendEvents(SEND_INPUT)).kind).toBe("invalid");

    stubFetch(jsonResponse(413, { error: { code: "payload_too_large", message: "too many events in batch" } }));
    expect((await client.sendEvents(SEND_INPUT)).kind).toBe("invalid");
  });

  it("maps 429/503 to retryable carrying Retry-After, and network failure to retryable", async () => {
    stubFetch(jsonResponse(429, { error: { code: "rate_limited", message: "later" } }, { "retry-after": "30" }));
    const client = buildAgentscanClient("http://localhost");
    expect(await client.sendEvents(SEND_INPUT)).toMatchObject({ kind: "retryable", status: 429, retryAfterSeconds: 30 });

    stubFetch(jsonResponse(503, { error: { code: "database_unavailable", message: "pool" } }, { "retry-after": "5" }));
    expect(await client.sendEvents(SEND_INPUT)).toMatchObject({ kind: "retryable", status: 503, retryAfterSeconds: 5 });

    stubFetch(new Error("fetch failed"));
    expect(await client.sendEvents(SEND_INPUT)).toMatchObject({ kind: "retryable", status: null });
  });
});
