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
 *     403-not_registered as recoverable auth loss, 410 / 403-quarantined as
 *     permanent stops, 400/413 as non-retryable client bugs;
 *   - `Retry-After` is surfaced on 429/503;
 *   - nothing throws - a network failure is a named outcome;
 *   - failure details never contain the token;
 *   - a 200 that does not ACCOUNT FOR the batch is `unknown_acknowledgement`,
 *     never a delivery: the drain settles everything a batch did not reject,
 *     so an empty or inconsistent body used to retire undelivered events.
 */
import { afterEach, describe, it, expect, vi } from "vitest";

import type { AgentscanEvent } from "../../../vex-agent/agentscan/mapper.js";
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

/** One event, only as much of it as the client puts on the wire verbatim. */
function event(index: number): AgentscanEvent {
  return {
    sourceRowId: `row-${index}`, sourceExecutionId: `exec-${index}`, eventIndex: index,
    kind: "swap", eventRole: "swap", status: "confirmed", protocol: "uniswap",
    chainFamily: "eip155", chainId: "1", fromChainId: null, toChainId: null,
    tokenIn: null, tokenOut: null, amountInRaw: null, amountOutRaw: null,
    executedInRaw: null, executedOutRaw: null, tokenIn2: null, tokenOut2: null,
    amountIn2Raw: null, amountOut2Raw: null, executedIn2Raw: null, executedOut2Raw: null,
    usdInEst: null, usdOutEst: null, usdFeeEst: null, usdSource: null,
    txHash: null, failureCode: null, createdAt: "2026-09-08T10:00:00.000Z",
    confirmedAt: null, observedAt: null,
  };
}

/** THREE events, so an acknowledgement can be checked against a real batch size. */
const SEND_INPUT = {
  agentHash: HASH,
  ingestToken: TOKEN,
  backfill: false,
  events: [event(0), event(1), event(2)],
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
    expect(JSON.parse(init.body as string)).toMatchObject({
      // 2 declares that this build's confirmedAt is the settling block time
      // (or null), never local observation time - the server side's request
      // so it can later relax the time rule for version-1 clients only.
      schemaVersion: 2,
      agentHash: HASH,
      backfill: true,
      events: [event(0), event(1), event(2)],
    });
  });

  it("surfaces per-item rejections as indexes", async () => {
    stubFetch(jsonResponse(200, { accepted: 1, duplicates: 0, rejected: [
      { index: 2, code: "validation_failed" },
      { index: 0, code: "conflicting_identity" },
    ] }));
    const client = buildAgentscanClient("http://localhost");
    const outcome = await client.sendEvents(SEND_INPUT);
    expect(outcome).toEqual({ kind: "ok", accepted: 1, duplicates: 0, rejectedIndexes: [2, 0], agentHealth: null });
  });

  it("reads the additive agent-health field, tolerantly", async () => {
    stubFetch(jsonResponse(200, {
      accepted: 3, duplicates: 0, rejected: [],
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
    stubFetch(jsonResponse(200, { accepted: 3, duplicates: 0, rejected: [], ...extra }));
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

/**
 * A 200 IS NOT A VERDICT UNLESS IT ACCOUNTS FOR THE BATCH.
 *
 * Both routes place every item in exactly one bucket - `accepted`, the settled
 * count, or one `rejected` entry - so `accepted + settled + rejected === sent`
 * is the server's own invariant. A body that breaks it did not come from a
 * server that processed this batch, and the caller settles everything a batch
 * did not reject: reading `{}` as "nothing rejected" retired undelivered work.
 */
const UNACCOUNTABLE: ReadonlyArray<readonly [string, unknown]> = [
  ["an empty object", {}],
  ["a null body", null],
  ["an array body", [1, 2, 3]],
  ["counts that do not add up", { accepted: 1, settled: 0, rejected: [] }],
  ["counts that overshoot the batch", { accepted: 4, settled: 0, rejected: [] }],
  ["a stringly count", { accepted: "3", settled: 0, rejected: [] }],
  ["a null count (Number(null) is 0)", { accepted: null, settled: 3, rejected: [] }],
  ["a boolean count (Number(true) is 1)", { accepted: true, settled: 2, rejected: [] }],
  ["a negative count", { accepted: -1, settled: 4, rejected: [] }],
  ["a missing rejected list", { accepted: 3, settled: 0 }],
  ["a rejected list that is not an array", { accepted: 2, settled: 0, rejected: { index: 0 } }],
  ["a rejection index beyond the batch", { accepted: 2, settled: 0, rejected: [{ index: 7, code: "validation_failed" }] }],
  ["a negative rejection index", { accepted: 2, settled: 0, rejected: [{ index: -1, code: "validation_failed" }] }],
  ["a non-integer rejection index", { accepted: 2, settled: 0, rejected: [{ index: 1.5, code: "validation_failed" }] }],
  ["a duplicated rejection index", { accepted: 1, settled: 0, rejected: [
    { index: 0, code: "validation_failed" },
    { index: 0, code: "validation_failed" },
  ] }],
  ["a rejection without a reason code", { accepted: 2, settled: 0, rejected: [{ index: 1 }] }],
  ["a rejection entry that is not an object", { accepted: 2, settled: 0, rejected: [1] }],
];

/** The same body with the endpoint's own name for its settled count. */
function withSettledField(body: unknown, field: "duplicates" | "ignoredStale"): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
  const record: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  if ("settled" in record) {
    record[field] = record.settled;
    delete record.settled;
  }
  return record;
}

describe("sendEvents - an acknowledgement that does not account for the batch", () => {
  it.each(UNACCOUNTABLE)("refuses to settle anything on %s", async (_label, body) => {
    stubFetch(jsonResponse(200, withSettledField(body, "duplicates")));
    const client = buildAgentscanClient("http://localhost");
    const outcome = await client.sendEvents(SEND_INPUT);
    expect(outcome.kind).toBe("unknown_acknowledgement");
  });

  it("refuses a 200 whose body is not JSON at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>proxy</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })));
    const client = buildAgentscanClient("http://localhost");
    expect((await client.sendEvents(SEND_INPUT)).kind).toBe("unknown_acknowledgement");
  });

  it("never leaks the token in the detail it reports", async () => {
    stubFetch(jsonResponse(200, {}));
    const client = buildAgentscanClient("http://localhost");
    const outcome = await client.sendEvents(SEND_INPUT);
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });
});

const POSITION_OBSERVATION = {
  environment: "core" as const,
  accountIndex: "24226",
  observationId: "obs-1",
  observedAt: "2026-09-08T10:00:00.000Z",
  source: "account_endpoint" as const,
  coverage: { markets: "all" as const, complete: true },
  positions: [],
};

const POSITIONS_INPUT = {
  agentHash: HASH,
  ingestToken: TOKEN,
  observations: [
    POSITION_OBSERVATION,
    { ...POSITION_OBSERVATION, observationId: "obs-2" },
    { ...POSITION_OBSERVATION, observationId: "obs-3" },
  ],
};

describe("postLighterPositionObservations - the acknowledgement", () => {
  it("reads a well-formed acknowledgement that accounts for every observation", async () => {
    stubFetch(jsonResponse(200, {
      accepted: 1,
      ignoredStale: 1,
      rejected: [{ index: 2, code: "validation_failed" }],
    }));
    const client = buildAgentscanClient("http://localhost");
    expect(await client.postLighterPositionObservations(POSITIONS_INPUT)).toEqual({
      kind: "ok", accepted: 1, ignoredStale: 1, rejectedIndexes: [2],
    });
  });

  it.each(UNACCOUNTABLE)("settles nothing on %s", async (_label, body) => {
    stubFetch(jsonResponse(200, withSettledField(body, "ignoredStale")));
    const client = buildAgentscanClient("http://localhost");
    const outcome = await client.postLighterPositionObservations(POSITIONS_INPUT);
    expect(outcome.kind).toBe("unknown_acknowledgement");
  });

  it("refuses a 200 whose body is not JSON at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    const client = buildAgentscanClient("http://localhost");
    const outcome = await client.postLighterPositionObservations(POSITIONS_INPUT);
    expect(outcome.kind).toBe("unknown_acknowledgement");
  });
});
